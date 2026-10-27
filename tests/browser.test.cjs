// Playwright 真实扩展验收：独立 profile、动态端口、仅合成数据，不清理其他进程。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');

// 阶段五在两种真实存储入口验证申请管理、导出导入和整个浏览器重启。
for (const withExtension of [true, false]) {
  test(`阶段五管理：${withExtension ? '扩展' : 'file://'}申请、筛选、看板、备份与重启`, { timeout: 120000 }, async (t) => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'stage5-management-')); const api = await serve(); let context; let page; let url; let firstId; let exported; const errors = [];
    // 通过真实页面 RPC 读取规范库，不用内存桩替代浏览器持久化。
    const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
    // 每次保存都回应实际差异确认对话框，不伪造 confirmed 状态。
    const confirmSave = async () => { page.once('dialog', (dialog) => dialog.accept()); await page.locator('#appSave').click(); await page.waitForFunction(() => !document.getElementById('appSave').disabled && document.getElementById('appStatusMessage').textContent.includes('已保存')); };
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000); url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html#applications` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href + '#applications';
      page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); await page.locator('#appCount').filter({ hasText: '全部' }).waitFor();
      await t.test('无 Key 可手动添加，取消确认不入库，保存后资料与字段保持完整', async () => {
        const before = await read(); await page.locator('#appNew').click(); await page.locator('#appCompany').fill('合成阶段五公司'); await page.locator('#appTitle').fill('合成开发岗位'); await page.locator('#appLocation').fill('合成甲城'); await page.locator('#appSource').fill('合成平台'); await page.locator('#appEmploymentType').fill('全职'); await page.locator('#appJobId').fill('SYN-MANUAL-1'); await page.locator('#appUrl').fill(api.base + '/test-pages/phase5-job.html?token=must-not-store&utm_source=test');
        page.once('dialog', (dialog) => dialog.dismiss()); await page.locator('#appSave').click(); assert.equal((await read()).applications.length, 0); assert.equal(await page.locator('#appTitle').inputValue(), '合成开发岗位');
        await confirmSave(); const db = await read(); firstId = db.applications[0].applicationId; assert.equal(db.applications[0].status, 'saved'); assert.equal(db.applications[0].appliedAt, null); assert.deepEqual(db.fieldValues, before.fieldValues); assert.ok(!db.applications[0].jobUrl.includes('token=')); assert.equal(api.calls.length, 0);
      });
      await t.test('状态、备注、标签、待办及自定义状态写入历史，恶意文字仅当文本', async () => {
        await page.locator('#appEditStatus').selectOption('interview'); await page.locator('#appNotes').fill('=合成备注 <img src=x onerror="window.__stage5Injected=true">'); await page.locator('#appTags').fill('重点、校招'); await page.locator('#appTodos').fill('准备合成面试\n[x] 完成合成测评'); await confirmSave(); assert.equal((await read()).applications[0].history.length, 2); assert.equal(await page.locator('#appTodoList input:checked').count(), 1);
        await page.locator('#appEditStatus').selectOption('custom'); await page.locator('#appCustomStatus').fill('已沟通'); await confirmSave(); assert.equal((await read()).applications[0].status, 'custom:已沟通'); assert.equal(await page.evaluate(() => window.__stage5Injected), undefined); assert.equal(await page.locator('#appTimeline li').count(), 3);
      });
      await t.test('搜索及组合筛选、看板隐藏列、窄窗和明暗主题可用', async () => {
        await page.locator('#appSearch').fill('重点'); await page.locator('#appStatusFilter').selectOption('custom:已沟通'); await page.locator('#appCityFilter').selectOption('合成甲城'); await page.locator('#appSourceFilter').selectOption('合成平台'); await page.locator('#appTypeFilter').selectOption('全职'); assert.equal(await page.locator('.application-record').count(), 1);
        await page.locator('#appDateFrom').fill('2099-01-01'); assert.equal(await page.locator('.application-record').count(), 0); await page.locator('#appDateFrom').fill('');
        await page.locator('#appBoardView').click(); await page.locator('#appColumns summary').click(); const column = page.locator('#appColumnOptions label').filter({ hasText: '已沟通' }); await column.locator('input').uncheck(); assert.equal(await page.locator('.application-record').count(), 0); await column.locator('input').check(); assert.equal(await page.locator('.application-record').count(), 1);
        await page.locator('#appListView').click(); await page.screenshot({ path: path.join(testRoot, `stage5-applications-${withExtension ? 'extension' : 'file'}.png`), fullPage: true });
        await page.setViewportSize({ width: 430, height: 850 }); await page.locator('#themeToggle').click(); await page.screenshot({ path: path.join(testRoot, `stage5-applications-narrow-${withExtension ? 'extension' : 'file'}.png`), fullPage: true }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.setViewportSize({ width: 1280, height: 900 });
      });
      await t.test('筛选导出有预览确认，CSV 含 BOM 并阻止公式，JSON 包含完整历史', async () => {
        await page.locator('#appExportPreview').click(); assert.ok((await page.locator('#appExportSummary').textContent()).includes('1 条'));
        let event = page.waitForEvent('download'); await page.locator('#appExportJson').click(); exported = await fs.readFile(await (await event).path()); const data = JSON.parse(exported); assert.equal(data.applications.length, 1); assert.equal(data.applications[0].history.length, 3); assert.ok(!exported.toString().includes('apiKeys'));
        event = page.waitForEvent('download'); await page.locator('#appExportCsv').click(); const csv = await fs.readFile(await (await event).path(), 'utf8'); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\'=合成备注')); assert.ok(csv.includes('已沟通'));
      });
      await t.test('删除后可确认导入恢复，重复导入去重，完整备份包含申请', async () => {
        await page.locator('#appExportCancel').click(); page.once('dialog', (dialog) => dialog.accept()); await page.locator('#appDelete').click(); await page.waitForFunction(() => document.getElementById('appStatusMessage').textContent.includes('已删除')); assert.equal((await read()).applications.length, 0);
        await page.locator('#appImportFile').setInputFiles({ name: 'synthetic-applications.json', mimeType: 'application/json', buffer: exported }); await page.locator('#appImportPreview').waitFor({ state: 'visible' }); assert.equal((await read()).applications.length, 0); await page.locator('#appImportConfirm').click(); await page.waitForFunction(() => document.getElementById('appStatusMessage').textContent.includes('导入完成')); assert.equal((await read()).applications[0].applicationId, firstId);
        await page.locator('#appImportFile').setInputFiles({ name: 'synthetic-applications-again.json', mimeType: 'application/json', buffer: exported }); await page.locator('#appImportPreview').waitFor({ state: 'visible' }); assert.ok((await page.locator('#appImportSummary').textContent()).includes('新增 0')); await page.locator('#appImportConfirm').click(); await page.locator('#appImportPreview').waitFor({ state: 'hidden' }); assert.equal((await read()).applications.length, 1);
        const full = (await page.evaluate(() => dataRequest('localapply:exportBackup'))).backup; assert.equal(full.database.schemaVersion, 5); assert.equal(full.database.applications.length, 1);
        // 通过真实兼容导出和恢复预览确认旧备份的申请缺失提示，预览不执行覆盖。
        await workspacePage(page, 'privacySettings'); const compatibilityDownload = page.waitForEvent('download'); await page.locator('#btnExportV4').click(); const compatible = await fs.readFile(await (await compatibilityDownload).path()); assert.equal(JSON.parse(compatible).schemaVersion, 4); assert.ok((await page.locator('#backupMsg').textContent()).includes('不含申请追踪'));
        await page.locator('#restoreMode').selectOption('replace'); await page.locator('#backupFile').setInputFiles({ name: 'synthetic-compatible-v4.json', mimeType: 'application/json', buffer: compatible }); await page.locator('#btnApplyRestore').waitFor({ state: 'visible' }); assert.ok((await page.locator('#restorePreview').textContent()).includes('移除档案 0、申请 1')); assert.equal((await read()).applications.length, 1); await workspacePage(page, 'applications');
        if (withExtension) { const logs = await rpc(page, 'diagnostics:read'); for (const secret of ['合成阶段五公司', '合成备注', 'must-not-store', api.base]) assert.ok(!JSON.stringify(logs).includes(secret)); }
      });
      const beforeRestart = (await read()).applications; await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      await t.test('刷新及整个浏览器重启后记录、待办、备注和历史完全一致', async () => {
        assert.deepEqual((await read()).applications, beforeRestart); await page.reload(); await page.locator('#appCount').filter({ hasText: '全部' }).waitFor(); await page.locator('.application-open').first().click(); await page.locator('#appDetail').waitFor({ state: 'visible' }); assert.equal(await page.locator('#appNotes').inputValue(), beforeRestart[0].notes); assert.equal(await page.locator('#appTodoList input:checked').count(), 1); assert.equal(api.calls.length, 0); assert.deepEqual(errors, []);
      });
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 真实点击仅发生在本地合成职位页，涵盖提交反馈、跨页面成功和卡片权限。
test('阶段五岗位：识别、直填、提交结果确认、去重和重启', { timeout: 180000 }, async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'stage5-jobs-')); const api = await serve(); let context; let page; let options; let worker; let extensionId; let frame; const errors = [];
  // 通过工具栏相同的后台管理器打开卡片，令牌仍由真实会话管理器创建。
  const open = async () => { await page.bringToFront(); const loaded = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) }); await worker.evaluate(async (url) => { const tab = (await chrome.tabs.query({ active: true })).find((row) => row.url === url); await floatingPanel.open(tab.id); }, page.url()); frame = await loaded; await frame.locator('#jobScan').waitFor(); };
  // 使用设置页读取实际持久库，不允许网页内容脚本访问。
  const read = async () => (await rpc(options, 'localapply:read')).database;
  try {
    context = await launch(profile); context.setDefaultTimeout(10000); ({ worker, extensionId } = await extension(context)); context.on('page', (item) => item.on('pageerror', (error) => errors.push(error.message)));
    options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); page = await context.newPage(); await page.goto(api.base + '/test-pages/phase5-job.html'); await open(); try { await frame.locator('#jobForm').waitFor({ state: 'visible' }); } catch { throw new Error('岗位识别卡片未就绪：' + await frame.locator('#jobStatus').textContent() + '；界面错误：' + errors.join(' / ')); }
    await t.test('JSON-LD 只选当前岗位，不选推荐，无 Key、不上传、不自动建记录', async () => {
      assert.equal(await frame.locator('#jobCompany').inputValue(), '合成科技有限公司'); assert.equal(await frame.locator('#jobTitle').inputValue(), '合成 AI 开发工程师'); assert.equal(await frame.locator('#jobLocation').inputValue(), '合成甲城'); assert.equal((await read()).applications.length, 0); assert.equal(await page.evaluate(() => __stage5Submissions), 0); assert.equal(api.calls.length, 0); assert.equal(await frame.locator('.panel-tabs button').count(), 2);
    });
    await t.test('取消不保存，确认收藏后重复操作不会创建第二条申请', async () => {
      page.once('dialog', (dialog) => dialog.dismiss()); await frame.locator('#jobSave').click(); assert.equal((await read()).applications.length, 0);
      page.once('dialog', (dialog) => dialog.accept()); await frame.locator('#jobSave').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已保存')); assert.equal((await read()).applications[0].status, 'saved');
      page.once('dialog', (dialog) => dialog.accept()); await frame.locator('#jobSave').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已复用')); assert.equal((await read()).applications.length, 1);
    });
    await t.test('一键填写只改变表单，不提交、不自动标记已投递', async () => {
      const db = await read(); for (const [fieldId, value] of [['builtin.name', '合成阶段五姓名'], ['builtin.phone', '13800000000'], ['builtin.email', 'stage5@example.test']]) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId: db.activeProfileId, fieldId, value } } });
      await frame.locator('#smartFillAll').click(); await frame.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('填写完成')); assert.equal(await page.locator('#syntheticName').inputValue(), '合成阶段五姓名'); assert.equal(await page.evaluate(() => __stage5Submissions), 0); assert.equal((await read()).applications[0].status, 'saved');
    });
    await t.test('用户实际提交失败或没有结果时，不能标记为已投递', async () => {
      await page.locator('#testOutcome').selectOption('failed'); await page.locator('#jobSubmit').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('失败')); await frame.locator('#jobScan').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('投递失败')); assert.equal(await frame.locator('#jobSuccess').isVisible(), false);
      await page.locator('#testOutcome').selectOption('cancel'); await page.locator('#jobSubmit').click(); assert.equal((await read()).applications[0].status, 'saved'); assert.equal(await page.evaluate(() => __stage5Submissions), 2);
    });
    await t.test('成功反馈提出确认，取消仍收藏，明确确认后同一条记录才变为已投递', async () => {
      await page.locator('#testOutcome').selectOption('success'); await page.locator('#jobSubmit').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('投递成功')); assert.equal((await read()).applications[0].status, 'saved');
      await frame.locator('#jobScan').click(); await frame.locator('#jobSuccess').waitFor({ state: 'visible' }); page.once('dialog', (dialog) => dialog.dismiss()); await frame.locator('#jobConfirmApplied').click(); assert.equal((await read()).applications[0].status, 'saved');
      page.once('dialog', (dialog) => dialog.accept()); await frame.locator('#jobConfirmApplied').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已确认记录')); const row = (await read()).applications[0]; assert.equal(row.status, 'applied'); assert.ok(row.appliedAt); assert.equal(row.history.at(-1).status, 'applied'); assert.equal((await read()).applications.length, 1);
      await frame.locator('#jobScan').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已有第')); assert.equal(await frame.locator('#jobSuccess').isVisible(), false);
      await page.screenshot({ path: path.join(testRoot, 'stage5-job-confirmed.png'), fullPage: true });
    });
    await t.test('显式新轮次可再次申请，跳转成功页后仍使用原岗位候选', async () => {
      await frame.locator('#jobNewRound').check(); page.once('dialog', (dialog) => dialog.accept()); await frame.locator('#jobSave').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已保存')); assert.equal((await read()).applications.length, 2);
      await page.locator('#testOutcome').selectOption('cancel'); await page.locator('#jobSubmit').click(); await page.locator('#testOutcome').selectOption('navigate'); await page.locator('#jobSubmit').click(); await page.waitForURL(api.base + '/test-pages/phase5-success.html'); await open(); await frame.locator('#jobSuccess').waitFor({ state: 'visible' }); assert.equal(await frame.locator('#jobTitle').inputValue(), '合成 AI 开发工程师');
      assert.equal((await read()).applications.find((row) => row.round === 2).status, 'saved'); page.once('dialog', (dialog) => dialog.accept()); await frame.locator('#jobConfirmApplied').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已确认记录')); assert.ok((await read()).applications.every((row) => row.status === 'applied'));
    });
    await t.test('内容脚本不能借岗位入口读库，直接打开成功页也不会产生投递建议', async () => {
      const denied = await worker.evaluate(async (url) => { const tab = (await chrome.tabs.query({})).find((item) => item.url === url); const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => chrome.runtime.sendMessage({ type: 'jobs:scan' }) }); return result.result; }, page.url()); assert.equal(denied.ok, false);
      await frame.locator('#panelClose').click(); const direct = await context.newPage(); await direct.goto(api.base + '/test-pages/phase5-success.html'); const previous = page; page = direct; await open(); await frame.waitForFunction(() => !document.getElementById('jobScan').disabled); assert.equal(await frame.locator('#jobSuccess').isVisible(), false); await direct.close(); page = previous; assert.equal((await read()).applications.length, 2);
    });
    const beforeRestart = (await read()).applications; await context.close(); context = await launch(profile); context.setDefaultTimeout(10000); ({ worker, extensionId } = await extension(context)); options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html#applications`); await options.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
    await t.test('真实进程重启保留岗位和事件，临时成功会话不冒充新申请', async () => {
      assert.deepEqual((await read()).applications, beforeRestart); page = await context.newPage(); await page.goto(api.base + '/test-pages/phase5-job.html'); await open(); await frame.locator('#jobForm').waitFor({ state: 'visible' }); assert.equal(await frame.locator('#jobSuccess').isVisible(), false); assert.equal(api.calls.length, 0); assert.deepEqual(errors, []);
    });
  } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
});

// 使用损坏、歧义及缺失元数据验证保守回退，所有页面修改只作用于合成夹具。
test('阶段五岗位边界：DOM回退、标题、缺失信息及异步成功', { timeout: 60000 }, async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'stage5-job-boundaries-')); const api = await serve(); let context;
  try {
    context = await launch(profile); context.setDefaultTimeout(10000); const { worker, extensionId } = await extension(context); const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
    const page = await context.newPage(); await page.goto(api.base + '/test-pages/phase5-job.html'); const ready = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) });
    const tabId = await worker.evaluate(async (url) => { const tab = (await chrome.tabs.query({})).find((item) => item.url === url); await floatingPanel.open(tab.id); return tab.id; }, page.url()); let frame = await ready; await frame.locator('#jobForm').waitFor({ state: 'visible' });
    // 直接调用生产的可信内容脚本消息，只检查候选，不写个人资料。
    const inspect = () => worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'jobs:inspect' }, { frameId: 0 }), tabId);
    await t.test('损坏及多个不相关 JSON-LD 回退详情区，不读推荐岗位或表单值', async () => {
      await page.evaluate(() => { const script = document.querySelector('script[type="application/ld+json"]'); script.textContent = '{broken'; const other = document.createElement('script'); other.type = 'application/ld+json'; other.textContent = JSON.stringify([{ '@type': 'JobPosting', title: '错误推荐甲', url: '/jobs/other-a' }, { '@type': 'JobPosting', title: '错误推荐乙', url: '/jobs/other-b' }]); document.head.append(other); });
      const view = await inspect(); assert.equal(view.ok, true); assert.equal(view.candidate.companyName, '合成科技有限公司'); assert.equal(view.candidate.jobTitle, '合成 AI 开发工程师'); assert.equal(view.candidate.jobId, '');
      const privacy = await worker.evaluate(async (id) => { const [result] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => { let reads = 0; for (const input of document.querySelectorAll('input')) Object.defineProperty(input, 'value', { configurable: true, get() { reads++; throw new Error('禁止读取合成私人值'); } }); const result = LocalApplyJobRecognizer.inspect(); return { reads, title: result.candidate.jobTitle }; } }); return result.result; }, tabId); assert.equal(privacy.reads, 0); assert.equal(privacy.title, view.candidate.jobTitle);
    });
    await t.test('明确岗位 URL 的页面标题可作为末级候选，跟踪参数不入库', async () => {
      // URL 变化必须撤销旧卡片授权，测试随后重新打开，不沿用已失效的 iframe。
      await worker.evaluate((id) => floatingPanel.close(id), tabId);
      await page.evaluate(() => { document.querySelector('main h1').remove(); document.title = '合成标题工程师 | 合成招聘'; history.pushState({}, '', '/jobs/SYN-TITLE?token=synthetic-hidden&utm_source=test'); });
      const view = await inspect(); assert.equal(view.candidate.jobTitle, '合成标题工程师'); assert.equal(view.candidate.jobId, 'SYN-TITLE'); assert.equal(view.candidate.jobUrl, api.base + '/jobs/SYN-TITLE');
      const reopened = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) }); await worker.evaluate((id) => floatingPanel.open(id), tabId); frame = await reopened; await frame.locator('#jobForm').waitFor({ state: 'visible' });
    });
    await t.test('缺少公司时可在卡片补全并确认收藏，未补全不能保存', async () => {
      await page.locator('[data-company]').evaluate((element) => element.remove()); await frame.locator('#jobScan').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('不完整')); assert.equal(await frame.locator('#jobForm').isVisible(), true); await frame.locator('#jobSave').click(); assert.equal((await rpc(options, 'localapply:read')).database.applications.length, 0);
      await frame.locator('#jobCompany').fill('合成手动补全公司'); page.once('dialog', (dialog) => dialog.accept()); await frame.locator('#jobSave').click(); await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('已保存')); assert.equal((await rpc(options, 'localapply:read')).database.applications[0].status, 'saved');
      await page.evaluate(() => { const company = document.createElement('p'); company.dataset.company = ''; company.textContent = '合成手动补全公司'; document.querySelector('main').prepend(company); });
    });
    await t.test('异步成功只提示确认，提交中和取消确认均不改成已投递', async () => {
      // 故障上下文仅来自本地合成页面，不输出真实资料或凭据。
      await worker.evaluate(() => { chrome.runtime.onMessage.addListener((message, sender) => { if (message.type === 'jobs:submitted') globalThis.__stage5Sender = { url: sender.url, tabUrl: sender.tab?.url }; }); });
      await page.locator('#testOutcome').selectOption('async'); await page.locator('#jobSubmit').click(); assert.equal((await rpc(options, 'localapply:read')).database.applications[0].status, 'saved');
      try { await frame.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('投递成功')); } catch { throw new Error('异步成功未提示：' + JSON.stringify(await worker.evaluate(async () => ({ sender: globalThis.__stage5Sender, sessions: await chrome.storage.session.get('localapply.jobSessions') })))); }
      await frame.locator('#jobScan').click(); await frame.locator('#jobSuccess').waitFor({ state: 'visible' }); page.once('dialog', (dialog) => dialog.dismiss()); await frame.locator('#jobConfirmApplied').click(); assert.equal((await rpc(options, 'localapply:read')).database.applications[0].status, 'saved'); assert.equal(await page.evaluate(() => __stage5Submissions), 1); assert.equal(api.calls.length, 0);
    });
    await t.test('卡片关闭后新成功显示右下角提示，点击才核对，不自动写入', async () => {
      await frame.locator('#panelClose').click(); await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').style.display === 'none'); await page.locator('#applicationResult').evaluate((element) => { element.textContent = ''; });
      await options.waitForFunction(async () => (await chrome.storage.session.get('localapply.jobSessions'))['localapply.jobSessions']?.[0]?.feedback === 'unknown');
      await page.locator('#testOutcome').selectOption('success'); await page.locator('#jobSubmit').click(); await page.locator('#wsa-floatbar-host').waitFor({ state: 'visible' });
      const cdp = await context.newCDPSession(page); const tree = await cdp.send('Accessibility.getFullAXTree'); assert.ok(tree.nodes.some((node) => node.name?.value?.includes('检测到投递成功，点击核对岗位'))); await cdp.detach();
      assert.equal((await rpc(options, 'localapply:read')).database.applications[0].status, 'saved'); await page.screenshot({ path: path.join(testRoot, 'stage5-job-notice.png'), fullPage: true });
      const opened = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) }); const box = await page.locator('#wsa-floatbar-host').boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); frame = await opened; await frame.locator('#jobSuccess').waitFor({ state: 'visible' }); assert.equal((await rpc(options, 'localapply:read')).database.applications[0].status, 'saved');
    });
  } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
});

// 旧经历命令仍用于备份和历史兼容夹具；新的简历编辑器不再提供经历模块入口。
async function addResumeEntry(page, kind, title) {
  return page.evaluate(async ({ kind, title }) => {
    const profileId = document.getElementById('entryProfile').value;
    const { result } = await dataCommand('createEntry', { profileId, kind, title });
    await reloadDataState(); return result;
  }, { kind, title });
}

