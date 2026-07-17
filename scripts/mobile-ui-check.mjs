import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:7072';
const CHROME_PATH = process.env.CHROME_PATH || '/bin/google-chrome';
const PASSWORD_FILE = process.env.PASSWORD_FILE || 'data/admin-password.txt';
const OUT_DIR = path.resolve('runtime/ui-check');
const viewports = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-430', width: 430, height: 932 }
];

async function api(page, pathName, options = {}) {
  return page.evaluate(async ({ pathName, options }) => {
    const res = await fetch(pathName, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }, { pathName, options });
}

async function loginSmoke(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  const loginVisible = await page.locator('#loginView:not([hidden])').count();
  if (loginVisible) {
    const password = (await readFile(PASSWORD_FILE, 'utf8')).trim();
    await page.evaluate(async (password) => {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, client: 'mobile-ui-check' })
      });
      if (!response.ok) throw new Error(`test login failed: HTTP ${response.status}`);
      await window.cmcAfterLogin?.();
    }, password);
  }
  await page.waitForSelector('#appView:not([hidden])', { timeout: 10000 });
  await page.waitForSelector('#messagePane', { timeout: 5000 });
}

async function webSessionIds(page) {
  const data = await api(page, '/api/sessions');
  return (data.sessions || [])
    .filter((session) => session.source !== 'codex')
    .map((session) => session.id)
    .sort();
}

async function waitForActiveSession(page, sessionId) {
  await page.waitForFunction((sessionId) => {
    return localStorage.getItem('cmc.activeId') === sessionId
      && document.querySelector('#promptInput')?.disabled === false
      && document.querySelector('#activeTitle')?.textContent !== 'Codex Console';
  }, sessionId, { timeout: 10000 });
}

