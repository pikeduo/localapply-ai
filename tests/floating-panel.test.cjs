// 卡片授权与诊断契约只使用合成数据，禁止读写用户浏览器资料。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 以真实模块和内存存储检查持久化边界，所有时间/网址均为测试值。
function fixture() {
  const disk = {}; let url = 'https://jobs.example.test/apply?private=synthetic'; let doc = 'document.one'; let open = false;
  const storage = { get: async (key) => ({ [key]: structuredClone(disk[key]) }), set: async (value) => Object.assign(disk, structuredClone(value)) };
  const browser = { storage: { session: storage }, runtime: { id: 'synthetic-extension', getURL: (page) => 'chrome-extension://synthetic-extension/' + page },
    tabs: { get: async () => ({ url }), sendMessage: async (id, message) => { if (message.type === 'wsa:floatingProbe') return { ok: true, open, documentId: doc };
      if (message.type === 'wsa:floatingOpen') { open = true; return { ok: true }; } if (message.type === 'wsa:floatingClose') open = false; return { ok: true }; } } };
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, Date });
  for (const file of ['diagnostics','floating-panel']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../data',file + '.js'),'utf8'), context);
  const diagnostics = context.LocalApplyDiagnostics.create(storage);
  const manager = context.LocalApplyFloatingPanel.create(browser, diagnostics);
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('panel/panel.html'), tab: { id: 1 }, frameId: 4 };
  return { disk, diagnostics, manager, sender, browser, context, navigate: () => { url += '&new=1'; }, reload: () => { doc = 'document.two'; open = false; }, token: () => disk['localapply.panelSessions'][0].token };
}

// 诊断白名单不接受任意请求字段、Key、个人值、网页地址或外部错误正文。
test('诊断仅记录白名单与安全错误分类，保留上限且可清空', async () => {
  const env = fixture(); const secret = 'sk-synthetic-private'; const error = new Error('HTTP 502 ' + secret + ' synthetic@example.test');
  error.stack = 'Error: ' + secret + '\n at call (chrome-extension://synthetic-extension/data/ai-client.js:63:4)';
  await env.diagnostics.append('wsa.aiChat', { level: 'ERROR', error, payload: secret, value: secret, url: 'https://example.test/private', durationMs: 123 });
  const result = await env.diagnostics.read(); assert.equal(result.rows[0].httpStatus, 502); assert.equal(result.rows[0].file, 'data/ai-client.js');
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('example.test'));
  for (let i = 0; i < 405; i++) await env.diagnostics.append('page.presence', { count: i, kind: 'application' });
  assert.equal((await env.diagnostics.read()).rows.length, 400);
  const restarted = env.context.LocalApplyDiagnostics.create(env.browser.storage.session); assert.equal((await restarted.read()).rows.length, 400);
  env.disk['localapply.diagnostics'][0].at = '2000-01-01T00:00:00.000Z'; assert.equal((await restarted.read()).rows.length, 399);
  await env.diagnostics.clear(); assert.equal((await env.diagnostics.read()).rows.length, 0);
});

// 私有页面不能凭地址提升权限，必须与用户打开的文档会话相符。
test('悬浮卡片令牌绑定标签/URL/文档/有效期，后台重建可恢复且关闭撤销', async () => {
  const env = fixture(); assert.equal(await env.manager.authorize(env.sender, { panelToken: 'forged' }), null);
  await env.manager.open(1); const panelToken = env.token(); assert.ok(await env.manager.authorize(env.sender, { panelToken }));
  for (const changed of [{ tab: { id: 2 } }, { frameId: 0 }, { url: 'https://jobs.example.test' }, { id: 'other-extension' }]) assert.equal(await env.manager.authorize({ ...env.sender, ...changed }, { panelToken }), null);
  const restored = env.context.LocalApplyFloatingPanel.create(env.browser, env.diagnostics); assert.ok(await restored.authorize(env.sender, { panelToken }));
  await restored.close(1); assert.equal(await restored.authorize(env.sender, { panelToken }), null);
  await env.manager.open(1); const second = env.token(); env.reload(); assert.equal(await env.manager.authorize(env.sender, { panelToken: second }), null);
  await env.manager.open(1); env.navigate(); assert.equal(await env.manager.authorize(env.sender, { panelToken: env.token() }), null);
  const expired = fixture(); await expired.manager.open(1); const oldToken = expired.token(); expired.disk['localapply.panelSessions'][0].createdAt = Date.now() - 1800001;
  const afterExpiry = expired.context.LocalApplyFloatingPanel.create(expired.browser, expired.diagnostics); assert.equal(await afterExpiry.authorize(expired.sender, { panelToken: oldToken }), null);
  // 日志存储异常时，已经授权的卡片打开和关闭仍须正常工作。
  const unavailable = fixture(); unavailable.diagnostics.append = async () => { throw new Error('合成日志写入失败'); };
  await unavailable.manager.open(1); await unavailable.manager.close(1);
});
