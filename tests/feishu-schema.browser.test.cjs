// 隔离 Chromium 中加载真实扩展；飞书域名全部被本地响应替代，不访问或保存真实申请。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures/feishu-schema');

// 合成字段标签来自配置，控件是测试自写 DOM；不能据此宣称真实飞书表单已验收。
function formHTML(raw, mode = '') {
  const row = (label, control) => `<div class="atsx-form-item"><div class="atsx-form-item-label"><label><span class="customResumeForm-fieldName">${label}</span></label></div><div class="atsx-form-item-control-wrapper">${control}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Schema 合成申请表</title><style>body{font:15px system-ui;padding:25px;max-width:760px}.atsx-form-item{margin:18px}input,select,textarea{padding:8px;min-width:180px}[hidden]{display:none!important}</style></head><body>
    <h1>隔离合成表单</h1><script id="js-websiteInfo" type="text/json">${JSON.stringify(raw)}</script>
    <form onsubmit="event.preventDefault();window.submits++"><div class="createFormSection-container"><div><div class="createFormSection-left"><div class="createFormSection-text">基本信息</div></div><div class="createFormSection-right"><div class="createFormSection-formList"><div class="resumeEditForm-item">
    ${row('姓名', '<input id="person">')}${row('所在地点', '<select id="city"><option value="">请选择</option><option value="合成所在地">合成所在地</option></select>')}${row('家庭住址', '<input id="home">')}
    ${row('出生日期', '<input type="month" id="birth">')}${row('性别', '<select id="gender"><option value="">请选择</option><option value="M">男</option><option value="F">女</option></select>')}
    ${mode === 'duplicate' ? row('姓名', '<input id="duplicate">') : ''}
    ${row('获取职位信息的渠道', '<select id="custom"><option value="">请选择</option><option value="A">合成渠道</option><option value="B">合成渠道</option></select>')}
    </div></div></div></div></div><button type="submit">提交申请</button><button type="button" onclick="window.saves++">保存简历</button></form>
    <script>window.submits=0;window.saves=0;window.state={};document.querySelector('form').addEventListener('input',e=>{window.state[e.target.id]=e.target.value});document.querySelector('form').addEventListener('change',e=>{window.state[e.target.id]=e.target.value});</script></body></html>`;
}

// 后台 RPC 使用可信设置页，断言产品返回值，不能以页面有文字冒充成功。
async function rpc(options, type, payload = {}) {
  const result = await options.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
  assert.equal(result.ok, true, result.error); return result;
}

