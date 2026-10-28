// 缓存/持久化契约：真实生产仓库、合成存储介质、可控通知与故障；不使用个人资料。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { modules } = require('../tools/storage-benchmark.cjs');
// 模拟 Chrome 的前后值通知及持久化完成点；默认立即通知，也可延迟送达。
function fixture(initial = {}, cache = true) {
  const context = modules(); const disk = structuredClone(initial); const listeners = new Set(); const delayed = []; const io = { reads: 0, writes: 0 };
  let failure = false; let defer = false; let gate = null; let onGet = null;
  // 外部和仓库共用真实的写入/通知顺序，不能通过替换仓库方法伪造成功。
  async function set(values) {
    if (failure) { failure = false; throw new Error('QUOTA_BYTES 合成配额异常'); }
    if (gate) { const wait = gate; gate = null; await wait; }
    const changes = {};
    for (const [key, value] of Object.entries(values)) if (JSON.stringify(disk[key]) !== JSON.stringify(value)) changes[key] = { oldValue: structuredClone(disk[key]), newValue: structuredClone(value) };
    Object.assign(disk, structuredClone(values));
    if (Object.hasOwn(values, 'localapply.database')) io.writes++;
    const notify = () => { for (const listener of listeners) listener(changes, 'local'); };
    if (defer) delayed.push(notify); else notify();
  }
  const storage = { QUOTA_BYTES: 1024 * 1024,
    // 读取结果在异步挂钩前固定，用于复现读取期间发生外部变化的竞态。
    async get(keys) { if ([keys].flat().includes('localapply.database')) io.reads++; const result = structuredClone(Object.fromEntries([keys].flat().map((key) => [key, disk[key]]))); if (onGet) { const callback = onGet; onGet = null; await callback(); } return result; },
    set, setAccessLevel: async () => {}, getBytesInUse: async (keys) => Buffer.byteLength(JSON.stringify(keys === null ? disk : Object.fromEntries([keys].flat().map((key) => [key, disk[key]])))) };
  const changes = { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) };
  const create = (enabled = cache) => context.LocalApplyStore.createRepository(storage, { cache: enabled, changes });
  return { repo: create(), create, disk, context, storage, io, external: set, fail: () => { failure = true; }, defer: (value) => { defer = value; }, flush: () => { delayed.splice(0).forEach((notify) => notify()); }, gate: (promise) => { gate = promise; }, duringRead: (callback) => { onGet = callback; } };
}
// 写入确定的合成姓名，允许复核串行队列与期望版本。
function write(repo, profileId, value, expectedRevision) { return repo.command({ action: 'setValue', expectedRevision, payload: { profileId, fieldId: 'builtin.name', value } }); }
// 精确读取单档案的个人值，不跨条目借值。
function name(db, profileId = db.activeProfileId) { return db.fieldValues.find((row) => row.profileId === profileId && row.fieldId === 'builtin.name' && row.entryId === null)?.value; }

