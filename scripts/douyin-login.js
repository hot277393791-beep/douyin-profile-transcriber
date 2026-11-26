const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const DEFAULT_STORAGE = path.join(ROOT, 'output', 'douyin-storage-state.json');
const DEFAULT_URL = 'https://www.douyin.com/';

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    storageState: DEFAULT_STORAGE,
    waitMs: 180000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url') args.url = next, i += 1;
    else if (arg === '--storage-state') args.storageState = path.resolve(next), i += 1;
    else if (arg === '--wait-ms') args.waitMs = Number(next), i += 1;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/douyin-login.js [options]

Options:
  --url <url>             Open URL, default https://www.douyin.com/
  --storage-state <path>  Save login storage JSON, default output/douyin-storage-state.json
  --wait-ms <n>           Non-interactive wait before saving, default 180000
`);
      process.exit(0);
    }
  }

  return args;
}

async function launchBrowser() {
  const launchOptions = {
    headless: false,
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

function waitForEnter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('抖音登录完成后按 Enter 保存登录态...', () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(args.storageState), { recursive: true });

  const browser = await launchBrowser();
  const context = await browser.newContext({
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  console.log(`已打开抖音页面: ${args.url}`);
  console.log('请在浏览器里扫码/验证码完成登录。脚本只保存登录后的 cookie/session，不保存账号密码。');

  if (process.stdin.isTTY) {
    await waitForEnter();
  } else {
    console.log(`当前不是交互终端，将等待 ${Math.round(args.waitMs / 1000)} 秒后保存登录态。`);
    await page.waitForTimeout(args.waitMs);
  }

  await context.storageState({ path: args.storageState });
  await browser.close();
  console.log(`抖音登录态已保存: ${args.storageState}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
