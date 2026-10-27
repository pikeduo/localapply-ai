// 阶段零基线：只在内存中执行原有脚本，不联网、不启动浏览器、不读写用户档案。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

// 读取仓库源码，测试不依赖运行命令所在的目录。
function source(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// 为每项测试创建隔离的 Chrome 存储和消息桩；fetch 调用一律阻止。
function sandbox(file = 'data/templates.js', initial = {}) {
  const storage = structuredClone(initial);
  const listeners = [];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, AbortController, URL, TextEncoder, TextDecoder, btoa, atob, crypto: require('node:crypto').webcrypto,
    fetch: async () => { throw new Error('基线测试禁止联网'); },
    chrome: {
      storage: { local: {
        get: async (key) => structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map((item) => [item, storage[item]]))),
        set: async (value) => { Object.assign(storage, structuredClone(value)); },
        setAccessLevel: async () => {},
      } },
      runtime: {
        id: 'test-extension', getURL: (name) => 'chrome-extension://test-extension/' + name,
        onMessage: { addListener: (listener) => listeners.push(listener) },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
      },
    },
  });
  // 原 service worker 通过 importScripts 加载模板，保持相同执行顺序。
  context.importScripts = (...names) => names.forEach((name) => vm.runInContext(source(name), context, { filename: name }));
  vm.runInContext(source(file), context, { filename: file });
  return { context, storage, listeners };
}

// 枚举手写 JavaScript，第三方压缩代码单独做语法检查。
function scripts(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? scripts(file) : /\.(js|cjs)$/.test(file) ? [file] : [];
  });
}

test('全部 JavaScript 可通过 Node 语法检查（不执行脚本）', () => {
  for (const file of ['background.js', 'common.js', ...['content', 'data', 'sidepanel', 'panel', 'options', 'tools', 'libs', 'tests'].flatMap(scripts)]) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

// 各补注入入口必须先加载适配器再启动扫描器，防止页面加载竞态污染扫描器依赖。
test('补注入脚本与清单保持相同依赖顺序', () => {
  const expected = JSON.parse(source('manifest.json')).content_scripts[0].js;
  for (const file of ['sidepanel/sidepanel.js', 'data/field-learning.js', 'data/floating-panel.js']) {
    const entries = source(file).match(/files:\s*\[([^\]]+)\]/);
    assert.ok(entries, file);
    assert.deepEqual([...entries[1].matchAll(/'([^']+)'/g)].map((match) => match[1]), expected, file);
  }
});

test('MV3 清单的脚本、页面及图标资源均存在', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  const files = [manifest.background.service_worker, 'sidepanel/sidepanel.html', 'panel/panel.html',
    manifest.options_page, ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => entry.js)];
  for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  // 新入口为网页悬浮卡片，旧侧栏文件仍检查资源完整性以保留历史回归。
  assert.equal(manifest.side_panel, undefined);
  assert.ok(!manifest.permissions.includes('sidePanel'));
  for (const html of ['sidepanel/sidepanel.html', 'panel/panel.html', manifest.options_page]) {
    for (const match of source(html).matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (match[1].startsWith('#')) continue; // 页内导航无需文件资源。
      assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(html), match[1])), `${html}: ${match[1]}`);
    }
  }
});

// 日历计算不依赖 DOM 或网络，严格区分闰年、日期精度和历史非标准文本。
test('中文日历：真实日期与年月/年份精度校验', () => {
  const { context } = sandbox('options/date-picker.js'); const picker = context.LocalApplyDatePicker;
  assert.equal(picker.parse('2000-02-29', 'date').day, 29);
  for (const value of ['1900-02-29', '2027-02-30', '2027-13-01', '0000-01-01', '2027.06', '2027-2-01']) assert.equal(picker.parse(value, 'date'), null, value);
  assert.equal(picker.parse('0001-01-01', 'date').year, 1);
  assert.equal(picker.parse('2027', 'year').year, 2027);
  assert.equal(picker.parse('2027-06', 'month').month, 6);
  assert.equal(picker.parse('2027', 'month'), null);
  assert.equal(picker.format(2027, 6, 18, 'year'), '2027');
  assert.equal(picker.format(2027, 6, 18, 'month'), '2027-06');
  assert.equal(picker.format(2000, 2, 29), '2000-02-29');
});

