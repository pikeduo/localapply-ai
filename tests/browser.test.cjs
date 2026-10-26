// Playwright 真实扩展验收：独立 profile、动态端口、仅合成数据，不清理其他进程。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');

// 从分类内的真实按钮新增记录，替代已移除的顶部经历工具栏。
async function addResumeEntry(page, kind, title) {
  page.once('dialog', (dialog) => dialog.accept(title));
  await page.locator('[data-add-entry-kind="' + kind + '"]').click();
  const entry = page.locator('#basicFields .entry-card').filter({ has: page.getByRole('heading', { name: title, exact: false }) });
  await entry.waitFor(); return entry;
}
// 补充空编辑框后通过真实输入/失焦保存，数据库写入仍由生产命令完成。
async function fillEntryField(page, entry, fieldId, value) {
  let field = entry.locator('[data-field-id="' + fieldId + '"]');
  if (!await field.count()) {
    const more = entry.locator('.resume-entry-more');
    if (!await more.evaluate((element) => element.open)) await more.locator('summary').click();
    await entry.getByLabel('补充经历字段', { exact: true }).selectOption(fieldId);
    await entry.getByRole('button', { name: '添加字段', exact: true }).click();
  }
  const input = field.locator('input,textarea,select');
  await input.fill(value); await input.blur(); await page.evaluate(() => resumeSaveQueue);
  assert.ok((await field.locator('small').textContent()).includes('已保存在本地'));
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
      const card = frame.locator('.smart-row').filter({has:frame.locator('h4').filter({hasText:'是否接受调剂'})}); await card.locator('.smart-ai-check').check(); await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'});
      const payload = JSON.parse(await frame.locator('#smartAIPayload').textContent()); assert.deepEqual(payload.fields.map((field)=>field.label),['是否接受调剂']); assert.ok(!JSON.stringify(payload).includes('合成手填新增资料'));
      api.modelApi.fieldHold = true; const started = new Promise((resolve)=>{api.modelApi.onField=resolve;}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await started;
      await frame.locator('#smartAICancel').click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false'); assert.ok((await frame.locator('#smartStatus').textContent()).includes('取消'));
      api.modelApi.releaseField(); api.modelApi.fieldHold = false; await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await frame.waitForFunction(()=>document.getElementById('smartStatus').textContent.includes('AI 返回 0'));
      assert.equal(await page.locator('#other-unknown').inputValue(),''); assert.equal(await page.evaluate(()=>__submitCount),0);
    });
    await t.test('AI 待人工选择及忽略建议不自动采用，用户确认后才移入忽略列表', async () => {
      const card=frame.locator('.smart-row').filter({has:frame.locator('h4').filter({hasText:'是否接受调剂'})});
      for (const action of ['needs_user_choice','skip_non_resume_control']) {
        api.modelApi.fieldReply=(payload)=>JSON.stringify({suggestions:[{scanId:payload.fields[0].scanId,existingFieldId:null,definition:null,sourceRef:null,confidence:0.1,action}]});
        await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'}); await frame.locator('#smartAIConsent').check(); await frame.locator('#smartAISend').click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false');
        assert.equal(await card.count(),1); assert.equal(await page.locator('#other-unknown').inputValue(),'');
        if(action==='needs_user_choice') { assert.ok((await card.textContent()).includes('AI 无法确定')); assert.equal(await card.locator('.smart-apply-suggestion').count(),0); }
      }
      await card.getByRole('button',{name:'确认本次忽略',exact:true}).click(); await frame.waitForFunction(()=>document.getElementById('tab-smart').getAttribute('aria-busy')==='false'); assert.equal(await card.count(),0); assert.ok((await frame.locator('#smartExcluded').textContent()).includes('是否接受调剂'));
    });
    await t.test('页面导航释放运行中的 AI 和未确认候选，不产生迟到保存', async () => {
      await frame.locator('#smartExcluded summary').click(); await frame.getByRole('button',{name:'恢复此字段',exact:true}).click();
      const card=frame.locator('.smart-row').filter({has:frame.locator('h4').filter({hasText:'是否接受调剂'})}); await card.locator('.smart-ai-check').check(); await frame.locator('#smartAI').click(); await frame.locator('#smartAIReview').waitFor({state:'visible'});
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
      await page.locator('#pdfFile').setInputFiles(path.join(ROOT, 'test-pages/fake-scan.pdf'));
      await page.locator('#sendResume').waitFor({ state: 'visible' }); await page.locator('#sendResume').click();
      await page.locator('#importRow').waitFor({ state: 'visible' });
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
      assert.equal((await page.evaluate(() => sendMessage('wsa:resumeRoute', { format: 'pdf' }))).ok, false);
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
        await page.locator('#resumeCenter details').evaluate((details) => { details.open = true; });
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
        await workspacePage(page, 'aiSettings');
        await page.locator('#manualModel').check();
        await page.locator('#model').fill('unprobed-model'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
        await prepare('blocked.pdf', fixtures.pdf()); await page.locator('#sendResume').click();
        await page.waitForFunction(() => document.getElementById('pdfStatus').textContent.includes('尚未通过'));
        assert.equal(api.calls.length, count); await page.locator('#cancelResume').click();
        await workspacePage(page, 'aiSettings');
        await page.locator('#model').fill('synthetic-local'); await page.locator('#model').press('Tab'); await page.evaluate(() => flushSaves());
      });
      await t.test('模型忽略附件但返回 HTTP 200 时也禁止发送真实简历', async () => {
        await workspacePage(page, 'aiSettings');
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
    await t.test('重复经历管理 UI 保存两段教育与项目', async () => {
      await workspacePage(options, 'resumeCenter');
      for (const kind of ['education', 'project']) {
        for (let index = 0; index < 2; index++) {
          await addResumeEntry(options, kind, `合成${kind}${index}`);
          await options.waitForFunction((count) => document.querySelectorAll('#basicFields .entry-card').length === count, kind === 'education' ? index + 1 : index + 3);
        }
      }
      const first = options.locator('#basicFields .entry-card').first();
      await fillEntryField(options, first, 'builtin.school', '合成测试学院');
      const firstId = await first.getAttribute('data-entry-id');
      assert.equal((await rpc(options, 'localapply:read')).database.fieldValues.find((row) => row.entryId === firstId && row.fieldId === 'builtin.school').value, '合成测试学院');
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
  const scan = async () => { const old = await sidebar.locator('#tab-smart').getAttribute('data-session-id'); await page.bringToFront(); await sidebar.locator('#smartPageConsent').check(); await sidebar.locator('#smartScan').click(); await sidebar.waitForFunction((id) => document.getElementById('tab-smart').dataset.sessionId !== id && document.querySelectorAll('.smart-row').length > 0 && document.getElementById('tab-smart').getAttribute('aria-busy') === 'false', old); };
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
      await page.locator('#basicFields .entry-card').first().waitFor();
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
      assert.equal(await page.locator('[data-add-entry-kind=education]').isDisabled(), false);
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
      await section.locator('summary').click(); assert.equal(await section.evaluate((element) => element.open), false);
      await frame.locator('#previewSearch').fill('合成是否调剂'); assert.ok((await frame.locator('#resumeContent').textContent()).includes('否')); assert.equal(await frame.locator('#resumeContent details').count(), 0); await frame.locator('#previewSearch').fill('');
    });
    await t.test('预览刷新实际读取修改，增删字段自动同步且不调用 AI', async () => {
      await rpc(options, 'localapply:command', { request: { action: 'setValue', payload: { profileId, fieldId: 'builtin.name', value: '合成阶段四刷新姓名' } } }); await frame.locator('#previewRefresh').click(); await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成阶段四刷新姓名'));
      const created = (await rpc(options, 'localapply:command', { request: { action: 'createField', payload: { profileId, definition: { label: '合成即时新增' }, value: '合成即时值' } } })).result; await frame.waitForFunction(() => document.getElementById('resumeContent').textContent.includes('合成即时新增'));
      await rpc(options, 'localapply:command', { request: { action: 'deleteField', payload: { fieldId: created } } }); await frame.waitForFunction(() => !document.getElementById('resumeContent').textContent.includes('合成即时新增')); assert.equal(api.calls.length, 0);
    });
    await t.test('编辑按钮打开当前档案与分类的简历中心', async () => {
      await frame.locator('#previewNav').selectOption('entry:' + schoolId); const opened = context.waitForEvent('page'); await frame.locator('#previewEdit').click(); const editor = await opened; await editor.waitForFunction(() => document.getElementById('overviewValues')?.textContent !== '—'); await editor.waitForFunction((id) => document.getElementById('entryProfile').value === id, profileId); assert.ok(editor.url().includes(encodeURIComponent('entry:' + schoolId))); await editor.locator('[data-entry-id="' + schoolId + '"].is-target').waitFor(); await editor.close();
    });
    await t.test('单击复制只针对所选项，敏感值保持遮挡直到主动显示', async () => {
      await frame.locator('#previewSearch').fill('手机号'); await frame.getByRole('button', { name: '复制手机号', exact: true }).click(); assert.ok((await frame.locator('#previewStatus').textContent()).includes('先勾选'));
      await frame.locator('#previewReveal').check(); await frame.getByRole('button', { name: '复制手机号', exact: true }).click(); await frame.waitForFunction(() => document.getElementById('previewStatus').textContent.includes('已复制')); await frame.locator('#previewSearch').fill('');
      await page.screenshot({ path: path.join(testRoot, 'stage4-preview.png'), fullPage: false });
    });
    await t.test('两个主标签切换保留扫描会话和字段选择，筛选不改变数据', async () => {
      await frame.locator('#autoTab').click(); await frame.locator('#smartScan').click(); await frame.locator('.smart-row').first().waitFor(); const session = await frame.locator('#tab-smart').getAttribute('data-session-id'); const count = await frame.locator('.smart-row').count();
      await frame.locator('#smartOnlyUnknown').check(); assert.equal(await frame.locator('#smartMatched').isHidden(), true); await frame.locator('#resumeTab').click(); await frame.locator('#autoTab').click(); assert.equal(await frame.locator('#tab-smart').getAttribute('data-session-id'), session); assert.equal(await frame.locator('.smart-row').count(), count); assert.equal(await frame.locator('#smartOnlyUnknown').isChecked(), true); await frame.locator('#smartOnlyUnknown').uncheck(); assert.equal(await frame.locator('.panel-tabs [role=tab]').count(), 2);
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
    await t.test('经历新增修改与删除按稳定 ID 生效，取消删除保留所有值', async () => {
      await workspacePage(options, 'resumeCenter');
      await addResumeEntry(options, 'project', '合成阶段四项目');
      const project = options.locator('#basicFields .entry-card').filter({ hasText: '合成阶段四项目' }); await project.waitFor(); const entryId = await project.getAttribute('data-entry-id');
      await fillEntryField(options, project, 'builtin.skills', '合成项目成果');
      const stable = options.locator('[data-entry-id="' + entryId + '"]'); options.once('dialog', (dialog) => dialog.accept('合成项目新名称')); await stable.getByRole('button', { name: '修改经历名称', exact: true }).click(); await options.waitForFunction((id) => [...document.querySelectorAll('[data-entry-id]')].find((item) => item.dataset.entryId === id)?.textContent.includes('合成项目新名称'), entryId);
      options.once('dialog', (dialog) => dialog.dismiss()); await stable.getByRole('button', { name: '删除经历', exact: true }).click(); assert.ok((await rpc(options, 'localapply:read')).database.fieldValues.some((item) => item.entryId === entryId && item.value === '合成项目成果'));
      options.once('dialog', (dialog) => dialog.accept()); await stable.getByRole('button', { name: '删除经历', exact: true }).click(); await stable.waitFor({ state: 'detached' }); assert.ok((await rpc(options, 'localapply:read')).database.entries.some((item) => item.entryId === schoolId));
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
      assert.deepEqual(await page.locator('.workspace-sidebar nav a').allTextContents(), ['导入简历','AI 与模型','我的简历','字段库','数据与备份','诊断与关于']);
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
      await page.waitForFunction(() => document.querySelectorAll('#resumeToc button[data-toc-key^="entry:"]').length === 2);
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
      await page.locator('#resumeToc button[data-toc-key="entry:' + entryIds[1] + '"]').click();
      assert.equal(await page.locator('#basicFields .is-target').getAttribute('data-entry-id'), entryIds[1]);
      await page.locator('#scrollTop').click(); await page.waitForFunction(() => scrollY === 0);
      assert.equal(await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(16, 23, 34)');
      assert.equal(await page.locator('#newProfileName').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(25, 35, 50)');
      await page.screenshot({ path: path.join(testRoot, `workspace-dark-${mode}.png`) });
      await page.locator('#scrollBottom').click(); await page.waitForFunction(() => Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) < 2);
      assert.equal(await page.locator('#fillingPreferences').evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; }), true);
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
      // 经历管理后的目录跟随真实数据更新，同名条目与其他档案严格隔离。
      await page.setViewportSize({ width: 1440, height: 900 });
      const secondEntry = page.locator('#basicFields [data-entry-id="' + entryIds[1] + '"]');
      page.once('dialog', (dialog) => dialog.accept('合成目录新名称')); await secondEntry.getByRole('button', { name: '修改经历名称', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('resumeToc').textContent.includes('合成目录新名称'));
      page.once('dialog', (dialog) => dialog.accept()); await secondEntry.getByRole('button', { name: '删除经历', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('#resumeToc button[data-toc-key^="entry:"]').length === 1);
      const otherProfile = (await page.evaluate(() => dataCommand('createProfile', { name: '合成目录第二档案' }))).result;
      await page.evaluate(() => reloadDataState()); await page.locator('#entryProfile').selectOption(otherProfile);
      await page.waitForFunction(() => document.querySelectorAll('#resumeToc button[data-toc-key^="entry:"]').length === 0);
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
      await page.locator('#entryProfile').selectOption(second); await page.locator('#basicFields [data-entry-id="' + entryId + '"]').waitFor();
      // 未保存经历输入须先确认丢弃；拒绝时不能发起删除或清空草稿。
      const draft = page.locator('#basicFields [data-entry-id="' + entryId + '"]').getByLabel('经历字段 · 毕业院校', { exact: true });
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
      const seeded = await page.evaluate(async () => {
        const profileId = (await dataRequest('localapply:read')).database.activeProfileId;
        const first = (await dataCommand('createEntry', { profileId, kind: 'project', title: '合成滚动项目' })).result;
        const second = (await dataCommand('createEntry', { profileId, kind: 'project', title: '合成滚动项目' })).result;
        const definitions = (await dataRequest('localapply:read')).database.fieldDefinitions.filter((item) => item.type === 'text').slice(0, 20);
        for (const definition of definitions) await dataCommand('setValue', { profileId, entryId: first, fieldId: definition.fieldId, value: '合成长记录字段' });
        return [first, second];
      });
      await page.evaluate(() => reloadDataState()); await page.locator('#basicFields [data-entry-id="' + seeded[1] + '"]').waitFor();
      const revision = (await page.evaluate(() => dataRequest('localapply:read'))).database.revision;
      assert.equal(await page.locator('#basicFields > .resume-group').count(), await page.locator('#resumeToc button[data-toc-key^="group:"]').count());
      assert.equal(await page.locator('#basicFields .center-field').evaluateAll((fields) => fields.every((field) => !!field.closest('.resume-group')?.querySelector('h3'))), true);
      const group = page.locator('.resume-group[data-group="求职意向"]');
      await page.locator('#resumeToc').getByRole('button', { name: '求职意向', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === 'group:求职意向');
      const bounds = await group.boundingBox(); assert.ok(bounds.y >= 20 && bounds.y + bounds.height <= 880, '可容纳的分类必须连同全部字段一起进入视口');
      assert.ok(await group.locator('.center-field').count() > 1); assert.equal(await group.locator('h3.is-target').count(), 0);
      assert.equal(await group.evaluate((element) => element.classList.contains('is-target') && document.activeElement === element), true);
      assert.equal(await group.locator('input,textarea,select').evaluateAll((fields) => fields.every((field) => { const rect = field.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })), true);
      await page.screenshot({ path: path.join(testRoot, `resume-module-light-${mode}.png`) });
      await page.locator('#themeToggle').click(); await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(16, 23, 34)');
      await page.screenshot({ path: path.join(testRoot, `resume-module-dark-${mode}.png`) });
      // 鼠标置于正文边缘留白，避免长文本输入框自身吞掉滚轮事件。
      const wheelTo = async (target, key) => {
        const delta = await target.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.top - (rect.height <= innerHeight - 48 ? (innerHeight - rect.height) / 2 : 24); });
        await page.mouse.move(225, 180); await page.mouse.wheel(0, delta);
        await page.waitForFunction((key) => document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === key, key);
      };
      const first = page.locator('#basicFields [data-entry-id="' + seeded[0] + '"]');
      const second = page.locator('#basicFields [data-entry-id="' + seeded[1] + '"]');
      const focus = await page.evaluate(() => document.activeElement.id);
      await wheelTo(first, 'entry:' + seeded[0]);
      await page.mouse.wheel(0, 450); await page.waitForFunction((id) => document.querySelector('[data-entry-id="' + id + '"] h4').getBoundingClientRect().bottom < 0, seeded[0]);
      assert.equal(await page.locator('#resumeToc [aria-current="location"]').getAttribute('data-toc-key'), 'entry:' + seeded[0]);
      assert.equal(await first.evaluate((element) => element.classList.contains('is-target')), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), focus, '滚动同步不得抢走焦点');
      await wheelTo(second, 'entry:' + seeded[1]);
      assert.equal(await first.evaluate((element) => element.classList.contains('is-target')), false);
      await page.setViewportSize({ width: 1440, height: 520 });
      await wheelTo(page.locator('#fillingPreferences'), 'preferences');
      const toc = await page.locator('.resume-toc').boundingBox(); const active = await page.locator('#resumeToc [aria-current="location"]').boundingBox();
      assert.ok(active.y >= toc.y && active.y + active.height <= toc.y + toc.height, '目录自身滚动后仍显示当前条目');
      // 当前条目未改变时缩小窗口，也要让目录重新露出该条目。
      await page.setViewportSize({ width: 1440, height: 420 });
      await page.waitForFunction(() => { const active = document.querySelector('#resumeToc [aria-current="location"]'); const box = document.querySelector('.resume-toc').getBoundingClientRect(); const item = active.getBoundingClientRect(); return active.dataset.tocKey === 'preferences' && item.top >= box.top && item.bottom <= box.bottom; });
      await page.locator('#scrollTop').click(); await page.waitForFunction(() => scrollY === 0 && document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === 'overview');
      await page.locator('#scrollBottom').click(); await page.waitForFunction(() => document.querySelector('#resumeToc [aria-current="location"]')?.dataset.tocKey === 'preferences');
      assert.equal(new URL(page.url()).hash, '#resumeCenter');
      assert.equal((await page.evaluate(() => dataRequest('localapply:read'))).database.revision, revision); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

// 已确认的合成导入走生产命令，验证统一分类、每个字段的编辑权、冲突和真实重启。
for (const withExtension of [true, false]) {
  test(`简历分类编辑：${withExtension ? '扩展' : 'file://'}自动归类、全部字段保存与重启`, { timeout: 60000 }, async () => {
    const testRoot = path.join(ROOT, '.browser-tests'); await fs.mkdir(testRoot, { recursive: true });
    const profile = await fs.mkdtemp(path.join(testRoot, 'resume-editor-')); let context; const errors = [];
    const mode = withExtension ? 'extension' : 'file';
    try {
      context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      const url = withExtension ? `chrome-extension://${(await extension(context)).extensionId}/options/options.html` : require('node:url').pathToFileURL(path.join(ROOT, 'options/options.html')).href;
      let page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(url); await workspacePage(page, 'resumeCenter');
      const seeded = await page.evaluate(async () => {
        const { database } = await dataRequest('localapply:read'); const profileId = database.activeProfileId;
        const cells = [
          ['education', 0, 'school', '合成同名学院'], ['education', 0, 'degree', '本科'], ['education', 0, 'major', '合成计算机'], ['education', 0, 'start', '2020-09'], ['education', 0, 'end', '2024-06'],
          ['education', 1, 'school', '合成同名学院'], ['education', 1, 'degree', '硕士'],
          ['employment', 0, 'company', '合成工作单位'], ['employment', 0, 'title', '合成岗位'], ['employment', 0, 'description', '合成工作职责'],
          ['internship', 0, 'company', '合成实习单位'], ['internship', 0, 'role', '合成实习角色'],
          ['project', 0, 'title', '合成项目'], ['project', 0, 'description', '合成项目描述'],
        ];
        await dataCommand('importResume', { profileId, fingerprint: 'a'.repeat(64), overwrite: false,
          rows: cells.map(([kind, index, key, value]) => ({ kind, index, key, value, evidence: { kind: 'manual', excerpt: '', page: 0, verified: false } })) }, database.revision);
        await dataCommand('createField', { profileId, definition: { label: '合成辅修', group: '教育经历' }, value: '合成辅修内容' });
        await dataCommand('createField', { profileId, definition: { label: '合成研究成果', group: '研究成果', type: 'textarea' }, value: '合成研究内容' });
        const db = (await dataRequest('localapply:read')).database;
        return { profileId, entries: db.entries, revision: db.revision };
      });
      await page.evaluate(() => reloadDataState());
      assert.equal(await page.locator('#entryKind,#entryTitle,#btnAddEntry,#entriesList,.entry-values').count(), 0);
      assert.equal(await page.locator('.resume-group[data-group="教育背景"]').count(), 1);
      assert.equal(await page.locator('.resume-group[data-group="教育经历"]').count(), 0);
      assert.equal(await page.locator('.resume-group[data-group="研究成果"]').count(), 1);
      const groups = { education: '教育背景', internship: '实习经历', employment: '工作经历', project: '项目经历' };
      for (const entry of seeded.entries) {
        const card = page.locator('[data-entry-id="' + entry.entryId + '"]');
        assert.equal(await card.evaluate((element) => element.closest('.resume-group').dataset.group), groups[entry.kind]);
      }
      const db = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      for (const entry of seeded.entries) {
        const stored = db.fieldValues.filter((row) => row.entryId === entry.entryId);
        const card = page.locator('[data-entry-id="' + entry.entryId + '"]');
        assert.equal(await card.locator('.center-field').count(), stored.length, '每个字段同时显示，不再用只读摘要代替');
        for (const row of stored) {
          const input = card.locator('[data-field-id="' + row.fieldId + '"] input,[data-field-id="' + row.fieldId + '"] select,[data-field-id="' + row.fieldId + '"] textarea');
          assert.equal(await input.inputValue(), row.value); assert.equal(await input.isEditable(), true);
        }
      }
      assert.equal(db.revision, seeded.revision, '界面归类不应改写数据库');
      // 原分类深链接也要定位到复用的完整分类，不能因名称归一而失效。
      const linked = await context.newPage();
      await linked.goto(url + '?profile=' + encodeURIComponent(seeded.profileId) + '&section=' + encodeURIComponent('group:教育经历') + '#resumeCenter');
      await linked.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
      assert.equal(await linked.evaluate(() => document.activeElement.dataset.group), '教育背景'); await linked.close();
      const schools = seeded.entries.filter((entry) => entry.kind === 'education');
      const first = page.locator('[data-entry-id="' + schools[0].entryId + '"]');
      await fillEntryField(page, first, 'builtin.school', '合成可编辑学院');
      await fillEntryField(page, first, 'builtin.major', '合成可编辑专业');
      await first.getByLabel('经历字段 · 学历', { exact: true }).selectOption('博士');
      await first.getByLabel('经历字段 · 学历', { exact: true }).blur(); await page.evaluate(() => resumeSaveQueue);
      const second = page.locator('[data-entry-id="' + schools[1].entryId + '"]');
      assert.equal(await second.getByLabel('经历字段 · 毕业院校', { exact: true }).inputValue(), '合成同名学院');
      const workId = seeded.entries.find((entry) => entry.kind === 'employment').entryId;
      await fillEntryField(page, page.locator('[data-entry-id="' + workId + '"]'), 'resume.description', '合成修改后的工作职责');
      const research = page.getByLabel('简历中心 · 合成研究成果', { exact: true });
      await research.fill('合成更新成果'); await research.blur(); await page.evaluate(() => resumeSaveQueue);
      // 第二页面的旧字段被修改后必须拒绝覆盖，其他未冲突字段仍可保存。
      const stale = await context.newPage(); await stale.goto(url); await workspacePage(stale, 'resumeCenter');
      await fillEntryField(page, first, 'builtin.school', '合成并发更新学院');
      const draft = stale.locator('[data-entry-id="' + schools[0].entryId + '"]').getByLabel('经历字段 · 毕业院校', { exact: true });
      await draft.fill('合成冲突草稿'); await draft.blur(); await stale.evaluate(() => resumeSaveQueue);
      assert.ok((await stale.locator('#centerStatus').textContent()).includes('其他页面修改'));
      assert.equal(await draft.inputValue(), '合成冲突草稿'); assert.equal(await draft.getAttribute('data-dirty'), 'true');
      await fillEntryField(stale, stale.locator('[data-entry-id="' + schools[0].entryId + '"]'), 'builtin.major', '合成无冲突专业');
      assert.equal(await draft.inputValue(), '合成冲突草稿'); await stale.close();
      await page.reload(); await workspacePage(page, 'resumeCenter');
      await page.locator('#resumeToc [data-toc-key="entry:' + workId + '"]').click();
      await page.screenshot({ path: path.join(testRoot, `resume-integrated-${mode}.png`) });
      await page.locator('#themeToggle').click(); await page.screenshot({ path: path.join(testRoot, `resume-integrated-dark-${mode}.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#resumeToc [data-toc-key="entry:' + workId + '"]').click();
      await page.screenshot({ path: path.join(testRoot, `resume-integrated-narrow-${mode}.png`) });
      await context.close(); context = await launch(profile, withExtension); context.setDefaultTimeout(10000);
      page = await context.newPage(); await page.goto(url); await workspacePage(page, 'resumeCenter');
      const restored = (await page.evaluate(() => dataRequest('localapply:read'))).database;
      assert.equal(restored.schemaVersion, 3); assert.equal(restored.entries.length, 5);
      assert.ok(restored.fieldValues.some((row) => row.entryId === schools[0].entryId && row.fieldId === 'builtin.school' && row.value === '合成并发更新学院' && row.source === 'manual' && !row.evidence));
      assert.equal(await page.locator('[data-entry-id="' + schools[0].entryId + '"]').getByLabel('经历字段 · 专业', { exact: true }).inputValue(), '合成无冲突专业');
      assert.equal(await page.getByLabel('简历中心 · 合成研究成果', { exact: true }).inputValue(), '合成更新成果');
      assert.equal(await page.locator('#basicFields .entry-card').count(), 5); assert.deepEqual(errors, []);
    } finally { if (context) await context.close(); assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
  });
}