test('C01/C02/C03 首次并发加载合并，重复读取命中且返回副本', async () => {
  const env = fixture(); const results = await Promise.all(Array.from({ length: 12 }, () => env.repo.read()));
  assert.ok(results.every((db) => db.schemaVersion === 5)); assert.equal(env.io.writes, 1); assert.equal(env.io.reads, 2); // 初始化含一次写后读回。
  const before = env.io.reads; results[0].profiles[0].name = '不得进入缓存'; await env.repo.read(); await env.repo.readContentSettings(); await env.repo.readLegacy();
  assert.equal(env.io.reads, before); assert.notEqual((await env.repo.read()).profiles[0].name, '不得进入缓存'); assert.ok((await env.repo.storageStatus()).hits >= 14);
});
test('C04/C05/C06 持久化完成才响应，失败可重试，旧 revision 拒绝', async () => {
  const env = fixture(); const db = await env.repo.read(); let release; const gate = new Promise((resolve) => { release = resolve; }); env.gate(gate);
  let complete = false; const saving = write(env.repo, db.activeProfileId, '合成已保存', db.revision).then(() => { complete = true; });
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(complete, false); assert.notEqual(name(env.disk['localapply.database']), '合成已保存'); release(); await saving;
  const latest = await env.repo.read(); assert.equal(name(latest), '合成已保存'); assert.equal(latest.revision, db.revision + 1);
  const parallel = await Promise.allSettled([write(env.repo, db.activeProfileId, '合成并发甲', latest.revision), write(env.repo, db.activeProfileId, '合成并发乙', latest.revision)]);
  assert.equal(parallel[0].status, 'fulfilled'); assert.equal(parallel[1].status, 'rejected');
  env.fail(); await assert.rejects(write(env.repo, db.activeProfileId, '不得保存'), /配额不足/); assert.equal((await env.repo.storageStatus()).valid, false);
  assert.equal(name(await env.repo.read()), '合成并发甲'); await write(env.repo, db.activeProfileId, '合成重试'); assert.equal(name(await env.repo.read()), '合成重试');
});
test('C07/C08 外部同 revision 更新失效，延迟自身通知不回退，不能误认外部回滚', async () => {
  const env = fixture(); const first = await env.repo.read(); env.defer(true); await write(env.repo, first.activeProfileId, '合成甲'); await write(env.repo, first.activeProfileId, '合成乙');
  const before = env.io.reads; env.flush(); await env.repo.read(); assert.equal(env.io.reads, before); assert.equal((await env.repo.storageStatus()).invalidations, 0);
  env.defer(false); const external = structuredClone(env.disk['localapply.database']); external.profiles[0].name = '外部同版本修改';
  await env.external({ 'localapply.database': external }); assert.equal((await env.repo.read()).profiles[0].name, '外部同版本修改'); assert.equal(env.io.reads, before + 1);
  await env.external({ 'localapply.database': first }); assert.equal(name(await env.repo.read()), name(first)); assert.equal((await env.repo.storageStatus()).invalidations, 2);
});
test('C08 Chrome 重排对象键的自身通知仍命中，不依赖属性插入顺序', async () => {
  const env = fixture(); await env.repo.read();
  // 重排通知中的全部对象键，但不更改任何值；与 Chrome 实际序列化行为一致。
  const original = env.storage.set;
  env.storage.set = async (values) => { const encoded = JSON.stringify(values, (_key, row) => row && !Array.isArray(row) && typeof row === 'object' ? Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])) : row); await original(JSON.parse(encoded)); };
  const db = await env.repo.read(); await write(env.repo, db.activeProfileId, '合成键顺序'); const before = env.io.reads; assert.equal(name(await env.repo.read()), '合成键顺序'); assert.equal(env.io.reads, before); assert.equal((await env.repo.storageStatus()).invalidations, 0);
});
test('C07 读取中发生外部变化会重读；恢复点等待期间变化拒绝覆盖', async () => {
  const env = fixture(); const initial = await env.repo.read();
  const external = structuredClone(initial); external.profiles[0].name = '读取期间外部保存'; env.duringRead(() => env.external({ 'localapply.database': external }));
  assert.equal((await env.repo.read()).profiles[0].name, '读取期间外部保存');
  const backup = await env.repo.exportBackup(); let release; env.gate(new Promise((resolve) => { release = resolve; }));
  const importing = env.repo.command({ action: 'importBackup', expectedRevision: external.revision, payload: { backup, mode: 'replace' } });
  // 立即附加拒绝处理，避免故障注入产生测试宿主的未处理拒绝。
  const rejected = assert.rejects(importing, /外部变化/); await new Promise((resolve) => setTimeout(resolve, 20));
  external.profiles[0].name = '恢复点等待期间外部保存'; await env.external({ 'localapply.database': external }); release(); await rejected;
  assert.equal((await env.repo.read()).profiles[0].name, '恢复点等待期间外部保存');
});
test('C09 档案隔离及多选投影没有可修改的缓存引用', async () => {
  const env = fixture(); const first = await env.repo.read(); await write(env.repo, first.activeProfileId, '合成档案甲');
  const created = await env.repo.command({ action: 'createProfile', payload: { name: '合成档案乙' } });
  const second = (await env.repo.read()).profiles.find((row) => row.profileId !== first.activeProfileId).profileId; assert.ok(created);
  await write(env.repo, second, '合成档案乙');
  const legacy = await env.repo.readLegacy(); assert.equal(legacy.profiles.find((p) => p.id === first.activeProfileId).fields.find((f) => f.key === 'name').value, '合成档案甲');
  assert.equal(legacy.profiles.find((p) => p.id === second).fields.find((f) => f.key === 'name').value, '合成档案乙');
  const multi = (await env.repo.read()).fieldDefinitions.find((def) => def.type === 'multiSelect' && !def.options.length);
  await env.repo.command({ action: 'setValue', payload: { profileId: second, fieldId: multi.fieldId, value: ['合成选项'] } });
  const view = await env.repo.readLegacy(); view.profiles.find((p) => p.id === second).fields.find((f) => f.label === multi.label).value.push('污染');
  assert.deepEqual(Array.from((await env.repo.read()).fieldValues.find((row) => row.profileId === second && row.fieldId === multi.fieldId).value), ['合成选项']);
  const firstContext = await env.repo.readFieldContext(first.activeProfileId); const secondContext = await env.repo.readFieldContext(second);
  assert.ok(firstContext.fieldValues.every((row) => row.profileId === first.activeProfileId)); assert.ok(secondContext.fieldValues.every((row) => row.profileId === second));
  assert.equal(name(firstContext, first.activeProfileId), '合成档案甲'); assert.equal(name(secondContext, second), '合成档案乙');
  assert.equal(secondContext.applications, undefined); const builds = (await env.repo.storageStatus()).indexBuilds;
  secondContext.fieldValues.length = 0; await env.repo.readFieldContext(second); assert.equal((await env.repo.storageStatus()).indexBuilds, builds);
  await write(env.repo, second, '合成索引更新'); assert.equal(name(await env.repo.readFieldContext(second), second), '合成索引更新'); assert.ok((await env.repo.storageStatus()).indexBuilds > builds);
});
test('C10 导入、恢复、清空及定义修改发布新快照', async () => {
  const env = fixture(); const db = await env.repo.read(); await write(env.repo, db.activeProfileId, '恢复点合成内容'); const backup = await env.repo.exportBackup();
  await write(env.repo, db.activeProfileId, '覆盖前内容'); const revision = (await env.repo.read()).revision;
  await env.repo.command({ action: 'importBackup', expectedRevision: revision, payload: { backup, mode: 'replace' } }); assert.equal(name(await env.repo.read()), '恢复点合成内容');
  await env.repo.command({ action: 'restoreRecovery', payload: {} }); assert.equal(name(await env.repo.read()), '覆盖前内容');
  const now = await env.repo.read(); await env.repo.command({ action: 'clearProfileValues', expectedRevision: now.revision, payload: { profileId: db.activeProfileId, confirmed: true } }); assert.equal(name(await env.repo.read()), null);
  await env.repo.command({ action: 'createField', payload: { profileId: db.activeProfileId, definition: { label: '合成新定义', group: '测试' }, value: '合成值' } });
  assert.ok((await env.repo.readLegacy()).profiles[0].fields.some((f) => f.label === '合成新定义'));
});
test('C11/C12 仓库释放重建读持久层，默认无缓存每次读取最新数据', async () => {
  const env = fixture(); const db = await env.repo.read(); await write(env.repo, db.activeProfileId, '重启合成内容'); env.repo.dispose();
  await assert.rejects(env.repo.read(), /已释放/); assert.equal(name(await env.create().read()), '重启合成内容');
  const uncached = env.create(false); const reads = env.io.reads; await uncached.read(); await uncached.read(); assert.equal(env.io.reads, reads + 2);
});
for (const version of [2, 3, 4]) test('C13 v' + version + ' 升级保留恢复点及兼容备份', async () => {
  const seed = fixture(); const backup = await seed.repo.exportBackup(version === 2 ? 3 : version); const old = structuredClone(backup.database);
  old.schemaVersion = version; const env = fixture({ 'localapply.database': old, 'localapply.apiSettings': seed.disk['localapply.apiSettings'], 'localapply.fieldCatalog': seed.disk['localapply.fieldCatalog'] });
  const [db] = await Promise.all([env.repo.read(), env.repo.read()]); assert.equal(db.schemaVersion, 5); assert.deepEqual(env.disk['localapply.recovery'], old); assert.equal(env.io.writes, 1);
  assert.equal((await env.repo.exportBackup(3)).database.schemaVersion, 3); assert.equal((await env.repo.exportBackup(4)).database.schemaVersion, 4);
});
test('C14 缓存不保留凭据投影，外部凭据更新仍即时生效', async () => {
  const env = fixture(); await env.repo.read(); await env.repo.vaultCommand('setKey', { providerId: 'deepseek', key: 'synthetic-cache-secret', revision: 0, localRevision: 0 });
  assert.equal((await env.repo.readAiSettings()).apiKeys.deepseek, 'synthetic-cache-secret');
  await env.create(false).vaultCommand('setKey', { providerId: 'deepseek', key: 'synthetic-updated-secret', revision: 0, localRevision: 1 });
  const diskReads = env.io.reads; assert.equal((await env.repo.readAiSettings()).apiKeys.deepseek, 'synthetic-updated-secret'); assert.equal(env.io.reads, diskReads);
  assert.ok(!JSON.stringify(await env.repo.readLegacy()).includes('synthetic-cache-secret')); assert.ok(!JSON.stringify(await env.repo.exportBackup()).includes('synthetic-cache-secret'));
  await env.repo.vaultCommand('setup', { password: 'synthetic-password-2026' }); await env.repo.vaultCommand('lock'); await assert.rejects(env.repo.vaultCommand('unlock', { password: 'wrong-password' }));
  await env.repo.vaultCommand('unlock', { password: 'synthetic-password-2026' }); assert.equal((await env.repo.readAiSettings()).apiKeys.deepseek, 'synthetic-updated-secret');
  assert.ok(!JSON.stringify(await env.repo.storageStatus()).includes('synthetic-cache-secret'));
});
test('C15 读取异常及外部损坏不会使用旧缓存或自动覆盖，修复后可重试', async () => {
  const env = fixture(); const valid = await env.repo.read(); const originalGet = env.storage.get; const before = env.io.writes;
  env.storage.get = async () => { throw new Error('合成读取失败'); }; await assert.rejects(env.repo.read(), /读取失败/); assert.equal(env.io.writes, before); env.storage.get = originalGet;
  await env.external({ 'localapply.database': null }); await assert.rejects(env.repo.read(), /版本/); assert.equal(env.io.writes, before + 1);
  await env.external({ 'localapply.database': valid }); assert.equal((await env.repo.read()).schemaVersion, 5);
});
for (const corrupt of [null, false, {}, { schemaVersion: 999 }]) test('C15 损坏数据库明确拒绝且零写入：' + JSON.stringify(corrupt), async () => {
  const env = fixture({ 'localapply.database': corrupt }); await assert.rejects(env.repo.read()); assert.equal(env.io.writes, 0); assert.deepEqual(env.disk['localapply.database'], corrupt);
});
test('C15 外部删除不能静默创建空库，字节指标提示配额但不清理', async () => {
  const env = fixture(); await env.repo.read(); const before = env.io.writes; await env.external({ 'localapply.database': undefined }); await assert.rejects(env.repo.read(), /外部移除/); assert.equal(env.io.writes, before + 1);
  const other = fixture(); await other.repo.read(); other.disk['synthetic.usage'] = 'x'.repeat(950000); const status = await other.repo.storageStatus();
  assert.equal(status.nearQuota, true); assert.ok(status.dbBytes > 0); assert.match(status.warning, /导出备份/); assert.equal(other.disk['synthetic.usage'].length, 950000);
});
test('C16 内容安全投影不含个人值、密钥或完整数据库', async () => {
  const env = fixture(); const db = await env.repo.read(); await write(env.repo, db.activeProfileId, '合成隐私值'); const safe = await env.repo.readContentSettings();
  assert.ok(!JSON.stringify(safe).includes('合成隐私值')); for (const key of ['profiles', 'fieldValues', 'apiKeys']) assert.equal(safe[key], undefined);
});