// 六行网格包含相邻月份并限制年份边界，避免跨月/跨年产生错误可选值。
test('中文日历：六行日期、周起点及年份边界', () => {
  const { context } = sandbox('options/date-picker.js'); const picker = context.LocalApplyDatePicker;
  const days = picker.monthDays(2000, 2);
  assert.equal(days.length, 42); assert.equal(days[0].value, '2000-01-30');
  assert.equal(days.filter((day) => day?.currentMonth).length, 29);
  assert.equal(picker.monthDays(1900, 2).filter((day) => day?.currentMonth).length, 28);
  assert.ok(picker.monthDays(1, 1).filter(Boolean).every((day) => day.year >= 1));
  assert.ok(picker.monthDays(9999, 12).filter(Boolean).every((day) => day.year <= 9999));
});

// 地区搜索只访问离线公共地名，多个关键词和重名区县都保留完整路径。
test('地区搜索：省市区路径、多关键词和重名候选', () => {
  const { context } = sandbox('data/regions.js'); vm.runInContext(source('options/region-picker.js'), context); const picker = context.LocalApplyRegionPicker;
  const city = picker.search('江苏 南京'); assert.ok(city.paths.some((path) => path.join('/') === '江苏省/南京市')); assert.ok(city.paths.some((path) => path.join('/') === '江苏省/南京市/玄武区'));
  const districts = picker.search('长安区'); assert.ok(districts.paths.some((path) => path[0] === '陕西省')); assert.ok(districts.paths.some((path) => path[0] === '河北省'));
  assert.equal(picker.search('南京/玄武').paths[0].join(' / '), '江苏省 / 南京市 / 玄武区');
});

// 查询不按正则解释且显示结果有界，手填新地区不依赖伪造候选。
test('地区搜索：空词、未知地区及结果数量限制', () => {
  const { context } = sandbox('data/regions.js'); vm.runInContext(source('options/region-picker.js'), context); const picker = context.LocalApplyRegionPicker;
  assert.equal(picker.search('  ').count, 0); assert.equal(picker.search('合成海外新地区').count, 0); assert.equal(picker.search('.*<script>').count, 0);
  const found = picker.search('广东'); assert.ok(found.count > 60); assert.equal(found.paths.length, 60);
});

test('普通网页缺少扩展接口时返回中文打开指引，不抛 sendMessage 异常', async () => {
  for (const globals of [{}, { chrome: {} }, { chrome: { runtime: {} } }]) {
    const context = vm.createContext(globals);
    vm.runInContext(source('common.js'), context);
    const response = await context.sendMessage('wsa:getState');
    assert.equal(response.ok, false);
    assert.match(response.error, /扩展选项/);
    assert.ok(!response.error.includes('Cannot read properties'));
  }
});

test('扩展页面消息正常转发，失效上下文提示重新打开', async () => {
  const runtime = { id: 'test-extension', sendMessage: (message, callback) => callback({ ok: true, type: message.type }) };
  const context = vm.createContext({ chrome: { runtime } });
  vm.runInContext(source('common.js'), context);
  assert.equal((await context.sendMessage('wsa:ping')).type, 'wsa:ping');
  runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
  assert.match((await context.sendMessage('wsa:getState')).error, /重新打开/);
});

