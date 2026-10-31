// 岗位 AI 使用隔离内存和合成页面文本；不请求真实模型或读取个人资料。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
// 加载生产契约与配置摘要，仅提供允许的后台接口，任何隐式写入都会失败。
function fixture() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, URL, TextEncoder, AbortController, Date });
  for (const name of ['templates', 'providers', 'field-matching', 'applications', 'model-capabilities', 'job-suggestions']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/' + name + '.js'), 'utf8'), context);
  const session = { tabId: 5, token: 'synthetic-panel', documentId: 'synthetic-document', url: 'https://jobs.example.test/job/123?token=private-link-token&utm_source=test' };
  const state = { url: session.url, documentId: session.documentId, open: true, calls: [], settings: { provider: 'deepseek', model: 'synthetic-model', apiKeys: { deepseek: 'sk-synthetic-job-only' } },
    snippets: [{ source: 'pageTitle', text: '合成科技 · 合成开发工程师' }, { source: 'jobMetadata', text: '工作地点：合成甲城' }] };
  const browser = { tabs: { get: async () => ({ url: state.url }), sendMessage: async (id, msg) => msg.type === 'wsa:floatingProbe' ? { open: state.open, documentId: state.documentId } : { ok: true, documentId: state.documentId, snippets: structuredClone(state.snippets) } } };
  const ai = { callGLM: async (request) => { state.calls.push(request); if (state.work) return state.work(request); return { content: state.reply || goodReply() }; } };
  const service = context.LocalApplyJobSuggestions.create({ readAiSettings: async () => structuredClone(state.settings) }, ai, browser);
  return { context, state, session, service, contract: context.LocalApplyJobSuggestions };
}
// 三个字段均引用本次发送的连续原文，链接不由模型提供。
function goodReply(overrides = {}) {
  return JSON.stringify({ companyName: { value: '合成科技', evidence: '合成科技 · 合成开发工程师' }, jobTitle: { value: '合成开发工程师', evidence: '合成科技 · 合成开发工程师' }, location: { value: '合成甲城', evidence: '工作地点：合成甲城' }, ...overrides });
}
// 通过真实预览令牌发起已确认请求，避免测试绕过授权前置条件。
async function recognize(env) { const preview = await env.service.prepare(env.session); return env.service.recognize(env.session, { token: preview.token, confirmed: true }); }

test('岗位 AI 预览不联网，正文脱敏且不读取简历，确认后返回三项和规范当前链接', async () => {
  const env = fixture(); env.state.snippets.push({ source: 'jobHeader', text: '联系 synthetic@example.test 13800000000 Bearer private-token' });
  const preview = await env.service.prepare(env.session); assert.equal(env.state.calls.length, 0); assert.equal(preview.recipient.model, 'synthetic-model');
  assert.equal(preview.payload.siteOrigin, 'https://jobs.example.test'); assert.equal(Object.hasOwn(preview.payload, 'jobUrl'), false); assert.ok(!JSON.stringify(preview.payload).includes('/job/123'));
  for (const secret of ['private-link-token', 'synthetic@example.test', '13800000000', 'Bearer private-token', 'sk-synthetic-job-only']) assert.ok(!JSON.stringify(preview).includes(secret));
  const result = await env.service.recognize(env.session, { token: preview.token, confirmed: true });
  assert.equal(result.suggestion.companyName, '合成科技'); assert.equal(result.suggestion.jobTitle, '合成开发工程师'); assert.equal(result.suggestion.location, '合成甲城'); assert.equal(result.suggestion.jobUrl, 'https://jobs.example.test/job/123');
  assert.equal(env.state.calls.length, 1); assert.ok(env.state.calls[0].expectedContext); assert.equal(env.state.calls[0].timeoutMs, 30000);
  await assert.rejects(env.service.recognize(env.session, { token: preview.token, confirmed: true }), /预览/);
});

test('岗位 AI 必须明确确认且令牌绑定当前卡片，伪造和重放不调用模型', async () => {
  const env = fixture(); const preview = await env.service.prepare(env.session);
  for (const message of [{ token: preview.token }, { token: 'forged', confirmed: true }]) await assert.rejects(env.service.recognize(env.session, message), /预览/);
  await assert.rejects(env.service.recognize({ ...env.session, token: 'other-panel' }, { token: preview.token, confirmed: true }), /预览/); assert.equal(env.state.calls.length, 0);
  env.service.invalidate(env.session.tabId); await assert.rejects(env.service.recognize(env.session, { token: preview.token, confirmed: true }), /预览/);
});