// v2 阶段三回归只使用合成复合控件；先确认子控件和网站操作不会生成个人字段。
test('新版阶段三：复合控件误识别回归', { timeout: 60000 }, async () => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'composites-')); const api = await serve(); let context;
  try {
    context = await launch(profile); const { worker, extensionId } = await extension(context);
    const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    const page = await context.newPage(); await page.goto(api.base + '/test-pages/phase3-composites.html');
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, page.url());
    const view = await rpc(options, 'learning:scanPage', { tabId, confirmed: true });
    const labels = view.rows.map((row) => row.field.label);
    assert.ok(!labels.includes('月'), '“月”必须归入毕业时间，而非未知字段');
    assert.ok(!labels.includes('+86'), '“+86”必须归入电话组件');
    assert.ok(!labels.includes('同步更新在线简历'), '网站操作复选框不属于个人资料');
    assert.equal(labels.filter((label) => label === '毕业时间').length, 1);
    assert.equal(labels.filter((label) => label === '手机号').length, 1);
    assert.equal(api.calls.length, 0);
  } finally {
    if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

// 模拟旧页首次补注入，强制清除依赖后验证旧侧栏仍能建立完整的扫描器。
test('旧侧栏补注入：复合适配器在扫描器之前恢复', async () => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'inject-recovery-')); const api = await serve(); let context;
  try {
    context = await launch(profile); const { worker, extensionId } = await extension(context);
    const sidebar = await context.newPage(); await sidebar.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`); await sidebar.locator('#profileSel option').first().waitFor({ state: 'attached' });
    const page = await context.newPage(); await page.goto(api.base + '/test-pages/phase3-composites.html');
    const tabId = await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { globalThis.LocalApplyFieldAdapters = undefined; globalThis.LocalApplyPageScanner = undefined; } });
      return tab.id;
    }, page.url());
    assert.equal(await sidebar.evaluate((id) => injectContentScripts(id), tabId), true);
    const view = await rpc(sidebar, 'learning:scanPage', { tabId, confirmed: true });
    assert.ok(view.rows.some((row) => row.field.label === '毕业时间'));
    assert.ok(!view.rows.some((row) => ['月', '+86', '同步更新在线简历'].includes(row.field.label)));
    assert.equal(api.calls.length, 0);
  } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); await fs.rm(profile, { recursive: true, force: true }); }
});

// 新版阶段三增量验收复用真实后台、存储和填写器，模型只连接 loopback Mock。
test('新版阶段三：日期电话、覆盖确认、手填学习与选择性 AI', { timeout: 120000 }, async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'phase3-v2-')); const api = await serve(); let context; let options; let page; let worker; let extensionId; let view; let profileId;
  // 当前文档重扫仅取元数据，调用后建立新的字段/版本边界。
  const scan = async () => { const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, page.url()); view = await rpc(options, 'learning:scanPage', { tabId, confirmed: true }); return view; };
  // 所有单项操作都使用后台返回的会话，测试不直接调用内容脚本内部函数。
  const send = async (type, payload = {}) => { const out = await rpc(options, 'learning:' + type, { sessionId: view.sessionId, ...payload }); if (out.rows) view = out; return out; };
  const row = (label) => { const found = view.rows.find((item) => item.field.label === label); assert.ok(found, label); return found; };
  // 修改本地合成值后刷新来源，不沿用过期版本令牌。
  const setValue = async (fieldId, value) => { await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId, entryId: null, value } } }); if (view) await send('session'); };
  // 显式选择来源模拟人工配对；复合控件的写入和验证仍走实际页面事件。
  const fill = async (label, fieldId) => { const scanId = row(label).field.scanId; if (fieldId) await send('select', { scanId, fieldId }); await send('fill', { scanId, confirmed: true }); return row(label); };
  try {
    context = await launch(profile); context.setDefaultTimeout(10000); ({ worker, extensionId } = await extension(context));
    options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    profileId = (await rpc(options, 'localapply:read')).database.activeProfileId;
    for (const [fieldId, value] of [['builtin.name','合成复合姓名'], ['builtin.phone','+8613800000000'], ['builtin.birthDate','2028-02-29'], ['builtin.graduationDate','2028-06']]) await setValue(fieldId, value);
    page = await context.newPage(); await page.goto(api.base + '/test-pages/phase3-composites.html'); await scan();
    await t.test('分类只产生主字段，排除日期/地址子项、国码、安全和网站操作', async () => {
      const labels = view.rows.map((item) => item.field.label);
      for (const label of ['月','年','日','+86','同步更新在线简历','密码','短信验证码','我已阅读并同意隐私协议']) assert.ok(!labels.includes(label), label);
      assert.equal(row('毕业时间').field.layout, 'date:year-month'); assert.equal(row('手机号').field.layout, 'phone:country-number'); assert.equal(row('现居地址').field.layout, 'address:province-city-district');
      assert.ok(view.excluded.some((item) => item.category === 'site_action')); assert.ok(view.excluded.some((item) => item.category === 'security_control'));
      assert.equal(api.calls.length, 0);
    });
    await t.test('本地姓名和国码电话写入验证，无 AI 且不重复号码', async () => {
      assert.equal((await fill('姓名')).status, 'success'); assert.equal((await fill('手机号')).status, 'success');
      assert.equal(await page.locator('#phone').inputValue(), '13800000000'); assert.equal(await page.locator('#country').inputValue(), '+86');
      assert.equal(api.calls.length, 0); assert.equal(await page.locator('#sync-resume').isChecked(), false); assert.equal(await page.locator('#agreement').isChecked(), false);
      await send('remember', { scanId: row('手机号').field.scanId, confirmed: true });
    });
    await t.test('国际国码精确拆分，不支持的国家和缺失区号保持待确认', async () => {
      await page.locator('#phone').fill(''); await setValue('builtin.phone', '+44 2070000000'); assert.equal((await fill('手机号')).status, 'success');
      assert.equal(await page.locator('#country').inputValue(), '+44'); assert.equal(await page.locator('#phone').inputValue(), '2070000000');
      await page.locator('#phone').fill(''); await setValue('builtin.phone', '+81 9012345678'); assert.equal((await fill('手机号')).status, 'needs_confirmation'); assert.equal(await page.locator('#phone').inputValue(), '');
      await setValue('builtin.phone', '+8613800000000');
    });
    await t.test('年月合并写入，原生日期和文本日期包含真实闰年、格式与精度校验', async () => {
      assert.equal((await fill('毕业时间')).status, 'success'); assert.equal(await page.locator('#grad-year').inputValue(), '2028'); assert.equal(await page.locator('#grad-month').inputValue(), '06');
      assert.equal((await fill('出生日期')).status, 'success'); assert.equal(await page.locator('#native-date').inputValue(), '2028-02-29');
      assert.equal((await fill('入学时间', 'builtin.birthDate')).status, 'success'); assert.equal(await page.locator('#native-month').inputValue(), '2028-02');
      assert.equal((await fill('日期说明', 'builtin.birthDate')).status, 'success'); assert.equal(await page.locator('#text-date').inputValue(), '2028/02/29');
    });
    await t.test('拆分年月日缺日时不补一日，完整日期可填写并验证全部子项', async () => {
      assert.equal((await fill('可到岗日期', 'builtin.graduationDate')).status, 'needs_confirmation');
      for (const id of ['arrival-year','arrival-month','arrival-day']) assert.equal(await page.locator('#' + id).inputValue(), '');
      assert.equal((await fill('可到岗日期', 'builtin.birthDate')).status, 'success');
      assert.equal(await page.locator('#arrival-year').inputValue(), '2028'); assert.equal(await page.locator('#arrival-month').inputValue(), '2'); assert.equal(await page.locator('#arrival-day').inputValue(), '29');
    });
    await t.test('绑定日历弹层可跨年选择并更新组件状态，未知弹层明确不支持', async () => {
      await page.locator('#calendar-date').click(); await send('session'); assert.equal(view.rows.filter((item)=>item.field.label==='日历日期').length,1);
      assert.equal((await fill('日历日期', 'builtin.birthDate')).status, 'success'); assert.equal(await page.locator('#calendar-state').textContent(), '2028-02-29');
      assert.equal(await page.locator('#calendar-year').inputValue(), '2028'); assert.equal(await page.locator('#calendar-month').inputValue(), '2');
      // 通过合成页面钩子模拟不可关联的旧组件，真实写入仍由适配器执行。
      await page.evaluate(() => { document.getElementById('calendar-date').value = ''; document.getElementById('calendar-date').setAttribute('aria-controls', 'missing-calendar'); });
      assert.equal((await fill('日历日期', 'builtin.birthDate')).status, 'unsupported');
    });
    await t.test('日期超出范围或非法闰日不会写入，时间区间保留开始结束语义', async () => {
      await page.evaluate(() => { document.getElementById('native-date').value = ''; document.getElementById('native-date').min = '2028-03-01'; });
      assert.equal((await fill('出生日期')).status, 'failed'); assert.equal(await page.locator('#native-date').inputValue(), '');
      await page.evaluate(() => { document.getElementById('native-date').removeAttribute('min'); }); await setValue('builtin.birthDate','2027-02-29');
      assert.equal((await fill('出生日期')).status, 'needs_confirmation'); await setValue('builtin.birthDate','2028-02-29');
      await page.evaluate(() => { const block = document.createElement('fieldset'); block.innerHTML = '<legend>项目经历</legend><div class="form-item"><span class="label">开始时间</span><input placeholder="年"><input placeholder="月"></div><div class="form-item"><span class="label">结束时间</span><input placeholder="年"><input placeholder="月"></div>'; document.getElementById('application').append(block); });
      await send('session'); assert.equal(row('开始时间').field.type, 'month'); assert.equal(row('结束时间').field.type, 'month'); assert.notEqual(row('开始时间').field.semanticId, row('结束时间').field.semanticId);
    });
    await t.test('分级地址精确写入，缺少结构边界不猜测', async () => {
      const created = await rpc(options,'localapply:command',{request:{action:'createField',payload:{profileId,definition:{label:'合成结构地址',type:'text',group:'其他'},value:'合成省 / 合成市 / 合成区'}}}); await send('session');
      assert.equal((await fill('现居地址',created.result)).status,'success'); assert.equal(await page.locator('#city').inputValue(),'合成市');
    });
    await t.test('不同非空值默认保留，覆盖令牌防伪造并绑定最新网页旧值', async () => {
      await page.locator('#name').fill('合成网页原值'); let conflict = await fill('姓名'); assert.equal(conflict.status,'needs_confirmation'); assert.equal(await page.locator('#name').inputValue(),'合成网页原值');
      const denied = await options.evaluate(({ sessionId, scanId }) => chrome.runtime.sendMessage({type:'learning:fill',sessionId,scanId,confirmed:true,overwriteToken:'forged'}),{sessionId:view.sessionId,scanId:conflict.field.scanId}); assert.equal(denied.ok,false);
      await page.locator('#name').fill('合成网页再次修改'); await send('fill',{scanId:conflict.field.scanId,confirmed:true,overwriteToken:conflict.conflict.token}); assert.equal(row('姓名').status,'needs_confirmation'); assert.equal(await page.locator('#name').inputValue(),'合成网页再次修改');
      conflict = row('姓名'); await send('fill',{scanId:conflict.field.scanId,confirmed:true,overwriteToken:conflict.conflict.token}); assert.equal(row('姓名').status,'success'); assert.equal(await page.locator('#name').inputValue(),'合成复合姓名');
    });
    await t.test('手填新字段确认后保存；原网页值验证成功后学习，刷新直接复用', async () => {
      const revision = (await rpc(options,'localapply:read')).database.revision; await page.locator('#unknown').fill('合成手填新增资料'); await page.locator('#unknown').blur();
      assert.equal((await rpc(options,'localapply:read')).database.revision,revision); const scanId = row('资格附加说明').field.scanId;
      const read = await send('readField',{scanId}); const preview = await send('previewValue',{scanId,definition:{label:'资格附加说明',type:'text',group:'其他',aliases:[],options:[]},value:read.value,source:'web-confirmed'});
      assert.equal((await rpc(options,'localapply:read')).database.revision,revision); await send('commitValue',{scanId,token:preview.token,confirmed:true});
      assert.equal((await fill('资格附加说明')).status,'success'); await send('remember',{scanId,confirmed:true});
      await page.reload(); await scan(); assert.equal(row('资格附加说明').source,'memory'); assert.equal(row('资格附加说明').value,'合成手填新增资料');
      assert.equal((await fill('资格附加说明')).status,'success'); assert.equal(await page.locator('#unknown').inputValue(),'合成手填新增资料'); assert.equal(api.calls.length,0);
    });
    let frame;
    await t.test('卡片展示排除原因及覆盖差异，只有确认此项后覆盖', async () => {
      await page.locator('#wsa-floatbar-host').waitFor(); const loaded = page.waitForEvent('framenavigated',{predicate:(item)=>item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`)}); await page.locator('#wsa-floatbar-host').click(); frame = await loaded;
      await frame.locator('#profileSel option').first().waitFor({state:'attached'}); await page.locator('#name').fill('合成卡片冲突'); await frame.locator('#smartFillAll').click(); await frame.waitForFunction(()=>document.getElementById('smartStatus').textContent.includes('填写完成'));
      assert.equal(await page.locator('#name').inputValue(),'合成卡片冲突'); const card = frame.locator('.smart-row').filter({has:frame.getByRole('heading',{name:'姓名 · 待处理',exact:true})});
      await card.locator('.smart-overwrite summary').click(); await card.getByRole('button',{name:'确认覆盖此项'}).click(); assert.equal(await page.locator('#name').inputValue(),'合成卡片冲突');
      await card.locator('.smart-overwrite-consent').check(); await card.getByRole('button',{name:'确认覆盖此项'}).click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false'); assert.equal(await page.locator('#name').inputValue(),'合成复合姓名');
      assert.ok((await frame.locator('#smartExcluded').textContent()).includes('同步更新在线简历')); await page.screenshot({path:path.join(testRoot,'stage3-v2-composites.png'),fullPage:true});
    });
    await t.test('AI 仅发送所选未知字段，取消中止请求并可再次使用', async () => {
      await workspacePage(options, 'aiSettings');
      await options.locator('#provider').fill(api.base+'/v1'); await options.locator('#provider').press('Enter'); await options.evaluate(()=>flushSaves()); await options.locator('#apiKey').fill('synthetic-v2-key'); await options.locator('#saveKey').click(); await options.evaluate(()=>flushCredentials()); await options.locator('#manualModel').check(); await options.locator('#model').fill('synthetic-field-model'); await options.locator('#model').press('Tab'); await options.evaluate(()=>flushSaves());
      await frame.locator('#smartAI').click(); await frame.waitForFunction(()=>document.getElementById('smartStatus').className==='err'); assert.equal(api.calls.length,0);
      const card = frame.locator('.smart-row').filter({has:frame.locator('h4').filter({hasText:'合成候选补充偏好'})}); await card.locator('.smart-ai-check').check(); await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'});
      const payload = JSON.parse(await frame.locator('#smartAIPayload').textContent()); assert.deepEqual(payload.fields.map((field)=>field.label),['合成候选补充偏好']); assert.ok(!JSON.stringify(payload).includes('合成手填新增资料'));
      api.modelApi.fieldHold = true; const started = new Promise((resolve)=>{api.modelApi.onField=resolve;}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await started;
      await frame.locator('#smartAICancel').click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false'); assert.ok((await frame.locator('#smartStatus').textContent()).includes('取消'));
      api.modelApi.releaseField(); api.modelApi.fieldHold = false; await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await frame.waitForFunction(()=>document.getElementById('smartStatus').textContent.includes('AI 返回 0'));
      assert.equal(await page.locator('#other-unknown').inputValue(),''); assert.equal(await page.evaluate(()=>__submitCount),0);
    });
    await t.test('AI 待人工选择及忽略建议不自动采用，用户确认后才移入忽略列表', async () => {
      const card=frame.locator('.smart-row').filter({has:frame.locator('h4').filter({hasText:'合成候选补充偏好'})});
      for (const action of ['needs_user_choice','skip_non_resume_control']) {
        api.modelApi.fieldReply=(payload)=>JSON.stringify({suggestions:[{scanId:payload.fields[0].scanId,existingFieldId:null,definition:null,sourceRef:null,confidence:0.1,action}]});
        await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false');
        assert.equal(await card.count(),1); assert.equal(await page.locator('#other-unknown').inputValue(),'');
        if(action==='needs_user_choice') { assert.ok((await card.textContent()).includes('AI 无法确定')); assert.equal(await card.locator('.smart-apply-suggestion').count(),0); }
      }
      await card.getByRole('button',{name:'确认本次忽略',exact:true}).click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false'); assert.equal(await card.count(),0); assert.ok((await frame.locator('#smartExcluded').textContent()).includes('合成候选补充偏好'));
    });
    await t.test('页面导航释放运行中的 AI 和未确认候选，不产生迟到保存', async () => {
      await frame.locator('#smartExcluded summary').click(); await frame.getByRole('button',{name:'恢复此字段',exact:true}).click();
      const card=frame.locator('.smart-row').filter({has:frame.locator('h4').filter({hasText:'合成候选补充偏好'})}); await card.locator('.smart-ai-check').check(); await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'});
      api.modelApi.fieldHold=true; const started=new Promise((resolve)=>{api.modelApi.onField=resolve;}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await started;
      const oldSession=await frame.locator('#tab-smart').getAttribute('data-session-id'); const before=(await rpc(options,'localapply:read')).database.revision; await page.reload();
      const old=await options.evaluate((sessionId)=>chrome.runtime.sendMessage({type:'learning:session',sessionId}),oldSession); assert.equal(old.ok,false); api.modelApi.releaseField(); api.modelApi.fieldHold=false; assert.equal((await rpc(options,'localapply:read')).database.revision,before);
    });
    await t.test('完整浏览器重启保留复合规则和个人字段，备份含结构不含 Key', async () => {
      await context.close(); context = await launch(profile); ({worker,extensionId}=await extension(context)); options=await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.locator('#entryProfile option').first().waitFor({state:'attached'}); page=await context.newPage(); await page.goto(api.base+'/test-pages/phase3-composites.html'); await scan();
      assert.equal(row('手机号').source,'memory'); assert.equal(row('资格附加说明').source,'memory'); assert.equal((await fill('手机号')).status,'success'); assert.equal((await fill('资格附加说明')).status,'success');
      const backup=(await rpc(options,'localapply:exportBackup')).backup; assert.ok(JSON.stringify(backup).includes('phone:country-number')); assert.ok(!JSON.stringify(backup).includes('synthetic-v2-key'));
      await page.screenshot({path:path.join(testRoot,'stage3-v2-restarted.png'),fullPage:true});
    });
  } finally { if (context) await context.close(); await new Promise((resolve)=>api.server.close(resolve)); await fs.rm(profile,{recursive:true,force:true,maxRetries:3}); }
});