test('文件设置页走独立运行时，HTTP 页面不能启用该存储回退', async () => {
  let fileCalls = 0; let extensionCalls = 0;
  const context = vm.createContext({ location: { protocol: 'file:' },
    LocalApplyStandalone: { enabled: true, request: async (type) => { fileCalls++; return { ok: true, type }; } },
    chrome: { runtime: { id: 'test-extension', sendMessage: (message, callback) => { extensionCalls++; callback({ ok: true }); } } },
  });
  vm.runInContext(source('common.js'), context);
  assert.equal((await context.sendMessage('wsa:getState')).type, 'wsa:getState');
  assert.equal(fileCalls, 1); assert.equal(extensionCalls, 0);
  context.location.protocol = 'https:';
  await context.sendMessage('wsa:getState'); assert.equal(fileCalls, 1); assert.equal(extensionCalls, 1);
  context.location.protocol = 'file:'; context.LocalApplyStandalone = undefined;
  assert.match((await context.sendMessage('wsa:getState')).error, /组件未加载/);
});

test('独立运行时在扩展/网页上下文不打开任何文件数据库', () => {
  for (const protocol of ['chrome-extension:', 'https:']) {
    const context = vm.createContext({ location: { protocol } });
    vm.runInContext(source('options/standalone.js'), context);
    assert.equal(context.LocalApplyStandalone.enabled, false);
  }
});

// 完整 URL 的根路径与 /v1 必须区分，省略协议的便捷输入仍自动补齐。
test('服务商地址规范化支持 IPv4/IPv6、本地域名和完整接口，拒绝危险地址', () => {
  const { context } = sandbox(); vm.runInContext(source('data/providers.js'), context);
  const providers = context.LocalApplyProviders;
  for (const [input, expected] of [
    ['192.168.1.10:8000', 'http://192.168.1.10:8000/v1'], ['[::1]:11434', 'http://[::1]:11434/v1'],
    ['localhost:11434/v1/', 'http://localhost:11434/v1'], ['api.example.test', 'https://api.example.test/v1'],
    ['https://api.example.test/custom/v1/chat/completions', 'https://api.example.test/custom/v1'],
    ['http://127.0.0.1:9000/', 'http://127.0.0.1:9000'], ['https://api.example.test', 'https://api.example.test'],
    ['http://127.0.0.1:9000/responses', 'http://127.0.0.1:9000'],
  ]) assert.equal(providers.normalizeBase(input), expected);
  for (const input of ['javascript:alert(1)', 'file:///tmp/x', 'https://name:password@example.test/v1', 'https://example.test/v1?key=private', '999.999.1.1:80']) {
    assert.throws(() => providers.normalizeBase(input), input);
  }
  assert.equal(providers.find({}, 'DeepSeek'), 'deepseek'); assert.equal(providers.find({}, 'qwen'), 'qwen');
  assert.equal(providers.find({}, 'localhost:11434'), 'ollama');
  assert.equal(providers.find({}, 'http://localhost:11434'), null);
});

// 根入口不会匹配已保存的 /v1 服务商，从而避免隐式继承另一端点的密钥。
test('自定义地址精确解析，未知服务商不回退到其他端点', () => {
  const { context } = sandbox(); vm.runInContext(source('data/providers.js'), context);
  const settings = { provider: 'custom.unit', customProviders: { 'custom.unit': { name: '测试服务', baseUrl: 'http://127.0.0.1:9000/v1' } } };
  assert.equal(context.LocalApplyProviders.find(settings, '127.0.0.1:9000'), 'custom.unit');
  assert.equal(context.LocalApplyProviders.find(settings, 'http://127.0.0.1:9000/'), null);
  assert.equal(context.LocalApplyProviders.resolve(settings).baseUrl, 'http://127.0.0.1:9000/v1');
  assert.throws(() => context.LocalApplyProviders.resolve({ provider: 'missing' }), /不存在/);
});