test('岗位 AI 拒绝过期预览及发送前后的页面、文档或配置变化', async () => {
  for (const change of ['url', 'documentId', 'open', 'model', 'key', 'expired']) {
    const env = fixture(); const preview = await env.service.prepare(env.session);
    if (change === 'url') env.state.url += '&changed=1'; else if (change === 'documentId') env.state.documentId = 'new-document'; else if (change === 'open') env.state.open = false;
    else if (change === 'model') env.state.settings.model = 'changed-model'; else if (change === 'key') env.state.settings.apiKeys.deepseek = 'changed-key';
    // 固定此模块的时钟验证有效期，不修改其他测试的 Date。
    else { const future = Date.now() + 300001; env.context.Date = class extends Date { static now() { return future; } }; }
    await assert.rejects(env.service.recognize(env.session, { token: preview.token, confirmed: true })); assert.equal(env.state.calls.length, 0);
  }
  for (const change of ['url', 'documentId', 'key']) {
    const env = fixture(); env.state.work = async () => { if (change === 'key') env.state.settings.apiKeys.deepseek = 'changed-key'; else env.state[change] += '-changed'; return { content: goodReply() }; };
    await assert.rejects(recognize(env)); assert.equal(env.state.calls.length, 1);
  }
});

test('岗位 AI 缺少地点返回 null，不编造内容或清空已有字段', async () => {
  const env = fixture(); env.state.reply = goodReply({ location: { value: null, evidence: null } });
  const result = await recognize(env); assert.equal(Object.hasOwn(result.suggestion, 'location'), false); assert.equal(result.suggestion.companyName, '合成科技');
  env.state.reply = goodReply(Object.fromEntries(['companyName', 'jobTitle', 'location'].map((key) => [key, { value: null, evidence: null }]))); await assert.rejects(recognize(env), /未能确定/);
});

test('岗位 AI 拒绝错误 JSON、额外脚本/链接、错误类型及无原文依据的建议', async () => {
  const env = fixture(); const input = (await env.service.prepare(env.session)).payload;
  for (const reply of ['', 'not json', '{}', '[]', goodReply({ script: 'globalThis.executed=true' }), goodReply({ jobUrl: 'https://evil.example.test' }),
    goodReply({ companyName: { value: '虚构公司', evidence: '合成科技' } }), goodReply({ location: { value: '合成甲城', evidence: '不存在的原文合成甲城' } }),
    goodReply({ location: { value: 5, evidence: '5' } }), goodReply({ location: { value: null, evidence: '工作地点' } })]) assert.throws(() => env.contract.validate(reply, input));
  assert.equal(env.context.executed, undefined); assert.match(env.contract.messages(input)[0].content, /不可信数据/);
});

test('岗位 AI 缺少模型/Key 或空上下文仍可回退手填，失败不残留发送令牌', async () => {
  for (const change of ['model', 'key', 'snippets']) {
    const env = fixture(); if (change === 'model') env.state.settings.model = ''; else if (change === 'key') env.state.settings.apiKeys = {}; else env.state.snippets = [];
    await assert.rejects(env.service.prepare(env.session)); assert.equal(env.state.calls.length, 0);
  }
});

test('岗位 AI 超时或限流释放旧令牌，可重新预览后继续识别', async () => {
  for (const reason of ['AI 请求超时', '调用频率受限（429）']) {
    const env = fixture(); env.state.work = async () => { throw new Error(reason); }; await assert.rejects(recognize(env), new RegExp(reason.replace(/[（）]/g, '.')));
    env.state.work = null; assert.equal((await recognize(env)).suggestion.jobTitle, '合成开发工程师');
  }
});

test('岗位 AI 运行中取消会中止信号，晚到回复不成为候选且可以重试', async () => {
  const env = fixture(); let release; let started; const ready = new Promise((resolve) => { started = resolve; });
  env.state.work = (request) => new Promise((resolve) => { release = () => resolve({ content: goodReply() }); started(request); });
  const pending = recognize(env); const request = await ready; env.service.invalidate(env.session.tabId); assert.equal(request.signal.aborted, true); release(); await assert.rejects(pending, /取消/);
  env.state.work = null; assert.equal((await recognize(env)).suggestion.companyName, '合成科技');
});