test('飞书 Schema 专项：真实扩展、多版配置、唯一关联、回退与失效', { timeout: 180000 }, async (t) => {
  const artifacts = path.join(ROOT, '.browser-tests'); await fs.mkdir(artifacts, { recursive: true }); const profile = await fs.mkdtemp(path.join(artifacts, 'feishu-schema-'));
  const fixtures = {}; for (const company of ['moonton', 'modelbest', 'poizon']) fixtures[company] = JSON.parse(await fs.readFile(path.join(FIXTURES, company + '.website-info.json'), 'utf8'));
  const bundle = (await require('esbuild').build({ entryPoints: [path.join(ROOT, 'test-pages/feishu-atsx-frameworks.js')], bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
  let context; let page; let frame; const outbound = []; const statistics = [];
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : { channel: 'chromium' }),
      args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT] });
    context.setDefaultTimeout(10000);
    // 所有 HTTP(S) 都在测试进程中终结，企业域名和 Schema 均不触发真实网络请求。
    await context.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url()); const company = url.hostname.split('.')[0];
      if (!fixtures[company]) { outbound.push(url.origin); await route.abort(); return; }
      const mode = url.searchParams.get('mode') || '';
      if (url.pathname === '/fixture-frameworks.js') { await route.fulfill({ contentType: 'text/javascript', body: bundle }); return; }
      let html;
      if (mode === 'inline') html = await fs.readFile(path.join(FIXTURES, company + '.inline-script.fixture.html'), 'utf8');
      else if (mode === 'react') {
        // 故意反转配置顺序，验证语义关联不依赖 Schema 数组下标；DOM仍由原React夹具生成。
        const raw = structuredClone(fixtures[company]); raw.website_info.resume_form_schema.object_list.reverse().forEach((group) => group.children.reverse());
        html = (await fs.readFile(path.join(ROOT, 'test-pages/feishu-atsx-controls.html'), 'utf8')).replace('feishu-atsx-frameworks.js', '/fixture-frameworks.js').replace('</head>', `<script id="js-websiteInfo" type="text/json">${JSON.stringify(raw)}</script></head>`);
      }
      else {
        // 单独构造可见场景覆盖版以测试被原配置隐藏的原生控件，原始两份配置保持不变。
        const raw = structuredClone(fixtures[company]);
        if (mode === 'visible') for (const field of raw.website_info.resume_form_schema.object_list.find((group) => group.attributes.field_type.name === 'basic_info').children) field.attributes.visible = true;
        html = formHTML(raw, mode);
      }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    let worker = context.serviceWorkers().find((item) => item.url().endsWith('/background.js')); if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host; const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options/options.html`); await options.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
    const profileId = (await rpc(options, 'localapply:read')).database.activeProfileId;
    const values = [['name', '合成Schema姓名'], ['currentCity', '合成所在地'], ['homeAddress', '合成家庭住址'], ['gender', '男'], ['birthDate', '2000-02-15'],
      ['school', '合成本科大学'], ['degree', '本科'], ['major', '合成计算机专业'], ['educationStartDate', '2020-09'], ['graduationDate', '2024-06'],
      ['internshipCompany', '合成实习公司'], ['internshipPosition', '合成实习岗位'], ['internshipStartDate', '2023-07'], ['internshipEndDate', '2023-09'], ['internshipDescription', '合成实习内容'],
      ['employmentCompany', '合成工作公司'], ['employmentPosition', '合成工作岗位'], ['employmentStartDate', '2024-07'], ['employmentEndDate', '2025-01'], ['employmentDescription', '合成工作内容'],
      ['projectName', '合成项目名称'], ['projectRole', '合成项目角色'], ['projectStartDate', '2022-01'], ['projectEndDate', '2022-08'], ['projectDescription', '合成项目内容']];
    for (const [key, value] of values) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: 'builtin.' + key, value } } });
    let saved = (await rpc(options, 'localapply:read')).database;
    // 每个模式使用配置声明的站点路径及独立文档，覆盖数字路径，旧页面与卡片不会沿用。
    async function open(company = 'moonton', mode = '') {
      if (page && !page.isClosed()) await page.close(); page = await context.newPage(); await page.goto(`https://${company}.jobs.feishu.cn/${fixtures[company].website_info.path}/resume/123456/apply?mode=${mode}`);
      const loaded = page.waitForEvent('framenavigated', { predicate: (next) => next.url().startsWith(`chrome-extension://${extensionId}/panel/panel.html`) });
      await worker.evaluate(async (url) => floatingPanel.open((await chrome.tabs.query({})).find((tab) => tab.url === url).id), page.url()); frame = await loaded; await frame.locator('#profileSel option').first().waitFor({ state: 'attached' });
    }
    // 扫描/填写均点击现有产品按钮，并读取同一个真实后台会话。
    async function action(button = '#smartScan') {
      await page.bringToFront(); await frame.locator(button).click();
      try { await frame.waitForFunction(() => document.getElementById('tab-smart').getAttribute('aria-busy') === 'false', null, { timeout: 60000 }); }
      catch (error) {
        // 仅保存合成测试的固定状态和已有脱敏日志，保留超时证据，不自动重试按钮。
        await fs.writeFile(path.join(artifacts, 'feishu-schema-timeout.json'), JSON.stringify({ button, ui: await frame.evaluate(() => ({ hidden: document.hidden, status: document.getElementById('smartStatus').textContent, busy: document.getElementById('tab-smart').getAttribute('aria-busy') })), logs: await rpc(options, 'diagnostics:read') }, null, 2));
        throw error;
      }
      return rpc(options, 'learning:session', { sessionId: await frame.locator('#tab-smart').getAttribute('data-session-id') });
    }
    // 只在 ISOLATED world 查询本页桥接及扫描器，不在 MAIN world 读取框架私有状态。
    async function isolated() {
      return worker.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
        // 测试代码是仓库固定函数，经 CDP 使用既有隔离世界读取，不来自网页/模型。
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ snapshot: LocalApplyPageScanner.scan(false), schema: LocalApplyFeishuSchemaBridge.readCurrentPageSchema().status }) });
        return results[0].result;
      }, page.url());
    }

    for (const [company, version, groups, fields] of [['moonton', 5, 13, 51], ['modelbest', 2, 12, 46]]) await t.test(`${company} 原始内嵌HTML夹具只读解析，无控件不创造填写目标`, async () => {
      await open(company, 'inline'); const result = await action(); assert.equal(result.rows.length, 0);
      assert.equal(result.schemaDiagnostic.version, version); assert.equal(result.schemaDiagnostic.groups, groups); assert.equal(result.schemaDiagnostic.fields, fields);
      assert.equal(result.schemaDiagnostic.associated, 0);
    });

    for (const company of ['moonton', 'modelbest']) await t.test(`${company} 合成可见覆盖版：本地匹配增强并经原生适配器验证，不跨企业取自定义值`, async () => {
      await open(company, 'visible'); const scan = await action(); assert.equal(scan.rows.length, 6); assert.equal(scan.schemaDiagnostic.associated, 5, JSON.stringify(scan.rows.map((row) => ({ label: row.field.label, type: row.field.type, evidence: row.field.feishu }))));
      const comparison = await worker.evaluate(async ({ fields, origin }) => {
        const db = await repository.read(); const before = FieldMatchingEngine.match(db, db.activeProfileId, origin, fields.map(({ feishu, ...row }) => row));
        return { beforeMatched: before.filter((row) => row.target && row.status === 'matched').length, afterMatched: FieldMatchingEngine.match(db, db.activeProfileId, origin, fields).filter((row) => row.status === 'matched').length };
      }, { fields: scan.rows.map((row) => row.field), origin: scan.origin });
      assert.ok(comparison.afterMatched > comparison.beforeMatched);
      assert.equal(scan.rows.find((row) => row.field.label === '家庭住址').target.fieldId, 'builtin.homeAddress');
      const result = await action('#smartFillAll'); assert.equal(result.rows.filter((row) => row.status === 'success').length, 5);
      assert.equal(await page.locator('#person').inputValue(), '合成Schema姓名'); assert.equal(await page.locator('#birth').inputValue(), '2000-02'); assert.equal(await page.locator('#gender').inputValue(), 'M');
      assert.equal(await page.locator('#custom').inputValue(), ''); assert.equal(await page.evaluate(() => submits + saves), 0);
      statistics.push({ company, visibilityVariant: true, scanned: scan.rows.length, ...comparison, ...scan.schemaDiagnostic, success: result.rows.filter((row) => row.status === 'success').length, failed: result.rows.filter((row) => row.status === 'failed').length });
      await page.screenshot({ path: path.join(artifacts, `feishu-schema-${company}-filled.png`) });
    });

    await t.test('数字站点v11进入Schema链路，标准角色可填写且企业自定义内容不猜填', async () => {
      await open('poizon', 'numeric-v11');
      // 下载源码不含真实表单；控件全部为合成，明确区分标准项目角色和企业自定义字段。
      await page.evaluate(() => {
        const custom = document.getElementById('custom'); custom.closest('.atsx-form-item').querySelector('.customResumeForm-fieldName').textContent = '家庭现居住地';
        const input = document.createElement('input'); input.id = 'custom'; input.value = '合成网页保留内容'; custom.replaceWith(input);
        const group = document.createElement('div'); group.className = 'createFormSection-container';
        group.innerHTML = '<div class="resumeEditForm-project"><div class="createFormSection-left"><div class="createFormSection-text">项目经历</div></div><div class="createFormSection-right"><div class="createFormSection-formList"><div class="resumeEditForm-item"><div class="atsx-form-item"><div class="atsx-form-item-label"><label><span class="customResumeForm-fieldName">项目角色</span></label></div><input id="numeric-project-role"></div></div></div></div></div>';
        document.querySelector('form').append(group);
      });
      const scan = await action(); assert.equal(scan.schemaDiagnostic.status, 'ready'); assert.equal(scan.schemaDiagnostic.version, 11);
      assert.equal(scan.schemaDiagnostic.groups, 22); assert.equal(scan.schemaDiagnostic.fields, 174); assert.equal(scan.schemaDiagnostic.visible, 34);
      const role = scan.rows.find((row) => row.field.label === '项目角色'); assert.equal(role.field.feishu.state, 'linked'); assert.equal(role.target.fieldId, 'builtin.projectRole');
      const custom = scan.rows.find((row) => row.field.label === '家庭现居住地'); assert.equal(custom.field.feishu.state, 'custom'); assert.equal(custom.target, null);
      const result = await action('#smartFillAll'); assert.equal(result.rows.find((row) => row.field.scanId === role.field.scanId).status, 'success');
      assert.equal(await page.locator('#numeric-project-role').inputValue(), '合成项目角色'); assert.equal(await page.locator('#person').inputValue(), '合成Schema姓名'); assert.equal(await page.locator('#gender').inputValue(), 'M');
      assert.equal(await page.locator('#custom').inputValue(), '合成网页保留内容'); assert.equal(await page.evaluate(() => submits + saves), 0);
      statistics.push({ company: 'poizon-v11-synthetic', scanned: result.rows.length, ...result.schemaDiagnostic, success: result.rows.filter((row) => row.status === 'success').length });
      await page.screenshot({ path: path.join(artifacts, 'feishu-schema-poizon-v11.png') });
    });

    await t.test('原配置隐藏项不填，重复标签选项和类型冲突有明确失败且不猜选', async () => {
      await open(); let view = await action('#smartFillAll');
      assert.equal(view.rows.filter((row) => row.field.feishu?.state === 'hidden').length, 4); assert.equal(await page.locator('#birth').inputValue(), '');
      assert.equal(await page.locator('#gender').inputValue(), '');
      await open('moonton', 'visible'); await page.locator('#gender').evaluate((node) => { const duplicate = document.createElement('option'); duplicate.value = 'OTHER'; duplicate.textContent = '男'; node.append(duplicate); });
      // 选择型 Schema 对普通文本控件拒绝关联，不能靠提高识别率放宽控件契约。
      await page.locator('#city').evaluate((node) => { const input = document.createElement('input'); input.id = node.id; node.replaceWith(input); });
      view = await action('#smartFillAll'); const gender = view.rows.find((row) => row.field.label === '性别');
      assert.equal(gender.status, 'failed'); assert.equal(gender.diagnostic.reasonCode, 'ambiguous_option'); assert.equal(await page.locator('#gender').inputValue(), '');
      const city = view.rows.find((row) => row.field.label === '所在地点'); assert.equal(city.field.feishu.state, 'control_conflict'); assert.equal(city.target, null); assert.equal(await page.locator('#city').inputValue(), '');
      statistics.push({ scenario: 'duplicate-option-and-control-conflict', scanned: view.rows.length, ...view.schemaDiagnostic, success: view.rows.filter((row) => row.status === 'success').length, failed: view.rows.filter((row) => row.status === 'failed').length, reasonCode: gender.diagnostic.reasonCode });
      assert.equal(await page.evaluate(() => submits + saves), 0);
    });

    await t.test('重复同名字段不猜目标，Schema缺失/损坏/未知版本/站点变化安全回退', async () => {
      await open('moonton', 'duplicate'); let view = await action(); const duplicates = view.rows.filter((row) => row.field.label === '姓名');
      assert.equal(duplicates.length, 2); assert.ok(duplicates.every((row) => row.field.feishu.state === 'ambiguous' && !row.target));
      for (const [mode, expected] of [['missing', 'missing_schema'], ['broken', 'invalid_json'], ['version', 'unsupported_version'], ['scope', 'scope_mismatch']]) {
        await page.evaluate((mode) => { const el = document.getElementById('js-websiteInfo'); if (mode === 'missing') { el.remove(); return; } if (mode === 'broken') { el.textContent = '{'; return; } const raw = JSON.parse(el.textContent); if (mode === 'version') raw.website_info.resume_form_schema.version = 99; else raw.website_info.path = 'social'; el.textContent = JSON.stringify(raw); }, mode);
        view = await action(); assert.equal(view.schemaDiagnostic.status, expected); assert.ok(view.rows.every((row) => !row.field.feishu));
        statistics.push({ scenario: 'fallback-' + mode, scanned: view.rows.length, ...view.schemaDiagnostic });
        await page.evaluate((raw) => { document.getElementById('js-websiteInfo')?.remove(); const el = document.createElement('script'); el.id = 'js-websiteInfo'; el.type = 'text/json'; el.textContent = JSON.stringify(raw); document.head.append(el); }, fixtures.moonton);
      }
    });

    await t.test('脚本替换、重复项插入及SPA切页令旧scanId失效，未执行旧计划', async () => {
      await open(); const view = await action(); const old = view.rows.find((row) => row.field.label === '所在地点');
      await page.evaluate(() => { const el = document.getElementById('js-websiteInfo'); el.replaceWith(el.cloneNode(true)); });
      const next = await isolated(); assert.ok(!next.snapshot.fields.some((row) => row.scanId === old.field.scanId));
      const response = await options.evaluate((payload) => chrome.runtime.sendMessage(payload), { type: 'learning:fill', sessionId: view.sessionId, scanId: old.field.scanId, confirmed: true });
      assert.equal(response.ok, false); assert.equal(await page.locator('#city').inputValue(), '');
      const prior = next.snapshot.fields[0].scanId; await page.evaluate(() => history.pushState({}, '', '/campus/resume/987654/apply'));
      const url = page.url(); const scan = await worker.evaluate(async (url) => chrome.tabs.sendMessage((await chrome.tabs.query({})).find((tab) => tab.url === url).id, { type: 'learning:scan', authorize: true, expectedUrl: url }), url);
      assert.equal(scan.ok, true); assert.ok(!scan.snapshot.fields.some((row) => row.scanId === prior));
    });

    await t.test('真实React的搜索下拉/年月/经历添加保留原管线，隐藏配置组不填', async () => {
      // 第二条教育/项目具有不同身份与日期，增加后仍共享字段定义，不能与首条串填。
      for (const [kind, entries] of [['education', [['school', '合成硕士大学'], ['degree', '硕士'], ['major', '合成硕士专业'], ['educationStartDate', '2024-09'], ['graduationDate', '2026-06']]], ['project', [['projectName', '合成第二项目'], ['projectRole', '合成第二角色'], ['projectStartDate', '2023-01'], ['projectEndDate', '2023-08'], ['projectDescription', '合成第二内容']]], ['internship', [['internshipCompany', '合成第二实习公司'], ['internshipPosition', '合成第二实习岗位'], ['internshipStartDate', '2022-07'], ['internshipEndDate', '2022-09'], ['internshipDescription', '合成第二实习内容']]], ['employment', [['employmentCompany', '合成第二工作公司'], ['employmentPosition', '合成第二工作岗位'], ['employmentStartDate', '2025-02'], ['employmentEndDate', '2025-09'], ['employmentDescription', '合成第二工作内容']]]]) {
        const entryId = (await rpc(options, 'localapply:command', { request: { action: 'createEntry', payload: { profileId, kind, title: '合成附加记录' } } })).result;
        for (const [key, value] of entries) await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: 'builtin.' + key, entryId, value } } });
      }
      saved = (await rpc(options, 'localapply:read')).database;
      await open('modelbest', 'react'); const result = await action('#smartFillAll');
      const state = await page.evaluate(() => __atsx);
      assert.equal(state['education[0].school'], '合成本科大学'); assert.deepEqual(state['education[0].period'], ['2020-09', '2024-06']);
      assert.equal(state['internship[0].company'], '合成实习公司'); assert.equal(state['career[0].company'], '合成工作公司'); assert.equal(state['project[0].desc'], '合成项目内容');
      assert.equal(state['education[1].school'], '合成硕士大学'); assert.deepEqual(state['education[1].period'], ['2024-09', '2026-06']);
      assert.equal(state['project[1].name'], '合成第二项目'); assert.deepEqual(state['project[1].period'], ['2023-01', '2023-08']);
      assert.equal(state['internship[1].company'], '合成第二实习公司'); assert.deepEqual(state['internship[1].period'], ['2022-07', '2022-09']);
      assert.equal(state['career[1].company'], '合成第二工作公司'); assert.deepEqual(state['career[1].period'], ['2025-02', '2025-09']);
      assert.equal(result.rows.filter((row) => row.status === 'success').length, 40); assert.equal(state.submits + state.saves, 0);
      statistics.push({ company: 'modelbest-react', scanned: result.rows.length, ...result.schemaDiagnostic, success: result.rows.filter((row) => row.status === 'success').length });
      await open('moonton', 'react'); const hidden = await action('#smartFillAll');
      assert.ok(hidden.rows.filter((row) => row.field.kind === 'employment').every((row) => row.field.feishu?.state === 'hidden' && row.status !== 'success'));
      const hiddenState = await page.evaluate(() => __atsx); assert.equal(hiddenState['career[0].company'], undefined); assert.equal(hiddenState.adds, 5); assert.equal(await page.locator('.resumeEditForm-career .resumeEditForm-item').count(), 0);
      statistics.push({ company: 'moonton-react', scanned: hidden.rows.length, ...hidden.schemaDiagnostic, success: hidden.rows.filter((row) => row.status === 'success').length, added: hiddenState.adds, hiddenWorkRecords: 0 });
      await page.screenshot({ path: path.join(artifacts, 'feishu-schema-react.png') });
    });

    await t.test('运行诊断只含固定状态和数量；不改个人库、历史规则、备份或权限', async () => {
      const after = (await rpc(options, 'localapply:read')).database; assert.deepEqual(after, saved); assert.equal(after.schemaVersion, 5);
      const logs = JSON.stringify(await rpc(options, 'diagnostics:read')); for (const value of ['合成Schema姓名', '合成家庭住址', '合成本科大学', 'tenant_id_md5', fixtures.moonton.tenant_info.tenant_id_md5]) assert.ok(!logs.includes(value));
      assert.equal(outbound.length, 0); await fs.writeFile(path.join(artifacts, 'feishu-schema-comparison.json'), JSON.stringify(statistics, null, 2));
    });
  } finally { await context?.close(); }
});