test('后台只向所选自定义端点发送其 Key，无 Key 本地服务不添加认证头', async () => {
  const initial = sandbox().context.WangshenTemplates.defaultState();
  initial.settings = { ...initial.settings, provider: 'custom.unit', model: 'synthetic-model',
    customProviders: { 'custom.unit': { name: '测试本地服务', baseUrl: 'http://127.0.0.1:9000/v1' } },
    apiKeys: { deepseek: 'fake-unrelated-key', 'custom.unit': 'fake-endpoint-key' } };
  const { context, storage } = sandbox('background.js', { wangshenAutofill: initial });
  const calls = [];
  context.fetch = async (url, request) => { calls.push({ url, request }); return { ok: true, json: async () => ({ choices: [{ message: { content: '正常' } }] }) }; };
  await context.callGLM({ messages: [] });
  assert.equal(calls[0].url, 'http://127.0.0.1:9000/v1/chat/completions');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer fake-endpoint-key');
  assert.equal(calls[0].request.redirect, 'error');
  delete storage['localapply.apiSettings'].apiKeys['custom.unit'];
  await context.callGLM({ messages: [] });
  assert.ok(!Object.hasOwn(calls[1].request.headers, 'Authorization'));
});

test('官方 DeepSeek 短探针显式关闭默认思考，不把该参数发给其他服务商', async () => {
  const initial = sandbox().context.WangshenTemplates.defaultState();
  initial.settings.provider = 'deepseek'; initial.settings.model = 'deepseek-flash'; initial.settings.apiKeys.deepseek = 'fake-only-test-key';
  const { context, storage } = sandbox('background.js', { wangshenAutofill: initial }); const requests = [];
  context.fetch = async (url, req) => { requests.push(JSON.parse(req.body)); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '73185204' } }] }) }; };
  const out = await context.callGLM({ messages: [], disableThinking: true, maxTokens: 512 });
  assert.equal(requests[0].thinking.type, 'disabled'); assert.equal(out.finishReason, 'stop');
  storage['localapply.apiSettings'].provider = 'qwen'; storage['localapply.apiSettings'].apiKeys.qwen = 'fake-qwen-only-key';
  await context.callGLM({ messages: [], disableThinking: true }); assert.ok(!Object.hasOwn(requests[1], 'thinking'));
  context.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: '不作为最终回答' } }] }) });
  await assert.rejects(context.callGLM({ messages: [] }), /输出被截断/);
});

// 使用独立合成端点测试模型发现，所有网络响应都由内存桩提供。
function modelListingFixture(provider = 'custom.models') {
  const initial = sandbox().context.WangshenTemplates.defaultState();
  initial.settings = { ...initial.settings, provider, apiKeys: { [provider]: 'fake-models-key', unrelated: 'fake-other-key' },
    customProviders: { 'custom.models': { name: '合成模型服务', baseUrl: 'http://127.0.0.1:9000/v1' } } };
  return sandbox('background.js', { wangshenAutofill: initial });
}

// 为 Responses 测试准备独立根入口，保留生产读取密钥和配置的路径。
async function responsesFixture() {
  const env = modelListingFixture(); await env.context.getState();
  const api = env.storage['localapply.apiSettings'];
  api.customProviders['custom.models'] = { name: '合成 Responses', baseUrl: 'http://127.0.0.1:9000', protocol: 'responses' };
  api.model = 'gpt-6.1-sol';
  return env;
}