// 本地夹具仅绑定 loopback；两种 AI 协议只返回合成响应，页面限制在 test-pages。
async function serve() {
  const calls = [];
  const modelRequests = [];
  const modelApi = { status: 200, data: { data: [{ id: 'synthetic-local' }, { id: 'synthetic-other' }, { id: 'synthetic-local' }] }, hold: false };
  let frameworkBundle = null; // 真正的 React/Vue 仅临时打包到测试响应，不写入发行资源。
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
    if (['/v1/models', '/models'].includes(pathname) && req.method === 'GET') {
      modelRequests.push({ authorization: req.headers.authorization, method: req.method, pathname });
      // 保留一次请求用于验证切换服务商后迟到响应不会污染新列表。
      const respond = () => { if (res.writableEnded) return; res.writeHead(modelApi.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(modelApi.data)); };
      if (modelApi.hold) { modelApi.release = respond; modelApi.onRequest(); } else respond();
      return;
    }
    if (pathname === '/responses' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body); const content = request.input?.at(-1)?.content;
      const probe = Array.isArray(content) && content.some((part) => part.type === 'input_text' && part.text.includes('读取附件图片中唯一的8位数字'));
      const file = Array.isArray(content) && content.find((part) => part.type === 'input_file');
      const inputType = file ? file.filename.split('.').at(-1) : 'image';
      calls.push({ authorization: req.headers.authorization, model: request.model, probe, inputType, protocol: 'responses', pathname,
        store: request.store, stream: request.stream, imageCount: Array.isArray(content) ? content.filter((part) => part.type === 'input_image').length : 0 });
      // 只对正式解析注入错误，验证用户可直接看到服务端拒绝且不会偷偷重试。
      if (!probe && modelApi.chatStatus) { res.writeHead(modelApi.chatStatus); res.end('{}'); return; }
      if (probe && inputType !== 'image') { res.writeHead(400); res.end('{}'); return; }
      const response = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
        text: probe ? '73185204' : modelApi.chatContent || '正常' }] }] };
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
      return;
    }
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (request.messages?.[0]?.content?.includes('你是网申字段语义分类器')) {
        calls.push({ fieldAI: true, payload: JSON.parse(request.messages[1].content), system: request.messages[0].content });
        // 挂起字段响应验证真正取消与恢复，晚到的 Mock 响应不得产生保存或建议。
        const respond = () => { if (res.destroyed) return; const status = modelApi.fieldStatus || 200; res.writeHead(status, { 'Content-Type': 'application/json' });
          const content = modelApi.fieldReply ? modelApi.fieldReply(JSON.parse(request.messages[1].content)) : '{"suggestions":[]}'; res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
        if (modelApi.fieldHold) { modelApi.releaseField=respond; modelApi.onField?.(); } else respond(); return;
      }
      const content = request.messages?.at(-1)?.content;
      const probe = Array.isArray(content) && content.some((part) => part.type === 'text' && part.text.includes('读取附件图片中唯一的8位数字'));
      const file = Array.isArray(content) && content.find((part) => part.type === 'file')?.file;
      const inputType = file ? file.filename.split('.').at(-1) : 'image';
      calls.push({ authorization: req.headers.authorization, model: request.model, probe, inputType,
        imageCount: Array.isArray(content) ? content.filter((part) => part.type === 'image_url').length : 0, fileData: file?.file_data });
      if (!probe) modelApi.lastResumeSystem = request.messages?.[0]?.content; // 仅在本地合成测试中检查发送的目录元数据。
      // 与 Responses 共用正式请求故障开关，保留可选诊断的独立行为。
      if (!probe && modelApi.chatStatus) { res.writeHead(modelApi.chatStatus); res.end('{}'); return; }
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
    if (pathname === '/test-pages/phase3-frameworks.js') {
      frameworkBundle ||= require('esbuild').build({ entryPoints: [path.join(ROOT, 'test-pages/phase3-frameworks.js')], bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' } });
      const output = await frameworkBundle; res.setHeader('Content-Type', 'application/javascript'); res.end(output.outputFiles[0].contents); return;
    }
    if (!/^\/test-pages\/[a-z0-9-]+\.html$/.test(pathname)) { res.writeHead(404); res.end(); return; }
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

// v2 要求逐项选择发送字段；历史 Mock 用例显式勾选候选，保留原有错误/安全断言。
async function selectUnknownAI(ui) {
  const checks = ui.locator('.smart-ai-check');
  for (let index = 0; index < await checks.count(); index++) await checks.nth(index).check();
}

// 独立模块通过真实导航切换；旧用例不再依赖所有设置控件同时可见。
async function workspacePage(page, target) {
  await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
  await page.locator('.workspace-sidebar nav a[href="#' + target + '"]').click();
  await page.locator('[data-workspace-page="' + target + '"]').waitFor({ state: 'visible' });
}

// 先通过目录定位再点击更多，回归用例不能绕过真实界面操作隐藏字段。
async function expandResumeGroup(page, name) {
  await page.locator('#resumeToc').getByRole('button', { name, exact: true }).click();
  const group = page.locator('.resume-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const primary = group.locator('.resume-primary-record'); if (await primary.count() && (await primary.getAttribute('open')) === null) await primary.locator(':scope > summary').click();
  const toggle = (await primary.count() ? primary : group).locator('.resume-more-toggle[aria-expanded="false"]');
  if (await toggle.count()) await toggle.click();
}

// 通过真实控件建立保险库，测试口令及 Key 全为合成数据。
async function setupVault(page) {
  await workspacePage(page, 'aiSettings');
  await page.locator('#keyProtection').evaluate((details) => { details.open = true; });
  await page.locator('#vaultPassword').fill('synthetic-password');
  await page.locator('#vaultConfirm').fill('synthetic-password');
  await page.locator('#vaultSetup').click();
  await page.waitForFunction(async () => (await getState()).settings.vault.unlocked);
}

// 两种入口共用真实服务商交互验收：完整列表、当前项滚动定位、键盘选择和手输撤销。
async function checkProviderPicker(page) {
  const input = page.locator('#provider');
  const name = await input.inputValue();
  const count = await page.evaluate(() => LocalApplyProviders.entries(state.settings).length);
  await page.locator('#providerToggle').click();
  assert.equal(await input.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#providerList [role=option]').count(), count);
  const selected = page.locator('#providerList [aria-selected=true]');
  assert.equal(await selected.count(), 1);
  const currentId = await selected.getAttribute('data-provider-id');
  assert.ok((await selected.textContent()).includes(name));
  assert.ok((await selected.textContent()).includes('当前'));
  assert.equal(await selected.evaluate((item) => {
    const list = item.parentElement;
    return item.offsetTop >= list.scrollTop && item.offsetTop + item.offsetHeight <= list.scrollTop + list.clientHeight;
  }), true);
  const second = await page.locator('#providerList [role=option]').nth(1).getAttribute('data-provider-id');
  // 文字编辑不缩减候选项，Escape 恢复已保存项；键盘浏览也不立即写配置。
  await input.fill('尚未提交的服务商');
  assert.equal(await page.locator('#providerList [role=option]').count(), count);
  await input.press('Escape'); assert.equal(await input.inputValue(), name);
  await input.click(); await input.press('Home'); await input.press('ArrowDown'); await input.press('Enter');
  await page.evaluate(() => flushSaves());
  assert.equal(await page.evaluate(() => state.settings.provider), second);
  await input.click();
  assert.equal(await page.locator('#providerList [role=option]').count(), count);
  // 鼠标选择自定义项不会触发失焦重复创建，恢复本测试进入时的服务商。
  await page.locator('#providerList [data-provider-id="' + currentId + '"]').click();
  await page.evaluate(() => flushSaves());
  assert.equal(await input.inputValue(), name);
  await page.locator('#providerToggle').click();
  await page.screenshot({ path: path.join(ROOT, '.browser-tests', page.url().startsWith('file:') ? 'provider-picker-file.png' : 'provider-picker-extension.png') });
  await input.press('Escape');
}

// 测试模型只识别已知合成挑战；文件和图片仍由生产代码真实生成，其他业务调用不伪造。
async function detectModel(page) {
  const previous = await page.evaluate(() => document.body.dataset.workspaceActivePage);
  await workspacePage(page, 'aiSettings');
  await page.evaluate(() => {
    const original = LocalApplyProbes.createProbe;
    LocalApplyProbes.createProbe = () => original('73185204');
  });
  await page.locator('#btnDetectCapabilities').click();
  await page.waitForFunction(() => !document.getElementById('btnDetectCapabilities').disabled);
  assert.match(await page.locator('#capabilityStatus').textContent(), /图片 识别通过/);
  if (previous !== 'aiSettings') await workspacePage(page, previous);
}

// 两种真实入口均验证根路径 Responses、文件能力、确认导入及整个浏览器重启。
for (const withExtension of [true, false]) {
  test(`Responses 根入口：${withExtension ? '扩展后台' : '独立文件页'}的选择、识别和重启`, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'responses-'));
    const api = await serve(); let context;
    api.modelApi.data = { data: [{ id: 'gpt-6.1-sol' }] };
    try {
      context = await launch(profile, withExtension);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html`
        : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); await page.goto(url);
      await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      await workspacePage(page, 'aiSettings');
      await page.locator('#provider').fill(api.base + '/'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
      assert.equal(await page.locator('#customBase').inputValue(), api.base);
      await page.locator('#apiKey').fill('synthetic-responses-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
      await page.locator('#apiProtocol').selectOption('responses'); await page.evaluate(() => flushSaves());
      assert.equal(await page.locator('#chatEndpoint').textContent(), api.base + '/responses');
      await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取'));
      assert.equal(api.modelRequests.at(-1).pathname, '/models');
      await page.locator('#modelSelect').selectOption('gpt-6.1-sol');
      await page.locator('#btnTestKey').click(); await page.waitForFunction(() => document.getElementById('testResult').textContent.includes('连接正常'));
      assert.equal(api.calls.at(-1).protocol, 'responses'); assert.equal(api.calls.at(-1).store, false); assert.equal(api.calls.at(-1).stream, true);
      assert.equal(api.calls.at(-1).authorization, 'Bearer synthetic-responses-key');
      await detectModel(page);
      api.modelApi.chatContent = JSON.stringify({ basic: { name: { value: '合成 Responses 姓名', evidence: '合成 Responses 姓名', page: 1 } } });
      await workspacePage(page, 'pdfCard');
      await page.locator('#autoImportResume').uncheck(); // 保留原有可选手动校对回归。
      await page.locator('#pdfFile').setInputFiles(path.join(ROOT, 'test-pages/fake-scan.pdf'));
      await page.locator('#sendResume').waitFor({ state: 'visible' }); await page.locator('#sendResume').click();
      await page.locator('#importRow').waitFor({ state: 'visible' });
      // 审核区域先显示，数据库读取与逐项渲染随后结束；必须等待真实候选而非空容器。
      await page.locator('#pdfReview input[type="checkbox"]').first().waitFor();
      assert.ok((await page.locator('#pdfReview').textContent()).includes('姓名'));
      assert.equal(await page.evaluate(async () => (await sendMessage('localapply:read')).database.fieldValues.some((row) => row.value === '合成 Responses 姓名')), false);
      await page.locator('#selectAllResume').click(); await page.locator('#btnImport').click();
      await page.locator('#importRow').waitFor({ state: 'hidden' });
      // 草稿先隐藏、资料投影随后刷新；必须等确认导入整条异步操作结束再切换协议。
      await page.waitForFunction(() => !document.getElementById('btnImport').disabled);
      assert.equal(await page.evaluate(async () => (await sendMessage('localapply:read')).database.fieldValues.some((row) => row.value === '合成 Responses 姓名')), true);
      assert.equal(api.calls.at(-1).imageCount, 1);
      const requests = api.calls.length;
      await workspacePage(page, 'aiSettings');
      await page.locator('#apiProtocol').selectOption('chat-completions'); await page.evaluate(() => flushSaves());
      const direct = await page.evaluate(() => sendMessage('wsa:resumeRoute', { format: 'pdf' })); assert.equal(direct.ok, true); assert.equal(direct.route.mode, 'vision');
      await page.locator('#apiProtocol').selectOption('responses'); await page.evaluate(() => flushSaves());
      assert.equal(api.calls.length, requests);
      // 不同路径作为独立服务商，不能继承根入口的 Key/模型/协议。
      await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
      assert.equal(await page.locator('#apiProtocol').inputValue(), 'chat-completions');
      assert.equal(await page.evaluate(() => !!state.settings.keyStatus[state.settings.provider]), false);
      await page.locator('#provider').fill(api.base + '/'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
      // 重启前直接核对后台存储，避免仅凭输入框显示就假定协议已保存。
      assert.equal(await page.evaluate(async () => { const saved=(await sendMessage('wsa:getState')).state.settings; return saved.customProviders[saved.provider].protocol; }), 'responses');
      await context.close(); context = await launch(profile, withExtension);
      page = await context.newPage(); await page.goto(url); await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      assert.equal(await page.locator('#customBase').inputValue(), api.base);
      assert.equal(await page.locator('#apiProtocol').inputValue(), 'responses');
      assert.equal(await page.evaluate(() => !!state.settings.keyStatus[state.settings.provider]), true);
      assert.equal(api.calls.length, requests);
    } finally {
      if (context) await context.close();
      await new Promise((resolve) => api.server.close(resolve));
      assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep));
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  });
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
      await workspacePage(page, 'pdfCard');
      await page.locator('#autoImportResume').uncheck(); // 此组仍验证可选逐项校对流程。
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
        await workspacePage(page, 'aiSettings');
        assert.equal(await page.locator('#apiKey').isEditable(), true);
        assert.equal(await page.locator('#keyProtection').evaluate((details) => details.open), false);
        await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
        await page.locator('#apiKey').fill('synthetic-default-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
        const state = (await call('wsa:getState')).state; assert.equal(state.settings.vault.enabled, false);
        assert.equal(state.settings.keyStatus[state.settings.provider], true); assert.deepEqual(state.settings.apiKeys, {});
        await page.locator('#btnFetchModels').click(); await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取'));
        assert.equal(api.modelRequests.at(-1).authorization, 'Bearer synthetic-default-key');
      });
      await setupVault(page);
      // PDF 图像解码使用随包 WASM；仅允许本地 WebAssembly，不开放 JavaScript eval。
      assert.equal(await page.evaluate(async () => (await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))) instanceof WebAssembly.Module), true);
      await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
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
        await workspacePage(page, 'pdfCard');
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
        await workspacePage(page, 'resumeCenter');
        await page.locator('#newProfileName').fill('第二份简历'); await page.locator('#createResumeProfile').click();
        await page.waitForFunction((id) => document.getElementById('targetProfile').value !== id, primary);
        await prepare('resume.pdf', fixtures.pdf()); await analyze(); await confirm();
        const db = (await call('localapply:read')).database; const second = db.activeProfileId;
        assert.equal(db.entries.filter((e) => e.profileId === primary).length, 5); assert.equal(db.entries.filter((e) => e.profileId === second).length, 5);
        assert.equal(db.fieldValues.find((v) => v.profileId === second && v.fieldId === 'builtin.name' && v.entryId === null).value, 'Test Person');
        await workspacePage(page, 'resumeCenter');
        await page.locator('#resumeFieldsEditor').evaluate((details) => { details.open = true; });
        await page.getByRole('textbox', { name: '简历中心 · 姓名', exact: true }).fill('Center edit');
        await page.getByRole('textbox', { name: '简历中心 · 姓名', exact: true }).press('Tab');
        await page.waitForFunction(() => document.getElementById('centerStatus').textContent.includes('已保存'));
        assert.equal((await call('localapply:read')).database.fieldValues.find((v) => v.profileId === second && v.fieldId === 'builtin.name' && v.entryId === null).evidence, undefined);
      });
      await t.test('畸形文档、无效 AI 和取消进行中的请求均不写入资料', async () => {
        await workspacePage(page, 'pdfCard');
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
      await t.test('可选原文件诊断保留字节直传，拒绝旧文本入口，新型号无需检测可发送', async () => {
        api.modelApi.capabilities = { image: true, pdf: true, docx: true }; await detectModel(page);
        for (const [type, buffer] of [['docx', fixtures.docx()], ['pdf', fixtures.pdf()]]) {
          await prepare('original.' + type, buffer); await analyze();
          assert.equal(api.calls.at(-1).inputType, type); assert.equal(api.calls.at(-1).imageCount, 0);
          assert.ok(Buffer.from(api.calls.at(-1).fileData.split(',')[1], 'base64').equals(buffer)); await confirm();
        }
        const route = (await call('wsa:resumeRoute', { format: 'pdf' })).route; const count = api.calls.length;
        const oldPath = await page.evaluate(async (route) => sendMessage('wsa:aiExtractResume', { payload: { requestId: crypto.randomUUID(), type: 'pdf', mode: route.mode, routeToken: route.token, text: '不能通过文字入口解析简历' } }), route);
        assert.equal(oldPath.ok, false); assert.equal(api.calls.length, count);
        await workspacePage(page, 'aiSettings');
        await page.locator('#manualModel').check();
        await page.locator('#model').fill('unprobed-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
        await prepare('direct-unprobed.pdf', fixtures.pdf()); await analyze();
        assert.equal(api.calls.length, count + 1); assert.equal(api.calls.at(-1).probe, false); assert.equal(api.calls.at(-1).model, 'unprobed-model'); assert.ok(api.calls.at(-1).imageCount > 0); await page.locator('#cancelResume').click();
        await workspacePage(page, 'aiSettings');
        await page.locator('#model').fill('synthetic-local'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      });
      await t.test('可选诊断未通过也允许正式解析，候选校对前不写资料', async () => {
        await workspacePage(page, 'aiSettings');
        api.modelApi.probeAnswer = '支持图片和文件';
        await page.locator('#btnDetectCapabilities').click(); await page.waitForFunction(() => !document.getElementById('btnDetectCapabilities').disabled);
        assert.match(await page.locator('#capabilityStatus').textContent(), /识别未通过/);
        const count = api.calls.length; const revision = (await call('localapply:read')).database.revision; await prepare('diagnostic-unverified.pdf', fixtures.pdf()); await analyze();
        assert.equal(api.calls.length, count + 1); assert.equal(api.calls.at(-1).probe, false); assert.equal((await call('localapply:read')).database.revision, revision); await page.locator('#cancelResume').click();
      });
      const before = (await call('localapply:read')).database;
      await page.evaluate(() => { document.getElementById('resumeFieldsEditor').open = false; window.scrollTo(0, 0); });
      await page.screenshot({ path: path.join(testRoot, `phase2-${withExtension ? 'extension' : 'file'}.png`), fullPage: false });
      await context.close(); context = await launch(profile, withExtension);
      page = await context.newPage(); await page.goto(url); await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      await t.test('整个浏览器重启后资料不变、保险库锁定且可再次解锁', async () => {
        await workspacePage(page, 'aiSettings');
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
        await workspacePage(page, 'aiSettings');
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
    await t.test('历史重复经历命令保存两段教育与项目，编辑页不生成独立卡片', async () => {
      await workspacePage(options, 'resumeCenter');
      let firstId;
      for (const kind of ['education', 'project']) for (let index = 0; index < 2; index++) {
        const entryId = await addResumeEntry(options, kind, `合成${kind}${index}`); firstId ||= entryId;
      }
      const profileId = await options.locator('#entryProfile').inputValue();
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, entryId: firstId, fieldId: 'builtin.school', value: '合成测试学院' } } });
      assert.equal((await rpc(options, 'localapply:read')).database.fieldValues.find((row) => row.entryId === firstId && row.fieldId === 'builtin.school').value, '合成测试学院');
      assert.equal(await options.locator('#basicFields .entry-card,[data-add-entry-kind]').count(), 0);
      assert.equal(await options.locator('#legacyEntriesNotice').isVisible(), true);
    });
    await t.test('服务商输入支持 DeepSeek/Qwen 和 IP 自动创建，Key/模型隔离且本地接口可调用', async () => {
      await workspacePage(options, 'aiSettings');
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
      await checkProviderPicker(options);
      await choose('zhipu');
    });
    await t.test('先获取模型列表再选择，选择持久化且成功调用；失败可手填，旧响应不污染新服务商', async () => {
      // 模拟用户进入已保存的本地端点，初次选择必须来自实际 GET /models 响应。
      const choose = async (text) => {
        await options.locator('#provider').fill(text); await options.locator('#provider').press('Enter'); await options.evaluate(() => flushSaves());
      };
      await choose(base + '/v1'); await options.locator('#manualModel').check();
      await options.locator('#model').fill(''); await options.locator('#model').press('Tab');
      await options.locator('#manualModel').uncheck();
      await options.locator('#btnFetchModels').click();
      await options.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取 2 个模型'));
      assert.equal(modelRequests.at(-1).method, 'GET'); assert.equal(modelRequests.at(-1).authorization, undefined);
      assert.equal(await options.locator('#modelSelect').inputValue(), '');
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.model, '');
      await options.locator('#modelSelect').selectOption('synthetic-other');
      // 已选值不能成为下一次展开的过滤条件；视觉模型也使用完整的原生下拉。
      assert.deepEqual(await options.locator('#modelSelect option').evaluateAll((items) => items.map((item) => item.value)), ['', 'synthetic-local', 'synthetic-other']);
      assert.deepEqual(await options.locator('#visionModelSelect option').evaluateAll((items) => items.map((item) => item.value)), ['', 'synthetic-local', 'synthetic-other']);
      await options.locator('#visionModelSelect').selectOption('synthetic-local'); await options.evaluate(() => flushSaves());
      assert.equal((await rpc(options, 'wsa:getState')).state.settings.visionModel, 'synthetic-local');
      assert.equal(await options.locator('#visionModelSelect option[value="synthetic-other"]').count(), 1);
      await options.locator('#manualVisionModel').check(); await options.locator('#visionModel').fill('manual-vision-id'); await options.locator('#visionModel').press('Tab');
      assert.equal(await options.locator('#visionModelSelect option[value="synthetic-other"]').count(), 1);
      await options.locator('#visionModelSelect').selectOption('synthetic-local'); assert.equal(await options.locator('#manualVisionModel').isChecked(), false);
      await options.locator('#manualModel').check(); assert.equal(await options.locator('#modelSelect').isDisabled(), false);
      await options.locator('#modelSelect').selectOption('synthetic-other'); assert.equal(await options.locator('#manualModel').isChecked(), false);
      await options.locator('#btnTestKey').click();
      await options.waitForFunction(() => document.getElementById('testResult').textContent.includes('连接正常'));
      assert.equal(calls.at(-1).model, 'synthetic-other');
      await options.reload(); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      assert.equal(await options.locator('#modelSelect').inputValue(), 'synthetic-other');
      assert.equal(await options.locator('#modelSelect').isDisabled(), false);
      assert.equal(await options.locator('#modelSelect option[value="synthetic-local"]').count(), 1);
      assert.equal(await options.locator('#visionModelSelect').inputValue(), 'synthetic-local');
      await options.locator('#apiKey').fill('fake-catalog-key'); await options.locator('#saveKey').click(); await options.evaluate(() => flushCredentials());
      assert.equal(await options.locator('#modelSelect option[value="synthetic-local"]').count(), 0);
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
      await workspacePage(options, 'privacySettings');
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

// 补充授权边界：登录页不采集，SPA 导航撤销旧授权，内容脚本不能访问学习及 AI 入口。
test('阶段三边界：登录页、SPA 导航及内容脚本隔离', async () => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'learning-boundary-')); const api = await serve(); let context;
  try {
    context = await launch(profile); const { worker, extensionId } = await extension(context);
    const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    const page = await context.newPage(); await page.goto(api.base + '/test-pages/login-mock.html');
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, page.url());
    const login = await rpc(options, 'learning:scanPage', { tabId, confirmed: true }); assert.equal(login.rows.length, 0); assert.match(login.notice, /登录/);
    await page.goto(api.base + '/test-pages/generic.html'); const form = await rpc(options, 'learning:scanPage', { tabId, confirmed: true }); assert.ok(form.rows.length > 0);
    const blocked = await worker.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: async () => Promise.all(['learning:rules', 'learning:prepareAI', 'learning:recognize'].map((type) => chrome.runtime.sendMessage({ type }))) });
      return result.result;
    }, tabId);
    assert.ok(blocked.every((response) => response.ok === false && /仅允许扩展/.test(response.error)));
    await page.evaluate(() => history.pushState({}, '', '?step=other'));
    const response = await options.evaluate((sessionId) => sendMessage('learning:session', { sessionId }), form.sessionId); assert.equal(response.ok, false); assert.match(response.error, /导航/);
    const legacy = await options.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'wsa:getState' }), tabId); assert.equal(legacy.state.authorized, false); assert.equal(legacy.state.fields.length, 0);
    assert.equal(api.calls.length, 0);
  } finally {
    if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

// 阶段三真实浏览器闭环：合成招聘表、真实 React/Vue、Mock AI、UI 确认及本机持久化。
test('阶段三：授权、智能字段学习、真实框架、规则管理与重启', { timeout: 240000 }, async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'learning-')); const api = await serve();
  let context; let sidebar; let options; let page; let extensionId; const pageErrors = []; const leaks = [];
  // 固定系统提示以外的数据仅为脱敏标签及引用，Mock 不能读取真实个人资料。
  const goodReply = (payload) => JSON.stringify({ suggestions: payload.fields.map((field) => ({ scanId: field.scanId,
    existingFieldId: null, definition: { label: field.label, type: 'text', group: '求职补充', aliases: [], options: [] },
    sourceRef: field.label === '便捷联系号码' ? payload.sources.find((source) => source.fieldId === 'builtin.phone' && source.hasValue)?.ref || null : null, confidence: 1 })) });
  // 定位只匹配卡片标题，避免下拉选项中的同名字段造成误匹配。
  const card = (label) => sidebar.locator('.smart-row').filter({ has: sidebar.locator('h4').filter({ hasText: label }) });
  // 通过真实侧栏选择本地来源，不直接操纵学习服务的内存状态。
  const selectSource = async (label, fieldId) => {
    const db = (await rpc(sidebar, 'localapply:read')).database; const definition = db.fieldDefinitions.find((row) => row.fieldId === fieldId);
    await card(label).locator('.smart-source').selectOption({ label: definition.label });
    await card(label).locator('p').filter({ hasText: '用户已选择本地来源' }).waitFor();
  };
  // 每次明确授权当前招聘页；测试侧栏是扩展页面标签，因此先激活实际招聘页。
  const ready = () => sidebar.waitForFunction(() => document.getElementById('tab-smart').getAttribute('aria-busy') === 'false');
  const scan = async () => {
    const old = await sidebar.locator('#tab-smart').getAttribute('data-session-id'); await page.bringToFront(); await sidebar.locator('#smartPageConsent').check(); await sidebar.locator('#smartScan').click();
    try { await sidebar.waitForFunction((id) => document.getElementById('tab-smart').dataset.sessionId !== id && document.querySelectorAll('.smart-row').length > 0 && document.getElementById('tab-smart').getAttribute('aria-busy') === 'false', old); }
    catch (error) { throw new Error('扫描未完成：' + await sidebar.locator('#smartStatus').textContent(), { cause: error }); }
  };
  // 模型调用始终先展示 payload，再通过复选框确认发送。
  const recognize = async () => { await selectUnknownAI(sidebar); const oldToken = await sidebar.locator('#smartAIReview').getAttribute('data-token'); await sidebar.locator('#smartAI').click(); await sidebar.waitForFunction((token) => document.getElementById('smartAIReview').dataset.token !== token && document.getElementById('tab-smart').getAttribute('aria-busy') === 'false', oldToken); await sidebar.locator('#smartAIConsent').check(); await sidebar.locator('#smartAISend').click(); };
  try {
    context = await launch(profile); context.setDefaultTimeout(10000); ({ extensionId } = await extension(context));
    context.on('page', (newPage) => { newPage.on('pageerror', (error) => pageErrors.push(error.message)); newPage.on('console', (message) => { if (message.text().includes('synthetic-phase3-key')) leaks.push('发现凭据输出'); }); });
    options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    const db = (await rpc(options, 'localapply:read')).database; const profileId = db.activeProfileId;
    // 所有测试资料均合成，重复经历独立保存，不覆盖阶段二导入逻辑。
    for (const [fieldId, value] of [['builtin.name','合成阶段三姓名'], ['builtin.phone','13800000000'], ['builtin.email','phase3@example.test'], ['builtin.gender','女']]) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId, entryId: null, value } } });
    for (const [degree, school] of [['本科','合成本科学院'], ['硕士','合成硕士学院']]) {
      const entry = await rpc(options, 'localapply:command', { request: { action: 'createEntry', payload: { profileId, kind: 'education', title: '合成教育' } } });
      for (const [fieldId, value] of [['builtin.degree',degree], ['builtin.school',school]]) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId, entryId: entry.result, value } } });
    }
    for (const [label, type, value, choices] of [['可到岗日期','date','2027-01-12',[]], ['毕业月份','date','2028-06',[]], ['应聘身份','select','应届生',['应届生','社会招聘']], ['具备实习经历','boolean',true,[]], ['可出差城市','multiSelect',['合成甲城','合成乙城'],['合成甲城','合成乙城']], ['意向方向','select','技术',['技术','运营']]]) await rpc(options, 'localapply:command', { request: { action: 'createField', payload: { profileId, definition: { label, type, group: '求职', options: choices }, value } } });
    await workspacePage(options, 'aiSettings');
    await options.locator('#provider').fill(api.base + '/v1'); await options.locator('#provider').press('Enter'); await options.evaluate(() => flushSaves());
    await options.locator('#apiKey').fill('synthetic-phase3-key'); await options.locator('#saveKey').click(); await options.evaluate(() => flushCredentials());
    await options.locator('#manualModel').check(); await options.locator('#model').fill('synthetic-field-model'); await options.locator('#model').press('Tab'); await options.evaluate(() => flushSaves());
    sidebar = await context.newPage(); await sidebar.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`); await sidebar.locator('#profileSel option').first().waitFor({ state: 'attached' }); await sidebar.locator('#tabSmartBtn').click();
    page = await context.newPage(); await page.goto(api.base + '/test-pages/phase3-application.html'); await page.locator('#real-vue-name').waitFor(); await page.locator('#real-react-name').waitFor();
    await page.evaluate(() => { window.__blockedReads = 0; for (const id of ['private-password','captcha']) { const element = document.getElementById(id); Object.defineProperty(element, 'value', { get() { window.__blockedReads++; return 'must-not-read'; }, set() {} }); } });
    await t.test('未授权不扫描；授权后返回稳定 ID、控件类型、脱敏上下文且不读取认证值', async () => {
      const tabId = await context.serviceWorkers()[0].evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, page.url());
      const state = await sidebar.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'wsa:getState' }), tabId);
      assert.equal(state.state.fields.length, 0); assert.equal(state.state.authorized, false);
      await scan(); assert.ok(await sidebar.locator('.smart-row').count() >= 17); assert.equal(api.calls.length, 0);
      const text = await sidebar.locator('#tab-smart').textContent(); assert.ok(!text.includes('must-not-read')); assert.ok(!text.includes('验证码 ·')); assert.equal(await page.evaluate(() => __blockedReads), 0);
      assert.equal(await card('第一学历毕业院校').getAttribute('data-status'), 'matched');
      const before = await card('姓名 · 已匹配').first().getAttribute('data-scan-id'); await sidebar.locator('#smartRefresh').click(); assert.equal(await card('姓名 · 已匹配').first().getAttribute('data-scan-id'), before);
    });
    await t.test('真实 React/Vue 及回退组件必须由用户选择来源，未知字段默认不执行', async () => {
      for (const label of ['React受控姓名','React拒绝回退姓名','Vue受控姓名','Vue拒绝回退姓名']) await selectSource(label, 'builtin.name');
      // 私有定义跨网站只能作为通用建议，由测试用户显式勾选后才进入填写预览。
      for (const label of ['可到岗日期','毕业月份','应聘身份','具备实习经历','可出差城市','意向方向']) await card(label).locator('.smart-check').check();
      assert.equal(await page.locator('#real-react-name').inputValue(), ''); assert.equal(await page.locator('#real-vue-name').inputValue(), '');
      assert.equal(await card('便捷联系号码').getAttribute('data-status'), 'needs_confirmation');
    });
    await t.test('AI 预览接收方和脱敏字段；未勾选确认不联网，输入值不在 payload 中', async () => {
      api.modelApi.fieldReply = goodReply; await selectUnknownAI(sidebar); await sidebar.locator('#smartAI').click(); await sidebar.locator('#smartAIReview').waitFor({ state: 'visible' });
      const payload = await sidebar.locator('#smartAIPayload').textContent(); for (const value of ['13800000000','合成阶段三姓名','合成本科学院','synthetic-phase3-key','must-not-read']) assert.ok(!payload.includes(value), value);
      await sidebar.locator('#smartAISend').click(); assert.equal(api.calls.length, 0);
      await sidebar.locator('#smartAIReview').screenshot({ path: path.join(testRoot, 'stage3-ai-preview.png') });
      await sidebar.locator('#smartAIConsent').check(); await sidebar.locator('#smartAISend').click(); await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('AI 返回'));
      assert.ok(api.calls.at(-1).fieldAI); assert.equal(await card('便捷联系号码').getAttribute('data-status'), 'needs_confirmation');
    });
    await t.test('错误 JSON、限流、空结果及恶意输出后界面恢复，个人库没有被修改', async () => {
      const before = (await rpc(sidebar, 'localapply:read')).database.revision;
      for (const mode of ['json','429','malicious','empty']) {
        api.modelApi.fieldStatus = mode === '429' ? 429 : 200;
        api.modelApi.fieldReply = (payload) => mode === 'json' ? 'not-json' : mode === 'empty' ? '{"suggestions":[]}' : JSON.stringify({ suggestions: [{ scanId: payload.fields[0].scanId, existingFieldId: null, definition: { label: '<script>window.pwned=1</script>', type: 'text', group: '其他', aliases: [], options: [] }, sourceRef: null, confidence: 1 }] });
        await recognize(); await sidebar.waitForFunction((mode) => { const text = document.getElementById('smartStatus').textContent; return mode === 'json' ? text.includes('有效 JSON') : mode === '429' ? text.includes('429') : mode === 'empty' ? text.includes('AI 返回 0') : text.includes('校验'); }, mode);
        assert.equal((await rpc(sidebar, 'localapply:read')).database.revision, before); assert.equal(await page.evaluate(() => !!window.pwned), false);
      }
      api.modelApi.fieldStatus = 200; api.modelApi.fieldReply = goodReply; await recognize(); await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('AI 返回'));
    });
    await t.test('AI 新字段复制已有来源，确认前不入库，确认后个人值独立保存', async () => {
      await card('便捷联系号码').locator('.smart-apply-suggestion').click(); await card('便捷联系号码').locator('.smart-value-preview').click();
      const before = (await rpc(sidebar, 'localapply:read')).database; assert.equal(before.fieldDefinitions.some((def) => def.label === '便捷联系号码'), false);
      await card('便捷联系号码').locator('.smart-value-commit').click(); assert.equal((await rpc(sidebar, 'localapply:read')).database.revision, before.revision);
      await card('便捷联系号码').locator('.smart-value-consent').check(); await card('便捷联系号码').locator('.smart-value-commit').click(); await card('便捷联系号码').locator('.smart-value-commit').waitFor({ state: 'hidden' });
      const db = (await rpc(sidebar, 'localapply:read')).database; const def = db.fieldDefinitions.find((def) => def.label === '便捷联系号码'); assert.ok(def); assert.ok(!JSON.stringify(def).includes('13800000000')); assert.equal(db.fieldValues.find((row) => row.fieldId === def.fieldId).value, '13800000000'); assert.equal(db.mappingRules.length, 0);
    });
    await t.test('缺少内容时允许创建空字段，用户填写后再预览确认，AI 不生成实际值', async () => {
      await card('到岗交通方式').locator('.smart-apply-suggestion').click(); assert.equal(await card('到岗交通方式').locator('.smart-field-value').inputValue(), '');
      await card('到岗交通方式').locator('.smart-value-preview').click(); await card('到岗交通方式').locator('.smart-value-consent').check(); await card('到岗交通方式').locator('.smart-value-commit').click(); await card('到岗交通方式').locator('details').waitFor({ state: 'attached' });
      await sidebar.waitForFunction(() => [...document.querySelectorAll('.smart-row')].some((row) => row.querySelector('h4').textContent.includes('到岗交通方式') && row.dataset.status === 'missing_value'));
      await card('到岗交通方式').locator('summary').click(); await card('到岗交通方式').locator('.smart-new').uncheck(); await card('到岗交通方式').locator('.smart-field-value').fill('用户确认步行');
      await card('到岗交通方式').locator('.smart-value-preview').click(); await card('到岗交通方式').locator('.smart-value-consent').check(); await card('到岗交通方式').locator('.smart-value-commit').click();
      await sidebar.waitForFunction(() => [...document.querySelectorAll('.smart-row')].some((row) => row.querySelector('h4').textContent.includes('到岗交通方式') && row.dataset.status === 'matched'));
    });
    await t.test('网页手填的未知字段仅在主动读取及确认后保存', async () => {
      await page.locator('#web-note').fill('合成网页手填说明'); await card('资格附加说明').locator('summary').click(); await card('资格附加说明').locator('.smart-read').click();
      await sidebar.waitForFunction(() => [...document.querySelectorAll('.smart-field-value')].some((input) => input.value === '合成网页手填说明'));
      assert.equal(await card('资格附加说明').locator('.smart-field-value').inputValue(), '合成网页手填说明');
      await card('资格附加说明').locator('.smart-value-preview').click(); await card('资格附加说明').locator('.smart-value-consent').check(); await card('资格附加说明').locator('.smart-value-commit').click();
      await sidebar.waitForFunction(() => [...document.querySelectorAll('.smart-row')].some((row) => row.querySelector('h4').textContent.includes('资格附加说明') && row.dataset.status === 'matched'));
    });
    await t.test('一键填写逐项验证；本科/硕士来源正确，真实框架状态接受与回退均准确', async () => {
      await sidebar.locator('#smartFillAll').click(); await sidebar.locator('#smartFillReview').waitFor({ state: 'visible' });
      await sidebar.locator('#smartFillConsent').check(); await sidebar.locator('#smartRememberAfter').check(); await sidebar.locator('#smartFillConfirm').click();
      await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('填写完成'), null, { timeout: 60000 });
      assert.equal(await page.locator('#undergrad-school').inputValue(), '合成本科学院'); assert.equal(await page.locator('#master-school').inputValue(), '合成硕士学院');
      assert.equal(await page.evaluate(() => __frameworkProbe.react()), '合成阶段三姓名'); assert.equal(await page.evaluate(() => __frameworkProbe.vue()), '合成阶段三姓名');
      await page.evaluate(() => { __frameworkProbe.rerenderReact(); __frameworkProbe.rerenderVue(); });
      assert.equal(await page.locator('#real-react-name').inputValue(), '合成阶段三姓名'); assert.equal(await page.locator('#real-vue-name').inputValue(), '合成阶段三姓名');
      assert.equal(await card('React拒绝回退姓名').getAttribute('data-status'), 'failed'); assert.equal(await card('Vue拒绝回退姓名').getAttribute('data-status'), 'failed');
      assert.equal(await page.locator('#arrival-date').inputValue(), '2027-01-12'); assert.equal(await page.locator('#graduation-month').inputValue(), '2028-06'); assert.equal(await page.locator('#identity').inputValue(), '应届生'); assert.equal(await page.locator('#has-internship').isChecked(), true); assert.equal(await page.locator('#career').textContent(), '技术');
      assert.equal(await page.locator('input[name=cities]:checked').count(), 2); assert.equal(await page.locator('input[name=gender]:checked').inputValue(), '女');
      assert.equal(await page.evaluate(() => __submitCount), 0); assert.equal(await page.locator('#agreement').isChecked(), false); assert.equal(await page.evaluate(() => __blockedReads), 0);
      assert.ok((await rpc(sidebar, 'localapply:read')).database.mappingRules.length >= 8);
      await page.screenshot({ path: path.join(testRoot, 'stage3-filled-page.png'), fullPage: true }); await sidebar.locator('#tab-smart').screenshot({ path: path.join(testRoot, 'stage3-fill-results.png') });
    });
    await t.test('刷新页面必须重新授权，同类未知字段优先复用记忆且不再调用 AI', async () => {
      const calls = api.calls.length; await page.reload(); await page.locator('#real-vue-name').waitFor(); await scan();
      assert.ok((await card('便捷联系号码').textContent()).includes('网站记忆')); assert.equal(api.calls.length, calls);
    });
    await t.test('动态增加项目字段可被重新匹配，不自动调用模型', async () => {
      const before = await sidebar.locator('.smart-row').count(); await page.locator('#add-project').click(); await sidebar.locator('#smartRefresh').click();
      await sidebar.waitForFunction((count) => document.querySelectorAll('.smart-row').length > count, before); assert.equal(await card('项目名称').count(), 1);
    });
    await t.test('规则可禁用、撤销、改目标及删除，修改后不会沿用旧验证', async () => {
      sidebar.on('dialog', (dialog) => dialog.accept()); await sidebar.locator('#smartRules').click();
      const rule = sidebar.locator('.smart-rule').filter({ has: sidebar.locator('p').filter({ hasText: '便捷联系号码' }) });
      await rule.locator('.smart-rule-enabled').uncheck(); await rule.getByText('确认修改规则', { exact: true }).click(); await sidebar.locator('#smartRefresh').click();
      await ready();
      assert.ok(!(await card('便捷联系号码').textContent()).includes('网站记忆'));
      await sidebar.locator('#smartUndo').click(); await sidebar.locator('#smartRefresh').click(); await ready(); assert.ok((await card('便捷联系号码').textContent()).includes('网站记忆'));
      await sidebar.locator('#smartRules').click(); await rule.locator('.smart-rule-target').selectOption(JSON.stringify(['builtin.email', null])); await rule.getByText('确认修改规则', { exact: true }).click(); await sidebar.locator('#smartRefresh').click();
      await ready();
      assert.equal(await card('便捷联系号码').getAttribute('data-status'), 'needs_confirmation'); assert.ok((await card('便捷联系号码').textContent()).includes('重新确认'));
      await sidebar.locator('#smartRules').click(); await rule.getByText('删除规则', { exact: true }).click(); await sidebar.locator('#smartRefresh').click(); await ready(); assert.ok(!(await card('便捷联系号码').textContent()).includes('网站记忆'));
    });
    await t.test('完整备份含动态字段和规则，兼容旧版备份可下载且不含 Key', async () => {
      const exported = await rpc(sidebar, 'localapply:exportBackup'); assert.ok(exported.backup.database.fieldDefinitions.some((def) => def.label === '到岗交通方式')); assert.ok(exported.backup.database.mappingRules.length);
      assert.ok(!JSON.stringify(exported).includes('synthetic-phase3-key'));
      const download = sidebar.waitForEvent('download'); await sidebar.locator('#smartExportV3').click(); const file = await download;
      const compatible = JSON.parse(await fs.readFile(await file.path(), 'utf8')); assert.equal(compatible.database.schemaVersion, 3); assert.equal(compatible.database.mappingRules[0].semanticId, undefined);
      await rpc(sidebar, 'localapply:previewImport', { backup: exported.backup, mode: 'merge' });
    });
    await t.test('密钥锁定时手动扫描、规则和本地填写继续可用', async () => {
      await setupVault(options); await options.locator('#vaultLock').click(); await options.waitForFunction(async () => !(await getState()).settings.vault.unlocked);
      await scan(); assert.ok(await sidebar.locator('.smart-row').count() > 0); await selectUnknownAI(sidebar); await sidebar.locator('#smartAI').click(); await sidebar.waitForFunction(() => /锁定/.test(document.getElementById('smartStatus').textContent));
      await card('姓名 ·').first().getByText('单项填写预览', { exact: true }).click(); await sidebar.locator('#smartFillConsent').check(); await sidebar.locator('#smartFillConfirm').click(); await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('填写完成'));
      assert.equal(await page.locator('#applicant-name').inputValue(), '合成阶段三姓名');
    });
    const before = (await rpc(sidebar, 'localapply:read')).database;
    await context.close(); context = await launch(profile); ({ extensionId } = await extension(context));
    sidebar = await context.newPage(); await sidebar.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`); await sidebar.locator('#profileSel option').first().waitFor({ state: 'attached' }); await sidebar.locator('#tabSmartBtn').click();
    page = await context.newPage(); await page.goto(api.base + '/test-pages/phase3-application.html'); await page.locator('#real-react-name').waitFor();
    await t.test('整个浏览器重启后字段、实际值与规则保留，页面需重新授权', async () => {
      const after = (await rpc(sidebar, 'localapply:read')).database; assert.deepEqual(after, before); assert.equal(await sidebar.locator('#smartPageConsent').isChecked(), false); await scan(); assert.ok(await sidebar.locator('.smart-row').count() > 0);
      await sidebar.locator('#smartRules').click(); await sidebar.locator('#smartRulesPanel').screenshot({ path: path.join(testRoot, 'stage3-mapping-rules.png') });
    });
    await t.test('页面无未捕获错误、无 Key 日志泄漏、无真实提交', async () => { assert.deepEqual(pageErrors, []); assert.deepEqual(leaks, []); assert.equal(await page.evaluate(() => __submitCount), 0); });
  } finally {
    if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
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
      await workspacePage(page, 'aiSettings');
      assert.equal(await page.evaluate(() => !!globalThis.chrome?.runtime?.id), false);
      assert.equal(await page.locator('#standaloneNotice').isVisible(), true);
      assert.equal(await page.locator('#provider').isDisabled(), false);
      await page.locator('#provider').fill(base + '/v1'); await page.locator('#provider').press('Enter');
      await checkProviderPicker(page);
      await setupVault(page);
      await page.locator('#apiKey').fill('fake-file-only-key'); await page.locator('#apiKey').press('Tab');
      await page.locator('#btnFetchModels').click();
      await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('已获取 2 个模型'));
      assert.equal(modelRequests.at(-1).authorization, 'Bearer fake-file-only-key');
      await page.locator('#modelSelect').selectOption('synthetic-local');
      await page.locator('#btnTestKey').click();
      await page.waitForFunction(() => document.getElementById('testResult').textContent.includes('连接正常'));
      await page.locator('#visionModelSelect').selectOption('synthetic-other'); await page.evaluate(() => flushSaves());
      const requests = modelRequests.length;
      await page.reload(); await page.locator('#entryProfile option').first().waitFor({ state: 'attached' });
      assert.equal(await page.locator('#modelSelect').inputValue(), 'synthetic-local');
      assert.deepEqual(await page.locator('#visionModelSelect option').evaluateAll((items) => items.map((item) => item.value)), ['', 'synthetic-local', 'synthetic-other']);
      assert.equal(await page.locator('#visionModelSelect').inputValue(), 'synthetic-other');
      assert.equal(modelRequests.length, requests); // 刷新只恢复临时列表，不静默联网。
      // 文件页刷新会结束可选口令会话；列表可保留，使用受保护 Key 仍须解锁。
      await page.locator('#keyProtection').evaluate((details) => { details.open = true; });
      await page.locator('#vaultPassword').fill('synthetic-password'); await page.locator('#vaultUnlock').click();
      await page.evaluate(() => flushCredentials());
      await page.locator('#visionModelSelect').selectOption(''); await page.evaluate(() => flushSaves());
    });
    await t.test('本地文件 PDF 通过读取、视觉假接口、校对确认入库，原文件不持久化', async () => {
      await detectModel(page);
      await workspacePage(page, 'pdfCard');
      modelApi.chatContent = JSON.stringify({ basic: { name: { value: '合成文件姓名', evidence: '合成文件姓名', page: 1 } } });
      await page.locator('#autoImportResume').uncheck();
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
      await workspacePage(page, 'resumeCenter');
      await addResumeEntry(page, 'education', '合成文件教育');
      assert.equal(await page.locator('#basicFields .entry-card').count(), 0);
      assert.equal(await page.locator('#legacyEntriesNotice').isVisible(), true);
      await workspacePage(page, 'privacySettings');
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
      await workspacePage(page, 'aiSettings');
      modelApi.allowCors = false;
      await page.locator('#btnFetchModels').click();
      await page.waitForFunction(() => document.getElementById('modelsStatus').textContent.includes('CORS'));
      assert.equal(await page.locator('#modelApiHelp').evaluate((details) => details.open), true);
      assert.ok((await page.locator('#modelsEndpoint').textContent()).endsWith('/v1/models'));
      assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).isDisabled(), false);
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

// 真实网页中的扩展 iframe：自动类型检测不授予字段读取权限，所有资料仍由确认流程控制。
test('悬浮卡片：自动检测、填写、预览、日志与安全边界', { timeout: 90000 }, async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'floating-')); const api = await serve(); let context;
  try {
    context = await launch(profile); context.setDefaultTimeout(12000); const { worker, extensionId } = await extension(context);
    const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.locator('#entryProfile option').first().waitFor({ state: 'attached' });
    const db = (await rpc(options, 'localapply:read')).database;
    for (const [fieldId, value] of [['builtin.name','合成卡片姓名'],['builtin.phone','13800000000']]) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId: db.activeProfileId, fieldId, entryId: null, value } } });
    const page = await context.newPage(); await page.goto(api.base + '/test-pages/phase3-application.html'); await page.locator('#real-vue-name').waitFor();
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, page.url());
    await t.test('自动显示网申提示，但没有读取字段或调用模型', async () => {
      await page.locator('#wsa-floatbar-host').waitFor({ state: 'visible' });
      const rect = await page.locator('#wsa-floatbar-host').boundingBox(); const viewport = page.viewportSize();
      assert.ok(Math.abs(viewport.width - rect.x - rect.width - 32) < 2 && Math.abs(viewport.height - rect.y - rect.height - 96) < 2, '检测卡片默认与右侧留出 32px、底部留出 96px');
      const result = await options.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'wsa:getState' }), tabId);
      assert.equal(result.state.authorized, false); assert.equal(result.state.fields.length, 0); assert.equal(api.calls.length, 0);
      assert.equal(await page.locator('#wsa-floatbar-host').evaluate((host) => host.shadowRoot), null);
      await page.screenshot({ path: path.join(testRoot, 'application-prompt-bottom-right.png') });
      // 窄窗保持新卡片的留白与完整可见，恢复尺寸后再验证用户拖动。
      await page.setViewportSize({ width: 375, height: 360 });
      await page.waitForFunction(() => { const rect = document.getElementById('wsa-floatbar-host').getBoundingClientRect(); return rect.left >= 10 && rect.right <= innerWidth - 10 && rect.top >= 10 && innerHeight - rect.bottom >= 64; });
      await page.screenshot({ path: path.join(testRoot, 'application-prompt-narrow.png') });
      await page.setViewportSize(viewport);
    });
    await t.test('检测提示可拖动，松手不误打开，缩窗后仍在视口内', async () => {
      const before = await page.locator('#wsa-floatbar-host').boundingBox(); const viewport = page.viewportSize();
      await page.mouse.move(before.x + 45, before.y + 20); await page.mouse.down();
      await page.mouse.move(before.x - 140, before.y - 120, { steps: 8 }); await page.mouse.up();
      await page.waitForFunction((before) => { const rect = document.getElementById('wsa-floatbar-host').getBoundingClientRect(); return rect.left < before.x - 100 && rect.top < before.y - 100; }, before);
      const probe = await options.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'wsa:floatingProbe' }), tabId);
      assert.equal(probe.open, false); assert.equal((await options.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'wsa:getState' }), tabId)).state.authorized, false);
      assert.equal(api.calls.length, 0);
      await page.screenshot({ path: path.join(testRoot, 'application-prompt-dragged.png') });
      await page.setViewportSize({ width: 375, height: 360 });
      await page.waitForFunction(() => { const rect = document.getElementById('wsa-floatbar-host').getBoundingClientRect(); return rect.left >= 10 && rect.right <= innerWidth - 9 && rect.top >= 10 && rect.bottom <= innerHeight - 9; });
      await page.setViewportSize(viewport);
    });
    const panelLoaded = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) });
    await page.locator('#wsa-floatbar-host').click();
    // 扩展 iframe 位于封闭 Shadow DOM，但浏览器级测试仍能访问真正的 frame。
    await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').getBoundingClientRect().height > 300);
    const frame = await panelLoaded;
    assert.ok(frame, '悬浮扩展 iframe 应已加载'); await frame.locator('#profileSel option').first().waitFor({ state: 'attached' });
    await t.test('点击即扫描并批量填写，单项填写也无需授权或核对', async () => {
      assert.equal(await frame.locator('.panel-tabs button').count(), 2);
      assert.equal(await frame.locator('#smartPageConsent,#smartFillConsent,#smartFillReview').count(), 0);
      assert.equal(await page.locator('#applicant-name').inputValue(), '');
      await frame.getByRole('button', { name: '自动填写此页面', exact: true }).click();
      await frame.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('填写完成'));
      assert.equal(await page.locator('#applicant-name').inputValue(), '合成卡片姓名'); assert.equal(await page.evaluate(() => __submitCount), 0);
      assert.equal(await page.locator('#applicant-phone').inputValue(), '13800000000'); assert.equal(await page.locator('#preferred-contact').inputValue(), ''); assert.equal(api.calls.length, 0);
      await page.locator('#applicant-name').fill('');
      const card = frame.locator('.smart-row').filter({ has: frame.getByRole('heading', { name: '姓名 · 填写成功', exact: true }) });
      await card.getByRole('button', { name: '单项填写', exact: true }).click();
      await frame.waitForFunction(() => document.getElementById('tab-smart').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('#applicant-name').inputValue(), '合成卡片姓名');
      await page.screenshot({ path: path.join(testRoot,'floating-autofill.png'), fullPage: false });
    });
    await t.test('简历预览按当前档案展示，联系方式默认遮挡', async () => {
      await frame.locator('#resumeTab').click(); await frame.locator('#resumeContent .resume-section').first().waitFor();
      assert.ok((await frame.locator('#resumeContent').textContent()).includes('合成卡片姓名'));
      assert.ok(!(await frame.locator('#resumeContent').textContent()).includes('13800000000'));
      await frame.locator('#previewReveal').check(); assert.ok((await frame.locator('#resumeContent').textContent()).includes('13800000000'));
      await page.screenshot({ path: path.join(testRoot,'floating-resume.png'), fullPage: false });
    });
    await t.test('伪造嵌入及内容脚本不能读取资料或日志', async () => {
      const forgedLoaded = page.waitForEvent('framenavigated', { predicate: (item) => item.url().endsWith('?token=forged') });
      await page.evaluate((url) => { const iframe = document.createElement('iframe'); iframe.id = 'forged'; iframe.src = url; document.body.append(iframe); }, `chrome-extension://${extensionId}/panel/panel.html?token=forged`);
      const forged = await forgedLoaded;
      await forged.waitForFunction(() => typeof sendMessage === 'function');
      assert.ok(forged); const denied = await forged.evaluate(() => sendMessage('localapply:read')); assert.equal(denied.ok, false);
      await page.locator('#forged').evaluate((item) => item.remove());
      const blocked = await worker.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: () => chrome.runtime.sendMessage({ type: 'diagnostics:read' }) }))[0].result, tabId);
      assert.equal(blocked.ok, false);
    });
    await t.test('运行与报错日志可查看导出，且不泄漏凭据、个人值或 URL', async () => {
      const failed = await frame.evaluate(() => sendMessage('wsa:aiChat', { payload: { messages: [{ role: 'user', content: '合成隐私内容' }] } })); assert.equal(failed.ok, false);
      await frame.evaluate(() => dispatchEvent(new ErrorEvent('error', { error: new Error('sk-synthetic-log-private 合成隐私内容') })));
      await frame.locator('#diagnosticsPanel summary').click(); await frame.locator('#logsRefresh').click();
      await frame.waitForFunction(() => document.getElementById('logsOutput').textContent.includes('wsa.aiChat'));
      const logs = await rpc(options, 'diagnostics:read'); assert.ok(logs.rows.some((row) => row.level === 'ERROR'));
      for (const privateText of ['13800000000','合成卡片姓名','sk-synthetic-log-private','合成隐私内容','?private=']) assert.ok(!JSON.stringify(logs).includes(privateText));
      const downloadPromise = page.waitForEvent('download'); await frame.locator('#logsExport').click(); const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), 'localapply-diagnostics.json');
      const backup = (await rpc(options,'localapply:exportBackup')).backup; assert.ok(!JSON.stringify(backup).includes('page.presence'));
    });
    await t.test('AI 识别保留为可选操作，采用来源后可直接填写未知字段', async () => {
      await workspacePage(options, 'aiSettings');
      await options.locator('#provider').fill(api.base + '/v1'); await options.locator('#provider').press('Enter'); await options.evaluate(() => flushSaves());
      await options.locator('#apiKey').fill('synthetic-direct-fill-key'); await options.locator('#saveKey').click(); await options.evaluate(() => flushCredentials());
      await options.locator('#manualModel').check(); await options.locator('#model').fill('synthetic-field-model'); await options.locator('#model').press('Tab'); await options.evaluate(() => flushSaves());
      // Mock 只返回已发送的字段和来源引用，不能生成个人实际值。
      api.modelApi.fieldReply = (payload) => JSON.stringify({ suggestions: [{ scanId: payload.fields.find((field) => field.label === '便捷联系号码').scanId, existingFieldId: 'builtin.phone', definition: null, sourceRef: payload.sources.find((source) => source.fieldId === 'builtin.phone' && source.hasValue).ref, confidence: 0.99 }] });
      await frame.locator('#autoTab').click(); await frame.locator('.smart-row').filter({ has: frame.locator('h4').filter({ hasText: '便捷联系号码' }) }).locator('.smart-ai-check').check(); await frame.locator('#smartAI').click();
      await frame.waitForFunction(() => !document.getElementById('smartAIReview').hidden || document.getElementById('smartStatus').className === 'err');
      assert.equal(await frame.locator('#smartAIReview').isVisible(), true, await frame.locator('#smartStatus').textContent());
      assert.equal(api.calls.length, 0); assert.equal(await page.locator('#preferred-contact').inputValue(), '');
      await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click();
      await frame.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('AI 返回 1'));
      assert.equal(await page.locator('#preferred-contact').inputValue(), '');
      const card = frame.locator('.smart-row').filter({ has: frame.locator('h4').filter({ hasText: '便捷联系号码' }) });
      await card.locator('.smart-apply-suggestion').click(); await card.getByRole('button', { name: '单项填写', exact: true }).click();
      await frame.waitForFunction(() => document.getElementById('tab-smart').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('#preferred-contact').inputValue(), '13800000000'); assert.equal(api.calls.length, 1); assert.equal(await page.evaluate(() => __submitCount), 0);
    });
    await t.test('旧界面的扫描与填写确认流程继续兼容', async () => {
      const sidebar = await context.newPage(); await sidebar.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
      await sidebar.locator('#profileSel option').first().waitFor({ state: 'attached' }); await sidebar.locator('#tabSmartBtn').click(); await page.bringToFront();
      await sidebar.locator('#smartScan').click(); await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('请先勾选授权'));
      await sidebar.locator('#smartPageConsent').check(); await sidebar.locator('#smartScan').click();
      const card = sidebar.locator('.smart-row').filter({ has: sidebar.getByRole('heading', { name: '姓名 · 已匹配', exact: true }) });
      await card.waitFor(); await sidebar.waitForFunction(() => document.getElementById('tab-smart').getAttribute('aria-busy') === 'false');
      await page.locator('#applicant-name').fill(''); await card.getByRole('button', { name: '单项填写预览', exact: true }).click();
      assert.equal(await page.locator('#applicant-name').inputValue(), ''); await sidebar.locator('#smartFillConfirm').click();
      await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('勾选确认')); assert.equal(await page.locator('#applicant-name').inputValue(), '');
      await sidebar.locator('#smartFillConsent').check(); await sidebar.locator('#smartFillConfirm').click();
      await sidebar.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('填写完成'));
      assert.equal(await page.locator('#applicant-name').inputValue(), '合成卡片姓名'); await sidebar.close();
    });
    await t.test('关闭与导航撤销卡片令牌，登录页不显示网申提示', async () => {
      const token = new URL(frame.url()).searchParams.get('token'); await frame.locator('#panelClose').click(); await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').style.display === 'none');
      const reloaded = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) });
      await worker.evaluate((tabId) => floatingPanel.open(tabId), tabId);
      const reopened = await reloaded; assert.ok(reopened); await reopened.locator('#profileSel option').first().waitFor({ state: 'attached' });
      assert.notEqual(new URL(reopened.url()).searchParams.get('token'), token);
      await page.evaluate(() => history.pushState({}, '', '?step=new'));
      const denied = await reopened.evaluate(() => sendMessage('localapply:read')); assert.equal(denied.ok, false);
      await page.goto(api.base + '/test-pages/login-mock.html'); await page.locator('input[placeholder="请输入验证码"]').waitFor();
      await page.waitForFunction(() => document.getElementById('wsa-floatbar-host')?.style.display === 'none');
      assert.equal(await page.locator('#wsa-floatbar-host').isVisible(), false);
      // 非招聘标题的异步表单使用无障碍标签；持续样式更新不能饿死检测，也不能读取值。
      await page.evaluate(() => {
        document.title = '用户中心'; document.querySelector('h1')?.remove(); const form = document.createElement('form'); form.id = 'dynamic-application'; form.hidden = true;
        window.__presenceValueReads = 0;
        for (const [index, name] of ['本科毕业院校','硕士专业','联系电话'].entries()) { const label = document.createElement('span'); label.id = 'presence-label-' + index; label.textContent = name; const input = document.createElement('input'); input.setAttribute('aria-labelledby', label.id); Object.defineProperty(input, 'value', { get() { window.__presenceValueReads++; return '禁止读取'; } }); form.append(label, input); }
        document.body.append(form);
        document.querySelector('input[placeholder="请输入验证码"]').remove();
      });
      await options.waitForFunction(async (tabId) => (await chrome.tabs.sendMessage(tabId, { type: 'wsa:floatingProbe' })).presence.kind === 'other', tabId);
      await page.locator('#dynamic-application').evaluate((form) => { form.hidden = false; window.__presencePulse = setInterval(() => { form.style.opacity = form.style.opacity === '0.99' ? '1' : '0.99'; }, 80); });
      await page.locator('#wsa-floatbar-host').waitFor({ state: 'visible' });
      await page.evaluate(() => clearInterval(window.__presencePulse));
      assert.equal(await page.evaluate(() => __presenceValueReads), 0);
    });
  } finally {
    if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

// 阶段四验收通过真实按钮与后台存储检查界面行为，不将元素存在视为完成。
test('阶段四：双标签、预览三操作、工作台和窄窗交互', { timeout: 180000 }, async (t) => {
  const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'phase4-')); const api = await serve(); let context; let worker; let extensionId; let options; let page; let frame; let profileId; let schoolId; let fieldId;
  const errors = [];
  // 使用后台同一入口模拟工具栏调用；iframe 的按钮和指针操作均为真实 UI 事件。
  const open = async () => { const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((item) => item.url === url).id, page.url()); const loaded = page.waitForEvent('framenavigated', { predicate: (item) => item.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) }); await worker.evaluate((tabId) => floatingPanel.open(tabId), tabId); frame = await loaded; await frame.locator('#profileSel option').first().waitFor({ state: 'attached' }); return tabId; };
  // 等待资料真正落盘后再进行跨窗口断言，避免以渲染时序冒充持久性。
  const value = async (id) => (await rpc(options, 'localapply:read')).database.fieldValues.find((item) => item.profileId === profileId && item.fieldId === id && item.entryId === null)?.value;
  try {
    context = await launch(profile); context.setDefaultTimeout(10000); ({ worker, extensionId } = await extension(context));
    options = await context.newPage(); options.on('pageerror', (error) => errors.push(error.message)); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.waitForFunction(() => document.getElementById('overviewValues')?.textContent !== '—'); profileId = (await rpc(options, 'localapply:read')).database.activeProfileId;
    page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(api.base + '/test-pages/phase3-composites.html'); await open();
    await t.test('空档案引导支持跳过 AI，填写不会假报成功且零模型请求', async () => {
      await frame.locator('#panelWelcome').waitFor({ state: 'visible' }); await frame.locator('#smartFillAll').click(); await frame.waitForFunction(() => document.getElementById('smartStatus').textContent.includes('没有可填写'));
      assert.equal(await page.locator('#name').inputValue(), ''); assert.equal(api.calls.length, 0); const opened = context.waitForEvent('page'); await frame.locator('#welcomeSkipAI').click(); const editor = await opened; await editor.waitForLoadState(); assert.ok(editor.url().includes('options/options.html?profile=')); assert.ok(editor.url().endsWith('#resumeCenter')); await editor.close();
    });
    await t.test('工作台新增类型化字段及值，保存前不入库，无 Key 可用', async () => {
      await workspacePage(options, 'fieldLibrary');
      await options.locator('#fieldCreate').evaluate((element) => { element.open = true; }); await options.locator('#fieldLabel').fill('合成是否调剂'); await options.locator('#fieldType').selectOption('boolean');
      assert.ok(!(await rpc(options, 'localapply:read')).database.fieldDefinitions.some((item) => item.label === '合成是否调剂')); await options.locator('#fieldSave').click(); await options.waitForFunction(() => document.getElementById('fieldStatus').textContent.includes('已保存'));
      const db = (await rpc(options, 'localapply:read')).database; fieldId = db.fieldDefinitions.find((item) => item.label === '合成是否调剂').fieldId; assert.equal(db.fieldValues.find((item) => item.fieldId === fieldId).value, null);
      await workspacePage(options, 'resumeCenter');
      await options.getByLabel('简历中心 · 合成是否调剂', { exact: true }).selectOption('false'); await options.waitForFunction(() => document.getElementById('centerStatus').textContent.includes('已保存')); await options.evaluate(() => flushSaves()); assert.equal(await value(fieldId), false);
      for (const [id, content] of [['builtin.name','合成阶段四姓名'],['builtin.phone','13800000000'],['builtin.skills','合成中文技能：DOM 与测试']]) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: id, value: content } } });
      for (let index = 0; index < 2; index++) { const entryId = (await rpc(options, 'localapply:command', { request: { action: 'createEntry', payload: { profileId, kind: 'education', title: '同名合成教育' } } })).result; if (!index) schoolId = entryId; await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, entryId, fieldId: 'builtin.school', value: '合成学院' + index } } }); }
      // 外部夹具写库后重新读取投影；产品已按要求移除刷新工具行。
      await options.evaluate(() => reloadDataState()); assert.equal(api.calls.length, 0);
    });
    await t.test('预览分类导航实际滚动展开并高亮，同名经历保持独立', async () => {
      await frame.locator('#resumeTab').click(); await frame.locator('#resumeContent .resume-section').first().waitFor(); assert.equal(await frame.locator('#resumeContent details').count(), 2); assert.ok(!(await frame.locator('#resumeContent').textContent()).includes('13800000000'));
      await frame.locator('#previewNav').selectOption('entry:' + schoolId); const section = frame.locator('[data-section-key="entry:' + schoolId + '"]'); assert.equal(await section.evaluate((element) => element.open), true); assert.ok(await section.evaluate((element) => element.classList.contains('is-target'))); assert.equal(await frame.evaluate(() => document.activeElement.dataset.sectionKey), 'entry:' + schoolId);
      await section.locator('summary').click();
      // 原生 details 的默认切换可能晚于点击返回，等待真实收起状态后再继续导航/搜索。
      await frame.waitForFunction((key) => [...document.querySelectorAll('.resume-section')].find((node) => node.dataset.sectionKey === key)?.open === false, 'entry:' + schoolId); assert.equal(await section.evaluate((element) => element.open), false);
      await frame.locator('#previewSearch').fill('合成是否调剂'); assert.ok((await frame.locator('#resumeContent').textContent()).includes('否')); assert.equal(await frame.locator('#resumeContent details').count(), 0); await frame.locator('#previewSearch').fill('');
    });
    await t.test('预览刷新实际读取修改，增删字段自动同步且不调用 AI', async () => {
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: 'builtin.name', value: '合成阶段四刷新姓名' } } }); await frame.locator('#previewRefresh').click(); await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成阶段四刷新姓名'));
      const created = (await rpc(options, 'localapply:command', { request: { action: 'createField', payload: { profileId, definition: { label: '合成即时新增' }, value: '合成即时值' } } })).result; await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成即时新增'));
      await rpc(options, 'localapply:command', { request: { action: 'deleteField', payload: { fieldId: created } } }); await frame.waitForFunction(() => !document.getElementById('resumeContent').textContent.includes('合成即时新增')); assert.equal(api.calls.length, 0);
    });
    await t.test('编辑按钮打开当前档案与分类的简历中心', async () => {
      await frame.locator('#previewNav').selectOption('entry:' + schoolId); const opened = context.waitForEvent('page'); await frame.locator('#previewEdit').click(); const editor = await opened; await editor.waitForFunction(() => document.getElementById('overviewValues')?.textContent !== '—'); await editor.waitForFunction((id) => document.getElementById('entryProfile').value === id, profileId); assert.ok(editor.url().includes(encodeURIComponent('entry:' + schoolId))); await editor.locator('#resumeProfileControls.is-target').waitFor(); assert.equal(await editor.locator('#basicFields .entry-card').count(), 0); await editor.close();
    });
    await t.test('单击复制只针对所选项，敏感值保持遮挡直到主动显示', async () => {
      await frame.locator('#previewSearch').fill('手机号'); await frame.getByRole('button', { name: '复制手机号', exact: true }).click(); assert.ok((await frame.locator('#previewStatus').textContent()).includes('先勾选'));
      await frame.locator('#previewReveal').check(); await frame.getByRole('button', { name: '复制手机号', exact: true }).click(); await frame.waitForFunction(() => document.getElementById('previewStatus').textContent.includes('已复制')); await frame.locator('#previewSearch').fill('');
      await page.screenshot({ path: path.join(testRoot, 'stage4-preview.png'), fullPage: false });
    });
    await t.test('两个主标签切换保留扫描会话和字段选择，筛选不改变数据', async () => {
      await frame.locator('#autoTab').click(); await frame.locator('#smartScan').click(); await frame.locator('.smart-row').first().waitFor(); const session = await frame.locator('#tab-smart').getAttribute('data-session-id'); const count = await frame.locator('.smart-row').count();
      await frame.locator('#smartOnlyUnknown').check(); assert.equal(await frame.locator('#smartMatched').isHidden(), true); await frame.locator('#resumeTab').click(); await frame.locator('#autoTab').click(); assert.equal(await frame.locator('#tab-smart').getAttribute('data-session-id'), session); assert.equal(await frame.locator('.smart-row').count(), count); assert.equal(await frame.locator('#smartOnlyUnknown').isChecked(), true); await frame.locator('#smartOnlyUnknown').uncheck(); assert.equal(await frame.locator('.panel-tabs [role=tab]').count(), 2);
      // 预览隐藏期间资料变化后，再打开必须刷新；相同版本的迟到通知又不能重建折叠节点。
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: 'builtin.name', value: '合成预览隐藏更新' } } }); await frame.locator('#resumeTab').click(); await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成预览隐藏更新'));
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: 'builtin.name', value: '合成阶段四刷新姓名' } } }); await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成阶段四刷新姓名')); await frame.locator('#autoTab').click();
    });
    await t.test('拖动、折叠、展开和视口变化保持卡片可见且保留会话', async () => {
      const before = await page.locator('#wsa-floatbar-host').boundingBox(); const header = await frame.locator('.panel-brand').boundingBox(); await page.mouse.move(header.x + 40, header.y + 16); await page.mouse.down(); await page.mouse.move(header.x - 120, header.y + 70, { steps: 8 }); await page.mouse.up(); await page.waitForFunction((left) => document.getElementById('wsa-floatbar-host').getBoundingClientRect().left < left - 30, before.x);
      const session = await frame.locator('#tab-smart').getAttribute('data-session-id'); await frame.locator('#panelMinimize').click(); await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').getBoundingClientRect().height < 90); await frame.locator('#panelMinimize').click(); assert.equal(await frame.locator('#tab-smart').getAttribute('data-session-id'), session);
      await page.setViewportSize({ width: 375, height: 720 }); await page.waitForFunction(() => { const rect = document.getElementById('wsa-floatbar-host').getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }); assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(testRoot, 'stage4-narrow.png'), fullPage: false }); await page.setViewportSize({ width: 1280, height: 900 });
    });
    await t.test('键盘标签切换与 Escape 关闭可用，再次打开不残留失效会话', async () => {
      await frame.locator('#autoTab').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await frame.locator('#resumeTab').getAttribute('aria-selected'), 'true'); await page.keyboard.press('Escape'); await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').getBoundingClientRect().height === 0); await open(); assert.equal(await frame.locator('#tab-smart').getAttribute('data-session-id'), null);
    });
    await t.test('工作台字段修改和删除有确认，未保存编辑不能被简历管理覆盖', async () => {
      await workspacePage(options, 'fieldLibrary');
      await options.locator('#fieldSearch').fill('合成是否调剂'); const row = options.locator('.library-row').filter({ hasText: '合成是否调剂' }); await row.getByRole('button', { name: '编辑定义', exact: true }).click(); await options.locator('#fieldLabel').fill('合成调剂修改名');
      // 刷新按钮已移除，改用会重新渲染的简历管理入口验证同一草稿保护。
      await workspacePage(options, 'resumeCenter'); options.once('dialog', (dialog) => dialog.dismiss()); await options.locator('#renameResumeProfile').click(); assert.equal(await options.locator('#fieldLabel').inputValue(), '合成调剂修改名'); await workspacePage(options, 'fieldLibrary');
      options.once('dialog', (dialog) => dialog.accept()); await options.locator('#fieldSave').click(); await options.waitForFunction(() => [...document.querySelectorAll('.center-field')].some((item) => item.textContent.includes('合成调剂修改名'))); assert.equal(await value(fieldId), false);
      await options.locator('#fieldSearch').fill('合成调剂修改名'); const updated = options.locator('.library-row').filter({ hasText: '合成调剂修改名' }); options.once('dialog', (dialog) => { assert.ok(dialog.message().includes('1 个档案')); dialog.dismiss(); }); await updated.getByRole('button', { name: '彻底删除字段', exact: true }).click(); assert.equal(await value(fieldId), false);
      options.once('dialog', (dialog) => dialog.accept()); await updated.getByRole('button', { name: '彻底删除字段', exact: true }).click(); await options.waitForFunction(() => document.getElementById('fieldStatus').textContent.includes('已删除')); assert.equal(await value(fieldId), undefined);
      await options.evaluate(() => window.scrollTo(0, 0)); await options.screenshot({ path: path.join(testRoot, 'stage4-workspace.png'), fullPage: false });
    });
    await t.test('中文和长字段、窄窗工作台无横向溢出，网页强样式不能污染卡片', async () => {
      await options.setViewportSize({ width: 390, height: 844 }); assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await options.setViewportSize({ width: 1440, height: 1000 });
      await page.addStyleTag({ content: 'input,button,select{font-size:70px!important;color:red!important}div{border:6px solid red!important}' }); assert.equal(await frame.locator('#autoTab').evaluate((element) => getComputedStyle(element).fontSize), '13px');
      assert.equal(api.calls.length, 0); assert.equal(await page.evaluate(() => __submitCount), 0); assert.deepEqual(errors, []);
    });
    await t.test('历史经历命令仍兼容稳定 ID，简历中心仅显示基础字段', async () => {
      await workspacePage(options, 'resumeCenter');
      const entryId = await addResumeEntry(options, 'project', '合成阶段四项目');
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, entryId, fieldId: 'builtin.skills', value: '合成项目成果' } } });
      await rpc(options, 'localapply:command', { request: { action: 'editEntry', payload: { entryId, title: '合成项目新名称' } } });
      const changed = (await rpc(options, 'localapply:read')).database;
      assert.ok(changed.entries.some((entry) => entry.entryId === entryId && entry.title === '合成项目新名称'));
      assert.ok(changed.fieldValues.some((row) => row.entryId === entryId && row.value === '合成项目成果'));
      await rpc(options, 'localapply:command', { request: { action: 'deleteEntry', payload: { entryId } } });
      assert.ok((await rpc(options, 'localapply:read')).database.entries.some((item) => item.entryId === schoolId));
      assert.equal(await options.locator('#basicFields .entry-card,[data-add-entry-kind]').count(), 0);
    });
    await t.test('档案切换隔离资料并在重新打开后保留，不复制其他人的内容', async () => {
      const second = (await rpc(options, 'localapply:command', { request: { action: 'createProfile', payload: { name: '合成第二预览档案' } } })).result;
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId: second, fieldId: 'builtin.name', value: '合成另一档案姓名' } } });
      await frame.waitForFunction((id) => [...document.getElementById('profileSel').options].some((item) => item.value === id), second); await frame.locator('#profileSel').selectOption(profileId); await frame.waitForFunction((id) => document.getElementById('profileSel').value === id, profileId);
      await frame.locator('#profileSel').selectOption(second); await frame.locator('#resumeTab').click(); await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成另一档案姓名')); assert.ok(!(await frame.locator('#resumeContent').textContent()).includes('合成阶段四刷新姓名'));
      await frame.locator('#panelClose').click(); await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').getBoundingClientRect().height === 0); await open(); assert.equal(await frame.locator('#profileSel').inputValue(), second); assert.equal(api.calls.length, 0);
    });
    await t.test('React、Moka 和日期复合夹具中浮层独立显示，导航关闭恢复可用', async () => {
      for (const fixture of ['phase3-application.html','moka-mock.html','phase3-composites.html']) {
        await page.goto(api.base + '/test-pages/' + fixture); await open(); await frame.locator('#resumeTab').click(); await frame.locator('#resumeContent h1').waitFor();
        const rect = await page.locator('#wsa-floatbar-host').boundingBox(); const viewport = page.viewportSize(); assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
        assert.equal(await frame.locator('.panel-tabs button').count(), 2); await frame.locator('#panelClose').click(); await page.waitForFunction(() => document.getElementById('wsa-floatbar-host').getBoundingClientRect().height === 0);
      }
      await page.goto(api.base + '/test-pages/login-mock.html'); await page.waitForFunction(() => !document.getElementById('wsa-floatbar-host') || getComputedStyle(document.getElementById('wsa-floatbar-host')).display === 'none'); assert.equal(api.calls.length, 0); assert.deepEqual(errors, []);
    });
    await t.test('无卡片令牌不能请求布局或编辑导航，普通管理页不能冒用卡片权限', async () => {
      const count = context.pages().length;
      for (const type of ['panel:layout', 'panel:edit']) { const result = await options.evaluate((type) => chrome.runtime.sendMessage({ type, dx: 1, dy: 1, destination: 'https://example.invalid/' }), type); assert.equal(result.ok, false); }
      assert.equal(context.pages().length, count);
    });
  } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
});

