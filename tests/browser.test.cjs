// Playwright 真实扩展验收：独立 profile、动态端口、仅合成数据，不清理其他进程。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');

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

// 通过真实控件建立保险库，测试口令及 Key 全为合成数据。
async function setupVault(page) {
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
  await page.evaluate(() => {
    const original = LocalApplyProbes.createProbe;
    LocalApplyProbes.createProbe = () => original('73185204');
  });
  await page.locator('#btnDetectCapabilities').click();
  await page.waitForFunction(() => !document.getElementById('btnDetectCapabilities').disabled);
  assert.match(await page.locator('#capabilityStatus').textContent(), /图片 识别通过/);
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
      assert.equal(await page.locator('#modelApiHelp').evaluate((details) => details.open), true);
      assert.ok((await page.locator('#modelsEndpoint').textContent()).endsWith('/v1/models'));
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
      const result = await options.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'wsa:getState' }), tabId);
      assert.equal(result.state.authorized, false); assert.equal(result.state.fields.length, 0); assert.equal(api.calls.length, 0);
      assert.equal(await page.locator('#wsa-floatbar-host').evaluate((host) => host.shadowRoot), null);
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
      // 异步招聘表单先挂载后显现，自动检测也不能读取任何控件值。
      await page.evaluate(() => {
        document.title = '动态候选人信息'; const form = document.createElement('form'); form.id = 'dynamic-application'; form.hidden = true;
        window.__presenceValueReads = 0;
        for (const name of ['本科毕业院校','硕士专业','联系电话']) { const label = document.createElement('label'); label.textContent = name; const input = document.createElement('input'); Object.defineProperty(input, 'value', { get() { window.__presenceValueReads++; return '禁止读取'; } }); label.append(input); form.append(label); }
        document.body.append(form);
        document.querySelector('input[placeholder="请输入验证码"]').remove();
      });
      await options.waitForFunction(async (tabId) => (await chrome.tabs.sendMessage(tabId, { type: 'wsa:floatingProbe' })).presence.kind === 'other', tabId);
      await page.locator('#dynamic-application').evaluate((form) => { form.hidden = false; });
      await page.locator('#wsa-floatbar-host').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => __presenceValueReads), 0);
    });
  } finally {
    if (context) await context.close(); await new Promise((resolve) => api.server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(testRoot) + path.sep)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});
