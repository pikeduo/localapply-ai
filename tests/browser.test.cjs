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
  const calls = [];
  const modelRequests = [];
  const modelApi = { status: 200, data: { data: [{ id: 'synthetic-local' }, { id: 'synthetic-other' }, { id: 'synthetic-local' }] }, hold: false };
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    // 文件页必须由服务端明确允许 Origin: null；测试不关闭浏览器 CORS 防护。
    if (req.headers.origin === 'null' && modelApi.allowCors !== false) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (pathname === '/v1/models' && req.method === 'GET') {
      modelRequests.push({ authorization: req.headers.authorization, method: req.method });
      // 保留一次请求用于验证切换服务商后迟到响应不会污染新列表。
      const respond = () => { if (res.writableEnded) return; res.writeHead(modelApi.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(modelApi.data)); };
      if (modelApi.hold) { modelApi.release = respond; modelApi.onRequest(); } else respond();
      return;
    }
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const content = request.messages?.at(-1)?.content;
      const probe = Array.isArray(content) && content.some((part) => part.type === 'text' && part.text.includes('读取附件图片中唯一的8位数字'));
      const file = Array.isArray(content) && content.find((part) => part.type === 'file')?.file;
      const inputType = file ? file.filename.split('.').at(-1) : 'image';
      calls.push({ authorization: req.headers.authorization, model: request.model, probe, inputType,
        imageCount: Array.isArray(content) ? content.filter((part) => part.type === 'image_url').length : 0, fileData: file?.file_data });
      if (probe) {
        const support = modelApi.capabilities || { image: true, pdf: false, docx: false };
        if (!support[inputType]) { res.writeHead(400); res.end('{}'); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: modelApi.probeAnswer || '73185204' } }] })); return;
      }
      // 可挂起聊天响应，验证取消时真正中止网络任务且不产生晚到写入。
      const respond = () => {
        if (res.destroyed) return;
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: modelApi.chatContent || '正常' } }] }));
      };
      if (modelApi.chatHold) { modelApi.releaseChat = respond; modelApi.onChat?.(); } else respond();
      return;
    }
    if (!/^\/test-pages\/[a-z-]+\.html$/.test(pathname)) { res.writeHead(404); res.end(); return; }
    try { const body = await fs.readFile(path.join(ROOT, pathname)); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, calls, modelApi, modelRequests, base: 'http://127.0.0.1:' + server.address().port };
}