// 两种入口验证真实独立模块路由，不通过修改 hidden 或强制点击绕过导航。
for (const withExtension of [true, false]) {
  test(`工作台模块导航：${withExtension ? '扩展' : 'file://'}顺序、隔离、草稿和地址恢复`, { timeout: 45000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'workspace-navigation-')); const api = await serve(); let context;
    const errors = [];
    try {
      context = await launch(profile, withExtension);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      assert.deepEqual(await page.locator('.workspace-sidebar nav a').allTextContents(), ['导入简历','AI 与模型','我的简历','申请追踪','字段库','数据与备份','诊断与关于']);
      assert.equal(await page.locator('.workspace-page:visible').count(), 1); assert.equal(await page.locator('#pdfCard').isVisible(), true);
      assert.equal(await page.locator('#workspaceMode').count(), 0); assert.equal(await page.locator('.workspace-sidebar small').count(), 0);
      assert.equal(await page.locator('#workspaceOverview').isVisible(), false); assert.equal(await page.locator('#provider').isVisible(), false);
      await page.screenshot({ path: path.join(testRoot, `navigation-import-${withExtension ? 'extension' : 'file'}.png`) });
      const fixtures = require('./resume-fixtures.cjs');
      await page.locator('#pdfFile').setInputFiles({ name: 'navigation.pdf', mimeType: 'application/pdf', buffer: fixtures.pdf() });
      await page.locator('#sourcePreview img').first().waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.getElementById('btnExtract').disabled);
      await workspacePage(page, 'aiSettings'); assert.equal(await page.locator('#sourcePreview img').isVisible(), false);
      for (const key of ['resumeCenter','fieldLibrary','privacySettings','diagnosticsPanel']) {
        await workspacePage(page, key); assert.equal(await page.locator('.workspace-page:visible').count(), 1);
        assert.equal(await page.locator('.workspace-sidebar nav a[aria-current="page"]').getAttribute('href'), '#' + key);
        assert.equal(await page.locator('#workspaceOverview').isVisible(), key === 'resumeCenter');
      }
      if (!withExtension) { assert.equal(await page.locator('#fileDiagnosticsNotice').isVisible(), true); assert.equal(await page.locator('#logsRefresh').isVisible(), false); }
      else { await page.locator('#logsRefresh').click(); await page.waitForFunction(() => document.getElementById('logsOutput').textContent.length > 0); }
      await workspacePage(page, 'pdfCard'); assert.equal(await page.locator('#sourcePreview img').isVisible(), true); assert.match(await page.locator('#resumeFileInfo').textContent(), /navigation.pdf/);
      await workspacePage(page, 'fieldLibrary'); await page.locator('#fieldCreate summary').click(); await page.locator('#fieldLabel').fill('合成导航草稿');
      await workspacePage(page, 'resumeCenter'); assert.equal(await page.locator('#workspaceOverview').isVisible(), true);
      assert.equal(await page.locator('#workspaceOverview').evaluate((element) => element.closest('[data-workspace-page]').dataset.workspacePage), 'resumeCenter');
      await page.screenshot({ path: path.join(testRoot, `navigation-resume-${withExtension ? 'extension' : 'file'}.png`) });
      await page.goBack(); await page.locator('#fieldLibrary').waitFor({ state: 'visible' }); assert.equal(await page.locator('#fieldLabel').inputValue(), '合成导航草稿');
      await page.goForward(); await page.locator('#resumeCenter').waitFor({ state: 'visible' });
      await workspacePage(page, 'fieldLibrary'); await page.locator('#fieldCancel').click();
      const aiLink = page.locator('.workspace-sidebar nav a[href="#aiSettings"]'); await aiLink.focus(); await aiLink.press('Enter'); await page.locator('#aiSettings').waitFor({ state: 'visible' });
      await page.reload(); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); assert.equal(await page.locator('#aiSettings').isVisible(), true);
      await page.goto(url + '#workspaceOverview'); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); assert.equal(await page.locator('#resumeCenter').isVisible(), true);
      await page.goto(url + '#invalid-module'); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); assert.equal(await page.locator('#pdfCard').isVisible(), true);
      await page.locator('#btnDetectImport').click(); await page.locator('#aiSettings').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.getElementById('btnDetectCapabilities').disabled); assert.match(await page.locator('#capabilityStatus').textContent(), /检测未完成/);
      await page.setViewportSize({ width: 390, height: 844 }); await workspacePage(page, 'privacySettings'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(api.calls.length, 0); assert.equal(api.modelRequests.length, 0); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 两种设置入口实测主题持久化、页面滚动和动态目录，所有资料均为合成内容。
for (const withExtension of [true, false]) {
  test(`设置快捷导航：${withExtension ? '扩展' : 'file://'}明暗、滚动与简历目录`, { timeout: 60000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'workspace-tools-')); let context;
    const errors = []; const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); await context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' }); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      assert.equal(await page.locator('#resumeToc').isVisible(), false);
      const before = await page.evaluate(() => dataRequest('localapply:read'));
      await page.locator('#themeToggle').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      assert.equal(await page.locator('#themeToggle').getAttribute('aria-label'), '切换至明亮模式');
      assert.equal(await page.locator('#themeToggle').getAttribute('aria-pressed'), 'true');
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, before.database.revision, '显示偏好不能写入简历数据库');
      await page.reload(); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await workspacePage(page, 'resumeCenter');
      const profileId = (await page.evaluate(() => dataRequest('localapply:read'))).database.activeProfileId;
      const entryIds = await page.evaluate(async (profileId) => {
        const first = await dataCommand('createEntry', { profileId, kind: 'education', title: '合成同名经历' });
        const second = await dataCommand('createEntry', { profileId, kind: 'education', title: '合成同名经历' });
        return [first.result, second.result];
      }, profileId);
      await page.evaluate(() => reloadDataState());
      assert.equal(await page.locator('#resumeToc button[data-toc-key^="entry:"]').count(), 0);
      assert.equal(await page.locator('#legacyEntriesNotice').isVisible(), true);
      assert.equal(await page.locator('#resumeToc').isVisible(), true);
      assert.equal(await page.locator('#resumeToc button[data-toc-key^="group:"]').count(), await page.locator('.center-group-heading').count());
      const group = page.locator('#resumeToc button[data-toc-key^="group:"]').first();
      assert.equal(await page.locator('#centerGroup, #centerSearch, #centerRefresh').count(), 0);
      await page.locator('#basicFields').evaluate((element) => { element.closest('details').open = false; });
      await group.click();
      assert.equal(await page.locator('#basicFields').evaluate((element) => element.closest('details').open), true);
      assert.equal(await group.getAttribute('aria-current'), 'location');
      // 分类导航按新要求聚焦整张卡片，标题和字段必须处于同一个目标区块。
      assert.equal(await page.locator('.resume-group.is-target').evaluate((element) => document.activeElement === element && element.contains(element.querySelector('.center-field'))), true);
      assert.equal(new URL(page.url()).hash, '#resumeCenter');
      assert.equal(await page.locator('#basicFields .entry-card').count(), 0);
      await page.locator('#scrollTop').click(); await page.waitForFunction(() => scrollY === 0);
      assert.equal(await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(16, 23, 34)');
      assert.equal(await page.locator('#newProfileName').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(25, 35, 50)');
      await page.screenshot({ path: path.join(testRoot, `workspace-dark-${mode}.png`) });
      await page.locator('#scrollBottom').click(); await page.waitForFunction(() => Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) < 2);
      // 填写偏好已移除，页面底部应显示最后一个保留的资料模块。
      assert.equal(await page.locator('#fillingPreferences').count(), 0);
      assert.equal(await page.locator('#basicFields > .resume-group').last().evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; }), true);
      await page.locator('#scrollTop').click(); await page.waitForFunction(() => scrollY === 0);
      await page.locator('#themeToggle').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      // 等按钮颜色过渡完成再截图，避免把中间帧误记为明亮主题效果。
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#renameResumeProfile')).backgroundColor === 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(testRoot, `workspace-light-${mode}.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const tools = await page.locator('.workspace-tools').boundingBox(); assert.ok(tools.x >= 0 && tools.x + tools.width <= 390 && tools.y + tools.height <= 844);
      // 用真实按钮位置验证竖向顺序，避免只检查样式声明而忽略实际布局。
      const buttons = await page.locator('.workspace-tools button').evaluateAll((items) => items.map((item) => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, bottom: rect.bottom }; }));
      assert.ok(tools.height > tools.width && buttons.every((button) => Math.abs(button.x - buttons[0].x) < 1));
      assert.ok(buttons[0].bottom <= buttons[1].y && buttons[1].bottom <= buttons[2].y);
      await page.locator('#themeToggle').click(); await page.waitForFunction(() => getComputedStyle(document.querySelector('#renameResumeProfile')).backgroundColor === 'rgb(25, 35, 50)');
      await page.screenshot({ path: path.join(testRoot, `workspace-narrow-${mode}.png`) });
      // 基础字段新增分类后目录同步，旧经历不重新生成目录项，切档案不复制资料。
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(async () => {
        const profileId = document.getElementById('entryProfile').value;
        await dataCommand('createField', { profileId, definition: { label: '合成目录字段', group: '合成目录分类' }, value: '' });
        await reloadDataState();
      });
      assert.equal(await page.locator('#resumeToc').getByRole('button', { name: '合成目录分类', exact: true }).count(), 1);
      const otherProfile = (await page.evaluate(() => dataCommand('createProfile', { name: '合成目录第二档案' }))).result;
      await page.evaluate(() => reloadDataState()); await page.locator('#entryProfile').selectOption(otherProfile);
      await page.waitForFunction(() => !document.getElementById('resumeToc').textContent.includes('合成目录分类'));
      assert.equal(await page.locator('#resumeToc button[data-toc-key^="entry:"]').count(), 0);
      await workspacePage(page, 'aiSettings'); assert.equal(await page.locator('#resumeToc').isVisible(), false);
      await page.locator('#scrollBottom').click(); await page.waitForFunction(() => Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) < 2);
      await page.locator('#scrollTop').click(); await page.waitForFunction(() => scrollY === 0);
      await page.reload(); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 用两种入口操作真实管理按钮，验证改名、删除确认、资料隔离及整个浏览器重启。
