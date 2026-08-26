import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files']
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(pathToFileURL(path.resolve('scripts/message-rendering-fixture.html')).href);
  await page.waitForFunction(() => window.fixtureReady === true);
  const clickDuration = await page.evaluate(() => {
    const startedAt = performance.now();
    document.querySelector('.message-toggle').click();
    return performance.now() - startedAt;
  });
  assert.ok(clickDuration < 50, `long message click blocked for ${clickDuration.toFixed(1)}ms`);
  await page.waitForFunction(() => document.querySelector('.message-text')?.dataset.loaded === '1', null, { timeout: 5000 });
  assert.equal(await page.locator('.code-block-wrap').count(), 48);
  console.log(`message rendering checks passed; click ${clickDuration.toFixed(1)}ms`);
} finally {
  await browser.close();
}
