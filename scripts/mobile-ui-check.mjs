import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:7072';
const CHROME_PATH = process.env.CHROME_PATH || '/bin/google-chrome';
const OUT_DIR = path.resolve('runtime/ui-check');
const viewports = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-430', width: 430, height: 932 }
];

async function loginSmoke(page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  const loginVisible = await page.locator('#loginView:not([hidden])').count();
  if (loginVisible) {
    const password = (await readFile('data/admin-password.txt', 'utf8')).trim();
    await page.fill('#password', password);
    await page.click('#loginButton');
  }
  await page.waitForSelector('#appView:not([hidden])', { timeout: 10000 });
  await page.waitForSelector('#messagePane', { timeout: 5000 });
}

async function setFixture(page) {
  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <link rel="stylesheet" href="${APP_URL}/styles.css?v=97">
      </head>
      <body>
        <main class="workspace">
          <header class="topbar">
            <button class="icon-button" type="button">☰</button>
            <div class="top-title"><strong>移动端检查</strong><span>/root/Projects</span></div>
            <div class="top-actions">
              <span class="connection-badge" data-icon="online" title="在线"></span>
              <button class="top-stop-button" type="button" aria-label="停止当前任务"><span aria-hidden="true"></span></button>
              <div class="top-more">
                <button class="top-more-button" type="button" aria-label="更多会话操作" aria-expanded="true">⋯</button>
                <div class="top-more-menu" role="menu">
                  <button class="top-menu-item active" type="button">已筛选收藏</button>
                  <button class="top-menu-item" type="button">运行时信息</button>
                </div>
              </div>
            </div>
          </header>
          <section class="message-pane">
            <article class="message user">
              <div class="message-head">
                <span>USER</span><span>6/7 22:30</span><span class="message-delivery queued">已排队</span>
                <div class="message-menu"><button class="message-menu-button" type="button">⋯</button></div>
                <button class="message-toggle" type="button">▾</button>
              </div>
              <pre class="message-text">描述这张客户截图。</pre>
              <div class="message-images"><button type="button"><img alt="sample" src="${sampleImage()}"></button></div>
            </article>
            <article class="message tool collapsed">
              <div class="message-head">
                <span>TOOL</span><span>6/7 22:31</span>
                <div class="message-menu open"><button class="message-menu-button" type="button">⋯</button><div class="message-menu-popover"><button>收藏</button><button>复制</button></div></div>
                <button class="message-toggle" type="button">▸</button>
              </div>
              <div class="message-summary">工具组 3 · $ npm test</div>
              <pre class="message-text">$ npm test\\n[completed]</pre>
            </article>
            <div class="queue-panel">
              <div class="queue-head"><strong>待执行 1 条</strong><span>等待当前任务结束后执行</span></div>
              <div class="queue-item"><span>分析客户截图 · 图片 1</span><div class="queue-images"><button class="queue-image-button"><img alt="queued" src="${sampleImage()}"></button></div><button class="queue-action-button">↑</button><button class="queue-action-button">✎</button><button class="queue-cancel-button">×</button></div>
            </div>
          </section>
          <form class="prompt-bar">
            <div class="prompt-tools">
              <button class="command-button" type="button">命令</button>
              <button class="command-button" type="button">图片</button>
            </div>
            <div class="image-preview-strip">
              <div class="image-preview-item"><img alt="preview" src="${sampleImage()}"><span>180KB</span><button>×</button></div>
              <div class="image-quick-actions"><button>描述</button><button>问题</button><button>文字</button><button>客户</button></div>
            </div>
            <div class="prompt-row"><textarea rows="1">帮我分析这张图</textarea><button type="button">发送</button></div>
          </form>
        </main>
        <div class="image-viewer">
          <button class="image-viewer-close" type="button">×</button>
          <img alt="viewer" src="${sampleImage()}">
        </div>
      </body>
    </html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.image-viewer img', { timeout: 5000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace')).display === 'grid', null, { timeout: 5000 });
}

