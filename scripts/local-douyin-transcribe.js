const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const ROOT = process.cwd();
const DEFAULT_SLUG = 'profile';
const DEFAULT_INPUT = path.join(ROOT, 'output', `${DEFAULT_SLUG}-simple.csv`);
const DEFAULT_OUTPUT = path.join(ROOT, 'output', `${DEFAULT_SLUG}-simple-with-local-transcript.csv`);
const DEFAULT_PROGRESS = path.join(ROOT, 'output', `${DEFAULT_SLUG}-local-transcript-progress.json`);
const DEFAULT_FAILURES = path.join(ROOT, 'output', `${DEFAULT_SLUG}-local-transcript-failures.csv`);
const DEFAULT_CACHE = path.join(ROOT, 'output', 'media-cache', DEFAULT_SLUG);
const DEFAULT_STORAGE_STATE = path.join(ROOT, 'output', 'douyin-storage-state.json');

const EXTRA_HEADERS = ['中文文案', '转写质量', '音频来源', '处理耗时', '错误原因'];
const FAILURE_HEADERS = ['标题', '视频链接', '失败阶段', '失败原因', '时间'];

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    progress: DEFAULT_PROGRESS,
    failures: DEFAULT_FAILURES,
    cacheDir: DEFAULT_CACHE,
    asrCacheDir: path.join(os.tmpdir(), 'douyin-local-asr-cache', DEFAULT_SLUG),
    slug: DEFAULT_SLUG,
    storageState: DEFAULT_STORAGE_STATE,
    python: 'py',
    pythonArgs: ['-3.11'],
    ffmpeg: 'ffmpeg',
    ytdlp: '',
    limit: 0,
    start: 0,
    force: false,
    forceDownload: false,
    device: 'auto',
    model: 'iic/SenseVoiceSmall',
    dryRun: false,
    prepareAudioOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input') args.input = path.resolve(next), i += 1;
    else if (arg === '--output') args.output = path.resolve(next), i += 1;
    else if (arg === '--progress') args.progress = path.resolve(next), i += 1;
    else if (arg === '--failures') args.failures = path.resolve(next), i += 1;
    else if (arg === '--cache-dir') args.cacheDir = path.resolve(next), i += 1;
    else if (arg === '--asr-cache-dir') args.asrCacheDir = path.resolve(next), i += 1;
    else if (arg === '--slug') args.slug = next, i += 1;
    else if (arg === '--storage-state') args.storageState = path.resolve(next), i += 1;
    else if (arg === '--python') {
      args.python = next;
      args.pythonArgs = [];
      i += 1;
    } else if (arg === '--python-arg') args.pythonArgs.push(next), i += 1;
    else if (arg === '--ffmpeg') args.ffmpeg = next, i += 1;
    else if (arg === '--yt-dlp') args.ytdlp = next, i += 1;
    else if (arg === '--limit') args.limit = Number(next), i += 1;
    else if (arg === '--start') args.start = Number(next), i += 1;
    else if (arg === '--device') args.device = next, i += 1;
    else if (arg === '--model') args.model = next, i += 1;
    else if (arg === '--force') args.force = true;
    else if (arg === '--force-download') args.forceDownload = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--prepare-audio-only') args.prepareAudioOnly = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/local-douyin-transcribe.js [options]

Options:
  --input <path>          Input simple CSV
  --output <path>         Output CSV with local transcript columns
  --progress <path>       Resume progress JSON
  --failures <path>       Failure CSV
  --cache-dir <path>      Audio/WAV cache directory
  --asr-cache-dir <path>  ASCII cache directory for ASR models
  --slug <name>           Prefix for existing post-page JSON files
  --storage-state <path>  Playwright storage state for yt-dlp cookies fallback
  --python <cmd>          Python command, default py
  --python-arg <arg>      Extra Python launcher arg, default -3.11
  --ffmpeg <cmd>          ffmpeg command
  --yt-dlp <cmd>          yt-dlp command, default auto-detect
  --limit <n>             Process n pending rows
  --start <n>             Start at zero-based row index
  --device <auto|cuda|cpu>
  --force                 Re-transcribe rows even if already successful
  --force-download        Re-download and reconvert audio
  --dry-run               Print pending work without downloading/transcribing
  --prepare-audio-only    Stop after audio download and 16k WAV conversion