// 标准终态夹具同时包含推理条目，避免客户端误把思考内容作为简历正文。
function responseResult(text = '正常') {
  return { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: '不能当作正文' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
}

// 根路径、密钥与输入附件必须原样对应，协议适配不能产生第二次联网调用。
test('Responses 使用根路径、当前 Key 和原文件/图片输入，关闭存储并适配 Sol 推理预算', async () => {
  const { context } = await responsesFixture(); const calls = [];
  context.fetch = async (url, req) => { calls.push({ url, req }); return new Response(JSON.stringify(req.method === 'GET' ? { data: [{ id: 'gpt-6.1-sol' }] } : responseResult()), { headers: { 'Content-Type': 'application/json' } }); };
  const out = await context.callGLM({ disableThinking: true, maxTokens: 128, messages: [
    { role: 'system', content: '合成系统指令' }, { role: 'user', content: [
      { type: 'text', text: '合成正文' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YQ==' } },
      { type: 'file', file: { filename: 'probe.pdf', file_data: 'data:application/pdf;base64,Yg==' } },
    ] },
  ] });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:9000/responses');
  assert.equal(calls[0].req.headers.Authorization, 'Bearer fake-models-key'); assert.equal(calls[0].req.redirect, 'error');
  const body = JSON.parse(calls[0].req.body);
  assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.instructions, '合成系统指令');
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.max_output_tokens, 2048);
  assert.equal(body.reasoning.effort, 'low'); assert.equal(body.temperature, undefined);
  assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: '合成正文' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,YQ==' },
    { type: 'input_file', filename: 'probe.pdf', file_data: 'data:application/pdf;base64,Yg==' }]);
  assert.equal(out.content, '正常'); assert.equal(out.finishReason, 'stop');
  await context.listAvailableModels('custom.models');
  assert.equal(calls[1].url, 'http://127.0.0.1:9000/models'); assert.equal(calls[1].req.method, 'GET');
});

// 将中文终态按字节拆开，并让连接保持打开，验证完成事件即可释放流。
test('Responses SSE 跨块解码中文并等待终态，不依赖连接关闭或 delta 猜测成功', async () => {
  const { context } = await responsesFixture(); let cancelled = false;
  const wire = ': ping\r\n\r\ndata: {"type":"response.output_text.delta","delta":"不作为终态"}\r\n\r\n'
    + 'event: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed', response: responseResult('中文终态') }) + '\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  context.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
  }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  assert.equal((await context.callGLM({ messages: [{ role: 'user', content: '合成请求' }] })).content, '中文终态');
  assert.equal(cancelled, true);
});

// 中断、错误、超限和不完整响应均不得成为“能力通过”，错误正文不展示给用户。
test('Responses 拒绝断流和服务端错误，限制流大小并识别输出截断', async () => {
  const { context } = await responsesFixture();
  for (const wire of ['data: [DONE]\n\n', 'data: {"type":"response.failed","error":{"message":"private-server-secret"}}\n\n']) {
    context.fetch = async () => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(context.callGLM({ messages: [] }), (error) => !error.message.includes('private-server-secret') && /提前结束|返回失败/.test(error.message));
  }
  context.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(context.callGLM({ messages: [] }), /大小限制/);
  context.fetch = async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
  await assert.rejects(context.callGLM({ messages: [] }), (error) => error.code === 'OUTPUT_LIMIT');
  const partial = responseResult('部分输出'); partial.status = 'incomplete'; partial.incomplete_details = { reason: 'max_output_tokens' };
  context.fetch = async () => new Response(JSON.stringify(partial));
  assert.equal((await context.callGLM({ messages: [] })).finishReason, 'length');
  context.fetch = async () => new Response('private-invalid-json');
  await assert.rejects(context.callGLM({ messages: [] }), (error) => /有效 JSON/.test(error.message) && !error.message.includes('private-invalid-json'));
});

