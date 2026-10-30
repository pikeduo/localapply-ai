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
    tabs: { get: async () => ({ url, active: true }), sendMessage: async (id, message) => { if (message.type === 'wsa:floatingProbe') return { ok: true, open, documentId: doc };
      if (message.type === 'wsa:floatingOpen') { open = true; return { ok: true }; } if (message.type === 'wsa:floatingClose') open = false; return { ok: true }; } } };
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, Date });
  for (const file of ['fill-result','diagnostics','floating-panel']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../data',file + '.js'),'utf8'), context);
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

// 相同顶层文档的加载通知不能撤销卡片；真实导航、重载仍撤销旧令牌。
test('卡片加载通知核对真实文档，不因同页通知或后台重建失去权限', async () => {
  const env = fixture(); assert.equal(await env.manager.reconcile(1), null);
  await env.manager.open(1); const panelToken = env.token();
  assert.equal(await env.manager.reconcile(1), false); assert.ok(await env.manager.authorize(env.sender, { panelToken }));
  const restored = env.context.LocalApplyFloatingPanel.create(env.browser, env.diagnostics);
  assert.equal(await restored.reconcile(1), false); assert.ok(await restored.authorize(env.sender, { panelToken }));
  env.navigate(); assert.equal(await restored.reconcile(1), true); assert.equal(await restored.authorize(env.sender, { panelToken }), null);
  const reloaded = fixture(); await reloaded.manager.open(1); const old = reloaded.token(); reloaded.reload();
  assert.equal(await reloaded.manager.reconcile(1), true); assert.equal(await reloaded.manager.authorize(reloaded.sender, { panelToken: old }), null);
});

// 过期并不等于可以放开权限：续期仍须原令牌、原文档、原iframe及活动标签。
test('过期卡片可在同一活动文档续期，轮换令牌且拒绝伪造和导航恢复', async () => {
  const env = fixture(); await env.manager.open(1); const oldToken = env.token();
  env.disk['localapply.panelSessions'][0].createdAt = Date.now() - 1800001;
  let cancelled = 0; const manager = env.context.LocalApplyFloatingPanel.create(env.browser, env.diagnostics, () => { cancelled++; });
  assert.equal(await manager.authorize(env.sender, { panelToken: oldToken }), null);
  await assert.rejects(manager.reconnect(env.sender, { panelToken: 'forged' }));
  await assert.rejects(manager.reconnect({ ...env.sender, frameId: 0 }, { panelToken: oldToken }));
  const get = env.browser.tabs.get; env.browser.tabs.get = async () => ({ ...await get(), active: false });
  await assert.rejects(manager.reconnect(env.sender, { panelToken: oldToken })); env.browser.tabs.get = get;
  const renewed = await manager.reconnect(env.sender, { panelToken: oldToken }); assert.notEqual(renewed.token, oldToken);
  assert.equal(cancelled, 1);
  assert.ok(await manager.authorize(env.sender, { panelToken: renewed.token })); assert.equal(await manager.authorize(env.sender, { panelToken: oldToken }), null);
  env.navigate(); await assert.rejects(manager.reconnect(env.sender, { panelToken: renewed.token }));
  await manager.invalidate(1); await assert.rejects(manager.reconnect(env.sender, { panelToken: renewed.token }));
});

// 控件诊断只能带固定原因和数量，恶意或含个人资料的附加属性必须丢弃。
test('下拉诊断保留阶段和精确候选统计，拒绝任意文字与个人内容', async () => {
  const env = fixture(); const secret = 'sk-synthetic-dropdown-private';
  const detail = { adapter: 'moka-dropdown', phase: 'options', status: 'unsupported', reasonCode: 'no_exact_option', candidateCount: 4, matchCount: 0,
    associatedPopup: true, searchable: false, fieldNumber: 7, popupRelation: 'portal', message: secret, value: secret, label: secret, options: [secret], url: secret, token: secret, selector: secret };
  await env.diagnostics.append('learning.fill', { fill: detail, unsupported: 1, needsConfirmation: 2 });
  const report = await env.diagnostics.read(); const row = report.rows[0];
  assert.equal(report.version, 2); assert.equal(report.storage.area, 'chrome.storage.local'); assert.equal(report.storage.key, 'localapply.diagnostics'); assert.equal(report.storage.maxRows, 400); assert.equal(report.storage.retentionDays, 7);
  assert.equal(row.fill.reasonCode, 'no_exact_option'); assert.equal(row.fill.candidateCount, 4); assert.equal(row.fill.fieldNumber, 7); assert.equal(row.fill.associatedPopup, true); assert.equal(row.unsupported, 1); assert.equal(row.needsConfirmation, 2);
  assert.ok(!JSON.stringify(report).includes(secret));
  for (const reasonCode of ['popup_not_found','options_not_found','ambiguous_option','value_not_accepted','existing_value_preserved']) {
    const result = env.context.LocalApplyDiagnostics.fillInfo({ ...detail, reasonCode }); assert.equal(result.reasonCode, reasonCode); assert.notEqual(result.message, row.fill.message);
  }
  const invalid = env.context.LocalApplyDiagnostics.fillInfo({ adapter: secret, phase: secret, reasonCode: secret, candidateCount: -1, matchCount: '2', focused: secret }); assert.equal(invalid, null);
  await env.diagnostics.append('runtime.request', { fill: detail }); assert.equal((await env.diagnostics.read()).rows.at(-1).fill, undefined);
});

// 写入故障不得伪报已持久化；已有记录仍可导出，存储恢复后继续串行写入。
test('诊断写入失败可见且恢复后继续保存，不影响其他本地数据', async () => {
  const env = fixture(); const storage = env.browser.storage.session; const save = storage.set; const logger = env.diagnostics;
  await logger.append('learning.scanPage', { count: 1 }); env.disk.privateSyntheticData = 'keep';
  storage.set = async () => { throw new Error('合成磁盘写入失败'); };
  await assert.rejects(logger.append('learning.fill', { fill: { status: 'failed', reasonCode: 'value_not_accepted' } }));
  const failed = await logger.read(); assert.equal(failed.storage.lastWriteFailed, true); assert.equal(failed.rows.length, 1);
  await assert.rejects(logger.clear()); assert.equal((await logger.read()).rows.length, 1);
  storage.set = save; await logger.append('learning.fill', { fill: { status: 'success', reasonCode: 'verified' } });
  assert.equal((await logger.read()).storage.lastWriteFailed, false); assert.equal((await logger.read()).rows.length, 2); assert.equal(env.disk.privateSyntheticData, 'keep');
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