async function setFixture(page) {
  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <link rel="stylesheet" href="${APP_URL}/styles.css?v=123">
      </head>
      <body>
        <main class="workspace">
          <header class="topbar">
            <button class="icon-button" type="button">☰</button>
            <div class="top-title">
              <div class="top-title-row">
                <strong>移动端检查</strong>
                <div class="top-more">
                  <button class="top-more-button" type="button" aria-label="更多会话操作" aria-expanded="true">▾</button>
                  <div class="top-more-menu" role="menu">
                    <button class="top-menu-item" type="button">运行时信息</button>
                  </div>
                </div>
                <div class="top-more top-filter">
                  <button class="top-more-button top-filter-button" type="button" aria-label="视图筛选" aria-expanded="false"></button>
                  <div class="top-more-menu top-filter-menu" role="menu" hidden>
                    <button class="top-menu-item active" type="button" role="menuitemcheckbox" aria-checked="true">已筛选收藏</button>
                    <button class="top-menu-item active" type="button" role="menuitemcheckbox" aria-checked="true">结论视图开启</button>
                    <button class="top-menu-item" type="button">折叠对话</button>
                    <button class="top-menu-item" type="button">展开对话</button>
                  </div>
                </div>
              </div>
              <span id="activeMeta">/root/Projects</span>
              <div class="top-meta-tools" aria-label="会话快捷入口">
                <nav class="site-mount-strip" aria-label="子站点">
                  <button class="site-mount-toggle" type="button" aria-expanded="true" aria-label="站点 2"></button>
                  <div class="site-mount-popover" role="menu">
                    <button class="site-mount-register" type="button" role="menuitem">新增</button>
                    <a class="site-mount-link" href="#" role="menuitem">预览服务</a>
                  </div>
                </nav>
                <button class="top-meta-tool top-share-button" type="button" aria-label="生成分享截图" aria-pressed="true"></button>
              </div>
            </div>
            <div class="top-actions">
              <span class="connection-badge" data-icon="online" title="在线"></span>
              <button class="top-stop-button" type="button" aria-label="停止当前任务"><span aria-hidden="true"></span></button>
            </div>
          </header>
          <section class="message-pane">
            <article class="message user">
              <div class="message-head">
                <span>USER</span><span>6/7 22:30</span><span class="message-delivery queued">已排队</span>
                <div class="message-menu"><button class="message-menu-button" type="button">⋯</button></div>
                <button class="message-toggle" type="button">▾</button>
              </div>
              <div class="message-text"><p>描述这张客户截图。</p></div>
              <div class="message-images"><button type="button"><img alt="sample" src="${sampleImage()}"></button></div>
            </article>
            <article class="message assistant">
              <div class="message-head"><span>ASSISTANT</span><span>6/7 22:31</span><div class="message-menu open"><button class="message-menu-button" type="button">⋯</button><div class="message-menu-popover"><button>复制</button></div></div></div>
              <div class="message-summary">输出 · Markdown 示例</div>
              <div class="message-text"><h3>结论</h3><p><strong>建议</strong>优先处理布局。</p><div class="message-table-wrap"><table><thead><tr><th>方案</th><th>建议</th></tr></thead><tbody><tr><td>Playwright</td><td>立刻加</td></tr></tbody></table></div></div>
            </article>
            <article class="message tool collapsed">
              <div class="message-head">
                <span>TOOL</span><span>6/7 22:31</span>
                <div class="message-menu open"><button class="message-menu-button" type="button">⋯</button><div class="message-menu-popover"><button>收藏</button><button>复制</button></div></div>
                <button class="message-toggle" type="button">▸</button>
              </div>
              <div class="message-summary">工具组 3 · $ npm test</div>
              <div class="message-text"><div class="code-block-wrap"><pre><code>$ npm test\\n[completed]</code></pre><button class="code-copy-button" type="button" aria-label="复制代码"></button></div></div>
            </article>
            <div class="queue-panel">
              <div class="queue-head"><strong>待执行 2 条</strong><div class="queue-head-actions"><span>已选 2 条，至少 2 条可合并</span><button class="queue-merge-button" type="button">合并选中</button></div></div>
              <div class="queue-item"><label class="queue-select"><input type="checkbox" aria-label="选择这条排队输入用于合并" checked></label><span>分析客户截图 · 图片 1 · 文件 1</span><div class="queue-images"><button class="queue-image-button"><img alt="queued" src="${sampleImage()}"></button></div><div class="queue-files"><a class="queue-file-link" href="#">📎</a></div><button class="queue-action-button">↑</button><button class="queue-action-button">✎</button><button class="queue-cancel-button">×</button></div>
              <div class="queue-item"><label class="queue-select"><input type="checkbox" aria-label="选择这条排队输入用于合并" checked></label><span>补充客户背景信息</span><div class="queue-images"></div><div class="queue-files"></div><button class="queue-action-button">↑</button><button class="queue-action-button">✎</button><button class="queue-cancel-button">×</button></div>
            </div>
          </section>
          <form class="prompt-bar">
            <div class="prompt-tools">
              <button class="command-button" type="button">命令</button>
              <div class="attachment-tool"><button class="command-button" type="button">附件</button><div class="attachment-menu"><button type="button">图片</button><button type="button">文件</button></div></div>
              <label class="bottom-follow-toggle" title="自动跟随底部">
                <input type="checkbox" checked>
                <span>跟随</span>
              </label>
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

async function checkSessionSearchLayout(page, viewportName) {
  await page.click('#openDrawer');
  await page.waitForSelector('#sessionDrawer.open', { timeout: 5000 });
  await waitForDrawerSettled(page, true);
  await page.click('#drawerSessionsButton');
  await page.waitForSelector('#drawerSessionsPanel.active', { timeout: 5000 });

  const controls = await assertVisibleBox(page, '.drawer-session-controls', 'session view controls');
  const search = await assertVisibleBox(page, '.session-search-row', 'session search row');
  const list = await assertVisibleBox(page, '#sessionList', 'session list');
  if (search.y < controls.y + controls.height - 1) {
    throw new Error(`session search overlaps controls: ${JSON.stringify({ controls, search })}`);
  }
  if (list.y < search.y + search.height - 1) {
    throw new Error(`session list overlaps search row: ${JSON.stringify({ search, list })}`);
  }

  await page.fill('#sessionSearchInput', '__cmc_no_match_9f8e__');
  await page.waitForFunction(() => document.querySelector('#sessionList .session-empty')?.textContent.includes('没有匹配'), null, { timeout: 5000 });
  const firstEntry = await page.locator('#sessionList .session-entry, #sessionList .session-empty').first().boundingBox();
  if (!firstEntry || firstEntry.y < search.y + search.height - 1) {
    throw new Error(`session search result overlaps search row: ${JSON.stringify({ search, firstEntry })}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${viewportName}-session-search.png`), fullPage: false });
  await page.fill('#sessionSearchInput', '');
  await page.click('#closeDrawer');
  await page.waitForSelector('#sessionDrawer:not(.open)', { timeout: 5000 });
  await waitForDrawerSettled(page, false);
}