// 取消信号必须中断正在读取的流，协议分支不能绕过既有取消机制。
test('Responses 读取期间可取消，外部错误内容不会回显', async () => {
  const { context } = await responsesFixture(); const external = new AbortController();
  context.fetch = async (url, req) => new Response(new ReadableStream({ start(controller) {
    req.signal.addEventListener('abort', () => { const error = new Error('private-abort'); error.name = 'AbortError'; controller.error(error); });
    external.abort();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(context.callGLM({ messages: [], signal: external.signal }), /已取消解析/);
});

test('模型列表解析去重排序，仅接受有效 ID，空列表与异常格式区分', () => {
  const { context } = sandbox(); vm.runInContext(source('data/providers.js'), context);
  const parse = context.LocalApplyProviders.parseModels;
  assert.deepEqual(Array.from(parse({ data: [{ id: 'z' }, { id: ' a ' }, { id: 'z' }, { id: 5 }, null] })), ['a', 'z']);
  assert.equal(parse({ data: [] }).length, 0);
  for (const input of [null, { models: [] }, { data: [{ id: '\n' }] }, { data: [{ id: 'x'.repeat(2001) }] }]) assert.throws(() => parse(input));
});

test('模型发现使用 GET 和当前 Key，不携带个人资料，并校验预期服务商', async () => {
  const { context } = modelListingFixture(); const calls = [];
  context.fetch = async (url, request) => { calls.push({ url, request }); return { ok: true, json: async () => ({ data: [{ id: 'synthetic-chat' }] }) }; };
  const response = await context.listAvailableModels('custom.models');
  assert.equal(calls[0].url, 'http://127.0.0.1:9000/v1/models');
  assert.equal(calls[0].request.method, 'GET'); assert.equal(calls[0].request.headers.Authorization, 'Bearer fake-models-key');
  assert.equal(calls[0].request.body, undefined); assert.equal(calls[0].request.redirect, 'error');
  assert.equal(response.models[0], 'synthetic-chat'); assert.ok(!JSON.stringify(response).includes('fake-models-key'));
  await assert.rejects(context.listAvailableModels('deepseek'), /已切换/); assert.equal(calls.length, 1);
});

test('模型发现兼容无 Key 本地服务；云服务缺 Key 在联网前失败', async () => {
  const local = modelListingFixture(); await local.context.getState();
  delete local.storage['localapply.apiSettings'].apiKeys['custom.models'];
  local.context.fetch = async (url, request) => {
    assert.ok(!Object.hasOwn(request.headers, 'Authorization'));
    return { ok: true, json: async () => ({ data: [] }) };
  };
  assert.equal((await local.context.listAvailableModels('custom.models')).models.length, 0);
  const cloud = modelListingFixture('deepseek'); await cloud.context.getState();
  delete cloud.storage['localapply.apiSettings'].apiKeys.deepseek;
  await assert.rejects(cloud.context.listAvailableModels('deepseek'), /先填写/);
});

// 鉴权、缺少接口和服务端故障分别提示，诊断请求编号不得携带任意服务端文本。
test('模型发现处理认证、无接口、限流及服务器错误，不返回原始错误体', async () => {
  const { context } = modelListingFixture();
  for (const [status, message] of [[401, /401/], [403, /403/], [404, /手动/], [405, /手动/], [429, /429/], [500, /500/], [502, /502.*反代日志/], [503, /503/], [504, /504/]]) {
    context.fetch = async () => ({ ok: false, status, json: async () => { throw new Error('禁止读取错误响应秘密'); } });
    await assert.rejects(context.listAvailableModels('custom.models'), message);
  }
  const requestId = '1da5bd20-019a-4a0c-a4fe-9d9e6f404271';
  context.fetch = async () => ({ ok: false, status: 502, headers: { get: () => requestId } });
  await assert.rejects(context.listAvailableModels('custom.models'), (error) => error.code === 'HTTP_502' && error.message.includes(requestId));
  context.fetch = async () => ({ ok: false, status: 502, headers: { get: () => 'private-server-secret' } });
  await assert.rejects(context.listAvailableModels('custom.models'), (error) => !error.message.includes('private-server-secret'));
  await assert.rejects(context.callGLM({ messages: [], model: 'synthetic-chat' }), (error) => error.code === 'HTTP_502' && !error.message.includes('private-server-secret'));
});

test('模型发现区分坏 JSON、网络失败和超时，超时覆盖响应体解析', async () => {
  const { context } = modelListingFixture();
  context.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('private response'); } });
  await assert.rejects(context.listAvailableModels('custom.models'), /有效 JSON/);
  context.fetch = async () => { vm.runInContext('throw new TypeError("failed to fetch")', context); };
  await assert.rejects(context.listAvailableModels('custom.models'), /无法连接/);
  context.fetch = async () => ({ ok: true, json: async () => { const error = new Error('abort'); error.name = 'AbortError'; throw error; } });
  await assert.rejects(context.listAvailableModels('custom.models'), /超时/);
  let cleared = false;
  context.setTimeout = () => 1; context.clearTimeout = () => { cleared = true; };
  context.fetch = async () => ({ ok: true, json: async () => { assert.equal(cleared, false); return { data: [] }; } });
  await context.listAvailableModels('custom.models'); assert.equal(cleared, true);
});

test('未选主模型时不使用预设的第一个模型偷偷发起调用', async () => {
  const { context } = modelListingFixture('deepseek');
  await assert.rejects(context.callGLM({ messages: [] }), /先获取模型列表/);
});

// 按最新要求只保留参考页 155 项字段，内部隐私默认值不随界面精简而改变。
test('默认档案包含 155 个唯一基础字段及隐私默认值', () => {
  const state = sandbox().context.WangshenTemplates.defaultState();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.profiles[0].fields.length, 155);
  assert.equal(new Set(state.profiles[0].fields.map((field) => field.key)).size, 155);
  assert.equal(state.settings.privacyMask, true);
  assert.equal(Object.keys(state.settings.apiKeys).length, 0);
});

