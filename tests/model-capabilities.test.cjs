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
test('普通 HTTP 成功、模型自述或忽略附件均不能获得识别能力', async () => {
  const env = fixture(); env.setReply(async () => ({ content: '支持图片及文件' }));
  await assert.rejects(env.client.route('pdf'), /尚未通过/);
  const report = await env.client.probe(probe());
  assert.equal(report.results[0].image, 'unverified'); assert.equal(report.results[0].pdf, 'unverified');
  await assert.rejects(env.client.route('docx'), /尚未通过/);
  assert.equal(env.calls.length, 3);
  assert.ok(env.calls.every((req) => !JSON.stringify(req.messages).includes('73185204')));
});
test('图片、PDF、DOCX 分开实测；原文件优先，不支持文件时才使用已验证图片路径', async () => {
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
test('鉴权/网络失败标记未知，结果与端点、Key、型号隔离并按时过期', async () => {
  const env = fixture(); await env.client.probe(probe());
  env.settings.apiKeys['custom.unit'] = 'changed-key'; await assert.rejects(env.client.route('pdf'), /尚未通过/);
  env.settings.apiKeys['custom.unit'] = 'fake-test-key'; env.settings.model = 'other-model'; await assert.rejects(env.client.route('pdf'), /尚未通过/);
  env.settings.model = 'main-model'; env.advance(); await assert.rejects(env.client.route('pdf'), /尚未通过/);
  env.setReply(async () => { throw new Error('AI 请求超时'); });
  const report = await env.client.probe(probe()); assert.equal(report.results[0].image, 'unknown');
  await assert.rejects(env.client.route('docx'), /尚未通过/);
});
test('主模型纯文本时可选择独立视觉模型；检测中配置变化或取消不能缓存成功结果', async () => {
  const env = fixture(); env.settings.visionModel = 'vision-model';
  env.setReply(async (req) => ({ content: req.model === 'vision-model' && !req.fileInput ? '73185204' : 'UNKNOWN' }));
  await env.client.probe(probe()); assert.equal((await env.client.route('docx')).model, 'vision-model');
  const changed = fixture(); changed.setReply(async () => { changed.settings.customProviders['custom.unit'].baseUrl = 'http://127.0.0.1:18001/v1'; return { content: '73185204' }; });
  await assert.rejects(changed.client.probe(probe()), /已变化/); await assert.rejects(changed.client.route('pdf'), /尚未通过/);
  const cancelled = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.client.probe(probe(), controller.signal), /已取消/); assert.equal(cancelled.calls.length, 0);
});