async function checkMessageCopyModule(page) {
  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <body>
        <section id="messagePane">
          <article class="message">
            <div class="message-text"><p>第一段 <strong>重点</strong></p><ul><li>条目一</li><li>条目二</li></ul><pre>const answer = 42;</pre><table><thead><tr><th>项目</th><th>状态</th></tr></thead><tbody><tr><td>复制</td><td>通过</td></tr></tbody></table></div>
          </article>
          <article class="message"><div class="message-text"><p>不应被复制</p></div></article>
        </section>
      </body>
    </html>`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async (appUrl) => {
    const module = await import(`${appUrl}/message-copy.js?v=1&t=${Date.now()}`);
    const pane = document.querySelector('#messagePane');
    const root = pane.querySelector('.message-text');
    module.installMessageCopyGuard({ messagePane: pane });
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
    document.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      text: clipboardData.getData('text/plain'),
      html: clipboardData.getData('text/html')
    };
  }, APP_URL);
  if (!result.prevented) throw new Error('message copy guard did not handle the selection');
  if (!result.text.includes('**重点**')
    || !result.text.includes('- 条目一')
    || !result.text.includes('```\nconst answer = 42;\n```')
    || !result.text.includes('| 项目 | 状态 |')
    || result.text.includes('不应被复制')) {
    throw new Error(`message copy markdown is invalid: ${JSON.stringify(result)}`);
  }
  if (!result.html.includes('<strong>重点</strong>') || result.html.includes('不应被复制')) {
    throw new Error(`message copy html is invalid: ${JSON.stringify(result)}`);
  }
}

async function checkRunSettingsPanel(page, viewportName) {
  await page.click('#openDrawer');
  await page.waitForSelector('#sessionDrawer.open', { timeout: 5000 });
  await waitForDrawerSettled(page, true);
  await page.click('#drawerSettingsButton');
  await page.waitForSelector('#drawerSettingsPanel.active', { timeout: 5000 });
  await page.click('[data-settings-tab="run"]');
  await page.waitForSelector('[data-settings-page="run"].active', { timeout: 5000 });
  await assertVisibleBox(page, '.codex-config-card', 'codex config card');
  await assertVisibleBox(page, '#runSettingsState', 'run settings summary');
  await assertVisibleBox(page, '#defaultModelSelect', 'default model select');
  await page.selectOption('#defaultModelSelect', 'custom');
  await assertVisibleBox(page, '#defaultModelCustomInput', 'default custom model input');
  await page.selectOption('#defaultModelSelect', '');
  await page.locator('#defaultSandboxSelect').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await assertVisibleBox(page, '#defaultSandboxSelect', 'default sandbox select');
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  if (dims.scrollWidth > dims.clientWidth + 1) {
    throw new Error(`run settings overflow: ${JSON.stringify(dims)}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${viewportName}-run-settings.png`), fullPage: false });
  await page.click('#closeDrawer');
  await page.waitForSelector('#sessionDrawer:not(.open)', { timeout: 5000 });
  await waitForDrawerSettled(page, false);
}

async function checkLongTitleMenu(page, viewportName) {
  await page.evaluate(() => {
    document.querySelector('#activeTitle').textContent = '这是一个非常非常长的会话标题用于验证手机端标题省略和箭头固定可见';
    document.querySelector('#activeMeta').textContent = '/root/Projects/very-long-directory-name/with/mobile/title/layout/check';
    const site = document.querySelector('#siteMountStrip');
    if (site) {
      site.hidden = false;
      if (!site.querySelector('.site-mount-toggle')) {
        site.innerHTML = '<button class="site-mount-toggle" type="button" aria-expanded="false" aria-label="站点"></button>';
      }
    }
  });
  const titleRow = await assertVisibleBox(page, '.top-title-row', 'long title row');
  const title = await assertVisibleBox(page, '#activeTitle', 'long title text');
  const arrow = await assertVisibleBox(page, '#topMoreButton', 'title menu arrow');
  const filter = await assertVisibleBox(page, '#topFilterButton', 'view filter button');
  const site = await assertVisibleBox(page, '#siteMountStrip', 'site shortcut');
  const share = await assertVisibleBox(page, '#shareCaptureButton', 'share shortcut');
  const actions = await assertVisibleBox(page, '.top-actions', 'top actions');
  if (arrow.x <= title.x || arrow.x + arrow.width > actions.x - 2) {
    throw new Error(`title menu arrow is not stable: ${JSON.stringify({ title, arrow, actions })}`);
  }
  if (filter.x <= title.x || filter.x + filter.width > actions.x - 2 || Math.abs(filter.x - arrow.x) < 20) {
    throw new Error(`view filter button is not stable: ${JSON.stringify({ arrow, filter, actions })}`);
  }
  if (titleRow.height > 28) {
    throw new Error(`long title row wrapped: ${JSON.stringify(titleRow)}`);
  }
  if (site.y <= titleRow.y || share.y <= titleRow.y || Math.abs(site.y - share.y) > 2) {
    throw new Error(`shortcut buttons are not in the meta row: ${JSON.stringify({ titleRow, site, share })}`);
  }
  await page.click('#topMoreButton');
  await page.waitForSelector('#topMoreMenu:not([hidden])', { timeout: 5000 });
  const menu = await assertVisibleBox(page, '#topMoreMenu', 'title menu');
  if (menu.x < 0 || menu.x + menu.width > page.viewportSize().width) {
    throw new Error(`title menu overflows viewport: ${JSON.stringify(menu)}`);
  }
  await page.click('#topFilterButton');
  await page.waitForSelector('#topFilterMenu:not([hidden])', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#topMoreMenu')?.hidden, null, { timeout: 5000 });
  const filterMenu = await assertVisibleBox(page, '#topFilterMenu', 'view filter menu');
  if (filterMenu.x < 0 || filterMenu.x + filterMenu.width > page.viewportSize().width) {
    throw new Error(`view filter menu overflows viewport: ${JSON.stringify(filterMenu)}`);
  }
  const labelLefts = await page.$$eval('#topFilterMenu .top-menu-item', (items) => items.map((item) => {
    const rect = item.getBoundingClientRect();
    const style = getComputedStyle(item);
    const columns = style.gridTemplateColumns.split(' ');
    return Math.round(rect.left + parseFloat(style.paddingLeft || '0') + parseFloat(columns[0] || '0') + parseFloat(style.columnGap || style.gap || '0'));
  }));
  if (Math.max(...labelLefts) - Math.min(...labelLefts) > 1) {
    throw new Error(`view filter labels are not aligned: ${labelLefts.join(',')}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${viewportName}-long-title-menu.png`), fullPage: false });
  await page.click('.workspace');
  await page.waitForFunction(() => document.querySelector('#topMoreMenu')?.hidden && document.querySelector('#topFilterMenu')?.hidden, null, { timeout: 5000 });
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
      try {
        await loginSmoke(page);
        const sessionsBefore = await webSessionIds(page);
        await checkDrawerSwitchStability(page, viewport.name);
        await checkSessionSearchLayout(page, viewport.name);
        await checkRunSettingsPanel(page, viewport.name);
        await checkLongTitleMenu(page, viewport.name);
        await checkSkillDialog(page);
        await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-app.png`), fullPage: true });

        await checkMessageCopyModule(page);
        await setFixture(page);
        await assertVisibleBox(page, '.prompt-bar', 'prompt bar');
        await assertVisibleBox(page, '.bottom-follow-toggle', 'follow toggle');
        await assertVisibleBox(page, '.queue-select input', 'queue merge checkbox');
        await assertVisibleBox(page, '.queue-merge-button', 'queue merge button');
        await assertVisibleBox(page, '.message-menu-popover', 'message menu');
        await assertVisibleBox(page, '.image-viewer img', 'image viewer');
        await assertVisibleBox(page, '.image-viewer-close', 'image close button');
        await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-fixture.png`), fullPage: true });
        await page.evaluate(() => {
          document.querySelector('.image-viewer')?.setAttribute('hidden', '');
          document.querySelector('.top-more-menu')?.setAttribute('hidden', '');
          document.querySelector('.attachment-menu')?.setAttribute('hidden', '');
          document.body.insertAdjacentHTML('beforeend', `
            <dialog class="session-dialog queue-edit-dialog" open>
              <form>
                <div class="dialog-head"><h2>编辑排队输入</h2><button class="icon-button" type="button">×</button></div>
                <label>内容<textarea rows="8">请继续分析客户截图，并把结论整理成三条。</textarea></label>
                <div class="queue-edit-meta">22 字 · 图片 1 · 文件 1</div>
                <div class="queue-edit-actions"><button class="ghost-button inline" type="button">取消</button><button type="submit">保存</button></div>
              </form>
            </dialog>
          `);
        });
        await assertVisibleBox(page, '.queue-edit-dialog', 'queue edit dialog');
        await assertVisibleBox(page, '.queue-edit-dialog textarea', 'queue edit textarea');
        await page.screenshot({ path: path.join(OUT_DIR, `${viewport.name}-queue-edit.png`), fullPage: false });
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#appView:not([hidden])', { timeout: 10000 });
        const sessionsAfter = await webSessionIds(page);
        if (JSON.stringify(sessionsAfter) !== JSON.stringify(sessionsBefore)) {
          throw new Error(`mobile UI check changed web sessions: ${JSON.stringify({ sessionsBefore, sessionsAfter })}`);
        }
      } finally {
        await api(page, '/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
        await context.close();
      }
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