test('不同档案的字段值和选项互不污染', () => {
  const templates = sandbox().context.WangshenTemplates;
  const first = templates.makeProfile('甲', 'all');
  const second = templates.makeProfile('乙', 'all');
  first.fields[0].value = '虚构姓名';
  first.fields.find((field) => field.options).options.push('测试选项');
  assert.equal(second.fields[0].value, '');
  assert.ok(!second.fields.find((field) => field.options).options.includes('测试选项'));
});

test('常用中文标签正确匹配；素材和未知标签不冒充已知字段', () => {
  const templates = sandbox().context.WangshenTemplates;
  for (const [label, key] of [[' * 姓名：', 'name'], ['手机号码', 'phone'], ['电子邮箱', 'email'], ['毕业院校', 'school'], ['期望工作城市', 'expectedCity']]) {
    assert.equal(templates.matchLabel(label).key, key);
  }
  assert.equal(templates.matchLabel('项目深挖'), null);
  assert.equal(templates.matchLabel('火星基地编号'), null);
});

test('旧档案升级保留已有值与自定义字段且可重复执行', () => {
  const templates = sandbox().context.WangshenTemplates;
  const profile = { id: 'old', fields: [
    { key: 'name', value: '测试姓名' }, { key: 'c_example', custom: true, value: '测试内容' },
  ] };
  templates.upgradeProfile(profile);
  const snapshot = JSON.stringify(profile);
  templates.upgradeProfile(profile);
  assert.equal(JSON.stringify(profile), snapshot);
  assert.equal(profile.fields.length, 156);
  assert.equal(profile.fields[0].value, '测试姓名');
  assert.equal(profile.fields[1].value, '测试内容');
});

test('旧单 Key 配置迁移至服务商配置且保持幂等', () => {
  const templates = sandbox().context.WangshenTemplates;
  const state = { settings: { apiKey: 'fake-test-key' } };
  assert.equal(templates.normalizeSettings(state), true);
  assert.equal(state.settings.apiKeys.zhipu, 'fake-test-key');
  assert.equal('apiKey' in state.settings, false);
  assert.equal(templates.normalizeSettings(state), false);
});

test('共享存储首次初始化和再次读取保持档案一致', async () => {
  const { context, storage } = sandbox('background.js');
  const first = await context.getState();
  const second = await context.getState();
  assert.equal(first.profiles[0].id, second.profiles[0].id);
  assert.equal(storage['localapply.database'].schemaVersion, 5); // 岗位追踪加入后，规范库升级至 v5。
});

test('AI 回复 JSON 围栏可解析，异常文本返回空结果', () => {
  const { context } = sandbox('background.js');
  assert.equal(context.extractJson('说明\n```json\n{"name":"测试"}\n```').name, '测试');
  assert.equal(context.extractJson('不是 JSON'), null);
  assert.equal(context.extractJson('{bad}'), null);
});

