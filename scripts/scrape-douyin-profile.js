const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    url: '',
    slug: 'douyin-profile',
    maxScrolls: 30,
    waitMs: 2500,
    storageState: '',
    dateFrom: '',
    dateTo: '',
    includePinned: false,
    headful: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url') args.url = next, i += 1;
    else if (arg === '--slug') args.slug = next, i += 1;
    else if (arg === '--max-scrolls') args.maxScrolls = Number(next), i += 1;
    else if (arg === '--wait-ms') args.waitMs = Number(next), i += 1;
    else if (arg === '--storage-state') args.storageState = path.resolve(next), i += 1;
    else if (arg === '--date-from') args.dateFrom = next, i += 1;
    else if (arg === '--date-to') args.dateTo = next, i += 1;
    else if (arg === '--include-pinned') args.includePinned = true;
    else if (arg === '--headful') args.headful = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/scrape-douyin-profile.js --url <douyin profile or short URL> --slug <output-prefix>

Options:
  --url <url>           Douyin profile/short URL
  --slug <name>         Output file prefix, default douyin-profile
  --max-scrolls <n>     Max page scrolls, default 30
  --wait-ms <n>         Wait after each scroll, default 2500
  --storage-state <p>   Reuse logged-in Douyin storage state JSON
  --date-from <date>    Keep videos on/after YYYY-MM-DD
  --date-to <date>      Keep videos on/before YYYY-MM-DD
  --include-pinned      Keep pinned videos even if outside date range
  --headful             Show browser
`);
      process.exit(0);
    }
  }

  if (!args.url) {
    console.error('Missing --url');
    process.exit(1);
  }

  args.slug = args.slug.replace(/[^\w.-]+/g, '-');
  return args;
}

async function launchBrowser(headful) {
  const launchOptions = {
    headless: !headful,
    viewport: { width: 1365, height: 900 },
  };
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ ...launchOptions, channel });
    } catch (error) {
      // Try the next browser channel.
    }
  }
  return chromium.launch(launchOptions);
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
  fs.writeFileSync(file, `\uFEFF${csv}`, 'utf8');
}

function chinaDateFromUnix(createTime) {
  if (!createTime) return '';
  return new Date((Number(createTime) + 8 * 60 * 60) * 1000).toISOString().slice(0, 10);
}

function isDateInRange(date, dateFrom, dateTo) {
  if (!date) return false;
  if (dateFrom && date < dateFrom) return false;
  if (dateTo && date > dateTo) return false;
  return true;
}

function mapAweme(aweme, sourceFile) {
  const stats = aweme.statistics || {};
  const createTime = aweme.create_time || 0;
  const durationMs = aweme.duration || aweme.video?.duration || 0;
  return {
    aweme_id: aweme.aweme_id || '',
    title: aweme.desc || '',
    create_time: createTime,
    create_date: chinaDateFromUnix(createTime),
    like_count: stats.digg_count ?? 0,
    comment_count: stats.comment_count ?? 0,
    share_count: stats.share_count ?? 0,
    collect_count: stats.collect_count ?? 0,
    recommend_count: stats.recommend_count ?? 0,
    play_count: stats.play_count ?? 0,
    duration_sec: durationMs ? Math.round(durationMs / 1000) : '',
    is_top: Boolean(aweme.is_top),
    source_file: sourceFile || '',
    video_url: aweme.aweme_id ? `https://www.douyin.com/video/${aweme.aweme_id}` : '',
  };
}

function oldestNonPinnedDateFromPostPages(postPages, slug) {
  const dates = [];
  postPages.forEach((item, index) => {
    const sourceFile = path.join('output', `${slug}-post-page-${index + 1}.json`);
    for (const aweme of item.json?.aweme_list || []) {
      const row = mapAweme(aweme, sourceFile);
      if (!row.is_top && row.create_date) dates.push(row.create_date);
    }
  });
  return dates.sort()[0] || '';
}

