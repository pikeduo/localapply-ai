// Playwright 真实扩展验收：独立 profile、动态端口、仅合成数据，不清理其他进程。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');

// 本地夹具服务仅绑定 loopback，并限制路径属于 test-pages。
async function serve() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!/^\/test-pages\/[a-z-]+\.html$/.test(pathname)) { res.writeHead(404); res.end(); return; }
    try { const body = await fs.readFile(path.join(ROOT, pathname)); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

// 允许使用用户指定的现有 Chromium；默认采用 Playwright 配套浏览器，不自动下载。
async function launch(profile) {
  const context = await chromium.launchPersistentContext(profile, { headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], // 正式 Chrome 的 CDP 加载也需要实际启用扩展系统。
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chromium' }),
    args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT],
    timeout: 30000,
  });
  return context;
}

// 从实际 worker 发现扩展 ID，不依赖用户浏览器中的任何扩展。
async function extension(context) {
  let worker = context.serviceWorkers().find((item) => item.url().endsWith('/background.js'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return { worker, extensionId: new URL(worker.url()).host };
}

// 通过真实扩展页面发送 RPC，与生产页面使用相同消息权限。
async function rpc(page, type, payload = {}) {
  const response = await page.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
  assert.equal(response.ok, true, response.error);
  return response;
}

// 自动等待 DOM 和扩展检测完成，不依赖固定长延时。
async function detect(sidebar, page) {
  await page.bringToFront();
  await page.waitForFunction(() => document.readyState === 'complete');
  await sidebar.waitForFunction(async () => {
    const detection = await WSA.refresh();
    return detection && detection.url.startsWith('http');
  });
  return sidebar.evaluate(() => WSA.refresh());
}

test('真实浏览器：迁移、UI、隔离、旧填充、备份和进程重启持久性', async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'profile-'));
  const { server, base } = await serve();
  let context;
  const pageErrors = [];
  try {
    context = await launch(profile);
    context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
    // 记录提交事件，验证旧填充引擎没有触发最终提交。
    await context.addInitScript(() => {
      window.__testSubmitCount = 0;
      document.addEventListener('submit', () => { window.__testSubmitCount++; }, true);
    });
    let { worker, extensionId } = await extension(context);
    // 用合成旧资料初始化真实 chrome.storage，删除的仅是该独立 profile 中的新库。
    await worker.evaluate(async () => {
      const old = WangshenTemplates.defaultState();
      old.profiles[0].fields.find((field) => field.key === 'name').value = '合成测试姓名';
      old.settings.apiKeys = { custom: 'fake-browser-only-key' };
      await chrome.storage.local.set({ wangshenAutofill: old });
      await chrome.storage.local.remove(['localapply.database', 'localapply.apiSettings']);
    });
    const sidebar = await context.newPage(); await sidebar.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await sidebar.waitForFunction(() => window.WSA && WSA.getState());
    const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    await t.test('真实迁移保留旧源且 API 与资料隔离', async () => {
      const { database } = await rpc(options, 'localapply:read');
      assert.equal(database.fieldValues.find((row) => row.fieldId === 'builtin.name').value, '合成测试姓名');
      const stored = await worker.evaluate(() => chrome.storage.local.get(null));
      assert.equal(stored.wangshenAutofill.profiles[0].fields[0].value, '合成测试姓名');
      assert.ok(!JSON.stringify(stored['localapply.database']).includes('fake-browser-only-key'));
    });
    await t.test('旧侧栏新建/编辑/删除动态字段实际落盘', async () => {
      const form = sidebar.locator('.addform').first();
      await form.locator('input').fill('合成动态字段'); await form.locator('button').click();
      const row = sidebar.locator('.frow').filter({ hasText: '合成动态字段' });
      await row.locator('input[type=text]').fill('合成动态值');
      await sidebar.evaluate(() => flushSaves());
      let db = (await rpc(options, 'localapply:read')).database;
      assert.ok(db.fieldValues.some((row) => row.value === '合成动态值'));
      sidebar.once('dialog', (dialog) => dialog.accept()); await row.locator('.del').click();
      await sidebar.evaluate(() => flushSaves()); db = (await rpc(options, 'localapply:read')).database;
      assert.ok(!db.fieldValues.some((row) => row.value === '合成动态值'));
    });
    await t.test('重复经历管理 UI 保存两段教育与项目', async () => {
      for (const kind of ['education', 'project']) {
        await options.locator('#entryKind').selectOption(kind);
        for (let index = 0; index < 2; index++) {
          await options.locator('#entryTitle').fill(`合成${kind}${index}`); await options.locator('#btnAddEntry').click();
          await options.waitForFunction((count) => document.querySelectorAll('#entriesList .card').length === count, kind === 'education' ? index + 1 : index + 3);
        }
      }
      const first = options.locator('#entriesList .card').first();
      await first.locator('select').selectOption('builtin.school'); await first.locator('input').fill('合成测试学院');
      await first.locator('button').filter({ hasText: '保存字段' }).click();
      await options.waitForFunction(() => document.getElementById('entriesList').textContent.includes('合成测试学院'));
    });
    const page = await context.newPage();
    await t.test('generic 识别和填充正确；内容脚本无法读取资料和 API', async () => {
      await page.goto(base + '/test-pages/generic.html');
      await sidebar.evaluate(async () => {
        for (const [key, value] of Object.entries({ name: '合成测试姓名', phone: '13800000000', email: 'synthetic@example.test', school: '合成测试学院', major: '合成专业', degree: '硕士', graduationDate: '2028-06', expectedCity: '合成城市' })) WSA.setFieldByKey(key, value);
        await WSA.save();
      });
      const detection = await detect(sidebar, page); assert.ok(detection.counts.auto >= 8);
      const review = await sidebar.evaluate(() => WSA.autoFill()); assert.ok(review.filter((row) => row.ok).length >= 8);
      const probe = await page.evaluate(() => __genericProbe()); assert.equal(probe.name, '合成测试姓名'); assert.equal(probe.grad, '2028-06'); assert.equal(probe.openQ, '');
      assert.equal(await page.evaluate(() => window.__testSubmitCount), 0);
      const security = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
          let denied = false;
          try { const data = await chrome.storage.local.get('localapply.database'); denied = !data['localapply.database']; } catch { denied = true; }
          return { denied, read: await chrome.runtime.sendMessage({ type: 'wsa:getState' }), settings: await chrome.runtime.sendMessage({ type: 'wsa:contentSettings' }) };
        } }); return result.result;
      });
      assert.equal(security.denied, true); assert.equal(security.read.ok, false);
      assert.deepEqual(Object.keys(security.settings.settings).sort(), ['autoFloatbar', 'autoThreshold', 'privacyMask']);
    });
    await t.test('受控组件、Moka 补全、国聘、登录与孤文本回归', async () => {
      for (const file of ['react-mock', 'moka-autocomplete', 'moka-mock', 'iguopin-mock', 'login-mock', 'lonely-textarea']) {
        await page.goto(base + '/test-pages/' + file + '.html'); await detect(sidebar, page);
        await sidebar.evaluate(async () => { WSA.setFieldByKey('ethnic', '汉族'); await WSA.save(); });
        const detection = await sidebar.evaluate(() => WSA.refresh());
        if (file === 'login-mock' || file === 'lonely-textarea') assert.equal(detection.fields.length, 0, file);
        else {
          await sidebar.evaluate(() => WSA.autoFill());
          if (file === 'react-mock') assert.equal(await page.evaluate(() => __reactMock.state().name), '合成测试姓名');
          if (file === 'moka-autocomplete') assert.equal(await page.evaluate(() => __mokaAutoProbe().picked), '汉族');
          if (file === 'moka-mock') assert.equal(await page.evaluate(() => __mokaProbe().name), '合成测试姓名');
          if (file === 'iguopin-mock') {
            const probe = await page.evaluate(() => __iguopinProbe()); assert.equal(probe.name, '合成测试姓名'); assert.equal(probe.fatherName, '');
          }
        }
      }
    });
    await t.test('真实备份下载、校验预览和恢复，无 API Key/原文件', async () => {
      const downloadEvent = options.waitForEvent('download'); await options.locator('#btnBackup').click();
      const download = await downloadEvent; const text = await fs.readFile(await download.path(), 'utf8');
      assert.ok(!text.includes('fake-browser-only-key')); assert.ok(!text.includes('apiKeys'));
      await options.locator('#backupFile').setInputFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
      await options.locator('#btnApplyRestore').waitFor({ state: 'visible' });
      assert.match(await options.locator('#restorePreview').textContent(), /校验通过/);
      await options.locator('#btnApplyRestore').click(); await options.waitForFunction(() => document.getElementById('restorePreview').textContent.includes('导入完成'));
    });
    const before = (await rpc(options, 'localapply:read')).database;
    await context.close(); context = await launch(profile);
    context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
    ({ worker, extensionId } = await extension(context));
    const restarted = await context.newPage(); await restarted.goto(`chrome-extension://${extensionId}/options/options.html`);
    await restarted.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    await t.test('关闭整个浏览器进程再启动，资料与重复经历保持一致', async () => {
      const after = (await rpc(restarted, 'localapply:read')).database;
      assert.deepEqual(after, before); assert.equal(after.entries.length, 4);
    });
    await t.test('扩展页面与夹具没有未捕获 JavaScript 错误', async () => {
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    // 删除前验证路径始终属于本次创建的独立测试根，绝不按端口强杀进程。
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});
