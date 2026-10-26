// 检测分类与路由契约：只使用合成样例，模型识别质量不由桩测试背书。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// 独立配置、时钟、网络桩；可模拟端点/Key 更改和服务中断。
function fixture() {
  const settings = { provider: 'custom.unit', model: 'main-model', visionModel: '', apiKeys: { 'custom.unit': 'fake-test-key' },
    customProviders: { 'custom.unit': { name: 'test', baseUrl: 'http://127.0.0.1:18000/v1' } } };
  let clock = 1000;
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, URL,
    Date: { now: () => clock }, WangshenTemplates: { PROVIDERS: {} } });
  for (const file of ['data/providers.js', 'data/model-capabilities.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const calls = []; let reply = async () => ({ content: '73185204' });
  const client = context.LocalApplyCapabilities.create(async () => structuredClone(settings), async (req) => { calls.push(req); return reply(req); });
  return { settings, client, calls, setReply: (fn) => { reply = fn; }, advance: () => { clock += 1800001; } };
}
// 输入封套固定，真实图片/PDF/DOCX 的生成与保留由浏览器测试验证。
function probe() {
  return { nonce: '73185204', image: 'data:image/jpeg;base64,AA==',
    pdf: { filename: 'probe.pdf', file_data: 'data:application/pdf;base64,AA==' },
    docx: { filename: 'probe.docx', file_data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AA==' } };
}
test('可选诊断不把自述冒充识别通过，未检测或未通过仍可直接发送', async () => {
  const env = fixture(); env.setReply(async () => ({ content: '支持图片及文件' }));
  assert.equal((await env.client.route('pdf')).mode, 'vision'); assert.equal(env.calls.length, 0);
  const report = await env.client.probe(probe());
  assert.equal(report.results[0].image, 'unverified'); assert.equal(report.results[0].pdf, 'unverified');
  assert.equal((await env.client.route('docx')).mode, 'vision');
  assert.equal(env.calls.length, 3);
  assert.ok(env.calls.every((req) => !JSON.stringify(req.messages).includes('73185204')));
});

test('探针关闭思考并给足短回答预算，截断输出不能误判为不支持', async () => {
  const env = fixture(); env.setReply(async () => ({ content: '', finishReason: 'length' }));
  const report = await env.client.probe(probe());
  assert.ok(env.calls.every((req) => req.disableThinking === true && req.maxTokens >= 512));
  assert.equal(report.results[0].image, 'unknown'); assert.match(report.results[0].reasons.image, /截断/);
  assert.equal((await env.client.route('pdf')).mode, 'vision');
});
test('可选诊断按格式分别报告，已知原文件可直传，否则直接使用页面图', async () => {
  const env = fixture(); await env.client.probe(probe());
  assert.equal((await env.client.route('docx')).mode, 'file');
  env.setReply(async (req) => {
    if (req.fileInput) { const error = new Error('AI 接口返回 HTTP 400'); error.code = 'HTTP_400'; throw error; }
    return { content: '73185204' };
  });
  const report = await env.client.probe(probe());
  assert.equal(report.results[0].image, 'supported'); assert.equal(report.results[0].docx, 'unsupported');
  assert.equal((await env.client.route('docx')).mode, 'vision');
});
// 已通过结果不跨配置使用，但诊断失败和过期不能成为解析门槛。
test('诊断与发送令牌按协议、Key、型号隔离，过期或网络失败仍可发送', async () => {
  const env = fixture(); await env.client.probe(probe());
  const original = await env.client.route('pdf');
  env.settings.customProviders['custom.unit'].protocol = 'responses'; const protocol = await env.client.route('pdf'); assert.equal(protocol.mode, 'vision'); assert.notEqual(protocol.token, original.token);
  delete env.settings.customProviders['custom.unit'].protocol;
  assert.equal((await env.client.route('pdf')).token, original.token);
  env.settings.apiKeys['custom.unit'] = 'changed-key'; assert.notEqual((await env.client.route('pdf')).token, original.token);
  env.settings.apiKeys['custom.unit'] = 'fake-test-key'; env.settings.model = 'other-model'; assert.equal((await env.client.route('pdf')).model, 'other-model');
  env.settings.model = 'main-model'; env.advance(); assert.equal((await env.client.route('pdf')).mode, 'vision');
  env.setReply(async () => { throw new Error('AI 请求超时'); });
  const report = await env.client.probe(probe()); assert.equal(report.results[0].image, 'unknown');
  assert.equal((await env.client.route('docx')).mode, 'vision');
});
test('主模型纯文本时可选择独立视觉模型；检测中配置变化或取消不能缓存成功结果', async () => {
  const env = fixture(); env.settings.visionModel = 'vision-model';
  env.setReply(async (req) => ({ content: req.model === 'vision-model' && !req.fileInput ? '73185204' : 'UNKNOWN' }));
  await env.client.probe(probe()); assert.equal((await env.client.route('docx')).model, 'vision-model');
  const changed = fixture(); changed.setReply(async () => { changed.settings.customProviders['custom.unit'].baseUrl = 'http://127.0.0.1:18001/v1'; return { content: '73185204' }; });
  await assert.rejects(changed.client.probe(probe()), /已变化/); assert.equal((await changed.client.route('pdf')).mode, 'vision');
  const cancelled = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.client.probe(probe(), controller.signal), /已取消/); assert.equal(cancelled.calls.length, 0);
});

// 直接解析只读取配置并签发短期令牌，不额外请求模型、猜测能力或跨型号自动重试。
test('无需检测直接选择配置模型，配置未变令牌稳定，过期须更新', async () => {
  const env = fixture(); const first = await env.client.route('pdf'); assert.equal(first.mode, 'vision'); assert.equal(first.model, 'main-model');
  assert.equal((await env.client.route('pdf')).token, first.token); assert.equal(env.calls.length, 0);
  env.settings.visionModel = 'chosen-vision'; const chosen = await env.client.route('docx'); assert.equal(chosen.model, 'chosen-vision');
  env.advance(); assert.notEqual((await env.client.route('docx')).token, chosen.token); assert.equal(env.calls.length, 0);
  await assert.rejects(env.client.route('exe'), /格式/); env.settings.model = env.settings.visionModel = ''; await assert.rejects(env.client.route('pdf'), /选择/);
});