for (const withExtension of [true, false]) {
  test(`简历管理：${withExtension ? '扩展' : 'file://'}重命名、删除与重启`, { timeout: 60000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'resume-management-')); let context;
    const mode = withExtension ? 'extension' : 'file'; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.equal(await page.locator('#centerGroup, #centerSearch, #centerRefresh').count(), 0);
      assert.equal(await page.locator('#deleteResumeProfile').isDisabled(), true);
      const first = await page.locator('#entryProfile').inputValue();
      await page.getByLabel('简历中心 · 姓名', { exact: true }).fill('合成第一简历姓名');
      await page.getByLabel('简历中心 · 姓名', { exact: true }).blur();
      await page.waitForFunction(() => document.getElementById('centerStatus').textContent === '已保存在本地');
      await page.locator('#newProfileName').fill('合成第二简历'); await page.locator('#createResumeProfile').click();
      await page.waitForFunction((id) => document.getElementById('entryProfile').value !== id && !document.getElementById('createResumeProfile').disabled, first);
      const second = await page.locator('#entryProfile').inputValue();
      assert.equal(await page.locator('#overviewProfile').textContent(), '合成第二简历');
      assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '');
      await page.getByLabel('简历中心 · 姓名', { exact: true }).fill('合成第二简历姓名'); await page.getByLabel('简历中心 · 姓名', { exact: true }).blur();
      await page.waitForFunction(() => document.getElementById('centerStatus').textContent === '已保存在本地');
      const entryId = await page.evaluate(async (profileId) => {
        const entryId = (await dataCommand('createEntry', { profileId, kind: 'project', title: '合成第二项目' })).result;
        await dataCommand('setValue', { profileId, entryId, fieldId: 'builtin.school', value: '合成第二经历值' });
        await dataCommand('saveMapping', { profileId, entryId, fieldId: 'builtin.school', origin: 'https://example.test', path: '/apply', label: '合成项目学校' });
        await reloadDataState(); return entryId;
      }, second);
      const beforeRename = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      page.once('dialog', (dialog) => dialog.dismiss()); await page.locator('#renameResumeProfile').click();
      await page.waitForFunction(() => !document.getElementById('renameResumeProfile').disabled);
      page.once('dialog', (dialog) => dialog.accept('   ')); await page.locator('#renameResumeProfile').click();
      await page.waitForFunction(() => document.getElementById('centerStatus').textContent.includes('名称不能为空'));
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, beforeRename.revision);
      page.once('dialog', (dialog) => dialog.accept(' 合成修改后的简历 ')); await page.locator('#renameResumeProfile').click();
      await page.waitForFunction(() => document.getElementById('overviewProfile').textContent === '合成修改后的简历' && !document.getElementById('renameResumeProfile').disabled);
      assert.equal(await page.locator('#entryProfile').inputValue(), second);
      assert.equal(await page.locator('#targetProfile option:checked').textContent(), '合成修改后的简历');
      const renamed = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.deepEqual(renamed.fieldValues, beforeRename.fieldValues); assert.deepEqual(renamed.entries, beforeRename.entries); assert.deepEqual(renamed.mappingRules, beforeRename.mappingRules);
      page.once('dialog', (dialog) => { assert.ok(dialog.message().includes('合成修改后的简历') && dialog.message().includes('1 段经历') && dialog.message().includes('1 条专属映射')); return dialog.dismiss(); });
      await page.locator('#deleteResumeProfile').click();
      await page.waitForFunction(() => !document.getElementById('deleteResumeProfile').disabled);
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, renamed.revision);
      await page.locator('#entryProfile').selectOption(first);
      await page.waitForFunction(() => document.getElementById('overviewProfile').textContent !== '合成修改后的简历');
      assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '合成第一简历姓名');
      await page.locator('#entryProfile').selectOption(second); await page.waitForFunction(() => document.getElementById('overviewProfile').textContent === '合成修改后的简历');
      // 未保存基础字段须先确认丢弃；拒绝时不能发起删除或清空草稿。
      const draft = page.getByLabel('简历中心 · 毕业院校', { exact: true });
      // 仅触发 input 保留尚未提交的草稿，不触发现在统一使用的失焦自动保存。
      await draft.evaluate((input) => { input.value = '合成未保存草稿'; input.dispatchEvent(new Event('input', { bubbles: true })); }); page.once('dialog', (dialog) => dialog.dismiss()); await page.locator('#deleteResumeProfile').click();
      await page.waitForFunction(() => !document.getElementById('deleteResumeProfile').disabled);
      assert.equal(await draft.inputValue(), '合成未保存草稿');
      let confirmations = 0;
      const acceptDeletion = (dialog) => { confirmations++; return dialog.accept(); };
      page.on('dialog', acceptDeletion); await page.locator('#deleteResumeProfile').click();
      await page.waitForFunction(() => document.getElementById('centerStatus').textContent.includes('已删除')); page.off('dialog', acceptDeletion);
      assert.equal(confirmations, 2);
      assert.equal(await page.locator('#entryProfile').inputValue(), first); assert.equal(await page.locator('#entryProfile option').count(), 1);
      assert.equal(await page.locator('#targetProfile option').count(), 1); assert.equal(await page.locator('#deleteResumeProfile').isDisabled(), true);
      assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '合成第一简历姓名');
      assert.equal(await page.locator('#resumeToc button[data-toc-key^="entry:"]').count(), 0);
      const deleted = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      for (const table of ['profiles', 'entries', 'fieldValues', 'bindings', 'mappingRules']) assert.ok(!deleted[table].some((row) => row.profileId === second));
      assert.deepEqual(deleted.fieldDefinitions, renamed.fieldDefinitions);
      await page.screenshot({ path: path.join(testRoot, `resume-management-${mode}.png`) });
      await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.equal(await page.locator('#entryProfile option').count(), 1); assert.equal(await page.locator('#entryProfile').inputValue(), first);
      assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '合成第一简历姓名');
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, deleted.revision); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 真实滚轮验证目录跟随完整区块；两种入口均不依赖模型或真实个人资料。
for (const withExtension of [true, false]) {
  test(`简历模块导航：${withExtension ? '扩展' : 'file://'}完整分类、滚轮同步与长区块`, { timeout: 60000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'resume-sections-')); let context;
    const mode = withExtension ? 'extension' : 'file'; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' }); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(url);
      await workspacePage(page, 'resumeCenter');
      await page.evaluate(async () => {
        const profileId = (await dataRequest('localapply:read')).database.activeProfileId;
        for (let index = 0; index < 20; index++) await dataCommand('createField', { profileId, definition: { label: '合成长分类字段' + index, group: '合成长分类' }, value: '合成内容' });
        await dataCommand('createField', { profileId, definition: { label: '合成下一分类字段', group: '合成下一分类' }, value: '' });
        await reloadDataState();
      });
      const revision = (await page.evaluate(() => dataRequest('localapply:read'))).database.revision;
      assert.equal(await page.locator('#basicFields > .resume-group').count(), await page.locator('#resumeToc button[data-toc-key^="group:"]').count());
      assert.equal(await page.locator('#basicFields .center-field').evaluateAll((fields) => fields.every((field) => !!field.closest('.resume-group')?.querySelector('h3'))), true);
      // 新需求默认收起选填项；目录定位仍应完整显示证书模块当前可见的内容。
      const group = page.locator('.resume-group[data-group="证书信息"]');
      await page.locator('#resumeToc').getByRole('button', { name: '证书信息', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === 'group:证书信息');
      const bounds = await group.boundingBox(); assert.ok(bounds.y >= 20 && bounds.y + bounds.height <= 880, '可容纳的分类必须连同全部字段一起进入视口');
      assert.ok(await group.locator('.center-field').count() > 1); assert.equal(await group.locator('h3.is-target').count(), 0);
      assert.equal(await group.evaluate((element) => element.classList.contains('is-target') && document.activeElement === element), true);
      assert.equal(await group.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await group.locator('input:visible,textarea:visible,select:visible').evaluateAll((fields) => fields.every((field) => { const rect = field.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })), true);
      await page.screenshot({ path: path.join(testRoot, `resume-module-light-${mode}.png`) });
      await page.locator('#themeToggle').click(); await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(16, 23, 34)');
      await page.screenshot({ path: path.join(testRoot, `resume-module-dark-${mode}.png`) });
      // 鼠标置于正文边缘留白，避免长文本输入框自身吞掉滚轮事件。
      const wheelTo = async (target, key) => {
        const delta = await target.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.top - (rect.height <= innerHeight - 48 ? (innerHeight - rect.height) / 2 : 24); });
        await page.mouse.move(225, 180); await page.mouse.wheel(0, delta);
        await page.waitForFunction((key) => document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === key, key);
      };
      const first = page.locator('.resume-group[data-group="合成长分类"]');
      const second = page.locator('.resume-group[data-group="合成下一分类"]');
      // 显式展开合成长模块，保留原有长内容滚动及目录同步断言。
      await expandResumeGroup(page, '合成长分类');
      const focus = await page.evaluate(() => document.activeElement.id);
      await wheelTo(first, 'group:合成长分类');
      await page.mouse.wheel(0, 450); await page.waitForFunction(() => document.querySelector('.resume-group[data-group="合成长分类"] h3').getBoundingClientRect().bottom < 0);
      assert.equal(await page.locator('#resumeToc [aria-current="location"]').getAttribute('data-toc-key'), 'group:合成长分类');
      assert.equal(await first.evaluate((element) => element.classList.contains('is-target')), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), focus, '滚动同步不得抢走焦点');
      await wheelTo(second, 'group:合成下一分类');
      assert.equal(await first.evaluate((element) => element.classList.contains('is-target')), false);
      await page.setViewportSize({ width: 1440, height: 520 });
      await wheelTo(second, 'group:合成下一分类');
      const toc = await page.locator('.resume-toc').boundingBox(); const active = await page.locator('#resumeToc [aria-current="location"]').boundingBox();
      assert.ok(active.y >= toc.y && active.y + active.height <= toc.y + toc.height, '目录自身滚动后仍显示当前条目');
      // 当前条目未改变时缩小窗口，也要让目录重新露出该条目。
      await page.setViewportSize({ width: 1440, height: 420 });
      await page.waitForFunction(() => { const active = document.querySelector('#resumeToc [aria-current="location"]'); const box = document.querySelector('.resume-toc').getBoundingClientRect(); const item = active.getBoundingClientRect(); return active.dataset.tocKey === 'group:合成下一分类' && item.top >= box.top && item.bottom <= box.bottom; });
      await page.locator('#scrollTop').click(); await page.waitForFunction(() => scrollY === 0 && document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === 'overview');
      await page.locator('#scrollBottom').click(); await page.waitForFunction(() => document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === 'group:合成下一分类');
      assert.equal(new URL(page.url()).hash, '#resumeCenter');
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, revision); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 最新需求移除经历模块；沿用旧导入命令造数，验证清理、基础编辑及真实重启。
for (const withExtension of [true, false]) {
  test(`简历分类编辑：${withExtension ? '扩展' : 'file://'}基础字段、旧经历清理与重启`, { timeout: 90000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'resume-cleanup-')); let context; const errors = [];
    const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      const seeded = await page.evaluate(async () => {
        const { database } = await dataRequest('localapply:read'); const profileId = database.activeProfileId;
        const cells = [
          ['education', 0, 'school', '合成同名学院'], ['education', 0, 'degree', '本科'], ['education', 0, 'major', '合成计算机'],
          ['education', 1, 'school', '合成同名学院'], ['education', 1, 'degree', '硕士'],
          ['employment', 0, 'company', '合成工作单位'], ['employment', 0, 'description', '合成工作职责'],
          ['internship', 0, 'company', '合成实习单位'], ['project', 0, 'title', '合成项目'],
        ];
        await dataCommand('importResume', { profileId, fingerprint: 'a'.repeat(64), overwrite: false,
          rows: cells.map(([kind, index, key, value]) => ({ kind, index, key, value, evidence: { kind: 'manual', excerpt: '', page: 0, verified: false } })) }, database.revision);
        await dataCommand('setValue', { profileId, fieldId: 'builtin.school', value: '合成基础学院' });
        await dataCommand('createField', { profileId, definition: { label: '合成辅修', group: '教育经历' }, value: '合成辅修内容' });
        await dataCommand('createField', { profileId, definition: { label: '合成研究成果', group: '研究成果', type: 'textarea' }, value: '合成研究内容' });
        const entries = (await dataRequest('localapply:read')).database.entries.filter((entry) => entry.profileId === profileId);
        await dataCommand('saveMapping', { profileId, entryId: entries[0].entryId, fieldId: 'builtin.school', origin: 'https://example.test', path: '/apply', label: '合成经历学校' });
        const other = (await dataCommand('createProfile', { name: '合成隔离简历' })).result;
        const otherEntry = (await dataCommand('createEntry', { profileId: other, kind: 'project', title: '合成保留项目' })).result;
        await dataCommand('setValue', { profileId: other, entryId: otherEntry, fieldId: 'builtin.skills', value: '合成保留值' });
        const state = await getState(); state.activeProfileId = profileId; await saveState(state);
        await dataRequest('localapply:vault', { action: 'setKey', payload: { providerId: 'zhipu', key: 'fake-cleanup-browser-key', revision: 0 } });
        await reloadDataState(profileId); return { profileId, other, entries };
      });
      assert.equal(await page.locator('#entryKind,#entryTitle,#btnAddEntry,#entriesList,.entry-card,[data-add-entry-kind],.resume-entry-more,.resume-record:not(.resume-primary-record)').count(), 0);
      assert.equal(await page.locator('#resumeToc [data-toc-key^="entry:"]').count(), 0);
      assert.equal(await page.locator('.resume-group[data-group="教育背景"]').count(), 1);
      // 参考目录已提供工作/实习/项目基础字段分类；仍不能按旧 entryId 生成独立经历卡片。
      assert.equal(await page.locator('.resume-group[data-group="教育经历"]').count(), 0);
      // 折叠选填区也沿用 basic-grid，只检查唯一的常用字段网格；旧数据仍不能生成目录记录。
      for (const group of ['工作经历', '实习经历', '项目经历']) assert.equal(await page.locator(`.resume-group[data-group="${group}"] .resume-primary-record .basic-grid:not(.resume-more-fields)`).count(), 1);
      assert.equal(await page.getByLabel('简历中心 · 毕业院校', { exact: true }).inputValue(), '合成基础学院', '旧经历不得自动覆盖基础字段');
      const before = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const settings = (await page.evaluate(() => getState())).settings;
      page.once('dialog', (dialog) => dialog.dismiss()); await page.locator('#clearResumeEntries').click();
      await page.waitForFunction(() => !document.getElementById('clearResumeEntries').disabled);
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, before.revision);
      // 清理确认显示影响数量及恢复范围，用户拒绝前不能落盘。
      page.once('dialog', (dialog) => { assert.ok(dialog.message().includes('5 条旧经历') && dialog.message().includes('恢复点')); return dialog.accept(); });
      await page.locator('#clearResumeEntries').click(); await page.waitForFunction(() => document.getElementById('entryStatus').textContent.includes('已清空 5 条'));
      const cleared = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.ok(!cleared.entries.some((entry) => entry.profileId === seeded.profileId));
      assert.ok(!cleared.fieldValues.some((row) => row.profileId === seeded.profileId && row.entryId !== null));
      assert.ok(!cleared.mappingRules.some((row) => row.profileId === seeded.profileId));
      assert.deepEqual(cleared.fieldDefinitions, before.fieldDefinitions); assert.deepEqual(cleared.bindings, before.bindings);
      for (const table of ['entries','fieldValues','mappingRules']) assert.deepEqual(cleared[table].filter((row) => row.profileId === seeded.other), before[table].filter((row) => row.profileId === seeded.other));
      assert.deepEqual((await page.evaluate(() => getState())).settings, settings);
      assert.equal(await page.locator('#legacyEntriesNotice').isVisible(), false);
      await workspacePage(page, 'privacySettings'); await page.locator('#btnRestoreRecovery').click();
      await page.waitForFunction(() => document.getElementById('backupMsg').textContent.includes('已恢复'));
      const recovered = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      for (const table of ['entries','fieldValues','mappingRules']) assert.deepEqual(recovered[table], before[table]);
      await workspacePage(page, 'resumeCenter'); assert.equal(await page.locator('#legacyEntriesNotice').isVisible(), true);
      page.once('dialog', (dialog) => dialog.accept()); await page.locator('#clearResumeEntries').click();
      await page.waitForFunction(() => document.getElementById('entryStatus').textContent.includes('已清空 5 条'));
      // 基础字段继续逐项保存；旧页面冲突时保留草稿，未冲突字段仍可编辑。
      const school = page.getByLabel('简历中心 · 毕业院校', { exact: true });
      const stale = await context.newPage(); await stale.goto(url); await workspacePage(stale, 'resumeCenter');
      await school.fill('合成更新基础学院'); await school.blur(); await page.evaluate(() => resumeSaveQueue);
      const draft = stale.getByLabel('简历中心 · 毕业院校', { exact: true });
      await draft.fill('合成冲突草稿'); await draft.blur(); await stale.evaluate(() => resumeSaveQueue);
      assert.ok((await stale.locator('#centerStatus').textContent()).includes('其他页面修改'));
      assert.equal(await draft.inputValue(), '合成冲突草稿'); assert.equal(await draft.getAttribute('data-dirty'), 'true');
      const research = stale.getByLabel('简历中心 · 合成研究成果', { exact: true });
      await research.fill('合成更新成果'); await research.blur(); await stale.evaluate(() => resumeSaveQueue);
      assert.equal(await draft.inputValue(), '合成冲突草稿'); await stale.close();
      const linked = await context.newPage();
      await linked.goto(url + '?profile=' + encodeURIComponent(seeded.profileId) + '&section=' + encodeURIComponent('group:教育经历') + '#resumeCenter');
      await linked.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      assert.equal(await linked.evaluate(() => document.activeElement.dataset.group), '教育背景'); await linked.close();
      await page.reload(); await workspacePage(page, 'resumeCenter');
      await page.locator('#resumeToc').getByRole('button', { name: '教育背景', exact: true }).click();
      await page.screenshot({ path: path.join(testRoot, `resume-cleanup-${mode}.png`) });
      await page.locator('#themeToggle').click(); await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(testRoot, `resume-cleanup-narrow-${mode}.png`) });
      const backup = (await page.evaluate(() => dataRequest('localapply:exportBackup'))).backup;
      assert.ok(!JSON.stringify(backup).includes('fake-cleanup-browser-key'));
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      page = await context.newPage(); await page.goto(url); await workspacePage(page, 'resumeCenter');
      const restarted = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.equal(restarted.schemaVersion, 5); assert.ok(!restarted.entries.some((entry) => entry.profileId === seeded.profileId));
      assert.equal(await page.getByLabel('简历中心 · 毕业院校', { exact: true }).inputValue(), '合成更新基础学院');
      assert.equal(await page.getByLabel('简历中心 · 合成研究成果', { exact: true }).inputValue(), '合成更新成果');
      assert.equal(await page.locator('#basicFields .entry-card,[data-add-entry-kind]').count(), 0); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 两种入口均使用独立浏览器目录，只填合成值，验证参考目录控件、持久化和用户删减。