test('无 Key 请求在联网前返回可读错误', async () => {
  const { context } = sandbox('background.js');
  await assert.rejects(context.callGLM({}), /尚未配置/);
});

test('消息层 ping 和无 Key 错误可异步返回', async () => {
  const { listeners } = sandbox('background.js');
  // 使用原消息回调验证异步响应；超时由 node:test 的测试选项控制。
  const ping = await new Promise((resolve) => listeners[0]({ type: 'wsa:ping' }, {}, resolve));
  assert.equal(ping.pong, true);
  const error = await new Promise((resolve) => listeners[0]({ type: 'wsa:aiChat', payload: {} },
    { id: 'test-extension', url: 'chrome-extension://test-extension/options/options.html' }, resolve));
  assert.equal(error.ok, false);
  assert.match(error.error, /尚未配置/);
});

test('内容脚本不能读取个人库、导出、命令写入或代理 AI', async () => {
  const { listeners } = sandbox('background.js');
  const sender = { id: 'test-extension', url: 'https://recruit.example.test/apply', tab: { id: 1 } };
  for (const type of ['wsa:getState', 'localapply:read', 'localapply:command', 'localapply:vault', 'localapply:exportBackup', 'localapply:exportPublicFields', 'wsa:aiChat', 'wsa:listModels', 'wsa:probeCapabilities', 'wsa:resumeRoute', 'wsa:aiExtractResume', 'wsa:cancelResume']) {
    const response = await new Promise((resolve) => listeners[0]({ type }, sender, resolve));
    assert.equal(response.ok, false, type);
    assert.match(response.error, /仅允许/);
  }
  const safe = await new Promise((resolve) => listeners[0]({ type: 'wsa:contentSettings' }, sender, resolve));
  assert.equal(safe.ok, true);
  assert.deepEqual(Object.keys(safe.settings).sort(), ['autoFloatbar', 'autoThreshold', 'privacyMask']);
});

test('CSV 保留 BOM、中文、双引号与换行转义', () => {
  const { context } = sandbox('background.js');
  const csv = context.buildCsv([{ company: '测试"公司\n第二行', autoCount: 2 }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('"测试""公司\n第二行"'));
  assert.ok(csv.includes('"2"'));
});

test('视觉页结果合并保留首个标量和去重技能', () => {
  const { context } = sandbox('background.js');
  const merged = {};
  context.mergeResumePart(merged, { name: '第一页', skills: ['JS'] });
  context.mergeResumePart(merged, { name: '第二页', skills: ['JS', 'CSS'] });
  assert.equal(merged.name, '第一页');
  // VM 数组来自不同原型域，转为宿主数组后比较实际内容。
  assert.deepEqual(Array.from(merged.skills), ['JS', 'CSS']);
});

test('PDF.js 可本地解析扫描夹具（不渲染、不联网）', async () => {
  // 使用实际分发的浏览器脚本及预载 worker，不依赖旧版 CommonJS 包装。
  const context = vm.createContext({ console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController, AbortSignal,
    setTimeout, clearTimeout, structuredClone, ReadableStream, Response, Request, Headers, DOMException, crypto: require('node:crypto').webcrypto,
    DOMMatrix: class DOMMatrix {} });
  vm.runInContext(source('libs/pdfjs/pdf.min.js'), context);
  vm.runInContext(source('libs/pdfjs/pdf.worker.min.js'), context);
  const pdfjs = context.pdfjsLib;
  assert.equal(pdfjs.version, '6.4.299');
  pdfjs.GlobalWorkerOptions.workerSrc = 'local-preloaded-worker.js';
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(path.join(ROOT, 'test-pages/fake-scan.pdf'))),
    isEvalSupported: false, useSystemFonts: false,
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 1);
    const content = await (await document.getPage(1)).getTextContent();
    assert.equal(content.items.length, 0);
  } finally {
    await task.destroy();
  }
});
