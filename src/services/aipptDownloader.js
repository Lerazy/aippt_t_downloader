import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';

let sharedBrowser = null;
let launchingBrowser = null;

async function getSharedBrowser(headless, slowMo) {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (launchingBrowser) {
    try { await launchingBrowser; } catch (_) { /* ignore */ }
    if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  }
  launchingBrowser = chromium.launch({
    headless,
    slowMo,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote'
    ]
  }).then((b) => {
    sharedBrowser = b;
    launchingBrowser = null;
    try {
      b.on('disconnected', () => { sharedBrowser = null; });
    } catch (_) {}
    return b;
  }).catch((e) => { launchingBrowser = null; throw e; });
  sharedBrowser = await launchingBrowser;
  return sharedBrowser;
}

export async function downloadAipptTemplate(templateUrl, options = {}) {
  if (!/^https?:\/\//.test(templateUrl)) {
    throw new Error('Invalid template URL');
  }
  const username = process.env.AIPPT_USERNAME;
  const password = process.env.AIPPT_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing AIPPT_USERNAME/AIPPT_PASSWORD');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aippt-'));
  const headlessEnv = process.env.PLAYWRIGHT_HEADLESS;
  const headless = options.headless ?? (headlessEnv ? headlessEnv !== 'false' : true);
  const slowMo = options.slowMo ?? 0;
  let browser = await getSharedBrowser(headless, slowMo);
  // Persist session between runs via storage state
  const dataDir = path.join(process.cwd(), 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  const stateFile = path.join(dataDir, 'aippt_storage.json');
  let context;
  let page;
  async function openContextWithRetry() {
    try {
      context = await browser.newContext({ acceptDownloads: true, storageState: fs.existsSync(stateFile) ? stateFile : undefined });
    } catch (e) {
      // Browser may have been closed/crashed; relaunch and retry once
      browser = await getSharedBrowser(headless, slowMo);
      context = await browser.newContext({ acceptDownloads: true, storageState: fs.existsSync(stateFile) ? stateFile : undefined });
    }
    page = await context.newPage();
  }
  await openContextWithRetry();
  try {
    // Log console messages for debugging
    page.on('console', msg => {
      try { console.log('[page]', msg.type(), msg.text()); } catch (_) {}
    });

    // Go to template page directly
    await page.goto(templateUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    // Ensure page is fully settled (post-DOM ready and quiet network)
    async function waitForPageSettled(extraDelayMs = 250) {
      try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (_) {}
      try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch (_) {}
      try { await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 3000 }); } catch (_) {}
      if (extraDelayMs > 0) { await page.waitForTimeout(extraDelayMs).catch(() => {}); }
    }
    await waitForPageSettled(250);
    // Avoid full-page scroll; we'll scroll specific targets into view when needed
    await page.waitForTimeout(200);

    // 1) Detect login state via the given login/register button text (exact text preferred)
    let loginRegisterBtn = page.locator('button:has-text("登录 ｜ 注册")').first();
    if ((await loginRegisterBtn.count()) === 0) {
      // fallback: any button containing both 登录 and 注册
      loginRegisterBtn = page.locator('button:has-text("登录")').filter({ hasText: '注册' }).first();
    }
    const isLoginRequired = (await loginRegisterBtn.count()) > 0;

    async function clickImmediateDownload() {
      // target download button as specified
      const candidates = [
        'button[data-track-event="dl_template_down_id"]:has-text("立即下载")',
        'button[data-track-event="dl_template_down_id"]',
        'button:has-text("立即下载")',
        'a:has-text("立即下载")',
        'button.bg-gradient-primary-lr',
        'button.ml-3',
      ];
      // prepare listeners for both download and possible popup
      const downloadListener = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
      const popupListener = context.waitForEvent('page', { timeout: 60000 }).catch(() => null);
      // response listener to catch direct file responses
      const responseListener = page.waitForResponse((resp) => {
        try {
          const url = resp.url();
          const headers = resp.headers();
          const disp = headers['content-disposition'] || headers['Content-Disposition'];
          if (disp && /attachment/i.test(disp)) return true;
          if (/\.(ppt|pptx|zip|rar|7z|pdf)(\?.*)?$/i.test(url)) return true;
        } catch (_) {}
        return false;
      }, { timeout: 60000 }).catch(() => null);
      let clicked = false;
      // small grace period to allow lazy components to mount
      await waitForPageSettled(150);
      for (const sel of candidates) {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0) {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
          // ensure inner text contains 立即下载 when applicable
          const txt = await loc.textContent().catch(() => '');
          if (txt && !txt.includes('立即下载') && sel === 'button[data-track-event="dl_template_down_id"]') {
            // continue to next selector
          }
          try {
            await loc.click({ timeout: 15000 });
            clicked = true;
            break;
          } catch (_) {
            // try force click
            try {
              await loc.click({ timeout: 15000, force: true });
              clicked = true;
              break;
            } catch (_) {}
          }
        }
      }
      if (!clicked) {
        // last resort: querySelector and click via evaluate
        clicked = await page.evaluate(() => {
          const qs = (s) => document.querySelector(s);
          const sels = [
            'button[data-track-event="dl_template_down_id"]',
            'button.bg-gradient-primary-lr',
            'button.ml-3',
          ];
          for (const s of sels) {
            const el = qs(s);
            if (el && (el.textContent || '').includes('立即下载')) {
              el.scrollIntoView({ block: 'center' });
              (el).click();
              return true;
            }
          }
          return false;
        });
      }
      if (!clicked) throw new Error('未找到“立即下载”按钮');
      // Post click short wait
      await page.waitForTimeout(250);
      let download = await downloadListener;
      if (!download) {
        // try popup page scenario
        const popup = await popupListener;
        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          const popupDownload = await popup.waitForEvent('download', { timeout: 60000 }).catch(() => null);
          if (popupDownload) return popupDownload;
          // also try clicking download in popup
          const popupDl = popup.locator('button[data-track-event="dl_template_down_id"]:has-text("立即下载"), button:has-text("立即下载"), a:has-text("立即下载")').first();
          if ((await popupDl.count()) > 0) {
            const popupDlListener = popup.waitForEvent('download', { timeout: 60000 }).catch(() => null);
            await popupDl.click({ timeout: 15000 }).catch(() => {});
            download = await popupDlListener;
          }
        }
      }
      if (download) return download;
      // As a fallback, if we have a file-like response, return it
      const resp = await responseListener;
      return resp || null;
    }

    let download = null;
    if (!isLoginRequired) {
      // if already logged in -> ensure settled then click download
      await waitForPageSettled(250);
      // retry a few times in case components mount slowly
      for (let i = 0; i < 3 && !download; i++) {
        download = await clickImmediateDownload().catch(() => null);
        if (!download) {
          await waitForPageSettled(200);
        }
      }
    } else {
      // Need to login: click switch to password login
      // Some pages require opening login modal first
      await loginRegisterBtn.first().click({ timeout: 10000 }).catch(() => {});
      const switchPwd = page.locator('div.dialog-login-change-btn .text:has-text("切换账号密码登录")').first();
      if ((await switchPwd.count()) > 0) {
        await switchPwd.click({ timeout: 10000 }).catch(() => {});
      }
      // Fill account and password
      await page.fill('#custom-validation_account', username, { timeout: 15000 });
      await page.fill('#custom-validation_password', password, { timeout: 15000 });
      // Click login button
      const submitBtnSpan = page.locator('button.ant-btn.ant-btn-primary[type="submit"] span:has-text("登 录")').first();
      if ((await submitBtnSpan.count()) > 0) {
        await submitBtnSpan.click({ timeout: 10000 }).catch(() => {});
      } else {
        await page.locator('button.ant-btn.ant-btn-primary[type="submit"]').first().click({ timeout: 10000 }).catch(() => {});
      }
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await waitForPageSettled(300);
      // Save storage state after login so future runs reuse the session
      try { await context.storageState({ path: stateFile }); } catch (_) {}
      // After login, click immediate download with retries to handle slow rendering
      for (let i = 0; i < 3 && !download; i++) {
        download = await clickImmediateDownload().catch(() => null);
        if (!download) {
          await waitForPageSettled(250);
        }
      }
    }

    if (!download) {
      throw new Error('下载未开始');
    }
    // If it's a Playwright Download object
    if (typeof download.suggestedFilename === 'function') {
      const suggested = download.suggestedFilename();
      const filePath = path.join(tmpDir, suggested || 'aippt-download');
      await download.saveAs(filePath);
      return { filePath, filename: path.basename(filePath), cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
    }
    // Otherwise treat it as a Response
    const resp = download; // from responseListener
    const headers = resp.headers();
    const disp = headers['content-disposition'] || headers['Content-Disposition'] || '';
    let filename = 'aippt-download';
    const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disp);
    if (match) {
      filename = decodeURIComponent((match[1] || match[2] || '').trim());
    } else {
      const u = new URL(resp.url());
      const last = u.pathname.split('/').pop();
      if (last) filename = last;
    }
    const buf = await resp.body();
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, buf);
    return { filePath, filename: path.basename(filePath), cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
  } finally {
    await context.close().catch(() => {});
    // Keep shared browser running for reuse
  }
}