function sampleImage() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="320" height="220" fill="#d9eee9"/><rect x="24" y="24" width="272" height="172" rx="10" fill="#f7faf8" stroke="#157a70" stroke-width="4"/><circle cx="92" cy="98" r="34" fill="#66d9c8"/><rect x="146" y="76" width="96" height="20" rx="5" fill="#f3b95f"/><rect x="146" y="112" width="126" height="16" rx="4" fill="#59626d"/></svg>`);
}

async function assertVisibleBox(page, selector, label) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${label} is not visible`);
  const viewport = page.viewportSize();
  if (box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
    throw new Error(`${label} is outside viewport: ${JSON.stringify(box)}`);
  }
  return box;
}

async function checkSkillDialog(page) {
  await page.click('#skillButton');
  await page.waitForSelector('#skillDialog[open]', { timeout: 5000 });
  await assertVisibleBox(page, '#skillDialog', 'skill dialog');
  await page.click('#closeSkillDialog');
  await page.waitForSelector('#skillDialog', { state: 'hidden', timeout: 5000 });
}

function assertStableBox(before, after, label, tolerance = 1) {
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Math.abs(before[key] - after[key]) > tolerance) {
      throw new Error(`${label} shifted on drawer switch: ${key} ${before[key]} -> ${after[key]}`);
    }
  }
}

async function getDrawerHeadBoxes(page) {
  return {
    titleSlot: await assertVisibleBox(page, '.drawer-title-slot', 'drawer title slot'),
    modeRow: await assertVisibleBox(page, '#drawerModeRow', 'drawer mode row'),
    closeButton: await assertVisibleBox(page, '#closeDrawer', 'drawer close button')
  };
}

async function waitForDrawerSettled(page, open) {
  await page.waitForFunction((expectedOpen) => {
    const drawer = document.querySelector('#sessionDrawer');
    if (!drawer) return false;
    const rect = drawer.getBoundingClientRect();
    return expectedOpen ? Math.abs(rect.top) <= 1 : !drawer.classList.contains('open');
  }, open, { timeout: 5000 });
  if (!open) await page.waitForTimeout(250);
}

async function checkDrawerSwitchStability(page, viewportName) {
  await page.click('#openDrawer');
  await page.waitForSelector('#sessionDrawer.open', { timeout: 5000 });
  await waitForDrawerSettled(page, true);
  const baseline = await getDrawerHeadBoxes(page);

  for (const selector of ['#skillManagerButton', '#drawerSettingsButton', '#drawerSessionsButton']) {
    await page.click(selector);
    await page.waitForFunction((activeSelector) => document.querySelector(activeSelector)?.classList.contains('active'), selector, { timeout: 5000 });
    const current = await getDrawerHeadBoxes(page);
    assertStableBox(baseline.titleSlot, current.titleSlot, `drawer title slot after ${selector}`);
    assertStableBox(baseline.modeRow, current.modeRow, `drawer mode row after ${selector}`);
    assertStableBox(baseline.closeButton, current.closeButton, `drawer close button after ${selector}`);
  }

  await page.screenshot({ path: path.join(OUT_DIR, `${viewportName}-drawer.png`), fullPage: false });
  await page.click('#closeDrawer');
  await page.waitForSelector('#sessionDrawer:not(.open)', { timeout: 5000 });
  await waitForDrawerSettled(page, false);
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, isMobile: true, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await loginSmoke(page);
      await checkDrawerSwitchStability(page, viewport.name);
      await checkSkillDialog(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-app.png`), fullPage: true });

      await setFixture(page);
      await assertVisibleBox(page, '.prompt-bar', 'prompt bar');
      await assertVisibleBox(page, '.message-menu-popover', 'message menu');
      await assertVisibleBox(page, '.image-viewer img', 'image viewer');
      await assertVisibleBox(page, '.image-viewer-close', 'image close button');
      await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-fixture.png`), fullPage: true });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`mobile UI checks passed; screenshots in ${OUT_DIR}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