`);
      process.exit(0);
    }
  }

  return args;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;
  const src = stripBom(text);
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\r') {
      if (next === '\n') i += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += ch;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((cells) => cells.some((cell) => cell.trim())).map((cells) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = cells[index] ?? '';
    });
    return item;
  });
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, headers, rows) {
  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\r\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `\uFEFF${csv}`, 'utf8');
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function nowIso() {
  return new Date().toISOString();
}

function getVideoId(row) {
  const link = row['视频链接'] || row.video_url || '';
  const match = link.match(/video\/(\d+)/);
  return match ? match[1] : link;
}

function isSuccessful(result) {
  return result && result.status === 'success' && result.transcript;
}

function readProgress(file) {
  const progress = readJson(file, {
    startedAt: nowIso(),
    updatedAt: nowIso(),
    results: {},
    failureEvents: [],
  });
  progress.results ||= {};
  progress.failureEvents ||= [];
  return progress;
}

function outputHeaders(inputRows) {
  const base = Object.keys(inputRows[0] || {});
  const cleaned = base.filter((header) => !EXTRA_HEADERS.includes(header));
  return [...cleaned, ...EXTRA_HEADERS];
}

function buildOutputRows(inputRows, progress) {
  return inputRows.map((row) => {
    const id = getVideoId(row);
    const result = progress.results[id] || {};
    return {
      ...row,
      中文文案: result.status === 'success' ? result.transcript || '' : '',
      转写质量: result.quality || '',
      音频来源: result.audioSource || '',
      处理耗时: result.elapsedMs ? String(Math.round(result.elapsedMs / 1000)) + 's' : '',
      错误原因: result.status === 'failed' ? result.error || '' : '',
    };
  });
}

function buildFailureRows(progress) {
  return Object.values(progress.results)
    .filter((item) => item.status === 'failed')
    .map((item) => ({
      标题: item.title || '',
      视频链接: item.url || '',
      失败阶段: item.stage || '',
      失败原因: item.error || '',
      时间: item.failedAt || '',
    }));
}

function persistAll(args, inputRows, progress) {
  progress.updatedAt = nowIso();
  const values = Object.values(progress.results);
  progress.successCount = values.filter((item) => item.status === 'success').length;
  progress.failedCount = values.filter((item) => item.status === 'failed').length;
  progress.total = inputRows.length;
  writeCsv(args.output, outputHeaders(inputRows), buildOutputRows(inputRows, progress));
  writeCsv(args.failures, FAILURE_HEADERS, buildFailureRows(progress));
  fs.mkdirSync(path.dirname(args.progress), { recursive: true });
  fs.writeFileSync(args.progress, JSON.stringify(progress, null, 2), 'utf8');
}

function commandExists(command, extraArgs = ['--version']) {
  const result = spawnSync(command, extraArgs, { encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0;
}

function findYtDlp(args) {
  if (args.ytdlp) return { command: args.ytdlp, args: [] };
  if (commandExists('yt-dlp')) return { command: 'yt-dlp', args: [] };
  const pyArgs = [...args.pythonArgs, '-m', 'yt_dlp', '--version'];
  if (spawnSync(args.python, pyArgs, { encoding: 'utf8', stdio: 'pipe' }).status === 0) {
    return { command: args.python, args: [...args.pythonArgs, '-m', 'yt_dlp'] };
  }
  return null;
}

function resolveFfmpeg(command) {
  if (command && command !== 'ffmpeg') return command;
  if (commandExists(command || 'ffmpeg')) return command || 'ffmpeg';
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return command || 'ffmpeg';
  }
}

function findPostPageFiles(slug) {
  const dir = path.join(ROOT, 'output');
  if (!fs.existsSync(dir)) return [];
  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-post-page-(\\d+)\\.json$`);
  return fs.readdirSync(dir)
    .map((name) => {
      const match = name.match(pattern);
      return match ? { name, index: Number(match[1]), file: path.join(dir, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.file);
}

function addUrl(candidates, url, source) {
  if (!url || typeof url !== 'string') return;
  if (!/^https?:\/\//.test(url)) return;
  if (candidates.some((item) => item.url === url)) return;
  candidates.push({ url, source });
}

function extractAudioCandidates(aweme) {
  const candidates = [];
  for (const item of aweme.video?.bit_rate_audio || []) {
    const urls = item.audio_meta?.url_list || {};
    addUrl(candidates, urls.main_url, 'post-page-audio-main');
    addUrl(candidates, urls.backup_url, 'post-page-audio-backup');
    addUrl(candidates, urls.fallback_url, 'post-page-audio-fallback');
  }
  for (const item of aweme.video?.play_addr?.url_list || []) {
    addUrl(candidates, item, 'post-page-video-play');
  }
  return candidates;
}

function buildAudioIndex(slug) {
  const index = new Map();
  for (const file of findPostPageFiles(slug)) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const aweme of json.aweme_list || []) {
      const id = aweme.aweme_id;
      if (!id || index.has(id)) continue;
      index.set(id, {
        id,
        title: aweme.desc || '',
        durationMs: aweme.duration || aweme.video?.duration || 0,
        sourceFile: path.relative(ROOT, file),
        candidates: extractAudioCandidates(aweme),
      });
    }
  }
  return index;
}

function downloadFile(url, target, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const request = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        Referer: referer || 'https://www.douyin.com/',
        Accept: '*/*',
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url).href;
        downloadFile(redirected, target, referer).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const stream = fs.createWriteStream(target);
      response.pipe(stream);
      stream.on('finish', () => {
        stream.close(() => resolve());
      });
      stream.on('error', reject);
    });
    request.setTimeout(90000, () => {
      request.destroy(new Error('download timeout'));
    });
    request.on('error', reject);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`.slice(0, 1200)));
    });
  });
}

function storageStateToCookieFile(storageState, cookieFile) {
  if (!storageState || !fs.existsSync(storageState)) return '';
  const state = JSON.parse(fs.readFileSync(storageState, 'utf8'));
  const lines = ['# Netscape HTTP Cookie File'];
  for (const cookie of state.cookies || []) {
    const domain = cookie.domain || '';
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const pathValue = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    lines.push([domain, includeSubdomains, pathValue, secure, expires, cookie.name, cookie.value].join('\t'));
  }
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
  fs.writeFileSync(cookieFile, lines.join('\n'), 'utf8');
  return cookieFile;
}

async function downloadWithYtDlp(args, ytdlp, row, rawFile) {
  if (!ytdlp) throw new Error('yt-dlp is not installed');
  const link = row['视频链接'];
  const cookieFile = storageStateToCookieFile(args.storageState, path.join(args.cacheDir, 'douyin-cookies.txt'));
  const outputTemplate = rawFile.replace(/\.[^.]+$/, '.%(ext)s');
  const cmdArgs = [
    ...ytdlp.args,
    '--no-playlist',
    '-f',
    'ba/bestaudio/best',
    '-o',
    outputTemplate,
  ];
  if (cookieFile) cmdArgs.push('--cookies', cookieFile);
  cmdArgs.push(link);
  await runCommand(ytdlp.command, cmdArgs, { echo: false });
  const dir = path.dirname(rawFile);
  const base = path.basename(rawFile).replace(/\.[^.]+$/, '.');
  const downloaded = fs.readdirSync(dir)
    .filter((name) => name.startsWith(base))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!downloaded || fs.statSync(downloaded).size < 1024) {
    throw new Error('yt-dlp did not produce a usable media file');
  }
  return downloaded;
}

async function ensureRawAudio(args, ytdlp, row, audioMeta) {
  const id = getVideoId(row);
  const dir = path.join(args.cacheDir, id);
  const rawFile = path.join(dir, `${id}.m4a`);
  if (!args.forceDownload && fs.existsSync(rawFile) && fs.statSync(rawFile).size > 1024) {
    return { rawPath: rawFile, source: 'cache' };
  }

  const referer = row['视频链接'] || 'https://www.douyin.com/';
  const errors = [];
  for (const candidate of audioMeta?.candidates || []) {
    try {
      await downloadFile(candidate.url, rawFile, referer);
      if (fs.statSync(rawFile).size > 1024) {
        return { rawPath: rawFile, source: candidate.source };
      }
    } catch (error) {
      errors.push(`${candidate.source}: ${error.message}`);
      fs.rmSync(rawFile, { force: true });
    }
  }

  try {
    const downloaded = await downloadWithYtDlp(args, ytdlp, row, rawFile);
    return { rawPath: downloaded, source: 'yt-dlp' };
  } catch (error) {
    errors.push(`yt-dlp: ${error.message}`);
  }

  throw new Error(errors.join(' | ') || 'no audio source found');
}

async function ensureWav(args, rawPath, id) {
  const wavPath = path.join(args.cacheDir, id, `${id}.16k.wav`);
  if (!args.forceDownload && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1024) {
    return wavPath;
  }
  fs.mkdirSync(path.dirname(wavPath), { recursive: true });
  await runCommand(args.ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    rawPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    wavPath,
  ]);
  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1024) {
    throw new Error('ffmpeg produced an empty wav file');
  }
  return wavPath;
}

function qualityOf(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return { quality: '失败', reason: 'empty transcript' };
  const compact = cleaned.replace(/\s/g, '');
  const chinese = (compact.match(/[\u4e00-\u9fff]/g) || []).length;
  const ratio = chinese / Math.max(1, compact.length);
  const repeated = /(.{8,})\1{2,}/.test(compact);
  if (compact.length < 20 || ratio < 0.25) return { quality: '需人工复核', reason: 'too short or low Chinese ratio' };
  if (repeated) return { quality: '需人工复核', reason: 'repeated text detected' };
  if (compact.length < 80 || ratio < 0.45) return { quality: '可用但需抽查', reason: '' };
  return { quality: '通过', reason: '' };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runAsr(args, manifestRows) {
  const runId = String(Date.now());
  const manifestFile = path.join(args.cacheDir, `asr-manifest-${runId}.jsonl`);
  const resultFile = path.join(args.cacheDir, `asr-results-${runId}.jsonl`);
  fs.mkdirSync(args.cacheDir, { recursive: true });
  fs.writeFileSync(manifestFile, manifestRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  await runCommand(args.python, [
    ...args.pythonArgs,
    path.join(__dirname, 'local_asr_funasr.py'),
    '--manifest',
    manifestFile,
    '--output',
    resultFile,
    '--device',
    args.device,
    '--model',
    args.model,
  ], {
    echo: true,
    env: {
      ...process.env,
      MODELSCOPE_CACHE: path.join(args.asrCacheDir, 'modelscope-cache'),
      HF_HOME: path.join(args.asrCacheDir, 'huggingface-cache'),
      LOCAL_ASR_CACHE: args.asrCacheDir,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  return readJsonl(resultFile);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputRows = parseCsv(fs.readFileSync(args.input, 'utf8'));
  const progress = readProgress(args.progress);
  fs.mkdirSync(args.cacheDir, { recursive: true });
  args.ffmpeg = resolveFfmpeg(args.ffmpeg);

  const audioIndex = buildAudioIndex(args.slug);
  const ytdlp = findYtDlp(args);
  const pending = inputRows
    .map((row, index) => ({ row, index, id: getVideoId(row) }))
    .filter((item) => item.index >= args.start)
    .filter((item) => args.force || !isSuccessful(progress.results[item.id]));
  const selected = args.limit > 0 ? pending.slice(0, args.limit) : pending;

  console.log(JSON.stringify({
    input: args.input,
    rows: inputRows.length,
    pending: pending.length,
    selected: selected.length,
    audioIndex: audioIndex.size,
    ytdlp: ytdlp ? `${ytdlp.command} ${ytdlp.args.join(' ')}`.trim() : '',
    cacheDir: args.cacheDir,
  }, null, 2));

  if (args.dryRun) {
    persistAll(args, inputRows, progress);
    return;
  }

  const manifestRows = [];
  for (const item of selected) {
    const started = Date.now();
    const { row, id } = item;
    const title = row['标题'] || '';
    const url = row['视频链接'] || '';
    try {
      console.log(`[audio] ${item.index + 1}/${inputRows.length} ${id} ${title}`);
      const raw = await ensureRawAudio(args, ytdlp, row, audioIndex.get(id));
      const wavPath = await ensureWav(args, raw.rawPath, id);
      progress.results[id] = {
        status: 'audio_ready',
        title,
        url,
        audioSource: raw.source,
        rawPath: raw.rawPath,
        wavPath,
        elapsedMs: Date.now() - started,
        updatedAt: nowIso(),
      };
      manifestRows.push({ id, title, url, wav_path: wavPath, audio_source: raw.source });
    } catch (error) {
      progress.results[id] = {
        status: 'failed',
        stage: 'audio',
        title,
        url,
        error: error.message,
        failedAt: nowIso(),
        elapsedMs: Date.now() - started,
      };
      progress.failureEvents.push({ id, title, url, stage: 'audio', error: error.message, time: nowIso() });
      console.log(`[fail][audio] ${id} ${error.message}`);
    }
    persistAll(args, inputRows, progress);
  }

  if (args.prepareAudioOnly) {
    console.log(JSON.stringify({
      preparedAudio: manifestRows.length,
      message: 'Stopped before ASR because --prepare-audio-only was set.',
    }, null, 2));
  } else if (manifestRows.length) {
    const asrResults = await runAsr(args, manifestRows);
    const byId = new Map(asrResults.map((item) => [item.id, item]));
    for (const item of manifestRows) {
      const result = byId.get(item.id);
      const previous = progress.results[item.id] || {};
      if (!result || result.status !== 'success') {
        progress.results[item.id] = {
          ...previous,
          status: 'failed',
          stage: 'asr',
          error: result?.error || 'missing ASR result',
          failedAt: nowIso(),
        };
        progress.failureEvents.push({
          id: item.id,
          title: item.title,
          url: item.url,
          stage: 'asr',
          error: result?.error || 'missing ASR result',
          time: nowIso(),
        });
        continue;
      }
      const quality = qualityOf(result.transcript);
      progress.results[item.id] = {
        ...previous,
        status: 'success',
        title: item.title,
        url: item.url,
        transcript: result.transcript,
        transcriptLength: result.transcript.length,
        quality: quality.quality,
        qualityReason: quality.reason,
        audioSource: item.audio_source,
        asrDevice: result.device || '',
        elapsedMs: (previous.elapsedMs || 0) + (result.elapsed_ms || 0),
        completedAt: nowIso(),
      };
      console.log(`[ok][asr] ${item.id} chars=${result.transcript.length} quality=${quality.quality}`);
    }
    persistAll(args, inputRows, progress);
  }

  const values = Object.values(progress.results);
  console.log(JSON.stringify({
    total: inputRows.length,
    success: values.filter((item) => item.status === 'success').length,
    failed: values.filter((item) => item.status === 'failed').length,
    output: args.output,
    failures: args.failures,
    progress: args.progress,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