for (const withExtension of [true, false]) {
  test(`参考字段目录：${withExtension ? '扩展' : 'file://'}下拉、日历、地区、多选和重启`, { timeout: 120000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'reference-catalog-')); let context; const errors = [];
    const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      // 通过字段 ID 定位同名表单项，避免跨基础信息、家庭成员或实习/工作分类误操作。
      const field = (key) => page.locator(`#basicFields .center-field[data-field-id="builtin.${key}"]`);
      // 自动保存完成后才读取结果，不能把界面上的暂存值误报为持久化成功。
      const saved = async () => { await page.evaluate(() => resumeSaveQueue); assert.ok(!(await page.locator('#centerStatus').textContent()).includes('保存失败')); };
      const initial = (await page.evaluate(() => dataRequest('localapply:read'))).database; const profileId = initial.activeProfileId;
      assert.equal(await page.locator('#basicFields .center-field').count(), 155);
      // 完整候选、地区和多城市属于选填区，先按新交互显式展开再验证原有编辑链路。
      for (const name of ['基本信息', '教育背景', '求职意向']) await expandResumeGroup(page, name);
      for (const group of ['基本信息','求职意向','教育背景','实习经历','工作经历','项目经历','家庭成员','获奖经历','英语能力','证书信息','论文期刊','自我介绍']) {
        assert.equal(await page.locator(`.resume-group[data-group="${group}"]`).count(), 1);
        assert.equal(await page.locator('#resumeToc').getByRole('button', { name: group, exact: true }).count(), 1);
      }
      assert.equal(await page.locator('.entry-card,[data-add-entry-kind]').count(), 0);
      assert.equal(initial.fieldDefinitions.find((item) => item.fieldId === 'builtin.majorCategory').options.length, 238);
      assert.equal(await field('ethnic').locator('select option').count(), 57);
      await field('identityType').locator('select').selectOption('护照'); await saved();
      // 专业分类改为真实搜索下拉，保留完整候选、仅确认保存、取消恢复和键盘选择的回归。
      const major = field('majorCategory'); const majorInput = major.getByRole('combobox'); const searchRevision = (await page.evaluate(() => dataRequest('localapply:read'))).database.revision;
      await majorInput.click(); assert.equal(await major.getByRole('option').count(), 239); await majorInput.fill('计算机'); assert.equal(await major.getByRole('option').count(), 2);
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, searchRevision);
      await major.locator('.workspace-select-popup').screenshot({ path: path.join(testRoot, `major-category-search-${mode}.png`) });
      await major.getByRole('option', { name: '学术型硕士 / 工学 / 计算机科学与技术', exact: true }).click(); await saved();
      await major.getByRole('button', { name: '展开选项 · 专业分类', exact: true }).click(); assert.equal(await major.getByRole('option').count(), 239); assert.equal(await major.locator('[role="option"][aria-selected="true"]').textContent(), '学术型硕士 / 工学 / 计算机科学与技术');
      const confirmedRevision = (await page.evaluate(() => dataRequest('localapply:read'))).database.revision;
      await majorInput.fill('合成无匹配专业'); assert.equal(await major.getByRole('option').count(), 0); await majorInput.press('Enter'); await majorInput.press('Escape'); assert.equal(await majorInput.inputValue(), '学术型硕士 / 工学 / 计算机科学与技术');
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, confirmedRevision);
      await majorInput.fill('学术型硕士 艺术学 音乐'); assert.equal(await major.getByRole('option').count(), 1); await majorInput.press('ArrowDown'); await majorInput.press('Enter'); await saved();
      const majorOption = initial.fieldDefinitions.find((item) => item.fieldId === 'builtin.majorCategory').options.at(-1); assert.equal(await majorInput.inputValue(), majorOption);
      await field('currentSalary').locator('input').fill('0'); await field('currentSalary').locator('input').blur(); await saved();
      await field('employmentCompany').locator('input').fill('合成工作单位'); await field('employmentCompany').locator('input').blur(); await saved();
      // 自绘日历使用可手输文本替代原生弹窗，精度和原有持久化断言保持不变。
      assert.equal(await field('awardDate').locator('input').getAttribute('data-date-precision'), 'date');
      await field('awardDate').locator('input').fill('2028-02-29'); await field('awardDate').locator('input').blur(); await saved();
      await field('educationStartDate').locator('select').selectOption('month');
      assert.equal(await field('educationStartDate').locator('input').getAttribute('data-date-precision'), 'month');
      await field('educationStartDate').locator('input').fill('2024-09'); await field('educationStartDate').locator('input').blur(); await saved();
      await page.evaluate(async ({ profileId }) => {
        await dataCommand('setValue', { profileId, fieldId: 'builtin.birthDate', value: '2000.02（合成旧格式）' });
        await dataCommand('setValue', { profileId, fieldId: 'builtin.graduationDate', value: '2027' }); await renderResumeCenter();
      }, { profileId });
      // 非标准日期及不存在的日期不得被原生 date 控件吞成空白。
      for (const legacy of ['2027-02-30', '2027-13']) {
        await page.evaluate(async ({ profileId, legacy }) => { await dataCommand('setValue', { profileId, fieldId: 'builtin.birthDate', value: legacy }); await renderResumeCenter(); }, { profileId, legacy });
        assert.equal(await field('birthDate').locator('input').inputValue(), legacy); assert.equal(await field('birthDate').locator('select').inputValue(), 'legacy');
      }
      await page.evaluate(async ({ profileId }) => { await dataCommand('setValue', { profileId, fieldId: 'builtin.birthDate', value: '2000.02（合成旧格式）' }); await renderResumeCenter(); }, { profileId });
      assert.equal(await field('birthDate').locator('input').inputValue(), '2000.02（合成旧格式）');
      assert.equal(await field('birthDate').locator('select').inputValue(), 'legacy');
      await field('birthDate').locator('select').selectOption('date');
      let database = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.equal(database.fieldValues.find((row) => row.fieldId === 'builtin.birthDate').value, '2000.02（合成旧格式）', '选择更高精度而未选日期时不得清掉旧值');
      await field('birthDate').locator('input').fill('2000-02-29'); await field('birthDate').locator('input').blur(); await saved();
      assert.equal(await field('graduationDate').locator('select').inputValue(), 'year');
      await field('graduationDate').locator('select').selectOption('month');
      assert.equal(await field('graduationDate').locator('input').inputValue(), '');
      database = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.equal(database.fieldValues.find((row) => row.fieldId === 'builtin.graduationDate').value, '2027');
      await field('graduationDate').locator('input').fill('2027-06'); await field('graduationDate').locator('input').blur(); await saved();
      await field('availableTime').locator('select').selectOption('legacy'); await field('availableTime').locator('input').fill('随时（合成说明）'); await field('availableTime').locator('input').blur(); await saved();
      // 省市区改为同一内容框内的联动面板；选择当前路径或手填确认后才写入。
      const region = page.getByRole('dialog', { name: '地区选择 · 家庭所在地区', exact: true });
      await field('homeRegion').locator('[data-primary]').click(); await region.getByRole('option', { name: '江苏省', exact: true }).click();
      assert.ok(await region.getByRole('option').count() >= 13); await region.getByRole('option', { name: '南京市', exact: true }).click();
      assert.equal(await region.getByRole('option', { name: '玄武区', exact: true }).count(), 1); await region.getByRole('button', { name: '使用当前地区', exact: true }).click(); await saved();
      await field('homeRegion').locator('[data-primary]').fill('江苏省 / 合成市 / 合成区'); await region.getByRole('button', { name: '使用输入内容', exact: true }).click(); await saved();
      assert.equal(await field('homeRegion').locator('[data-primary]').inputValue(), '江苏省 / 合成市 / 合成区');
      await field('expectedCities').getByRole('textbox').fill('合成甲城、合成乙城'); await field('expectedCities').getByRole('textbox').press('Enter'); await saved();
      // 回车后的城市标签与继续输入的位置都必须落在同一可见边框内，而非显示在框外。
      assert.equal(await field('expectedCities').locator('.workspace-multi-entry').evaluate((element) => {
        const box = element.getBoundingClientRect(); return [...element.querySelectorAll('button, input')].every((node) => { const rect = node.getBoundingClientRect(); return rect.left >= box.left && rect.right <= box.right + 1 && rect.top >= box.top && rect.bottom <= box.bottom + 1; });
      }), true);
      assert.equal(await field('expectedCities').locator('.workspace-multi-entry button').count(), 2); assert.equal(await field('expectedCities').getByRole('textbox').inputValue(), '');
      await field('expectedCities').screenshot({ path: path.join(testRoot, `city-tags-inside-${mode}.png`) });
      database = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.deepEqual(database.fieldValues.find((row) => row.fieldId === 'builtin.expectedCities').value, ['合成甲城', '合成乙城']);
      await field('expectedCities').getByRole('button', { name: '移除城市 · 合成甲城', exact: true }).click(); await saved();
      database = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.deepEqual(database.fieldDefinitions.find((def) => def.fieldId === 'builtin.expectedCities').options, []);
      await workspacePage(page, 'fieldLibrary');
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('.library-row[data-field-id="builtin.paperName"]').getByRole('button', { name: '移除当前档案字段' }).click();
      await page.waitForFunction(() => document.getElementById('fieldStatus').textContent.includes('已从当前档案移除'));
      await workspacePage(page, 'resumeCenter'); await page.locator('#resumeToc').getByRole('button', { name: '教育背景', exact: true }).click();
      await page.screenshot({ path: path.join(testRoot, `reference-catalog-${mode}.png`) });
      await page.locator('#themeToggle').click(); await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#resumeToc').getByRole('button', { name: '获奖经历', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(testRoot, `reference-catalog-narrow-${mode}.png`) });
      const backup = (await page.evaluate(() => dataRequest('localapply:exportBackup'))).backup;
      assert.equal(backup.database.schemaVersion, 5);
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      page = await context.newPage(); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.equal(await field('paperName').count(), 0, '用户移除的字段在整个浏览器重启后不再自动补回');
      assert.equal(await field('awardDate').locator('input').inputValue(), '2028-02-29');
      assert.equal(await field('educationStartDate').locator('input').inputValue(), '2024-09');
      assert.equal(await field('graduationDate').locator('input').inputValue(), '2027-06');
      assert.equal(await field('availableTime').locator('input').inputValue(), '随时（合成说明）');
      assert.equal(await field('homeRegion').locator('[data-primary]').inputValue(), '江苏省 / 合成市 / 合成区');
      assert.equal(await field('employmentCompany').locator('input').inputValue(), '合成工作单位');
      assert.equal(await field('identityType').locator('select').inputValue(), '护照');
      await expandResumeGroup(page, '教育背景'); assert.equal(await field('majorCategory').getByRole('combobox').inputValue(), majorOption);
      database = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.deepEqual(database.fieldValues.find((row) => row.fieldId === 'builtin.expectedCities').value, ['合成乙城']);
      assert.equal(database.fieldValues.find((row) => row.fieldId === 'builtin.currentSalary').value, 0);
      // 附加教育记录沿用同一可搜索模板，其选中值不得覆盖首条记录。
      await expandResumeGroup(page, '教育背景'); const education = page.locator('.resume-group[data-group="教育背景"]'); await education.locator('[data-module-action="add"]').click(); await page.waitForFunction(() => document.querySelectorAll('.resume-group[data-group="教育背景"] .resume-record').length === 2);
      const secondEducation = education.locator('.resume-record:not(.resume-primary-record)'); await secondEducation.locator('.resume-more-toggle').click(); const secondMajor = secondEducation.locator('[data-field-id="builtin.majorCategory"]'); await secondMajor.getByRole('combobox').fill('软件工程'); await secondMajor.getByRole('option', { name: '学术型硕士 / 工学 / 软件工程', exact: true }).click(); await saved();
      assert.equal(await education.locator('.resume-primary-record [data-field-id="builtin.majorCategory"]').getByRole('combobox').inputValue(), majorOption); assert.equal(await secondMajor.getByRole('combobox').inputValue(), '学术型硕士 / 工学 / 软件工程'); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 自绘日期控件在两种入口运行真实保存链路；翻页和取消不能改动个人资料。
for (const withExtension of [true, false]) {
  test(`中文弹出日历：${withExtension ? '扩展' : 'file://'}选择、精度、键盘和主题`, { timeout: 120000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'calendar-')); let context; const errors = []; const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      await page.evaluate(async () => { const database = (await dataRequest('localapply:read')).database; await dataCommand('setValue', { profileId: database.activeProfileId, fieldId: 'builtin.birthDate', value: '2000-02-01' }); await renderResumeCenter(); });
      const birth = page.locator('#basicFields .center-field[data-field-id="builtin.birthDate"]'); const input = birth.locator('input'); const popup = page.getByRole('dialog', { name: '日期选择 · 出生日期', exact: true });
      // 查询后台真实存储，不能把输入框中的暂存文本当作保存成功。
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      // 等待既有自动保存队列结束后取得生日值。
      const savedValue = async () => { await page.evaluate(() => resumeSaveQueue); return (await read()).fieldValues.find((row) => row.fieldId === 'builtin.birthDate')?.value ?? null; };
      const revision = (await read()).revision;
      await birth.getByRole('button', { name: '打开日历 · 出生日期', exact: true }).click(); await popup.waitFor();
      assert.equal(await popup.locator('[aria-selected="true"]').getAttribute('data-value'), '2000-02-01');
      await popup.getByRole('button', { name: '下个月', exact: true }).click();
      await popup.getByRole('button', { name: '前一年', exact: true }).click();
      await popup.getByRole('button', { name: '后一年', exact: true }).click();
      assert.equal((await read()).revision, revision); await page.keyboard.press('Escape'); assert.equal(await popup.count(), 0); assert.equal(await input.inputValue(), '2000-02-01');
      await input.click(); await popup.getByRole('button', { name: '选择年份', exact: true }).click();
      await popup.getByRole('gridcell', { name: '2000年', exact: true }).click();
      await popup.getByRole('gridcell', { name: '2000年2月', exact: true }).click();
      await popup.getByRole('gridcell', { name: '2000年2月29日', exact: true }).click();
      assert.equal(await savedValue(), '2000-02-29');
      await input.click(); await input.press('ArrowDown'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter'); assert.equal(await savedValue(), '2000-02-28');
      // 手输错误日期显示错误且不写库，纠正后仍可沿用自动保存。
      await input.fill('2001-02-29'); await input.blur(); assert.equal(await input.getAttribute('aria-invalid'), 'true'); assert.equal(await savedValue(), '2000-02-28');
      await input.fill('2000-02-29'); await input.blur(); assert.equal(await savedValue(), '2000-02-29');
      // 点击文本框打开日历后仍可直接打字，不能将输入焦点强行挪到日期按钮。
      await input.click(); assert.equal(await input.evaluate((element) => document.activeElement === element), true);
      await input.press('Control+A'); await input.pressSequentially('2000-02-28'); await input.press('Tab'); assert.equal(await savedValue(), '2000-02-28');
      await birth.locator('select').selectOption('month'); assert.equal(await savedValue(), '2000-02');
      await input.click(); await popup.getByRole('button', { name: '选择年份', exact: true }).click(); await popup.getByRole('gridcell', { name: '2001年', exact: true }).click(); await popup.getByRole('gridcell', { name: '2001年9月', exact: true }).click(); assert.equal(await savedValue(), '2001-09');
      await birth.locator('select').selectOption('year'); assert.equal(await savedValue(), '2001');
      await input.click(); await popup.getByRole('gridcell', { name: '2002年', exact: true }).click(); assert.equal(await savedValue(), '2002');
      await input.click(); await popup.getByRole('button', { name: '清空日期', exact: true }).click(); assert.equal(await savedValue(), null);
      const emptyRevision = (await read()).revision;
      await birth.locator('select').selectOption('date'); await input.click(); assert.equal(await input.inputValue(), ''); assert.equal((await read()).revision, emptyRevision);
      await popup.getByRole('button', { name: '选择当前日期', exact: true }).click();
      const today = await page.evaluate(() => { const now = new Date(); return LocalApplyDatePicker.format(now.getFullYear(), now.getMonth() + 1, now.getDate()); }); assert.equal(await savedValue(), today);
      // 明暗主题以及窄屏截图仅使用合成值，检查弹层在视口内且不制造横向滚动。
      await input.fill('2000-02-01'); await input.blur(); await savedValue();
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await input.click();
      await page.screenshot({ path: path.join(testRoot, `calendar-light-${mode}.png`) });
      const light = await popup.evaluate((element) => getComputedStyle(element).backgroundColor);
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      assert.notEqual(await popup.evaluate((element) => getComputedStyle(element).backgroundColor), light);
      await page.screenshot({ path: path.join(testRoot, `calendar-dark-${mode}.png`) });
      await page.keyboard.press('Escape'); await page.setViewportSize({ width: 390, height: 844 }); await input.click(); await popup.waitFor();
      const bounds = await popup.boundingBox(); assert.ok(bounds.x >= 11 && bounds.x + bounds.width <= 379 && bounds.y >= 11 && bounds.y + bounds.height <= 833);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(testRoot, `calendar-narrow-${mode}.png`) });
      await workspacePage(page, 'aiSettings'); assert.equal(await popup.count(), 0, '模块切换应清理日历'); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 更多字段在真实扩展和文件入口均只控制显示，不改变字段数量、数据库或编辑能力。
for (const withExtension of [true, false]) {
  test(`简历更多字段：${withExtension ? '扩展' : 'file://'}默认收起、编辑与档案隔离`, { timeout: 90000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'resume-more-')); let context; const errors = []; const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(url); await workspacePage(page, 'resumeCenter');
      const primaryId = await page.locator('#entryProfile').inputValue();
      // 只读取后台版本和值，验证展开行为没有触发隐式保存。
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const before = await read(); const basic = page.locator('.resume-group[data-group="基本信息"]'); const education = page.locator('.resume-group[data-group="教育背景"]'); const job = page.locator('.resume-group[data-group="求职意向"]');
      assert.equal(await page.locator('#basicFields .center-field').count(), 155);
      for (const [section, visible] of [[basic, 18], [education, 7], [job, 8]]) {
        assert.equal(await section.locator('.center-field:visible').count(), visible); assert.equal(await section.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'false');
        assert.ok(await section.locator('.center-field').count() > visible);
      }
      assert.equal(await page.locator('.resume-group[data-group="自我介绍"] .resume-more-toggle').count(), 0);
      for (const toggle of await page.locator('.resume-more-toggle').all()) assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.locator('#resumeToc').getByRole('button', { name: '求职意向', exact: true }).click();
      assert.equal(await job.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'false', '目录定位不得自动展开选填字段');
      await page.screenshot({ path: path.join(testRoot, `resume-more-collapsed-${mode}.png`) });
      await job.locator('.resume-more-toggle').click(); assert.equal(await job.locator('.center-field:visible').count(), await job.locator('.center-field').count());
      await page.screenshot({ path: path.join(testRoot, `resume-more-expanded-${mode}.png`) });
      await job.locator('.resume-more-toggle').click(); assert.equal(await job.locator('.center-field:visible').count(), 8); assert.equal((await read()).revision, before.revision);
      await expandResumeGroup(page, '基本信息'); const wechat = basic.locator('[data-field-id="builtin.wechat"] input');
      await wechat.fill('合成更多字段值'); await wechat.blur(); await page.evaluate(() => resumeSaveQueue);
      assert.equal((await read()).fieldValues.find((row) => row.profileId === primaryId && row.fieldId === 'builtin.wechat').value, '合成更多字段值');
      const revision = (await read()).revision;
      // 无效日期留作未保存草稿，折叠/再展开不得重建输入或丢失文字。
      const date = basic.locator('[data-field-id="builtin.joinPartyDate"] input'); await date.fill('2027-02-30');
      await basic.locator('.resume-more-toggle').click(); await basic.locator('.resume-more-toggle').click(); assert.equal(await date.inputValue(), '2027-02-30'); assert.equal(await date.getAttribute('aria-invalid'), 'true'); assert.equal((await read()).revision, revision);
      await date.fill('2027-02-28'); await date.blur(); await page.evaluate(() => resumeSaveQueue);
      await workspacePage(page, 'aiSettings'); await workspacePage(page, 'resumeCenter'); assert.equal(await basic.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'true');
      await page.evaluate(() => renderResumeCenter()); assert.equal(await basic.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'true'); assert.equal(await wechat.inputValue(), '合成更多字段值');
      // 新简历默认收起，返回原简历只恢复本页展开状态，不串用个人值。
      await page.locator('#newProfileName').fill('合成第二份简历'); await page.locator('#createResumeProfile').click(); await page.waitForFunction(() => !document.getElementById('createResumeProfile').disabled);
      assert.notEqual(await page.locator('#entryProfile').inputValue(), primaryId); assert.equal(await basic.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'false'); assert.equal(await wechat.inputValue(), '');
      await page.locator('#entryProfile').selectOption(primaryId); await page.waitForFunction((profileId) => document.getElementById('entryProfile').value === profileId && document.querySelector('.resume-group[data-group="基本信息"] .resume-more-toggle')?.getAttribute('aria-expanded') === 'true', primaryId);
      assert.equal(await wechat.inputValue(), '合成更多字段值');
      await page.locator('#themeToggle').click(); await page.setViewportSize({ width: 390, height: 844 }); await expandResumeGroup(page, '证书信息');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(testRoot, `resume-more-narrow-${mode}.png`) });
      await page.reload(); await workspacePage(page, 'resumeCenter'); assert.equal(await basic.locator('.resume-more-toggle').getAttribute('aria-expanded'), 'false'); assert.equal(await wechat.inputValue(), '合成更多字段值'); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 清空内容通过真实按钮确认，独立浏览器重启后验证空值及恢复点，而非仅检查显示文字。
for (const withExtension of [true, false]) {
  test(`简历清空内容：${withExtension ? '扩展' : 'file://'}确认、隔离、重启与恢复`, { timeout: 90000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'clear-values-')); let context; const errors = []; const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      const seeded = await page.evaluate(async () => {
        const db = (await dataRequest('localapply:read')).database; const profileId = db.activeProfileId;
        await dataCommand('setValue', { profileId, fieldId: 'builtin.name', value: '合成清空姓名' }); await dataCommand('setValue', { profileId, fieldId: 'builtin.wechat', value: '合成隐藏字段内容' });
        const fieldId = (await dataCommand('createField', { profileId, definition: { label: '合成动态数字', group: '合成清空模块', type: 'number' }, value: 0 })).result;
        await dataCommand('importResume', { profileId, fingerprint: 'e'.repeat(64), overwrite: false, rows: [{ kind: 'education', index: 0, key: 'school', value: '合成旧经历学院', evidence: { kind: 'manual', excerpt: '合成来源', page: 0, verified: false } }] }, (await dataRequest('localapply:read')).database.revision);
        const other = (await dataCommand('createProfile', { name: '合成保留简历' })).result; await dataCommand('setValue', { profileId: other, fieldId: 'builtin.name', value: '合成隔离姓名' });
        const next = await getState(); next.activeProfileId = profileId; await saveState(next); await reloadDataState(profileId); return { profileId, other, fieldId };
      });
      // 读取完整规范数据库进行隔离检查，不借助 UI 投影掩盖隐藏值。
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const before = await read(); const settings = await page.evaluate(async () => (await getState()).settings);
      const stale = await context.newPage(); await stale.goto(url); await workspacePage(stale, 'resumeCenter');
      page.once('dialog', (dialog) => dialog.dismiss()); await page.locator('#clearResumeValues').click(); await page.waitForFunction(() => !document.getElementById('clearResumeValues').disabled);
      assert.equal((await read()).revision, before.revision); assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '合成清空姓名');
      page.once('dialog', (dialog) => { assert.match(dialog.message(), /收起的选填字段/); assert.match(dialog.message(), /恢复点/); dialog.accept(); });
      await page.locator('#clearResumeValues').click(); await page.waitForFunction(() => !document.getElementById('clearResumeValues').disabled && document.getElementById('centerStatus').textContent.startsWith('已清空'));
      const after = await read(); assert.ok(after.fieldValues.filter((row) => row.profileId === seeded.profileId).every((row) => row.value === null && row.evidence === undefined));
      for (const table of ['profiles', 'fieldDefinitions', 'bindings', 'entries', 'mappingRules']) assert.deepEqual(after[table], before[table]);
      assert.deepEqual(after.fieldValues.filter((row) => row.profileId === seeded.other), before.fieldValues.filter((row) => row.profileId === seeded.other));
      assert.deepEqual(await page.evaluate(async () => (await getState()).settings), settings);
      assert.equal(await page.locator('#overviewValues').textContent(), '0'); assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '');
      await page.locator('#resumeToc').getByRole('button', { name: '档案与资料', exact: true }).click(); await page.screenshot({ path: path.join(testRoot, `clear-values-${mode}.png`) });
      const staleName = stale.getByLabel('简历中心 · 姓名', { exact: true }); await staleName.fill('合成过期输入'); await staleName.blur(); await stale.evaluate(() => resumeSaveQueue);
      assert.ok((await stale.locator('#centerStatus').textContent()).includes('保存失败')); assert.equal((await read()).revision, after.revision); await stale.close();
      // 全空时重复点击不覆盖恢复点；明确放弃未保存日期草稿后也应清空界面。
      const date = page.locator('[data-field-id="builtin.birthDate"] input'); await date.fill('2027-02-30'); page.once('dialog', (dialog) => dialog.accept()); await page.locator('#clearResumeValues').click();
      await page.waitForFunction(() => !document.getElementById('clearResumeValues').disabled && document.getElementById('centerStatus').textContent.includes('已为空'));
      assert.equal(await date.inputValue(), ''); assert.equal((await read()).revision, after.revision);
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.ok((await read()).fieldValues.filter((row) => row.profileId === seeded.profileId).every((row) => row.value === null));
      await workspacePage(page, 'privacySettings'); await page.locator('#btnRestoreRecovery').click(); await page.waitForFunction(() => document.getElementById('backupMsg').textContent.includes('已恢复'));
      assert.deepEqual((await read()).fieldValues, before.fieldValues); await workspacePage(page, 'resumeCenter'); assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '合成清空姓名'); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 直接在独立测试存储植入 v1 快照，验证真实启动迁移及两种入口的刷新/进程重启。