async function fetchSignedPostPage(page, firstPostUrl, cursor) {
  return page.evaluate(async ({ firstPostUrl, cursor }) => {
    const u = new URL(firstPostUrl);
    u.searchParams.set('max_cursor', String(cursor));
    u.searchParams.set('count', u.searchParams.get('count') || '18');
    u.searchParams.delete('a_bogus');
    u.searchParams.delete('X-Bogus');
    u.searchParams.delete('x-secsdk-web-signature');
    u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));

    const unsigned = u.pathname + '?' + u.searchParams.toString();
    const signOut = window.byted_acrawler?.frontierSign?.({ url: unsigned });
    if (signOut && typeof signOut === 'object') {
      for (const [key, value] of Object.entries(signOut)) {
        u.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(u.href, { credentials: 'include' });
    const text = await response.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = { status_code: -1, parse_error: error.message, body_sample: text.slice(0, 500) };
    }
    return { url: u.href, json };
  }, { firstPostUrl, cursor });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.join(ROOT, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await launchBrowser(args.headful);
  const contextOptions = {
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  };
  if (args.storageState) {
    if (!fs.existsSync(args.storageState)) {
      throw new Error(`登录态文件不存在: ${args.storageState}`);
    }
    contextOptions.storageState = args.storageState;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const postPages = [];
  let profileData = null;

  page.on('response', async (response) => {
    const url = response.url();
    if (!/douyin\.com\/aweme\/v1\/web\//.test(url)) return;

    const isPost = url.includes('/aweme/post/');
    const isProfile = url.includes('/user/profile/other/');
    if (!isPost && !isProfile) return;

    try {
      const json = await response.json();
      if (isPost) {
        postPages.push({ url, json });
      } else if (isProfile) {
        profileData = { url, json };
      }
    } catch (error) {
      // Some responses may be compressed or non-JSON; ignore them.
    }
  });

  console.log(JSON.stringify({ stage: 'opening_profile' }));
  const response = await page.goto(args.url, { waitUntil: 'commit', timeout: 50000 });
  const loadedUrl = new URL(page.url());
  if (!['www.douyin.com', 'douyin.com'].includes(loadedUrl.hostname) || !loadedUrl.pathname.startsWith('/user/')) {
    await browser.close();
    throw new Error('The link did not open a Douyin creator homepage. Try the creator homepage URL.');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 22000 }).catch(() => {});
  await page.waitForFunction(() => /作品|登录|验证/.test(document.body?.innerText || ''), { timeout: 35000 }).catch(() => {});
  if (!postPages.length) {
    await page.waitForResponse(r => r.url().includes('/aweme/post/') && r.ok(), { timeout: 20000 }).catch(() => {});
  }
  console.log(JSON.stringify({ stage: 'profile_loaded', url: page.url().split('?')[0], title: await page.title(),
    status: response?.status(), responses: postPages.length, bodyLength: await page.locator('body').innerText({ timeout: 3000 }).then(t => t.length).catch(() => 0) }));
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(args.waitMs);

  let lastHeight = 0;
  let lastPostCount = 0;
  const visibleWorks = new Map();
  const worksLocator = page.locator('li a[href*="/video/"], li a[href*="/note/"], li a[href*="/article/"]');
  async function rememberVisibleWorks() {
    const works = await worksLocator.evaluateAll(anchors => anchors.map(anchor => {
      const link = new URL(anchor.href);
      if (link.hostname !== 'www.douyin.com' || link.searchParams.get('source') === 'Baiduspider') return null;
      return { url: link.origin + link.pathname, title: anchor.getAttribute('title') || anchor.innerText.trim() || anchor.querySelector('img')?.alt || '' };
    }).filter(Boolean));
    for (const work of works) visibleWorks.set(work.url, work);
  }
  let stableScrolls = 0;
  for (let i = 0; i < args.maxScrolls; i += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await rememberVisibleWorks();
    await worksLocator.last().scrollIntoViewIfNeeded({ timeout: 1400 }).catch(() => {});
    await page.mouse.move(1000, 650);
    await page.mouse.wheel(0, 1800);
    await page.evaluate(() => {
      const profile = document.querySelector('.page-reflow-user-new');
      const scrollable = document.querySelector('.route-scroll-container') || (profile && [profile, ...profile.querySelectorAll('div')].find((node) => {
        return node.clientHeight > 250 && node.scrollHeight > node.clientHeight + 100 &&
          ['auto', 'scroll'].includes(getComputedStyle(node).overflowY);
      }));
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
        scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      else window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForTimeout(args.waitMs);

    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    if ((currentHeight === lastHeight || currentHeight === height) && postPages.length === lastPostCount) {
      stableScrolls += 1;
    } else {
      stableScrolls = 0;
    }
    lastHeight = currentHeight; lastPostCount = postPages.length;
    if (i % 4 === 0) console.log(JSON.stringify({ stage: 'scrolling', scrolls: i + 1, responses: postPages.length, visibleWorks: visibleWorks.size }));

    const oldestNonPinnedDate = oldestNonPinnedDateFromPostPages(postPages, args.slug);
    const reachedDateFloor = Boolean(args.dateFrom && oldestNonPinnedDate && oldestNonPinnedDate < args.dateFrom);
    const hasMore = postPages.at(-1)?.json?.has_more === 1;
    if (reachedDateFloor) break;
    if (stableScrolls >= (hasMore || !postPages.length ? 12 : 5)) break;
  }

  const firstPostUrl = postPages.find((item) => item.json?.aweme_list?.length)?.url || '';
  const seenCursors = new Set(postPages.map((item) => item.json?.max_cursor).filter(Boolean));
  let nextCursor = postPages
    .map((item) => item.json)
    .filter((json) => json?.aweme_list?.length && json?.has_more === 1 && json?.max_cursor)
    .at(-1)?.max_cursor;

  while (firstPostUrl && nextCursor && postPages.length < args.maxScrolls) {
    const oldestNonPinnedDate = oldestNonPinnedDateFromPostPages(postPages, args.slug);
    if (args.dateFrom && oldestNonPinnedDate && oldestNonPinnedDate < args.dateFrom) break;

    const result = await fetchSignedPostPage(page, firstPostUrl, nextCursor);
    const json = result.json || {};
    if (!json.aweme_list?.length) break;
    postPages.push({ url: result.url, json });

    if (!json.has_more || !json.max_cursor || seenCursors.has(json.max_cursor)) break;
    seenCursors.add(json.max_cursor);
    nextCursor = json.max_cursor;
    await page.waitForTimeout(Math.max(500, Math.floor(args.waitMs / 2)));
  }

  await page.waitForTimeout(args.waitMs);

  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

  await rememberVisibleWorks();
  fs.writeFileSync(path.join(outputDir, `${args.slug}-visible-works.json`), JSON.stringify([...visibleWorks.values()], null, 2), 'utf8');
  console.log(JSON.stringify({ stage: 'saving', responses: postPages.length, recordedWorks: visibleWorks.size,
    loginText: /登录后查看|登录后可查看|扫码登录/.test(bodyText),
    challengeText: /安全验证|验证码|验证后/.test(bodyText.slice(0, 450)),
    visibleVideoLinks: await page.locator('a[href*="/video/"]').count(),
    noMoreText: /没有更多|到底了/.test(bodyText) }));
  const savedPostFiles = [];
  postPages.forEach((item, index) => {
    const file = path.join(outputDir, `${args.slug}-post-page-${index + 1}.json`);
    fs.writeFileSync(file, JSON.stringify(item.json, null, 2), 'utf8');
    savedPostFiles.push(file);
  });

  if (profileData) {
    fs.writeFileSync(
      path.join(outputDir, `${args.slug}-profile.json`),
      JSON.stringify(profileData.json, null, 2),
      'utf8'
    );
  }

  const byId = new Map();
  postPages.forEach((item, index) => {
    const sourceFile = path.join('output', `${args.slug}-post-page-${index + 1}.json`);
    for (const aweme of item.json?.aweme_list || []) {
      if (aweme?.aweme_id && !byId.has(aweme.aweme_id)) {
        byId.set(aweme.aweme_id, mapAweme(aweme, sourceFile));
      }
    }
  });

  const rawRows = [...byId.values()].sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
  const hasDateFilter = Boolean(args.dateFrom || args.dateTo);
  const rows = rawRows
    .map((row) => {
      const inRange = !hasDateFilter || isDateInRange(row.create_date, args.dateFrom, args.dateTo);
      const pinnedExtra = hasDateFilter && args.includePinned && row.is_top && !inRange;
      return {
        ...row,
        range_source: inRange ? '日期范围内' : pinnedExtra ? '置顶额外保留' : '区间外',
      };
    })
    .filter((row) => row.range_source !== '区间外')
    .sort((a, b) => {
      if (a.range_source !== b.range_source) {
        if (a.range_source === '日期范围内') return -1;
        if (b.range_source === '日期范围内') return 1;
      }
      return (b.create_time || 0) - (a.create_time || 0);
    });
  const allJson = path.join(outputDir, `${args.slug}-all-videos.json`);
  const allCsv = path.join(outputDir, `${args.slug}-all-videos.csv`);
  fs.writeFileSync(allJson, JSON.stringify(rows, null, 2), 'utf8');
  writeCsv(allCsv, Object.keys(rows[0] || {
    aweme_id: '',
    title: '',
    create_time: '',
    create_date: '',
    like_count: '',
    comment_count: '',
    share_count: '',
    collect_count: '',
    recommend_count: '',
    play_count: '',
    duration_sec: '',
    is_top: '',
    source_file: '',
    video_url: '',
  }), rows);

  const simpleRows = rows.map((row) => ({
    发布日期: row.create_date,
    范围来源: row.range_source,
    标题: row.title,
    点赞: row.like_count,
    评论: row.comment_count,
    转发: row.share_count,
    视频链接: row.video_url,
  }));
  const simpleCsv = path.join(outputDir, `${args.slug}-simple.csv`);
  const simpleJson = path.join(outputDir, `${args.slug}-simple.json`);
  writeCsv(simpleCsv, ['发布日期', '范围来源', '标题', '点赞', '评论', '转发', '视频链接'], simpleRows);
  fs.writeFileSync(simpleJson, JSON.stringify(simpleRows, null, 2), 'utf8');

  const summary = {
    slug: args.slug,
    finalUrl,
    pageTitle: title,
    profileNickname: profileData?.json?.user?.nickname || '',
    profileAwemeCount: profileData?.json?.user?.aweme_count ?? '',
    bodyAwemeCountText: bodyText.match(/作品\s*\n?(\d+)/)?.[1] || '',
    needsLogin: /登录后查看更多作品|登录后可查看更多作品/.test(bodyText),
    postResponses: postPages.length,
    rawUniqueVideos: rawRows.length,
    totalUniqueVideos: rows.length,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    includePinned: args.includePinned,
    newest: rows[0]?.create_date || '',
    oldest: rows.at(-1)?.create_date || '',
    outOfRangeFiltered: rawRows.length - rows.length,
    outputs: {
      allJson,
      allCsv,
      simpleJson,
      simpleCsv,
    },
  };
  fs.writeFileSync(path.join(outputDir, `${args.slug}-scrape-summary.json`), JSON.stringify(summary, null, 2), 'utf8');

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