// 允许使用用户指定的现有 Chromium；默认采用 Playwright 配套浏览器，不自动下载。
async function launch(profile, withExtension = true) {
  const context = await chromium.launchPersistentContext(profile, { headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], // 正式 Chrome 的 CDP 加载也需要实际启用扩展系统。
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chromium' }),
    args: withExtension ? ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT] : [],
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

// 通过真实控件建立保险库，测试口令及 Key 全为合成数据。
async function setupVault(page) {
  await page.locator('#keyProtection').evaluate((details) => { details.open = true; });
  await page.locator('#vaultPassword').fill('synthetic-password');
  await page.locator('#vaultConfirm').fill('synthetic-password');
  await page.locator('#vaultSetup').click();
  await page.waitForFunction(async () => (await getState()).settings.vault.unlocked);
}

// 测试模型只识别已知合成挑战；文件和图片仍由生产代码真实生成，其他业务调用不伪造。
async function detectModel(page) {
  await page.evaluate(() => {
    const original = LocalApplyProbes.createProbe;
    LocalApplyProbes.createProbe = () => original('73185204');
  });
  await page.locator('#btnDetectCapabilities').click();
  await page.waitForFunction(() => !document.getElementById('btnDetectCapabilities').disabled);
  assert.match(await page.locator('#capabilityStatus').textContent(), /图片 识别通过/);
}

for (const withExtension of [true, false]) {
  test(`阶段二：${withExtension ? '扩展' : 'file://'} 简历审核、取消、密钥加密与重启`, async (t) => {
    const fixtures = require('./resume-fixtures.cjs');
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'resume-'));
    const api = await serve(); let context; let page; let url;
    const errors = [];
    // 两种运行环境均使用生产消息入口，不注入存储或解析器替身。
    const call = async (type, payload = {}) => {
      const response = await page.evaluate(({ type, payload }) => sendMessage(type, payload), { type, payload });
      assert.equal(response.ok, true, response.error); return response;
    };
    // 真实上传并本地预览，证明明确发送前没有聊天请求。
    const prepare = async (name, buffer) => {
      const count = api.calls.length;
      await page.locator('#pdfFile').setInputFiles({ name, mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
      await page.waitForFunction(() => !document.getElementById('btnExtract').disabled);
      assert.equal(await page.locator('#sendResume').isVisible(), true, await page.locator('#pdfStatus').textContent());
      assert.equal(api.calls.length, count);
    };
    // 等待真实校对 DOM 完成后才操作确认，保留失败时的可读错误。
    const analyze = async () => {
      await page.locator('#sendResume').click();
      await page.waitForFunction(() => !document.getElementById('sendResume').disabled);
      assert.match(await page.locator('#pdfStatus').textContent(), /解析完成/);
      await page.locator('#pdfReview .review-cell').first().waitFor();
      assert.equal(await page.locator('#pdfReview input[type=checkbox]:checked').count(), 0);
      await page.locator('#selectAllResume').click();
      const gpa = page.locator('.review-cell').filter({ hasText: 'GPA/排名' });
      if (await gpa.count()) await gpa.locator('input[type=checkbox]').uncheck();
    };
    // 确认后必须观察到表单消失和持久化结果，不能只断言点击成功。
    const confirm = async () => {
      await page.locator('#btnImport').click();
      await page.waitForFunction(() => !document.getElementById('btnImport').disabled);
      assert.equal(await page.locator('#importRow').isVisible(), false, await page.locator('#pdfStatus').textContent());
    };
    try {
      context = await launch(profile, withExtension);
      url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html`
        : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url);
      await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      await t.test('首次可直接填写并保存 Key，无需设置或展开安全口令', async () => {
        assert.equal(await page.locator('#apiKey').isEditable(), true);
        assert.equal(await page.locator('#keyProtection').evaluate((details) => details.open), false);
        await page.locator('#provider').fill(api.base); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
        await page.locator('#apiKey').fill('synthetic-default-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
        const state = (await call('wsa:getState')).state; assert.equal(state.settings.vault.enabled, false);
        assert.equal(state.settings.keyStatus[state.settings.provider], true); assert.deepEqual(state.settings.apiKeys, {});
        await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取'));
        assert.equal(api.modelRequests.at(-1).authorization, 'Bearer synthetic-default-key');
      });
      await setupVault(page);
      // PDF 图像解码使用随包 WASM；仅允许本地 WebAssembly，不开放 JavaScript eval。
      assert.equal(await page.evaluate(async () => (await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))) instanceof WebAssembly.Module), true);
      await page.locator('#provider').fill(api.base); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
      await page.locator('#apiKey').fill('synthetic-stage2-key'); await page.locator('#apiKey').press('Tab'); await page.evaluate(() => flushCredentials());
      await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-local'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      // 点击检测时由失焦触发 Key 保存，检测必须等待保存刷新后继续执行。
      await page.locator('#apiKey').fill('synthetic-stage2-key');
      await detectModel(page);
      await t.test('锁定只阻止密钥调用，错误口令不清除数据，正确口令可恢复调用', async () => {
        await page.locator('#vaultLock').click(); await page.waitForFunction(async () => !(await getState()).settings.vault.unlocked);
        const db = await call('localapply:read'); assert.equal(db.database.profiles.length, 1);
        await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('锁定'));
        await page.locator('#vaultPassword').fill('wrong-password'); await page.locator('#vaultUnlock').click();
        await page.waitForFunction(() => document.getElementById('vaultStatus').textContent.includes('口令错误'));
        // 忘记旧口令时也能重新输入 Key；旧密文保持可恢复，其他资料不受影响。
        assert.equal(await page.locator('#apiKey').isEditable(), true);
        await page.locator('#apiKey').fill('synthetic-stage2-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
        await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取'));
        assert.equal(api.modelRequests.at(-1).authorization, 'Bearer synthetic-stage2-key');
        await page.locator('#vaultPassword').fill('synthetic-password'); await page.locator('#vaultUnlock').click();
        await page.waitForFunction(async () => (await getState()).settings.vault.unlocked);
        assert.deepEqual((await call('wsa:getState')).state.settings.apiKeys, {});
      });
      await t.test('拖入 PDF/DOCX 自动展开页面预览，取消/错误文件不调用模型', async () => {
        const count = api.calls.length; const before = (await call('localapply:read')).database;
        for (const [name, buffer] of [['drag-resume.pdf', fixtures.pdf()], ['drag-resume.docx', fixtures.docx()]]) {
          await page.evaluate(({ name, bytes }) => {
            const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(bytes)], name));
            const zone = document.getElementById('resumeDropZone');
            zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          }, { name, bytes: [...buffer] });
          await page.locator('#sourcePreview img').first().waitFor({ state: 'visible' });
          await page.waitForFunction(() => !document.getElementById('btnExtract').disabled);
          assert.equal(await page.locator('#resumePreview').evaluate((details) => details.open), true);
          assert.match(await page.locator('#resumeFileInfo').textContent(), new RegExp(name.replace('.', '\\.')));
          assert.equal(await page.locator('#resumeDropZone').evaluate((zone) => zone.classList.contains('drag-active')), false);
          assert.equal(api.calls.length, count);
        }
        await page.locator('#pdfCard').screenshot({ path: path.join(testRoot, `drag-preview-${withExtension ? 'extension' : 'file'}.png`) });
        await page.locator('#cancelResume').click(); assert.equal(await page.locator('#sourcePreview img').count(), 0);
        await page.evaluate(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(['x'], 'one.pdf')); transfer.items.add(new File(['y'], 'two.docx'));
          document.getElementById('resumeDropZone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        });
        assert.match(await page.locator('#pdfStatus').textContent(), /每次/);
        assert.deepEqual((await call('localapply:read')).database, before); assert.equal(api.calls.length, count);
      });
      const primary = (await call('wsa:getState')).state.activeProfileId;
      api.modelApi.chatContent = JSON.stringify(fixtures.parsed());
      await t.test('真实 DOCX：来源、人工编辑、不选字段、重复经历及重复导入', async () => {
        const before = (await call('localapply:read')).database;
        await prepare('resume.docx', fixtures.docx()); await analyze();
        assert.equal((await call('localapply:read')).database.revision, before.revision);
        const gpa = page.locator('.review-cell').filter({ hasText: 'GPA/排名' }); assert.equal(await gpa.locator('input[type=checkbox]').isChecked(), false);
        await page.getByRole('textbox', { name: '基本信息 · 姓名', exact: true }).fill('Confirmed Person');
        await page.locator('.review-cell').filter({ hasText: '基本信息 · 邮箱' }).locator('input[type=checkbox]').uncheck();
        await confirm();
        let db = (await call('localapply:read')).database; assert.equal(db.entries.length, 5);
        const name = db.fieldValues.find((r) => r.profileId === primary && r.entryId === null && r.fieldId === 'builtin.name');
        assert.equal(name.value, 'Confirmed Person'); assert.equal(name.evidence.kind, 'manual');
        assert.ok(!db.fieldValues.some((r) => r.value === '4.0' || r.value === 'test@example.test'));
        await prepare('same-bytes-renamed.docx', fixtures.docx()); await analyze(); await confirm();
        db = (await call('localapply:read')).database; assert.equal(db.entries.length, 5);
        assert.equal(db.fieldValues.find((r) => r.fieldId === 'builtin.name' && r.entryId === null).value, 'Confirmed Person');
      });
      await t.test('真实文本 PDF 与第二档案隔离，基本信息可在中心编辑', async () => {
        await page.locator('#newProfileName').fill('第二份简历'); await page.locator('#createResumeProfile').click();
        await page.waitForFunction((id) => document.getElementById('targetProfile').value !== id, primary);
        await prepare('resume.pdf', fixtures.pdf()); await analyze(); await confirm();
        const db = (await call('localapply:read')).database; const second = db.activeProfileId;
        assert.equal(db.entries.filter((e) => e.profileId === primary).length, 5); assert.equal(db.entries.filter((e) => e.profileId === second).length, 5);
        assert.equal(db.fieldValues.find((v) => v.profileId === second && v.fieldId === 'builtin.name' && v.entryId === null).value, 'Test Person');
        await page.locator('#resumeCenter details').evaluate((details) => { details.open = true; });
        await page.getByRole('textbox', { name: '简历中心 · 姓名', exact: true }).fill('Center edit');
        await page.getByRole('textbox', { name: '简历中心 · 姓名', exact: true }).press('Tab');
        await page.waitForFunction(() => document.getElementById('centerStatus').textContent.includes('已保存'));
        assert.equal((await call('localapply:read')).database.fieldValues.find((v) => v.profileId === second && v.fieldId === 'builtin.name' && v.entryId === null).evidence, undefined);
      });
      await t.test('畸形文档、无效 AI 和取消进行中的请求均不写入资料', async () => {
        const before = (await call('localapply:read')).database;
        await page.locator('#pdfFile').setInputFiles({ name: 'bad.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a zip') });
        await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('读取失败'));
        await prepare('resume.docx', fixtures.docx()); api.modelApi.chatContent = '{"education":"wrong-type"}';
        await page.locator('#sendResume').click(); await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('解析失败'));
        api.modelApi.chatHold = true; const received = new Promise((resolve) => { api.modelApi.onChat = resolve; });
        await page.locator('#sendResume').click(); await received;
        await page.locator('#cancelResume').click(); api.modelApi.chatHold = false; api.modelApi.releaseChat();
        assert.match(await page.locator('#pdfStatus').textContent(), /已取消/);
        assert.equal(await page.locator('#importRow').isVisible(), false);
        assert.deepEqual((await call('localapply:read')).database, before);
        assert.equal(await page.locator('#sourcePreview').textContent(), '');
        await prepare('retry.docx', fixtures.docx()); assert.equal(await page.locator('#sendResume').isEnabled(), true);
        await page.locator('#cancelResume').click();
      });
      await t.test('纯图片 PDF/DOCX 保留可见图片并交给视觉模型，不依赖文字层', async () => {
        const probeFiles = await page.evaluate(() => LocalApplyProbes.createProbe('73185204'));
        api.modelApi.chatContent = JSON.stringify({ basic: { phone: { value: '73185204', evidence: '73185204', page: 1 } } });
        for (const type of ['pdf', 'docx']) {
          const buffer = Buffer.from(probeFiles[type].file_data.split(',')[1], 'base64');
          await prepare('image-only.' + type, buffer);
          const dark = await page.locator('#sourcePreview img').first().evaluate(async (img) => {
            await img.decode(); const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let pixels = 0; for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) pixels++;
            canvas.width = canvas.height = 0; return pixels;
          });
          assert.ok(dark > 500, type + ' 的嵌入图片未出现在实际页面预览中');
          await analyze(); assert.equal(api.calls.at(-1).inputType, 'image'); assert.ok(api.calls.at(-1).imageCount > 0);
          await confirm();
        }
        assert.ok((await call('localapply:read')).database.fieldValues.some((row) => row.value === '73185204'));
      });
      await t.test('原文件能力通过后按原字节提交，旧文本入口及不支持的新型号不能绕过检测', async () => {
        api.modelApi.capabilities = { image: true, pdf: true, docx: true }; await detectModel(page);
        for (const [type, buffer] of [['docx', fixtures.docx()], ['pdf', fixtures.pdf()]]) {
          await prepare('original.' + type, buffer); await analyze();
          assert.equal(api.calls.at(-1).inputType, type); assert.equal(api.calls.at(-1).imageCount, 0);
          assert.ok(Buffer.from(api.calls.at(-1).fileData.split(',')[1], 'base64').equals(buffer)); await confirm();
        }
        const route = (await call('wsa:resumeRoute', { format: 'pdf' })).route; const count = api.calls.length;
        const oldPath = await page.evaluate(async (route) => sendMessage('wsa:aiExtractResume', { payload: { requestId: crypto.randomUUID(), type: 'pdf', mode: route.mode, routeToken: route.token, text: '不能通过文字入口解析简历' } }), route);
        assert.equal(oldPath.ok, false); assert.equal(api.calls.length, count);
        await page.locator('#manualModel').check();
        await page.locator('#model').fill('unprobed-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
        await prepare('blocked.pdf', fixtures.pdf()); await page.locator('#sendResume').click();
        await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('尚未通过'));
        assert.equal(api.calls.length, count); await page.locator('#cancelResume').click();
        await page.locator('#model').fill('synthetic-local'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      });
      await t.test('模型忽略附件但返回 HTTP 200 时也禁止发送真实简历', async () => {
        api.modelApi.probeAnswer = '支持图片和文件';
        await page.locator('#btnDetectCapabilities').click(); await page.waitForFunction(() => !document.getElementById('btnDetectCapabilities').disabled);
        assert.match(await page.locator('#capabilityStatus').textContent(), /识别未通过/);
        const count = api.calls.length; await prepare('unsupported.pdf', fixtures.pdf()); await page.locator('#sendResume').click();
        await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('尚未通过'));
        assert.equal(api.calls.length, count); await page.locator('#cancelResume').click();
      });
      const before = (await call('localapply:read')).database;
      await page.evaluate(() => { document.querySelector('#resumeCenter details').open = false; window.scrollTo(0, 0); });
      await page.screenshot({ path: path.join(testRoot, `phase2-${withExtension ? 'extension' : 'file'}.png`), fullPage: false });
      await context.close(); context = await launch(profile, withExtension);
      page = await context.newPage(); await page.goto(url); await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      await t.test('整个浏览器重启后资料不变、保险库锁定且可再次解锁', async () => {
        assert.deepEqual((await call('localapply:read')).database, before);
        const s = (await call('wsa:getState')).state.settings; assert.equal(s.vault.unlocked, false); assert.equal(s.keyStatus[s.provider], true);
        await page.locator('#keyProtection').evaluate((details) => { details.open = true; });
        await page.locator('#vaultPassword').fill('synthetic-password'); await page.locator('#vaultUnlock').click();
        await page.waitForFunction(async () => (await getState()).settings.vault.unlocked);
        await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取'));
        assert.equal(api.modelRequests.at(-1).authorization, 'Bearer synthetic-stage2-key');
        assert.deepEqual(errors, []);
      });
      await t.test('取消可选口令后，整个浏览器重启可直接调用已保存的 Key', async () => {
        await page.locator('#vaultDisable').click(); await page.evaluate(() => flushCredentials());
        assert.equal((await call('wsa:getState')).state.settings.vault.enabled, false);
        await context.close(); context = await launch(profile, withExtension);
        page = await context.newPage(); await page.goto(url); await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
        assert.equal(await page.locator('#apiKey').isEditable(), true);
        assert.equal((await call('wsa:getState')).state.settings.vault.enabled, false);
        await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取'));
        assert.equal(api.modelRequests.at(-1).authorization, 'Bearer synthetic-stage2-key');
        assert.deepEqual((await call('localapply:read')).database, before);
      });
    } finally {
      if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve));
      assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep));
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  });
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
  const { server, base, calls, modelApi, modelRequests } = await serve();
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
    await t.test('服务商输入支持 DeepSeek/Qwen 和 IP 自动创建，Key/模型隔离且本地接口可调用', async () => {
      // 回车提交使用真实 UI 事件；等待本页保存队列完成。
      const choose = async (text) => {
        await options.locator('#provider').fill(text); await options.locator('#provider').press('Enter');
        await options.evaluate(() => flushSaves());
      };
      await choose('deepseek'); assert.equal(await options.locator('#provider').inputValue(), 'DeepSeek');
      await setupVault(options);
      await options.locator('#apiKey').fill('fake-deepseek-ui-key'); await options.locator('#apiKey').press('Tab');
      await options.evaluate(() => flushCredentials());
      await options.locator('#manualModel').check();
      await options.locator('#model').fill('synthetic-deepseek'); await options.locator('#model').press('Tab');
      await choose('qwen'); assert.equal(await options.locator('#apiKey').inputValue(), '');
      await choose('deepseek'); assert.equal(await options.locator('#model').inputValue(), 'synthetic-deepseek');
      assert.equal(await options.locator('#apiKey').inputValue(), '');
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.keyStatus.deepseek, true);
      await choose(base.replace('http://', ''));
      assert.equal(await options.locator('#customBase').inputValue(), base + '/v1');
      assert.equal(await options.locator('#apiKey').inputValue(), ''); assert.equal(await options.locator('#model').inputValue(), '');
      await options.locator('#model').fill('synthetic-local'); await options.locator('#btnTestKey').click();
      await options.waitForFunction(() => document.getElementById('testResult').textContent.includes('连接正常'));
      assert.equal(calls.at(-1).model, 'synthetic-local'); assert.equal(calls.at(-1).authorization, undefined);
      const before = await rpc(options, 'wsa:getState'); const customId = before.state.settings.provider;
      await choose('192.0.2.15:9000'); assert.equal(await options.locator('#model').inputValue(), '');
      await choose(base + '/v1/chat/completions'); assert.equal(await options.locator('#model').inputValue(), 'synthetic-local');
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.provider, customId);
      await options.reload(); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      const after = await rpc(options, 'wsa:getState'); assert.equal(after.state.settings.provider, customId);
      assert.equal(Object.keys(after.state.settings.customProviders).length, 2);
      await choose('zhipu');
    });
    await t.test('先获取模型列表再选择，选择持久化且成功调用；失败可手填，旧响应不污染新服务商', async () => {
      // 模拟用户进入已保存的本地端点，初次选择必须来自实际 GET /models 响应。
      const choose = async (text) => {
        await options.locator('#provider').fill(text); await options.locator('#provider').press('Enter'); await options.evaluate(() => flushSaves());
      };
      await choose(base); await options.locator('#manualModel').check();
      await options.locator('#model').fill(''); await options.locator('#model').press('Tab');
      await options.locator('#manualModel').uncheck();
      await options.locator('#btnFetchModels').click();
      await options.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取 2 个模型'));
      assert.equal(modelRequests.at(-1).method, 'GET'); assert.equal(modelRequests.at(-1).authorization, undefined);
      assert.equal(await options.locator('#modelSelect').inputValue(), '');
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.model, '');
      await options.locator('#modelSelect').selectOption('synthetic-other');
      await options.locator('#btnTestKey').click();
      await options.waitForFunction(() => document.getElementById('testResult').textContent.includes('连接正常'));
      assert.equal(calls.at(-1).model, 'synthetic-other');
      await options.reload(); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      assert.equal(await options.locator('#modelSelect').inputValue(), 'synthetic-other');
      assert.equal(await options.locator('#modelSelect').isDisabled(), true);
      modelApi.status = 401;
      await options.locator('#btnFetchModels').click();
      await options.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('401'));
      assert.equal(await options.locator('#manualModel').isChecked(), true);
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.model, 'synthetic-other');
      modelApi.status = 200; modelApi.data = { data: [] };
      await options.locator('#btnFetchModels').click();
      await options.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('空模型列表'));
      modelApi.data = { data: [{ id: 'late-local-model' }] }; modelApi.hold = true;
      const received = new Promise((resolve) => { modelApi.onRequest = resolve; });
      const fetching = options.evaluate(() => fetchAvailableModels());
      await received; await choose('qwen'); modelApi.release(); await fetching;
      assert.equal(await options.locator('#modelSelect option[value="late-local-model"]').count(), 0);
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.provider, 'qwen');
      modelApi.hold = false; await choose('zhipu');
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
    await t.test('直接打开设置 HTML 时启用独立文件管理模式', async () => {
      const preview = await context.newPage();
      await preview.goto(require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href);
      await preview.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      assert.equal(await preview.locator('#standaloneNotice').isVisible(), true);
      assert.equal(await preview.locator('#initializationError').isVisible(), false);
      assert.equal(await preview.locator('#provider').isDisabled(), false);
      assert.equal((await preview.evaluate(() => getState())).profiles[0].fields.find((field) => field.key === 'name').value, '');
      assert.ok(!(await preview.locator('body').textContent()).includes('Cannot read properties'));
      await preview.close();
    });
  } finally {
    if (modelApi.release) modelApi.release(); // 失败路径也释放挂起的本地响应，避免清理阶段卡住。
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    // 删除前验证路径始终属于本次创建的独立测试根，绝不按端口强杀进程。
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('无扩展的 file:// 模式：持久化、模型、PDF、备份和并发写入', async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'file-profile-'));
  const { server, base, modelApi, modelRequests } = await serve();
  const fileUrl = require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
  let context;
  let page;
  // 文件页复用 common.js 的入口，测试不注入 Chrome API 或内存存储替身。
  const call = async (type, payload = {}) => {
    const response = await page.evaluate(({ type, payload }) => sendMessage(type, payload), { type, payload });
    assert.equal(response.ok, true, response.error); return response;
  };
  try {
    context = await launch(profile, false);
    page = await context.newPage(); await page.goto(fileUrl);
    await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    await t.test('无扩展接口时仍能设置并在真实 CORS 下获取模型及测试连接', async () => {
      assert.equal(await page.evaluate(() => !!globalThis.chrome?.runtime?.id), false);
      assert.equal(await page.locator('#standaloneNotice').isVisible(), true);
      assert.equal(await page.locator('#provider').isDisabled(), false);
      await page.locator('#provider').fill(base); await page.locator('#provider').press('Enter');
      await setupVault(page);
      await page.locator('#apiKey').fill('fake-file-only-key'); await page.locator('#apiKey').press('Tab');
      await page.locator('#btnFetchModels').click();
      await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取 2 个模型'));
      assert.equal(modelRequests.at(-1).authorization, 'Bearer fake-file-only-key');
      await page.locator('#modelSelect').selectOption('synthetic-local');
      await page.locator('#btnTestKey').click();
      await page.waitForFunction(() => document.getElementById('testResult').textContent.includes('连接正常'));
    });
    await t.test('本地文件 PDF 通过读取、视觉假接口、校对确认入库，原文件不持久化', async () => {
      await detectModel(page);
      modelApi.chatContent = JSON.stringify({ basic: { name: { value: '合成文件姓名', evidence: '合成文件姓名', page: 1 } } });
      await page.locator('#pdfFile').setInputFiles(path.join(ROOT, 'test-pages/fake-scan.pdf'));
      await page.waitForFunction(() => !document.getElementById('btnExtract').disabled);
      assert.ok(!await page.locator('#sendResume').isHidden(), await page.locator('#pdfStatus').textContent());
      await page.locator('#sendResume').waitFor({ state: 'visible' }); await page.locator('#sendResume').click();
      await page.locator('#importRow').waitFor({ state: 'visible' });
      // 扫描件来源无法本地核对，必须由测试用户明确勾选。
      await page.locator('#pdfReview input[type=checkbox]').first().check();
      await page.locator('#btnImport').click();
      await page.waitForFunction(() => !document.getElementById('btnImport').disabled);
      assert.equal(await page.locator('#importRow').isVisible(), false, await page.locator('#pdfStatus').textContent());
      await page.locator('#importRow').waitFor({ state: 'hidden' });
      const { database } = await call('localapply:read');
      assert.ok(database.fieldValues.some((row) => row.value === '合成文件姓名' && row.source === 'ai-confirmed'));
      assert.ok(!JSON.stringify(database).includes('data:image'));
      modelApi.chatContent = '正常';
    });
    await t.test('文件页重复经历和完整备份可操作，默认不导出 API 配置', async () => {
      await page.locator('#entryTitle').fill('合成文件教育'); await page.locator('#btnAddEntry').click();
      await page.locator('#entriesList .card').first().waitFor();
      const downloadEvent = page.waitForEvent('download'); await page.locator('#btnBackup').click();
      const download = await downloadEvent; const text = await fs.readFile(await download.path(), 'utf8');
      assert.ok(text.includes('合成文件教育')); assert.ok(!text.includes('fake-file-only-key'));
      await page.locator('#backupFile').setInputFiles({ name: 'file-backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
      await page.locator('#btnApplyRestore').waitFor({ state: 'visible' }); await page.locator('#btnApplyRestore').click();
      await page.waitForFunction(() => document.getElementById('restorePreview').textContent.includes('导入完成'));
    });
    await t.test('多个文件页同时写不同字段，Web Lock 防止覆盖', async () => {
      const other = await context.newPage(); await other.goto(fileUrl);
      await other.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      const firstBase = await page.evaluate(() => getState());
      const secondBase = await other.evaluate(() => getState());
      const first = structuredClone(firstBase);
      const second = structuredClone(secondBase);
      first.profiles[0].fields.find((field) => field.key === 'phone').value = '13800000000';
      second.profiles[0].fields.find((field) => field.key === 'email').value = 'file-synthetic@example.test';
      // 直接提交两份从同一版本读取的投影，复用生产中的冲突检查。
      await Promise.all([
        call('localapply:saveLegacy', { base: firstBase, state: first }),
        other.evaluate(async ({ base, state }) => {
          const response = await sendMessage('localapply:saveLegacy', { base, state });
          if (!response.ok) throw new Error(response.error);
        }, { base: secondBase, state: second }),
      ]);
      const { database } = await call('localapply:read');
      assert.ok(database.fieldValues.some((row) => row.value === '13800000000'));
      assert.ok(database.fieldValues.some((row) => row.value === 'file-synthetic@example.test'));
      await other.close();
    });
    await t.test('服务端不允许文件来源时只提示网络/CORS，不禁用资料管理', async () => {
      modelApi.allowCors = false;
      await page.locator('#btnFetchModels').click();
      await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('CORS'));
      assert.equal(await page.locator('#btnAddEntry').isDisabled(), false);
      assert.equal(await page.locator('#btnBackup').isDisabled(), false);
      modelApi.allowCors = true;
    });
    const before = await call('wsa:getState');
    await context.close(); context = await launch(profile, false);
    page = await context.newPage(); await page.goto(fileUrl);
    await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    await t.test('关闭浏览器后重开文件页，IndexedDB 资料和配置保持不变', async () => {
      const after = await call('wsa:getState'); before.state.settings.vault.unlocked = false; assert.deepEqual(after.state, before.state);
      assert.equal(after.state.settings.model, 'synthetic-local');
      assert.equal(Object.values(after.state.settings.apiKeys).length, 0);
      assert.equal(after.state.settings.vault.unlocked, false);
    });
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});