for (const withExtension of [true, false]) {
  test(`旧模块删除：${withExtension ? '扩展' : 'file://'}目录迁移、删除保留与重启`, { timeout: 90000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'prune-modules-')); let context; const errors = []; const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.equal(await page.locator('#basicFields .center-field').count(), 155); assert.equal(await page.locator('#basicFields > .resume-group').count(), 12);
      await page.evaluate(async () => {
        const db = (await dataRequest('localapply:read')).database; const profileId = db.activeProfileId;
        db.fieldValues.find((row) => row.profileId === profileId && row.fieldId === 'builtin.name').value = '合成保留姓名';
        const retained = new Set(WangshenTemplates.PROFILE_TEMPLATE.map((field) => field.key));
        for (const field of WangshenTemplates.SOE_LONG_TEMPLATE.filter((field) => !retained.has(field.key))) {
          const fieldId = 'builtin.' + field.key; db.fieldDefinitions.push(LocalApplyStore.definition({ fieldId, label: field.label, type: field.inputType, group: field.group, options: field.options || [], aliases: [], description: '', version: 1 })); db.publicFieldIds.push(fieldId);
          db.bindings.push({ profileId, fieldId, fid: 'retired.' + field.key, key: field.key, sensitive: false, autoFill: false, material: !!field.material, custom: false });
          db.fieldValues.push({ profileId, fieldId, entryId: null, value: '合成旧模块资料', updatedAt: new Date().toISOString(), source: 'manual' });
        }
        // 旧模型契约把语言证书存到“简历资料”，此前会绕过按分类清理并重新生成语言模块。
        db.fieldDefinitions.push(LocalApplyStore.definition({ fieldId: 'resume.languages', label: '语言证书', type: 'text', group: '简历资料', aliases: [], options: [], description: '', version: 1 }));
        db.bindings.push({ profileId, fieldId: 'resume.languages', fid: 'retired.resume-languages', key: 'languages', sensitive: false, autoFill: false, material: false, custom: true });
        db.fieldValues.push({ profileId, fieldId: 'resume.languages', entryId: null, value: '合成旧语言证书', updatedAt: new Date().toISOString(), source: 'ai-confirmed' });
        db.bindings = db.bindings.filter((row) => row.fieldId !== 'builtin.paperName'); db.fieldValues = db.fieldValues.filter((row) => row.fieldId !== 'builtin.paperName'); LocalApplyStore.validate(db);
        const write = { 'localapply.database': db, 'localapply.fieldCatalog': { version: 1 } };
        // 仅用于合成夹具置入升级前快照；生产界面仍通过后台仓库写数据。
        if (location.protocol !== 'file:') await chrome.storage.local.set(write);
        else await new Promise((resolve, reject) => {
          const request = indexedDB.open('localapply-file:' + new URL('.', location.href).href, 1);
          request.onerror = () => reject(request.error); request.onsuccess = () => { const database = request.result; const tx = database.transaction('storage', 'readwrite'); tx.oncomplete = () => { database.close(); resolve(); }; tx.onerror = tx.onabort = () => { database.close(); reject(tx.error); }; for (const [key, value] of Object.entries(write)) tx.objectStore('storage').put(value, key); };
        });
      });
      await page.reload(); await workspacePage(page, 'resumeCenter');
      // 数据库、正文、目录和字段库同时检查，避免仅靠隐藏旧模块伪装删除。
      const check = async () => {
        const database = (await page.evaluate(() => dataRequest('localapply:read'))).database; assert.equal(database.schemaVersion, 5); assert.equal(database.fieldDefinitions.length, 155);
        assert.ok(!database.fieldDefinitions.some((field) => field.fieldId === 'resume.languages')); assert.ok(!database.fieldValues.some((row) => row.value === '合成旧语言证书'));
        assert.equal(await page.locator('#basicFields .center-field').count(), 154); assert.equal(await page.locator('#basicFields > .resume-group').count(), 12);
        for (const name of ['技能与其他', '开放题素材', '政治与个人情况', '语言与技能证书', '家庭与紧急联系', '补充声明', '填写偏好']) assert.equal(await page.locator('#resumeToc').getByRole('button', { name, exact: true }).count(), 0);
        assert.equal(await page.locator('#fillingPreferences,#autoThreshold,#privacyMask,#autoFloatbar').count(), 0);
        assert.ok(!database.fieldValues.some((row) => row.value === '合成旧模块资料')); assert.equal(await page.getByLabel('简历中心 · 姓名', { exact: true }).inputValue(), '合成保留姓名'); assert.equal(await page.locator('[data-field-id="builtin.paperName"]').count(), 1, '字段库定义保留，但当前简历不重新绑定');
        assert.equal(await page.locator('#basicFields [data-field-id="builtin.paperName"]').count(), 0);
      };
      await check(); await workspacePage(page, 'fieldLibrary'); assert.equal(await page.locator('.library-row[data-field-id="builtin.github"]').count(), 0); await workspacePage(page, 'resumeCenter');
      await page.locator('#resumeToc').getByRole('button', { name: '自我介绍', exact: true }).click(); await page.screenshot({ path: path.join(testRoot, `modules-pruned-${mode}.png`) });
      await page.reload(); await workspacePage(page, 'resumeCenter'); await check(); await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter'); await check(); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 单框地区选择使用真实本地候选，搜索/浏览不入库，确认后的自由文本和地区路径可重启恢复。
for (const withExtension of [true, false]) {
  test(`地区单框选择：${withExtension ? '扩展' : 'file://'}联动、搜索、手填和取消`, { timeout: 90000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'region-picker-')); let context; const errors = []; const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      await page.evaluate(async () => { const profileId = (await dataRequest('localapply:read')).database.activeProfileId; await dataCommand('setValue', { profileId, fieldId: 'builtin.homeRegion', value: '合成旧地区（海外）' }); await dataCommand('setValue', { profileId, fieldId: 'builtin.schoolRegion', value: '合成其他地区' }); await renderResumeCenter(); });
      const field = page.locator('#basicFields [data-field-id="builtin.homeRegion"]'); const input = field.locator('[data-primary]'); const popup = page.getByRole('dialog', { name: '地区选择 · 家庭所在地区', exact: true });
      // 直接读取规范库确认保存，不能将搜索框文字当作已经保存的个人值。
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      // 等待现有串行队列完成后取得地区字段值。
      const saved = async () => { await page.evaluate(() => resumeSaveQueue); return (await read()).fieldValues.find((row) => row.fieldId === 'builtin.homeRegion').value; };
      assert.equal(await field.locator('input').count(), 1); assert.equal(await page.locator('.workspace-region-parts, .workspace-region select, .workspace-region datalist').count(), 0);
      assert.equal(await input.inputValue(), '合成旧地区（海外）'); const revision = (await read()).revision;
      await input.click(); await popup.getByRole('option', { name: '江苏省', exact: true }).click(); await popup.getByRole('option', { name: '南京市', exact: true }).click();
      assert.equal((await read()).revision, revision); assert.equal(await popup.getByRole('option', { name: '玄武区', exact: true }).count(), 1);
      await popup.getByRole('button', { name: '使用当前地区', exact: true }).click(); assert.equal(await saved(), '江苏省 / 南京市');
      await input.click(); await popup.getByRole('option', { name: '玄武区', exact: true }).click(); assert.equal(await saved(), '江苏省 / 南京市 / 玄武区');
      const selectedRevision = (await read()).revision;
      await input.fill('长安区'); assert.ok(await popup.getByRole('option').count() > 1); assert.equal((await read()).revision, selectedRevision);
      await page.keyboard.press('Escape'); assert.equal(await input.inputValue(), '江苏省 / 南京市 / 玄武区'); assert.equal(await popup.count(), 0);
      await input.fill('浙江'); await page.getByRole('heading', { name: '简历中心', exact: true }).click(); assert.equal(await input.inputValue(), '江苏省 / 南京市 / 玄武区'); assert.equal((await read()).revision, selectedRevision);
      await input.fill('陕西 长安'); await popup.getByRole('option', { name: '陕西省 / 西安市 / 长安区', exact: true }).click(); assert.equal(await saved(), '陕西省 / 西安市 / 长安区');
      await input.fill('海外 / 合成新地区'); await popup.getByRole('button', { name: '使用输入内容', exact: true }).click(); assert.equal(await saved(), '海外 / 合成新地区');
      await input.fill('南京 玄武'); await input.press('Enter'); assert.equal(await saved(), '江苏省 / 南京市 / 玄武区');
      await input.click(); await popup.getByRole('button', { name: '清空', exact: true }).click(); assert.equal(await saved(), null);
      await input.fill('江苏省 / 合成市 / 合成区'); await input.press('Control+Enter'); assert.equal(await saved(), '江苏省 / 合成市 / 合成区');
      assert.equal(await page.locator('#basicFields [data-field-id="builtin.schoolRegion"] [data-primary]').inputValue(), '合成其他地区');
      // 公共地名搜索截图仅含合成个人资料，检查明暗主题及 390px 视口的弹窗边界。
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await input.fill('长安区'); await page.screenshot({ path: path.join(testRoot, `region-picker-light-${mode}.png`) });
      await page.keyboard.press('Escape'); await page.locator('#themeToggle').click(); await input.click(); await page.screenshot({ path: path.join(testRoot, `region-picker-dark-${mode}.png`) });
      await page.keyboard.press('Escape'); await page.setViewportSize({ width: 390, height: 844 }); await input.fill('南京'); await popup.waitFor(); const bounds = await popup.boundingBox();
      assert.ok(bounds.x >= 11 && bounds.x + bounds.width <= 379 && bounds.y >= 11 && bounds.y + bounds.height <= 833); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(testRoot, `region-picker-narrow-${mode}.png`) });
      await workspacePage(page, 'aiSettings'); assert.equal(await popup.count(), 0); await workspacePage(page, 'resumeCenter'); assert.equal(await input.inputValue(), '江苏省 / 合成市 / 合成区');
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter'); assert.equal(await page.locator('#basicFields [data-field-id="builtin.homeRegion"] [data-primary]').inputValue(), '江苏省 / 合成市 / 合成区'); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 真实 PDF/DOCX 走两种协议及入口，严格统计正式请求数，确保没有隐藏探针或自动重试。
for (const withExtension of [true, false]) {
  test(`无需检测解析：${withExtension ? '扩展' : 'file://'}PDF、DOCX、协议与错误恢复`, { timeout: 120000 }, async () => {
    const fixtures = require('./resume-fixtures.cjs'); const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'direct-resume-')); const api = await serve(); let context; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'aiSettings');
      api.modelApi.chatContent = JSON.stringify({ basic: { name: { value: '合成直接解析姓名', evidence: '合成直接解析姓名', page: 1 } } });
      // 上传仅校验和生成预览，不能自动发送简历、获取模型列表或执行能力探针。
      const prepare = async (type) => {
        await workspacePage(page, 'pdfCard'); const before = api.calls.length;
        await page.locator('#autoImportResume').uncheck(); // 协议回归独立验证手动模式不自动入库。
        await page.locator('#pdfFile').setInputFiles({ name: 'synthetic-direct.' + type, mimeType: type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fixtures[type]() });
        await page.waitForFunction(() => !document.getElementById('btnExtract').disabled && !document.getElementById('sendResume').hidden);
        assert.equal(api.calls.length, before); assert.ok((await page.locator('#pdfStatus').textContent()).includes('无需预先检测'));
      };
      // 只在用户点击发送后等待校对区域；返回值始终默认不选，不自动入库。
      const send = async () => { await page.locator('#sendResume').click(); await page.waitForFunction(() => !document.getElementById('sendResume').disabled && document.getElementById('pdfStatus').textContent.includes('解析完成')); await page.locator('#pdfReview .review-cell').first().waitFor(); assert.equal(await page.locator('#pdfReview input[type="checkbox"]:checked').count(), 0); };
      for (const protocol of ['chat-completions', 'responses']) {
        await workspacePage(page, 'aiSettings'); const count = api.calls.length;
        await page.locator('#provider').fill(api.base + (protocol === 'chat-completions' ? '/v1' : '')); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves());
        await page.locator('#apiProtocol').selectOption(protocol); await page.evaluate(() => flushSaves()); await page.locator('#apiKey').fill('synthetic-direct-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
        await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-direct-main'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
        assert.equal(api.calls.length, count); assert.ok((await page.locator('#btnDetectCapabilities').textContent()).includes('可选'));
        for (const type of ['pdf', 'docx']) {
          if (type === 'docx') { await workspacePage(page, 'aiSettings'); await page.locator('#manualVisionModel').check(); await page.locator('#visionModel').fill('synthetic-direct-vision'); await page.locator('#visionModel').press('Tab'); await page.evaluate(() => flushSaves()); }
          await prepare(type); const before = api.calls.length; const revision = (await page.evaluate(() => dataRequest('localapply:read'))).database.revision;
          await send(); assert.equal(api.calls.length, before + 1); assert.equal(api.calls.at(-1).probe, false); assert.ok(api.calls.at(-1).imageCount > 0); assert.equal(api.calls.at(-1).model, type === 'pdf' ? 'synthetic-direct-main' : 'synthetic-direct-vision');
          assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, revision); await page.locator('#cancelResume').click();
        }
        await prepare('pdf'); api.modelApi.chatStatus = 422; const before = api.calls.length; await page.locator('#sendResume').click();
        await page.waitForFunction(() => !document.getElementById('sendResume').disabled && document.getElementById('pdfStatus').textContent.includes('422'));
        assert.equal(api.calls.length, before + 1); assert.equal(await page.locator('#pdfReview .review-cell').count(), 0); assert.equal(await page.locator('#sendResume').isVisible(), true);
        api.modelApi.chatStatus = 0; await send(); assert.equal(api.calls.length, before + 2); await page.locator('#cancelResume').click();
      }
      assert.equal(api.calls.filter((call) => call.probe).length, 0); assert.equal(api.modelRequests.length, 0); assert.equal(api.calls.length, 8); assert.deepEqual(errors, []);
      await page.locator('#pdfCard').screenshot({ path: path.join(testRoot, `direct-resume-${withExtension ? 'extension' : 'file'}.png`) });
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 合成文档包含明确出生年月，验证模型候选从校对到已有日期字段的完整链路与月精度。
for (const withExtension of [true, false]) {
  test(`出生年月导入：${withExtension ? '扩展' : 'file://'}映射出生日期、确认与月精度`, { timeout: 90000 }, async () => {
    const fixtures = require('./resume-fixtures.cjs'); const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'birth-date-')); const api = await serve(); let context; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'aiSettings');
      await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves()); await page.locator('#apiKey').fill('synthetic-birth-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
      await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-birth-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      api.modelApi.chatContent = JSON.stringify({ basic: { birthYearMonth: { value: '1997 年 8 月', evidence: '出生年月：1997 年 8 月', page: 1 } } });
      const before = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      await workspacePage(page, 'pdfCard'); await page.locator('#autoImportResume').uncheck(); await page.locator('#pdfFile').setInputFiles({ name: 'synthetic-birth.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fixtures.docx('出生年月：1997 年 8 月。') });
      await page.waitForFunction(() => !document.getElementById('btnExtract').disabled && !document.getElementById('sendResume').hidden); assert.equal(api.calls.length, 0);
      await page.locator('#sendResume').click(); await page.waitForFunction(() => !document.getElementById('sendResume').disabled && document.getElementById('pdfStatus').textContent.includes('解析完成'));
      const review = page.locator('#pdfReview .review-cell'); assert.equal(await review.count(), 1); assert.ok((await review.textContent()).includes('出生日期')); assert.equal(await review.locator('input:not([type="checkbox"])').inputValue(), '1997-08'); assert.equal(await review.locator('input[type="checkbox"]').isChecked(), false);
      assert.ok((await review.textContent()).includes('出生年月：1997 年 8 月')); assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, before.revision);
      await review.locator('input[type="checkbox"]').check(); await page.locator('#btnImport').click(); await page.waitForFunction(() => !document.getElementById('btnImport').disabled && document.getElementById('importRow').style.display === 'none');
      const database = (await page.evaluate(() => dataRequest('localapply:read'))).database; const row = database.fieldValues.find((item) => item.profileId === before.activeProfileId && item.fieldId === 'builtin.birthDate');
      assert.equal(row.value, '1997-08'); assert.equal(row.entryId, null); assert.equal(row.evidence.excerpt, '出生年月：1997 年 8 月'); assert.equal(row.evidence.verified, false); assert.equal(database.fieldDefinitions.length, before.fieldDefinitions.length); assert.equal(database.entries.length, 0); assert.ok(!database.fieldDefinitions.some((item) => item.fieldId === 'resume.birthDate' || item.fieldId === 'resume.birthYearMonth'));
      // 重启后重新定位当前页面，不能用旧 Locator 或仅靠数据库桩验证日期精度。
      const birth = () => page.locator('#basicFields [data-field-id="builtin.birthDate"]');
      await workspacePage(page, 'resumeCenter'); assert.equal(await birth().locator('[data-primary]').inputValue(), '1997-08'); assert.equal(await birth().locator('select').inputValue(), 'month');
      await birth().screenshot({ path: path.join(testRoot, `birth-date-${withExtension ? 'extension' : 'file'}.png`) });
      await page.reload(); await workspacePage(page, 'resumeCenter'); assert.equal(await birth().locator('select').inputValue(), 'month'); await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.equal(await birth().locator('[data-primary]').inputValue(), '1997-08'); assert.equal(await birth().locator('select').inputValue(), 'month'); assert.equal(api.calls.length, 1); assert.equal(api.calls[0].probe, false); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 默认自动导入走真实存储；覆盖、缺失保留、取消及恢复只使用合成文档和本地 Mock。
for (const withExtension of [true, false]) {
  test(`自动导入简历：${withExtension ? '扩展' : 'file://'}覆盖、保留、重试和重启恢复`, { timeout: 120000 }, async (t) => {
    const fixtures = require('./resume-fixtures.cjs'); const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'auto-resume-')); const api = await serve(); let context; let page; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'aiSettings');
      await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves()); await page.locator('#apiKey').fill('synthetic-auto-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
      await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-auto-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      const ids = await page.evaluate(async () => {
        const first = (await dataRequest('localapply:read')).database.activeProfileId;
        const other = (await dataCommand('createProfile', { name: '合成其他简历' })).result;
        for (const [fieldId, value] of [['builtin.name', '合成原姓名'], ['builtin.phone', '13900000000'], ['builtin.email', 'keep@example.test'], ['builtin.birthDate', '1991-01-01'], ['builtin.politicalStatus', '群众']]) await dataCommand('setValue', { profileId: first, fieldId, value });
        await dataCommand('setValue', { profileId: other, fieldId: 'builtin.name', value: '合成其他姓名' }); await reloadDataState(); return { first, other };
      });
      await workspacePage(page, 'pdfCard'); assert.equal(await page.locator('#autoImportResume').isChecked(), true); assert.equal(await page.locator('#targetProfile').isVisible(), true);
      await page.locator('#targetProfile').selectOption(ids.first);
      // 不读取真实简历：Mock 的空值故意与原资料不同，验证它们不会触发清空。
      api.modelApi.chatContent = JSON.stringify({ basic: { name: { value: '合成简历新姓名', evidence: '姓名：合成简历新姓名', page: 1 }, birthDate: { value: '1994 年 6 月', evidence: '出生年月：1994 年 6 月', page: 1 }, politicalStatus: { value: '团员', evidence: '政治面貌：团员', page: 1 }, phone: null, email: { value: null }, gpa: { value: '  ' } }, education: null });
      // 两种文件都通过真实选择、渲染和发送入口；预览本身不发请求或写入资料。
      const prepare = async (type = 'docx') => {
        await page.locator('#pdfFile').setInputFiles({ name: 'synthetic-auto.' + type, mimeType: type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: type === 'pdf' ? fixtures.pdf() : fixtures.docx('姓名：合成简历新姓名；出生年月：1994 年 6 月；政治面貌：团员。') });
        await page.waitForFunction(() => !document.getElementById('btnExtract').disabled && !document.getElementById('sendResume').hidden);
      };
      // 页面读取只经正式 RPC，字段比较不依赖 DOM 是否碰巧显示了新文字。
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const field = (database, key, profileId = ids.first) => database.fieldValues.find((row) => row.profileId === profileId && row.fieldId === 'builtin.' + key && row.entryId === null);
      let imported;
      await t.test('默认自动覆盖非空结果，缺失内容及其他简历保留，导入目标不随刷新变化', async () => {
        const before = await read(); await prepare(); assert.equal(api.calls.length, 0); assert.equal((await read()).revision, before.revision);
        api.modelApi.chatHold = true; const started = new Promise((resolve) => { api.modelApi.onChat = resolve; }); await page.locator('#sendResume').click(); await started;
        await page.evaluate(() => reloadDataState()); assert.equal(await page.locator('#targetProfile').inputValue(), ids.first); assert.equal(await page.locator('#targetProfile').isDisabled(), true);
        api.modelApi.chatHold = false; api.modelApi.releaseChat(); await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('已自动导入'));
        imported = await read(); assert.equal(imported.revision, before.revision + 1); assert.equal(field(imported, 'name').value, '合成简历新姓名'); assert.equal(field(imported, 'birthDate').value, '1994-06'); assert.equal(field(imported, 'politicalStatus').value, '共青团员');
        assert.equal(field(imported, 'phone').value, '13900000000'); assert.equal(field(imported, 'email').value, 'keep@example.test'); assert.equal(field(imported, 'name', ids.other).value, '合成其他姓名');
        assert.equal(field(imported, 'name').source, 'ai-imported'); assert.equal(field(imported, 'name').evidence.verified, false); assert.deepEqual(imported.fieldDefinitions, before.fieldDefinitions);
        assert.equal(await page.locator('#pdfReview .review-cell').count(), 0); assert.equal(await page.locator('#importRow').isVisible(), false); assert.equal(api.calls.length, 1);
        await page.locator('#pdfCard').screenshot({ path: path.join(testRoot, `auto-resume-${withExtension ? 'extension' : 'file'}.png`) });
      });
      await t.test('解析取消及迟到响应不会写入资料', async () => {
        const before = await read(); await prepare('pdf'); api.modelApi.chatHold = true; const started = new Promise((resolve) => { api.modelApi.onChat = resolve; }); await page.locator('#sendResume').click(); await started;
        await page.locator('#cancelResume').click(); api.modelApi.chatHold = false; api.modelApi.releaseChat(); await page.waitForFunction(() => !document.getElementById('autoImportResume').disabled);
        assert.ok((await page.locator('#pdfStatus').textContent()).includes('未写入')); assert.deepEqual(await read(), before); assert.equal(await page.locator('#retryResumeImport').isVisible(), false);
      });
      await t.test('错误结构不产生覆盖，界面可以继续解析', async () => {
        const before = await read(); api.modelApi.chatContent = '{"basic":{"name":{"value":123}}}'; await prepare(); await page.locator('#sendResume').click();
        await page.waitForFunction(() => !document.getElementById('sendResume').disabled && document.getElementById('pdfStatus').textContent.includes('解析失败'));
        assert.deepEqual(await read(), before); assert.equal(await page.locator('#retryResumeImport').isVisible(), false); await page.locator('#cancelResume').click();
      });
      await t.test('保存传输失败保留解析结果，重试不重复调用模型', async () => {
        api.modelApi.chatContent = JSON.stringify({ basic: { name: { value: '合成重试姓名', evidence: '合成重试姓名', page: 1 } } }); await prepare('pdf'); await page.locator('#targetProfile').selectOption(ids.first);
        // 只故障注入一次 UI 命令传输；实际磁盘失败与原子写入由数据层测试另行验证。
        await page.evaluate(() => { const original = dataCommand; let failOnce = true; dataCommand = async function (action, ...args) { if (action === 'autoImportResume' && failOnce) { failOnce = false; throw new Error('合成命令传输失败'); } return original(action, ...args); }; });
        const before = await read(); await page.locator('#sendResume').click(); await page.locator('#retryResumeImport').waitFor({ state: 'visible' }); assert.deepEqual(await read(), before);
        const count = api.calls.length; await page.locator('#retryResumeImport').click(); await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('已自动导入'));
        assert.equal(api.calls.length, count); const after = await read(); assert.equal(after.revision, before.revision + 1); assert.equal(field(after, 'name').value, '合成重试姓名'); assert.equal(field(after, 'birthDate').value, '1994-06');
      });
      await t.test('刷新及整个浏览器重启保留结果，并可恢复覆盖前内容', async () => {
        await page.reload(); await workspacePage(page, 'pdfCard'); assert.equal(field(await read(), 'name').value, '合成重试姓名'); assert.equal(await page.locator('#autoImportResume').isChecked(), true);
        await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'pdfCard');
        assert.equal(field(await read(), 'name').value, '合成重试姓名'); await workspacePage(page, 'privacySettings'); await page.locator('#btnRestoreRecovery').click(); await page.waitForFunction(() => document.getElementById('backupMsg').textContent.includes('已恢复'));
        const restored = await read(); assert.deepEqual(restored.fieldValues, imported.fieldValues); assert.deepEqual(restored.fieldDefinitions, imported.fieldDefinitions); assert.equal(field(restored, 'name', ids.other).value, '合成其他姓名');
        assert.equal(api.calls.length, 4); assert.ok(api.calls.every((call) => !call.probe)); assert.deepEqual(errors, []);
      });
    } finally { api.modelApi.releaseChat?.(); if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 完整目录实际通过模型 Mock、两种存储入口和 UI；报告含个人信息但不得夹带凭据或文件字节。
for (const withExtension of [true, false]) {
  test(`完整字段解析：${withExtension ? '扩展' : 'file://'}模块映射、报告、多段编辑和重启`, { timeout: 120000 }, async (t) => {
    const fixtures = require('./resume-fixtures.cjs'); const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'catalog-resume-')); const api = await serve(); let context; let page; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'aiSettings');
      await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves()); await page.locator('#apiKey').fill('synthetic-catalog-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials()); await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-catalog-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      const setup = await page.evaluate(async () => {
        const profileId = (await dataRequest('localapply:read')).database.activeProfileId;
        await dataCommand('setValue', { profileId, fieldId: 'builtin.phone', value: '13900000000' }); await dataCommand('setValue', { profileId, fieldId: 'builtin.name', value: '合成仅本机保留的旧姓名' });
        const custom = (await dataCommand('createField', { profileId, definition: { label: '合成布尔字段', group: '基本信息', type: 'boolean' }, value: null })).result;
        const next = await getState(); next.profiles.find((item) => item.id === profileId).fields = next.profiles.find((item) => item.id === profileId).fields.filter((field) => field.key !== 'wechat'); await saveState(next); await reloadDataState(); return { profileId, custom };
      });
      // 候选涵盖此前遗漏的模块、控件和额外经历；未知/错误字段也故意返回以验证报告。
      const raw = { fields: [
        ['name', '合成新姓名'], ['gender', '男'], ['ethnic', '汉族'], ['hometown', '合成省 / 合成市'], ['expectedPosition', '合成岗位'], ['currentSalary', 0], ['expectedCities', ['合成城市甲', '合成城市乙']],
        ['school', '合成第一学校'], ['major', '合成第一专业'], ['degree', '本科'], ['educationStartDate', '2016 年 9 月'],
        ['school', '合成第二学校', 1], ['major', '合成第二专业', 1], ['degree', '硕士', 1], ['educationStartDate', '2020-09', 1],
        ['internshipCompany', '合成实习单位'], ['internshipStartDate', '2021-03'], ['employmentCompany', '合成工作单位'], ['employmentPosition', '合成职位'],
        ['projectName', '合成第一项目'], ['projectDescription', '合成项目说明'], ['projectName', '合成第二项目', 1], ['projectDescription', '合成额外项目说明', 1],
        ['awardName', '合成奖项'], ['certificateName', '合成证书'], ['paperName', '合成论文'], ['englishScore', '600'], ['selfIntroduction', '<img src=x onerror="window.catalogExecuted=true">'],
        ['phone', null], ['employmentEndDate', '至今'], ['currentAnnualSalary', '两万元'], ['wechat', '合成已移除字段'], ['unknownCatalog', '合成未匹配信息'],
      ].map(([key, value, record = 0]) => ({ fieldId: 'builtin.' + key, record, value, evidence: '合成来源', page: 1 })) };
      raw.fields.push({ fieldId: setup.custom, value: false, evidence: '合成明确否', page: 1 });
      api.modelApi.chatContent = JSON.stringify(raw);
      // 上传走实际 PDF/DOCX 渲染，不注入解析器或存储替身。
      const prepare = async (type = 'docx') => { await workspacePage(page, 'pdfCard'); await page.locator('#pdfFile').setInputFiles({ name: 'synthetic-catalog.' + type, mimeType: type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fixtures[type]() }); await page.waitForFunction(() => !document.getElementById('btnExtract').disabled && !document.getElementById('sendResume').hidden); };
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const value = (database, key, entryId = null) => database.fieldValues.find((row) => row.profileId === setup.profileId && row.fieldId === 'builtin.' + key && row.entryId === entryId)?.value;
      await t.test('完整目录自动导入现有模块，已移除/缺失/错误候选不写入', async () => {
        const before = await read(); await prepare(); assert.equal(api.calls.length, 0); await page.locator('#sendResume').click(); await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('已自动导入'));
        const db = await read(); assert.equal(db.revision, before.revision + 1); assert.equal(value(db, 'gender'), '男'); assert.equal(value(db, 'ethnic'), '汉族'); assert.equal(value(db, 'currentSalary'), 0); assert.deepEqual(value(db, 'expectedCities'), ['合成城市甲', '合成城市乙']); assert.equal(value(db, 'school'), '合成第一学校'); assert.equal(value(db, 'employmentCompany'), '合成工作单位'); assert.equal(value(db, 'internshipCompany'), '合成实习单位'); assert.equal(value(db, 'paperName'), '合成论文'); assert.equal(value(db, 'phone'), '13900000000'); assert.equal(db.fieldValues.find((row) => row.fieldId === setup.custom).value, false);
        assert.equal(db.entries.length, 2); assert.ok(db.entries.every((entry) => entry.entryId.startsWith('catalog.'))); assert.deepEqual(db.fieldDefinitions, before.fieldDefinitions); assert.ok(!db.bindings.some((binding) => binding.fieldId === 'builtin.wechat')); assert.ok(!db.fieldValues.some((row) => row.fieldId === 'builtin.unknownCatalog'));
        assert.match(api.modelApi.lastResumeSystem, /builtin\.paperName/); assert.match(api.modelApi.lastResumeSystem, /builtin\.internshipCompany/); assert.ok(!api.modelApi.lastResumeSystem.includes('合成仅本机保留的旧姓名')); assert.ok(!api.modelApi.lastResumeSystem.includes('13900000000')); assert.equal(api.calls.length, 1); assert.equal(api.calls[0].probe, false);
      });
      await t.test('解析报告可查看和下载，显示未写入原因，模型 HTML 仅作为文本', async () => {
        await page.locator('#resumeReport > summary').click(); assert.equal(await page.locator('#resumeReport [data-report-status="unmatched"]').count(), 2); assert.equal(await page.locator('#resumeReport [data-report-status="invalid"]').count(), 2); assert.equal(await page.locator('#resumeReport [data-report-status="missing"]').count(), 1); assert.ok(await page.locator('#resumeReport [data-report-status="absent"]').count() > 100); assert.equal(await page.locator('#resumeReport img').count(), 0); assert.equal(await page.evaluate(() => window.catalogExecuted), undefined);
        await page.locator('#resumeReport details > summary').click(); assert.ok((await page.locator('#resumeReportRaw').textContent()).includes('onerror')); assert.ok((await page.locator('#resumeReportItems').textContent()).includes('日期无法无损转换'));
        const downloaded = page.waitForEvent('download'); await page.locator('#downloadResumeReport').click(); const download = await downloaded; const report = JSON.parse(await fs.readFile(await download.path(), 'utf8')); assert.deepEqual(report.raw, raw); assert.ok(report.items.some((item) => item.status === 'saved')); assert.ok(!JSON.stringify(report).includes('synthetic-catalog-key')); assert.ok(!JSON.stringify(report).includes('data:image'));
        await page.locator('#resumeReport details > summary').click(); await page.locator('#pdfCard').screenshot({ path: path.join(testRoot, `resume-catalog-report-${withExtension ? 'extension' : 'file'}.png`) });
      });
      await t.test('基础模块下拉/日期已填，额外记录在同一模块可编辑', async () => {
        await workspacePage(page, 'resumeCenter'); assert.equal(await page.locator('[data-field-id="builtin.gender"] select').inputValue(), '男'); assert.equal(await page.locator('[data-field-id="builtin.currentSalary"] input').inputValue(), '0');
        const education = page.locator('.resume-group[data-group="教育背景"]'); assert.equal(await education.count(), 1); assert.equal(await education.locator('.resume-record').count(), 2); assert.equal(await education.locator('.resume-primary-record [data-field-id="builtin.school"] input').inputValue(), '合成第一学校');
        const additional = education.locator('.resume-record:not(.resume-primary-record)'); await additional.locator(':scope > summary').click(); assert.equal(await additional.locator('[data-field-id="builtin.school"] input').inputValue(), '合成第二学校'); assert.equal(await additional.locator('[data-field-id="builtin.degree"] select').inputValue(), '硕士'); assert.equal(await additional.locator('[data-field-id="builtin.educationStartDate"] [data-primary]').inputValue(), '2020-09');
        await additional.locator('[data-field-id="builtin.major"] input').fill('合成修改后的第二专业'); await additional.locator('[data-field-id="builtin.major"] input').blur(); await page.evaluate(() => resumeSaveQueue);
        const db = await read(); const entryId = db.entries.find((entry) => entry.kind === 'education').entryId; assert.equal(value(db, 'major', entryId), '合成修改后的第二专业'); assert.equal(value(db, 'major'), '合成第一专业'); assert.equal(await page.locator('#resumeToc').getByRole('button', { name: '教育背景', exact: true }).count(), 1);
        await education.screenshot({ path: path.join(testRoot, `resume-catalog-module-${withExtension ? 'extension' : 'file'}.png`) });
      });
      await t.test('可选手动校对使用目录控件，未勾选项不被报告成已保存', async () => {
        api.modelApi.chatContent = JSON.stringify({ fields: [{ fieldId: 'builtin.englishScore', value: '650', evidence: '合成新分数', page: 1 }, { fieldId: 'builtin.awardName', value: '合成不导入奖项' }] }); await prepare('pdf'); await page.locator('#autoImportResume').uncheck(); await page.locator('#sendResume').click(); await page.locator('#importRow').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#pdfReview input[type="checkbox"]:checked').count(), 0); const score = page.locator('#pdfReview .review-cell').filter({ hasText: '成绩' }); await score.locator('input[type="checkbox"]').check(); await page.locator('#overwriteResume').check(); await page.locator('#btnImport').click(); await page.waitForFunction(() => document.getElementById('importRow').style.display === 'none');
        assert.equal(value(await read(), 'englishScore'), '650'); assert.equal(value(await read(), 'awardName'), '合成奖项'); await page.locator('#resumeReport > summary').click(); assert.equal(await page.locator('#resumeReport [data-report-status="skipped"]').count(), 1); assert.equal(await page.locator('#resumeReport [data-report-status="overwritten"]').count(), 1);
      });
      await t.test('刷新和浏览器重启后全部模块及记录保留，原始报告不进入数据库', async () => {
        const before = await read(); await page.reload(); await workspacePage(page, 'pdfCard'); assert.equal(await page.locator('#resumeReport').isVisible(), false); assert.deepEqual((await read()).fieldValues, before.fieldValues);
        await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter'); const db = await read(); assert.deepEqual(db.fieldValues, before.fieldValues); assert.equal(db.entries.length, 2); assert.equal(value(db, 'englishScore'), '650');
        const backup = (await page.evaluate(() => dataRequest('localapply:exportBackup'))).backup; assert.ok(!JSON.stringify(backup).includes('synthetic-catalog-key')); assert.ok(!JSON.stringify(backup).includes('lastResumeReport'));
        // 新旧数据混存时，真实“清空旧经历”按钮只能删除旧记录，不能删除目录导入的额外学校/项目。
        await page.evaluate(async (profileId) => { const old = (await dataCommand('createEntry', { profileId, kind: 'education', title: '合成旧记录' })).result; await dataCommand('setValue', { profileId, fieldId: 'builtin.school', entryId: old, value: '合成待清理学校' }); await reloadDataState(); }, setup.profileId);
        page.once('dialog', (dialog) => { assert.ok(dialog.message().includes('1 条旧经历')); dialog.accept(); }); await page.locator('#clearResumeEntries').click(); await page.waitForFunction(() => document.getElementById('entryStatus').textContent.includes('已清空 1 条旧经历'));
        const cleaned = await read(); assert.equal(cleaned.entries.length, 2); assert.ok(cleaned.entries.every((entry) => entry.entryId.startsWith('catalog.'))); assert.equal(value(cleaned, 'school'), '合成第一学校'); assert.equal(api.calls.length, 2); assert.deepEqual(errors, []);
      });
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 真实布局回归覆盖全部单行控件，避免链接/日期/选择框随相邻描述框变高。
for (const withExtension of [true, false]) {
  test(`简历控件高度：${withExtension ? '扩展' : 'file://'}单行控件不随描述框拉伸`, { timeout: 60000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'field-height-')); let context;
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000); const page = await context.newPage();
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      for (const toggle of await page.locator('#basicFields .resume-more-toggle').all()) if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      const link = page.locator('#basicFields [data-field-id="builtin.paperLink"] input'); const description = page.locator('#basicFields [data-field-id="builtin.paperDescription"] textarea');
      assert.equal(await link.count(), 1); const initialHeight = (await link.boundingBox()).height; assert.ok(initialHeight >= 30 && initialHeight < 65);
      await description.evaluate((element) => { element.style.height = '240px'; }); assert.ok(Math.abs((await link.boundingBox()).height - initialHeight) < 1);
      // 检查所有可见单行控件，也包含复合日期/地区控件内的输入框；多选列表保留其合理高度。
      const oversized = await page.locator('#basicFields .center-field input:not([type="checkbox"]), #basicFields .center-field select:not([multiple])').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length && node.getBoundingClientRect().height >= 65).map((node) => node.closest('[data-field-id]').dataset.fieldId));
      assert.deepEqual(oversized, []); assert.ok((await description.boundingBox()).height >= 240);
      await page.locator('#themeToggle').click(); await link.scrollIntoViewIfNeeded(); await page.locator('.resume-group[data-group="论文期刊"]').screenshot({ path: path.join(testRoot, `field-height-${withExtension ? 'extension' : 'file'}.png`) });
      await page.setViewportSize({ width: 390, height: 844 }); assert.ok((await link.boundingBox()).height < 65); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 摘要与整行布局通过真实编辑验证，两种入口均只使用合成学校及独立浏览器资料。
for (const withExtension of [true, false]) {
  test(`经历摘要布局：${withExtension ? '扩展' : 'file://'}保存更新、记录隔离及自我介绍整行`, { timeout: 60000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'record-heading-')); let context;
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000); const page = await context.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      const education = page.locator('.resume-group[data-group="教育背景"]'); const first = education.locator('.resume-primary-record');
      assert.equal(await first.locator('.resume-record-caption strong').textContent(), '教育背景');
      await first.locator('[data-field-id="builtin.school"] input').fill('合成第一学校'); await first.locator('[data-field-id="builtin.school"] input').blur(); await page.evaluate(() => resumeSaveQueue);
      await first.locator('[data-field-id="builtin.degree"] select').selectOption({ label: '本科' }); await page.evaluate(() => resumeSaveQueue);
      assert.equal(await first.locator('.resume-record-caption strong').textContent(), '合成第一学校'); assert.equal(await first.locator('.resume-record-subtitle').textContent(), '本科');
      // 右侧独立箭头支持键盘展开收起，按钮状态与原生 details 保持一致。
      const collapse = first.locator('.resume-record-collapse'); await collapse.press('Enter'); assert.equal(await first.getAttribute('open'), null); assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
      await collapse.press('Enter'); assert.notEqual(await first.getAttribute('open'), null); assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
      await education.locator('[data-module-action="add"]').click(); await education.locator('.resume-record:not(.resume-primary-record)').waitFor();
      const second = education.locator('.resume-record:not(.resume-primary-record)'); assert.equal(await second.locator('.resume-record-caption strong').textContent(), '教育背景');
      const unsafe = '<img src=x onerror="window.unexpectedExecution=true">';
      await second.locator('[data-field-id="builtin.school"] input').fill(unsafe); await second.locator('[data-field-id="builtin.school"] input').blur(); await page.evaluate(() => resumeSaveQueue);
      assert.equal(await second.locator('.resume-record-caption strong').textContent(), unsafe); assert.equal(await second.locator('summary img').count(), 0); assert.equal(await page.evaluate(() => !!window.unexpectedExecution), false);
      await second.locator('[data-field-id="builtin.school"] input').fill('合成第二学校'); await second.locator('[data-field-id="builtin.school"] input').blur(); await page.evaluate(() => resumeSaveQueue);
      await first.locator(':scope > summary').click(); await second.locator(':scope > summary').click();
      assert.equal(await first.locator('.resume-record-caption strong').textContent(), '合成第一学校'); assert.equal(await second.locator('.resume-record-caption strong').textContent(), '合成第二学校'); assert.equal(await second.locator('[data-module-action="delete"]').isVisible(), true);
      const footer = education.locator('.resume-group-footer'); const add = footer.locator('[data-module-action="add"]');
      assert.ok(Math.abs((await add.boundingBox()).width - (await footer.boundingBox()).width) < 2); assert.ok((await add.boundingBox()).y >= (await second.boundingBox()).y + (await second.boundingBox()).height);
      assert.equal(await second.locator('.resume-record-actions [data-module-action="delete"] svg').count(), 1);
      await education.screenshot({ path: path.join(testRoot, `record-heading-${withExtension ? 'extension' : 'file'}.png`) });
      const intro = page.locator('[data-field-id="builtin.selfIntroduction"] textarea'); const grid = intro.locator('..').locator('..');
      assert.ok(Math.abs((await intro.boundingBox()).width - (await grid.boundingBox()).width) < 3);
      await intro.fill('合成自我介绍\n第二行'); await intro.blur(); await page.evaluate(() => resumeSaveQueue);
      await page.locator('.resume-group[data-group="自我介绍"]').screenshot({ path: path.join(testRoot, `intro-full-width-${withExtension ? 'extension' : 'file'}.png`) });
      await page.reload(); await workspacePage(page, 'resumeCenter'); assert.equal(await first.locator('.resume-record-caption strong').textContent(), '合成第一学校'); assert.equal(await second.locator('.resume-record-caption strong').textContent(), '合成第二学校'); assert.equal(await intro.inputValue(), '合成自我介绍\n第二行');
      await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#themeToggle').click();
      assert.ok(Math.abs((await intro.boundingBox()).width - (await grid.boundingBox()).width) < 3); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 删除入口验收：首条、收起记录及最后空模板均通过真实按钮操作，不访问用户浏览器资料。
for (const withExtension of [true, false]) {
  test(`经历删除入口：${withExtension ? '扩展' : 'file://'}标题常驻、首条接替、最后清空及恢复`, { timeout: 120000 }, async (t) => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'record-delete-')); let context; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter');
      // 每次查询当前 DOM 和后台库，避免重绘后沿用旧句柄。
      const group = (name) => page.locator(`.resume-group[data-group="${name}"]`);
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const before = await read(); const profileId = before.activeProfileId;
      await t.test('八模块收起后均能取消或确认删除首条，第二条内容正确接替', async () => {
        for (const [name, key] of [['教育背景','school'], ['实习经历','internshipCompany'], ['工作经历','employmentCompany'], ['项目经历','projectName'], ['家庭成员','familyName1'], ['获奖经历','awardName'], ['证书信息','certificateName'], ['论文期刊','paperName']]) {
          const section = group(name); const first = section.locator('.resume-primary-record'); const selector = `[data-field-id="builtin.${key}"] input`;
          await first.locator(selector).fill('合成待删除' + name); await first.locator(selector).blur(); await page.evaluate(() => resumeSaveQueue);
          await section.locator('[data-module-action="add"]').click(); await page.waitForFunction((name) => document.querySelector(`.resume-group[data-group="${name}"]`).querySelectorAll('.resume-record').length === 2, name);
          const second = section.locator('.resume-record:not(.resume-primary-record)'); await second.locator(selector).fill('合成保留' + name); await second.locator(selector).blur(); await page.evaluate(() => resumeSaveQueue);
          await first.locator(':scope > summary').click(); await second.locator(':scope > summary').click(); assert.equal(await first.locator('[data-module-action="delete"]').isVisible(), true); assert.equal(await second.locator('[data-module-action="delete"]').isVisible(), true);
          const current = await read(); page.once('dialog', (dialog) => dialog.dismiss()); await first.locator('[data-module-action="delete"]').click(); await page.waitForFunction((name) => !document.querySelector(`.resume-group[data-group="${name}"] .resume-primary-record [data-module-action="delete"]`).disabled, name);
          assert.equal((await read()).revision, current.revision); assert.equal(await first.getAttribute('open'), null); assert.equal(await section.locator('.resume-record').count(), 2);
          if (name === '获奖经历') await section.screenshot({ path: path.join(testRoot, `record-delete-collapsed-${withExtension ? 'extension' : 'file'}.png`) });
          page.once('dialog', (dialog) => dialog.accept());
          // 家庭模块使用键盘激活，验证按钮不会同时展开其父 summary。
          if (name === '家庭成员') await first.locator('[data-module-action="delete"]').press('Enter'); else await first.locator('[data-module-action="delete"]').click();
          await page.waitForFunction(({ name, selector }) => { const section = document.querySelector(`.resume-group[data-group="${name}"]`); return section.querySelectorAll('.resume-record').length === 1 && section.querySelector(selector)?.value === '合成保留' + name; }, { name, selector });
          assert.equal(await first.getAttribute('open'), null);
        }
        const after = await read(); assert.deepEqual(after.fieldDefinitions, before.fieldDefinitions); assert.deepEqual(after.bindings, before.bindings); assert.equal(after.entries.filter((entry) => entry.profileId === profileId).length, 0);
      });
      await t.test('最后一条删除留下空模板，重复删除不覆盖恢复点，恢复能找回内容', async () => {
        const section = group('获奖经历'); const first = section.locator('.resume-primary-record'); const saved = await read();
        page.once('dialog', (dialog) => dialog.accept()); await first.locator('[data-module-action="delete"]').click();
        await page.waitForFunction(() => document.querySelector('.resume-group[data-group="获奖经历"] [data-field-id="builtin.awardName"] input').value === '');
        assert.equal(await section.locator('.resume-record').count(), 1); const cleared = await read(); assert.ok(!cleared.fieldValues.some((row) => row.profileId === profileId && row.fieldId === 'builtin.awardName' && row.entryId === null));
        page.once('dialog', (dialog) => dialog.accept()); await first.locator('[data-module-action="delete"]').click(); await page.waitForFunction(() => !document.querySelector('.resume-group[data-group="获奖经历"] [data-module-action="delete"]').disabled); assert.equal((await read()).revision, cleared.revision);
        await workspacePage(page, 'privacySettings'); await page.locator('#btnRestoreRecovery').click(); await page.waitForFunction(() => document.getElementById('backupMsg').textContent.includes('已恢复')); assert.deepEqual((await read()).fieldValues, saved.fieldValues);
        await workspacePage(page, 'resumeCenter'); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#themeToggle').click();
        // 等待父 fieldset 也解除禁用，避免把恢复后的加载状态当作最终暗色界面截图。
        await page.waitForFunction(() => !document.querySelector('.resume-group[data-group="获奖经历"] [data-module-action="delete"]').matches(':disabled')); assert.equal(await section.locator('[data-module-action="delete"]').isVisible(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); await section.screenshot({ path: path.join(testRoot, `record-delete-dark-${withExtension ? 'extension' : 'file'}.png`) });
      });
      assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 参考模块多记录验收：仅合成资料，真实按钮/选择/保存/备份及整个浏览器重启，不读取用户简历。
for (const withExtension of [true, false]) {
  test(`共享模块记录：${withExtension ? '扩展' : 'file://'}添加、折叠、模板、获奖导入和回滚`, { timeout: 150000 }, async (t) => {
    const fixtures = require('./resume-fixtures.cjs'); const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'shared-records-')); const api = await serve(); let context; let page; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter');
      // Locator 始终取当前页面，重绘/重启后不复用旧元素句柄。
      const group = (name) => page.locator('.resume-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
      const read = async () => (await page.evaluate(() => dataRequest('localapply:read'))).database;
      const initial = await read(); const profileId = initial.activeProfileId; const slots = [['教育背景','school'], ['实习经历','internshipCompany'], ['工作经历','employmentCompany'], ['项目经历','projectName'], ['家庭成员','familyName1'], ['获奖经历','awardName'], ['证书信息','certificateName'], ['论文期刊','paperName']];
      await t.test('八个模块均可添加，首条和附加条目使用相同完整字段，收起不改资料', async () => {
        for (const [name, key] of slots) {
          let section = group(name); const first = section.locator('.resume-primary-record'); assert.equal(await section.locator('.resume-record').count(), 1);
          await first.locator(`[data-field-id="builtin.${key}"] input`).fill('合成首条' + name); await first.locator(`[data-field-id="builtin.${key}"] input`).blur(); await page.evaluate(() => resumeSaveQueue);
          await section.locator('.resume-group-footer [data-module-action="add"]').click(); await page.waitForFunction((name) => document.querySelector(`.resume-group[data-group="${name}"]`)?.querySelectorAll('.resume-record').length === 2, name);
          section = group(name); const second = section.locator('.resume-record:not(.resume-primary-record)'); assert.notEqual(await second.getAttribute('open'), null);
          const fields = await section.locator('.resume-primary-record .center-field').evaluateAll((nodes) => nodes.map((node) => node.dataset.fieldId)); assert.deepEqual(await second.locator('.center-field').evaluateAll((nodes) => nodes.map((node) => node.dataset.fieldId)), fields);
          assert.equal(await second.locator(`[data-field-id="builtin.${key}"] input`).inputValue(), ''); await second.locator(`[data-field-id="builtin.${key}"] input`).fill('合成第二条' + name); await second.locator(`[data-field-id="builtin.${key}"] input`).blur(); await page.evaluate(() => resumeSaveQueue);
          const revision = (await read()).revision; await section.locator('.resume-primary-record > summary').click(); assert.equal(await section.locator(`.resume-primary-record [data-field-id="builtin.${key}"] input`).isVisible(), false); assert.equal(await second.locator(`[data-field-id="builtin.${key}"] input`).isVisible(), true); await section.locator('.resume-primary-record > summary').click(); assert.equal((await read()).revision, revision);
        }
        const db = await read(); assert.equal(db.schemaVersion, 5); assert.equal(db.entries.length, 8); assert.deepEqual(db.fieldDefinitions, initial.fieldDefinitions); assert.equal(await group('英语能力').locator('[data-module-action="add"]').count(), 0); assert.equal(api.calls.length, 0);
      });
      await t.test('自定义字段加入或移除共享模板后同时作用所有记录，值仍相互独立', async () => {
        await workspacePage(page, 'fieldLibrary'); await page.locator('#fieldCreate > summary').click(); await page.locator('#fieldLabel').fill('合成共享辅修'); await page.locator('#fieldGroup').fill('教育背景'); await page.locator('#fieldSave').click(); await page.waitForFunction(() => document.getElementById('fieldStatus').textContent.includes('字段定义已保存'));
        let db = await read(); const definition = db.fieldDefinitions.find((field) => field.label === '合成共享辅修'); assert.ok(definition); await workspacePage(page, 'resumeCenter'); let section = group('教育背景');
        for (const record of await section.locator('.resume-record').all()) { const toggle = record.locator('.resume-more-toggle[aria-expanded="false"]'); if (await toggle.count()) await toggle.click(); assert.equal(await record.locator(`[data-field-id="${definition.fieldId}"] input`).inputValue(), ''); }
        const second = section.locator('.resume-record:not(.resume-primary-record)'); await second.locator(`[data-field-id="${definition.fieldId}"] input`).fill('合成第二条专有值'); await second.locator(`[data-field-id="${definition.fieldId}"] input`).blur(); await page.evaluate(() => resumeSaveQueue); assert.equal(await section.locator(`.resume-primary-record [data-field-id="${definition.fieldId}"] input`).inputValue(), '');
        await workspacePage(page, 'fieldLibrary'); page.once('dialog', (dialog) => dialog.accept()); await page.locator(`.library-row[data-field-id="${definition.fieldId}"]`).getByRole('button', { name: '移除当前档案字段' }).click(); await page.waitForFunction(() => document.getElementById('fieldStatus').textContent.includes('已从当前档案移除')); await workspacePage(page, 'resumeCenter'); assert.equal(await group('教育背景').locator(`[data-field-id="${definition.fieldId}"]`).count(), 0);
        await workspacePage(page, 'fieldLibrary'); page.once('dialog', (dialog) => dialog.accept()); await page.locator(`.library-row[data-field-id="${definition.fieldId}"]`).getByRole('button', { name: '添加到当前档案' }).click(); await workspacePage(page, 'resumeCenter'); await page.waitForFunction((fieldId) => document.querySelectorAll(`.resume-group[data-group="教育背景"] [data-field-id="${fieldId}"]`).length === 2, definition.fieldId);
        db = await read(); assert.equal(db.fieldDefinitions.length, initial.fieldDefinitions.length + 1); assert.equal(db.fieldDefinitions.filter((field) => field.fieldId === definition.fieldId).length, 1); assert.equal(db.fieldValues.find((row) => row.fieldId === definition.fieldId && row.entryId)?.value, '合成第二条专有值');
      });
      await t.test('三条奖项经 Mock AI 分组自动导入，手动槽位被复用且不存在字段冲突', async () => {
        await workspacePage(page, 'aiSettings'); await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves()); await page.locator('#apiKey').fill('synthetic-modules-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials()); await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-module-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
        const raw = { fields: [2,0,1].flatMap((record) => [['awardName','合成奖项' + record], ['awardCategory','奖学金'], ['awardLevel','校级'], ['awardRank','合成等级' + record], ['awardDate','2028-0' + (record + 1)]].map(([key,value]) => ({ fieldId: 'builtin.' + key, record, value, evidence: '合成来源', page: 1 }))) }; api.modelApi.chatContent = JSON.stringify(raw);
        await workspacePage(page, 'pdfCard'); await page.locator('#pdfFile').setInputFiles({ name: 'synthetic-awards.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fixtures.docx('合成奖项甲、合成奖项乙、合成奖项丙。') }); await page.locator('#sendResume').waitFor({ state: 'visible' }); assert.equal(api.calls.length, 0); await page.locator('#sendResume').click(); await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('已自动导入'));
        assert.equal(await page.locator('#resumeReport [data-report-status="conflict"]').count(), 0); assert.equal(api.calls.length, 1); assert.match(api.modelApi.lastResumeSystem, /不同记录必须使用不同 record/); assert.ok(!api.modelApi.lastResumeSystem.includes('合成首条教育背景')); const db = await read(); assert.equal(db.entries.filter((entry) => entry.kind === 'award').length, 2);
        await workspacePage(page, 'resumeCenter'); const records = group('获奖经历').locator('.resume-record'); assert.equal(await records.count(), 3);
        for (let index = 0; index < 3; index++) { const record = records.nth(index); if ((await record.getAttribute('open')) === null) await record.locator(':scope > summary').click(); assert.equal(await record.locator('[data-field-id="builtin.awardName"] input').inputValue(), '合成奖项' + index); assert.equal(await record.locator('[data-field-id="builtin.awardRank"] input').inputValue(), '合成等级' + index); }
        await group('获奖经历').screenshot({ path: path.join(testRoot, `module-records-awards-${withExtension ? 'extension' : 'file'}.png`) });
      });
      await t.test('记录收起保留无效日期草稿，单条删除需确认且可从恢复点撤销', async () => {
        const third = group('获奖经历').locator('.resume-record').nth(2); const entryId = await third.getAttribute('data-entry-id'); const date = third.locator('[data-field-id="builtin.awardDate"] [data-primary]'); await third.locator('[data-field-id="builtin.awardDate"] select').selectOption('date');
        const revision = (await read()).revision; await date.fill('2028-02-30'); await date.blur(); await third.locator(':scope > summary').click(); await third.locator(':scope > summary').click(); assert.equal(await date.inputValue(), '2028-02-30'); assert.equal((await read()).revision, revision); await date.fill('2028-03-15'); await date.blur(); await page.evaluate(() => resumeSaveQueue);
        page.once('dialog', (dialog) => dialog.dismiss()); await third.locator('[data-module-action="delete"]').click(); assert.ok((await read()).entries.some((entry) => entry.entryId === entryId)); page.once('dialog', (dialog) => dialog.accept()); await third.locator('[data-module-action="delete"]').click(); await page.waitForFunction(() => document.getElementById('centerStatus').textContent.includes('已删除此条记录'));
        assert.equal((await read()).entries.filter((entry) => entry.kind === 'award').length, 1); await workspacePage(page, 'privacySettings'); await page.locator('#btnRestoreRecovery').click(); await page.waitForFunction(() => document.getElementById('backupMsg').textContent.includes('已恢复')); assert.ok((await read()).entries.some((entry) => entry.entryId === entryId)); await workspacePage(page, 'resumeCenter'); await page.locator('#themeToggle').click(); await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); await group('获奖经历').screenshot({ path: path.join(testRoot, `module-records-dark-${withExtension ? 'extension' : 'file'}.png`) }); await page.setViewportSize({ width: 1280, height: 900 });
      });
      await t.test('简历隔离、v4/v3 备份往返及整个浏览器重启后记录和值保留', async () => {
        await page.locator('#newProfileName').fill('合成另一份简历'); await page.locator('#createResumeProfile').click(); await page.waitForFunction((id) => document.getElementById('entryProfile').value !== id && !document.getElementById('entryProfile').disabled && document.querySelectorAll('.resume-group[data-group="获奖经历"] .resume-record').length === 1, profileId); assert.equal(await group('获奖经历').locator('.resume-record').count(), 1); await page.locator('#entryProfile').selectOption(profileId); await page.waitForFunction(() => document.querySelectorAll('.resume-group[data-group="获奖经历"] .resume-record').length === 3);
        const before = await read(); await workspacePage(page, 'privacySettings');
        const fullEvent = page.waitForEvent('download'); await page.locator('#btnBackup').click(); const fullBuffer = await fs.readFile(await (await fullEvent).path()); const full = JSON.parse(fullBuffer); assert.equal(full.schemaVersion, 5);
        const compatEvent = page.waitForEvent('download'); await page.locator('#btnExportV3').click(); const compatBuffer = await fs.readFile(await (await compatEvent).path()); const compatible = JSON.parse(compatBuffer); assert.equal(compatible.schemaVersion, 3); assert.ok(compatible.database.entries.every((entry) => ['education','internship','employment','project'].includes(entry.kind))); assert.ok(!fullBuffer.toString().includes('synthetic-modules-key')); assert.ok(!compatBuffer.toString().includes('synthetic-modules-key'));
        // 两种备份都经真实预览和确认导入；兼容格式保留内容，完整格式恢复多记录结构。
        for (const [name, buffer] of [['synthetic-v3.json',compatBuffer], ['synthetic-v4.json',fullBuffer]]) {
          await page.locator('#restoreMode').selectOption('replace'); await page.locator('#backupFile').setInputFiles({ name, mimeType: 'application/json', buffer }); await page.locator('#btnApplyRestore').waitFor({ state: 'visible' }); await page.locator('#btnApplyRestore').click(); await page.waitForFunction(() => document.getElementById('restorePreview').textContent.includes('导入完成')); assert.equal((await read()).schemaVersion, 5);
        }
        assert.deepEqual((await read()).fieldValues, before.fieldValues); assert.deepEqual((await read()).entries, before.entries); await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter'); const restarted = await read(); assert.equal(restarted.schemaVersion, 5); assert.deepEqual(restarted.fieldValues, before.fieldValues); assert.deepEqual(restarted.entries, before.entries); assert.equal(await group('获奖经历').locator('.resume-record').count(), 3); assert.equal(await group('获奖经历').locator('.resume-record[open]').count(), 1);
        const target = restarted.entries.find((entry) => entry.kind === 'education'); const deepLink = new URL(url); deepLink.searchParams.set('profile', profileId); deepLink.searchParams.set('section', 'entry:' + target.entryId); deepLink.hash = 'resumeCenter'; await page.goto(deepLink.href); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); assert.notEqual(await page.locator(`[data-entry-id="${target.entryId}"]`).getAttribute('open'), null); assert.equal(await page.locator(`#resumeToc button[aria-current="location"]`).textContent(), '教育背景'); assert.equal(api.calls.length, 1); assert.deepEqual(errors, []);
      });
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 合成政治面貌通过模型、校对与原有下拉框完整导入；未列入公共选项的原文不得被丢失。
for (const withExtension of [true, false]) {
  test(`政治面貌导入：${withExtension ? '扩展' : 'file://'}标准选项、原文保留与重启`, { timeout: 90000 }, async () => {
    const fixtures = require('./resume-fixtures.cjs'); const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true }); const profile = await fs.mkdtemp(path.join(testRoot, 'political-status-')); const api = await serve(); let context; const errors = [];
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'aiSettings');
      await page.locator('#provider').fill(api.base + '/v1'); await page.locator('#provider').press('Enter'); await page.evaluate(() => flushSaves()); await page.locator('#apiKey').fill('synthetic-political-key'); await page.locator('#saveKey').click(); await page.evaluate(() => flushCredentials());
      await page.locator('#manualModel').check(); await page.locator('#model').fill('synthetic-political-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      const before = (await page.evaluate(() => dataRequest('localapply:read'))).database; const definition = before.fieldDefinitions.find((field) => field.fieldId === 'builtin.politicalStatus');
      // 每次只确认模型明确给出的政治面貌；覆盖已有值也通过原有覆盖复选框。
      const importStatus = async (raw, key, expected, overwrite = false) => {
        api.modelApi.chatContent = JSON.stringify({ basic: { [key]: { value: raw, evidence: '政治面貌：' + raw, page: 1 } } });
        await workspacePage(page, 'pdfCard'); await page.locator('#autoImportResume').uncheck(); await page.locator('#pdfFile').setInputFiles({ name: 'synthetic-political.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fixtures.docx('政治面貌：' + raw + '。') });
        await page.waitForFunction(() => !document.getElementById('btnExtract').disabled && !document.getElementById('sendResume').hidden); const revision = (await page.evaluate(() => dataRequest('localapply:read'))).database.revision;
        await page.locator('#sendResume').click(); await page.waitForFunction(() => !document.getElementById('sendResume').disabled && document.getElementById('pdfStatus').textContent.includes('解析完成'));
        const review = page.locator('#pdfReview .review-cell'); assert.equal(await review.count(), 1); assert.ok((await review.textContent()).includes('政治面貌')); assert.equal(await review.locator('input:not([type="checkbox"])').inputValue(), expected); assert.equal(await review.locator('input[type="checkbox"]').isChecked(), false);
        assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, revision);
        if (overwrite) { await page.locator('#overwriteResume').check(); await page.waitForFunction(() => document.getElementById('pdfReview').textContent.includes('确认后覆盖勾选项')); }
        await review.locator('input[type="checkbox"]').check(); await page.locator('#btnImport').click(); await page.waitForFunction(() => !document.getElementById('btnImport').disabled && document.getElementById('importRow').style.display === 'none');
        const database = (await page.evaluate(() => dataRequest('localapply:read'))).database; const row = database.fieldValues.find((item) => item.fieldId === 'builtin.politicalStatus');
        assert.equal(row.value, expected); assert.equal(row.entryId, null); assert.equal(row.evidence.excerpt, '政治面貌：' + raw); assert.equal(row.evidence.verified, false); assert.equal(database.fieldDefinitions.length, before.fieldDefinitions.length); assert.deepEqual(database.fieldDefinitions.find((field) => field.fieldId === definition.fieldId), definition); assert.equal(database.entries.length, 0);
        await workspacePage(page, 'resumeCenter');
      };
      // Locator 按当前页面创建，真实浏览器重启后也检查选中值和显示文字。
      const field = () => page.locator('#basicFields [data-field-id="builtin.politicalStatus"]');
      await importStatus('团员', 'political_status', '共青团员'); assert.equal(await field().locator('select').inputValue(), '共青团员'); assert.equal(await field().locator('option:checked').textContent(), '共青团员'); assert.equal(await field().locator('option').count(), definition.options.length + 1);
      await field().screenshot({ path: path.join(testRoot, `political-status-${withExtension ? 'extension' : 'file'}.png`) });
      await importStatus('中国民主同盟盟员', 'politicalStatus', '中国民主同盟盟员', true); assert.equal(await field().locator('option:checked').textContent(), '中国民主同盟盟员'); assert.equal(await field().locator('option').count(), definition.options.length + 2);
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); await page.goto(url); await workspacePage(page, 'resumeCenter');
      assert.equal(await field().locator('select').inputValue(), '中国民主同盟盟员'); assert.equal(await field().locator('option:checked').textContent(), '中国民主同盟盟员'); assert.equal(api.calls.length, 2); assert.ok(api.calls.every((call) => !call.probe)); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve)); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}
