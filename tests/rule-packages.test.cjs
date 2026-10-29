// 离线包只用合成公共定义及虚构个人库，不访问网络、第三方代码或真实凭据。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');

// 加载真实定义白名单与v5校验，不用另造宽松Schema代替生产边界。
function fixture() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, URL, TextEncoder, TextDecoder, btoa, atob });
  for (const name of ['templates', 'key-vault', 'resume', 'resume-catalog', 'field-matching', 'applications', 'local-store', 'rule-packages']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/' + name + '.js'), 'utf8'), context);
  const db = context.LocalApplyStore.migrate(context.WangshenTemplates.defaultState()).db;
  return { context, P: context.LocalApplyRulePackages, db };
}

// 包源是独立人工审核的公共定义，不包含个人值或接口配置。
function definition(version = 1) { return { fieldId: 'public.synthetic', label: '合成附加字段', type: 'text', group: '其他', aliases: ['附加字段'], options: [], description: '', version }; }
// 版本和来源只供离线审计，不触发来源URL的请求。
function input(fields = [definition()], release = 1) { return { kind: 'localapply-rule-package', formatVersion: 1, packageId: 'localapply.synthetic', release,
  compatibility: { minSchema: 5, maxSchema: 5, fillContract: 1 }, source: { name: '合成审核包', reference: 'https://example.test/public-rules' }, fields }; }

// 持久化桩按一次批量写入更新并发出真实前后值通知，失败不公布新副本。
async function repositoryFixture() {
  const env = fixture(); const disk = {}; const listeners = new Set(); let fail = false;
  const storage = { get: async (names) => structuredClone(Object.fromEntries([names].flat().map((key) => [key, disk[key]]))),
    setAccessLevel: async () => {}, set: async (values) => {
      if (fail && Object.hasOwn(values, 'localapply.database')) { fail = false; throw new Error('QUOTA_BYTES 合成失败'); }
      const changes = {};
      for (const [key, value] of Object.entries(values)) if (JSON.stringify(disk[key]) !== JSON.stringify(value)) changes[key] = { oldValue: structuredClone(disk[key]), newValue: structuredClone(value) };
      Object.assign(disk, structuredClone(values)); for (const listener of listeners) listener(changes, 'local');
    } };
  const repo = env.context.LocalApplyStore.createRepository(storage, { cache: true, changes: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) } });
  await repo.read();
  return { ...env, repo, disk, storage, fail: () => { fail = true; } };
}

test('离线规则包：摘要、未知格式、个人属性、兼容范围及重复ID完整校验', async () => {
  const { P, db } = fixture(); const pack = await P.create(input()); assert.equal((await P.parse(pack)).sha256, pack.sha256);
  const changed = structuredClone(pack); changed.fields[0].label = '被篡改'; await assert.rejects(P.parse(changed), /摘要不符/);
  await assert.rejects(P.parse({ ...pack, rawHtml: '<input>' }), /格式错误/);
  await assert.rejects(P.create(input([{ ...definition(), value: '不得发送的合成值' }])), /字段定义/);
  await assert.rejects(P.create(input([definition(), definition()])), /重复/);
  const incompatible = input(); incompatible.compatibility.minSchema = 6; incompatible.compatibility.maxSchema = 6;
  await assert.rejects(P.preview(await P.create(incompatible), db), /不兼容/);
  const unknown = input(); unknown.formatVersion = 2; await assert.rejects(P.create(unknown), /格式错误/);
});

test('离线规则包：摘要不受对象键顺序影响，安装预览不改个人库', async () => {
  const { P, db } = fixture(); const source = input(); const other = structuredClone(source); other.fields[0] = Object.fromEntries(Object.entries(other.fields[0]).reverse());
  const pack = await P.create(source); assert.equal((await P.create(other)).sha256, pack.sha256);
  const before = JSON.stringify(db); const preview = await P.preview(pack, db); assert.equal(preview.changes.length, 1); assert.equal(preview.revision, db.revision);
  assert.equal(JSON.stringify(db), before); assert.equal(preview.changes[0].before, null); assert.equal(preview.conflicts.length, 0);
});

test('离线规则包：私有ID、类型/分类/标签改义及字段版本冲突只展示不执行', async () => {
  const { P, db } = fixture(); db.fieldDefinitions.push(definition());
  let preview = await P.preview(await P.create(input([definition(2)])), db); assert.equal(preview.conflicts[0].reason, 'private_id');
  db.publicFieldIds.push('public.synthetic');
  for (const change of [{ type: 'textarea' }, { group: '工作经历' }, { label: '另一语义' }]) {
    preview = await P.preview(await P.create(input([{ ...definition(2), ...change }])), db); assert.equal(preview.conflicts[0].reason, 'semantic_change');
  }
  preview = await P.preview(await P.create(input([{ ...definition(), aliases: ['新别名'] }])), db); assert.equal(preview.conflicts[0].reason, 'field_version');
});

test('离线规则包：版本回执、同版本内容冲突、降级和记录漂移不会静默覆盖', async () => {
  const { P, db } = fixture(); const pack = await P.create(input()); const plan = await P.preview(pack, db);
  db.fieldDefinitions.push(definition()); db.publicFieldIds.push('public.synthetic');
  const registry = P.installed(plan, db); assert.equal((await P.preview(pack, db, registry)).alreadyInstalled, true);
  await assert.rejects(P.preview(await P.create(input([{ ...definition(), aliases: ['其他'] }])), db, registry), /同版本内容冲突/);
  const higher = await P.create(input([definition()], 2)); const next = P.installed(await P.preview(higher, db, registry), db, registry);
  await assert.rejects(P.preview(pack, db, next), /版本倒退/);
  db.fieldDefinitions.find((def) => def.fieldId === 'public.synthetic').aliases.push('用户后改');
  await assert.rejects(P.preview(pack, db, registry), /已安装字段发生变化/);
});

test('离线规则包：新字段已有0/false/文字、映射或新增绑定均不能删除回滚', async () => {
  const { P, db } = fixture(); const plan = await P.preview(await P.create(input()), db);
  db.fieldDefinitions.push(definition()); db.publicFieldIds.push('public.synthetic');
  const receipt = P.installed(plan, db); const before = JSON.stringify(db);
  assert.equal(P.rollback(db, receipt, 'localapply.synthetic').conflicts.length, 0);
  for (const value of [0, false, '合成保留内容']) {
    db.fieldValues.push({ fieldId: 'public.synthetic', value }); assert.equal(P.rollback(db, receipt, 'localapply.synthetic').conflicts[0].reason, 'has_values'); db.fieldValues.pop();
  }
  db.mappingRules.push({ fieldId: 'public.synthetic' }); assert.equal(P.rollback(db, receipt, 'localapply.synthetic').conflicts[0].reason, 'has_mappings'); db.mappingRules.pop();
  db.bindings.push({ fieldId: 'public.synthetic', fid: 'later' }); assert.equal(P.rollback(db, receipt, 'localapply.synthetic').conflicts[0].reason, 'bindings_changed'); db.bindings.pop();
  assert.equal(JSON.stringify(db), before);
});

test('离线规则包：更新已有字段只回退元数据，安装后改过定义则阻断', async () => {
  const { P, db } = fixture(); db.fieldDefinitions.push(definition()); db.publicFieldIds.push('public.synthetic');
  const next = { ...definition(2), aliases: ['新增明确别名'] }; const plan = await P.preview(await P.create(input([next])), db);
  db.fieldDefinitions[db.fieldDefinitions.length - 1] = next; const receipt = P.installed(plan, db);
  db.fieldValues.push({ fieldId: 'public.synthetic', value: '之后填写的合成资料' });
  const rollback = P.rollback(db, receipt, 'localapply.synthetic'); assert.equal(rollback.conflicts.length, 0); assert.equal(rollback.changes[0].before.version, 1);
  next.aliases.push('用户后改'); assert.equal(P.rollback(db, receipt, 'localapply.synthetic').conflicts[0].reason, 'metadata_changed');
});

test('离线规则包：其他已安装包依赖同字段时，不删除或降级共享元数据', async () => {
  const { P, db } = fixture(); const pack = await P.create(input()); const plan = await P.preview(pack, db); db.fieldDefinitions.push(definition()); db.publicFieldIds.push('public.synthetic');
  const installed = P.installed(plan, db); const other = input(); other.packageId = 'localapply.another'; const next = P.installed(await P.preview(await P.create(other), db, installed), db, installed);
  assert.equal(P.rollback(db, next, 'localapply.synthetic').conflicts[0].reason, 'other_package');
});

test('离线包仓库：预览与确认分离、revision绑定、回执与恢复点持久化，安全回滚不动其他资料', async () => {
  const env = await repositoryFixture(); const { P, repo, disk } = env; const pack = await P.create(input()); const before = await repo.read();
  const preview = await repo.command({ action: 'previewRulePackage', payload: { package: pack } }); assert.equal((await repo.read()).revision, before.revision);
  const request = { action: 'installRulePackage', expectedRevision: preview.revision, payload: { package: pack, confirmed: true } };
  await assert.rejects(repo.command({ ...request, payload: { package: pack } }), /明确确认/);
  await assert.rejects(repo.command({ ...request, expectedRevision: -1 }), /数据版本/);
  const apiBefore = JSON.stringify(disk['localapply.apiSettings']); await repo.command(request); const installed = await repo.read();
  assert.equal(installed.schemaVersion, 5); assert.ok(installed.fieldDefinitions.some((def) => def.fieldId === 'public.synthetic'));
  assert.equal(JSON.stringify(disk['localapply.recovery']), JSON.stringify(before)); assert.equal(JSON.stringify(disk['localapply.apiSettings']), apiBefore);
  assert.equal((await repo.command({ action: 'listRulePackages' })).result[0].canRollback, true);
  assert.equal((await repo.command({ ...request, expectedRevision: installed.revision })).result.alreadyInstalled, true);
  assert.equal((await repo.read()).revision, installed.revision);
  const rollback = await repo.command({ action: 'previewRuleRollback', payload: { packageId: pack.packageId } });
  await repo.command({ action: 'rollbackRulePackage', expectedRevision: rollback.revision, payload: { packageId: pack.packageId, confirmed: true } });
  const after = await repo.read(); after.revision = before.revision; assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal((await repo.command({ action: 'listRulePackages' })).result.length, 0);
});

test('离线包仓库：写盘失败不发布新快照，已有值阻止删除回滚；备份仍保持v5兼容', async () => {
  const env = await repositoryFixture(); const { P, repo } = env; const pack = await P.create(input()); const before = await repo.read();
  env.fail(); await assert.rejects(repo.command({ action: 'installRulePackage', expectedRevision: before.revision, payload: { package: pack, confirmed: true } }), /存储配额/);
  assert.equal(JSON.stringify(await repo.read()), JSON.stringify(before)); assert.equal(env.disk[P.KEY], undefined);
  await repo.command({ action: 'installRulePackage', expectedRevision: before.revision, payload: { package: pack, confirmed: true } });
  await repo.command({ action: 'setValue', payload: { profileId: before.activeProfileId, fieldId: 'public.synthetic', value: '合成必须保留的值' } });
  const current = await repo.read(); const preview = await repo.command({ action: 'previewRuleRollback', payload: { packageId: pack.packageId } }); assert.equal(preview.result.conflicts[0].reason, 'has_values');
  await assert.rejects(repo.command({ action: 'rollbackRulePackage', expectedRevision: current.revision, payload: { packageId: pack.packageId, confirmed: true } }), /已有资料引用/);
  const backup = await repo.exportBackup(); assert.equal(backup.schemaVersion, 5); assert.ok(!JSON.stringify(backup).includes('rulePackages'));
  assert.equal(JSON.stringify(await repo.read()), JSON.stringify(current));
});

test('离线包仓库：已有定义更新不重建移除的绑定，外部回执更改使缓存失效', async () => {
  const env = await repositoryFixture(); const { repo, P, storage } = env; const db = await repo.read(); const original = db.fieldDefinitions.find((def) => def.fieldId === 'builtin.workExperience');
  db.bindings = db.bindings.filter((binding) => binding.fieldId !== original.fieldId); db.fieldValues = db.fieldValues.filter((row) => row.fieldId !== original.fieldId);
  await storage.set({ 'localapply.database': db });
  const pack = await P.create(input([{ ...original, aliases: [...original.aliases, '合成新明确别名'], version: original.version + 1 }]));
  const preview = await repo.command({ action: 'previewRulePackage', payload: { package: pack } });
  await repo.command({ action: 'installRulePackage', expectedRevision: preview.revision, payload: { package: pack, confirmed: true } });
  assert.ok(!(await repo.read()).bindings.some((row) => row.fieldId === original.fieldId));
  await storage.set({ [P.KEY]: { version: 1, packages: [] } });
  assert.equal((await repo.command({ action: 'listRulePackages' })).result.length, 0);
});

// 随发行包附带的自主词典包必须能从仓库确定性重建，不能混入任何档案或凭据。
test('随附公共别名包可重复生成，字段版本与运行模板一致', async () => {
  const { P } = fixture(); const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rule-packs/core-aliases-v1.json'), 'utf8'));
  const built = await require('../tools/build-rule-package.cjs').build(); assert.equal(JSON.stringify(saved), JSON.stringify(built));
  await P.parse(saved); assert.equal(saved.fields.length, 2); assert.ok(saved.fields.every((def) => def.version === 2));
  assert.ok(!JSON.stringify(saved).includes('profileId') && !JSON.stringify(saved).includes('apiKeys'));
});

// 回退封闭多选选项也须通过现有个人值校验，不能删掉安装后合法填写的答案。
test('离线包仓库：旧选项不兼容新个人值时回滚失败且库/回执保持原样', async () => {
  const env = await repositoryFixture(); const { P, repo } = env; const first = { ...definition(), type: 'multiSelect', options: ['合成甲'] };
  let db = await repo.read(); await repo.command({ action: 'installRulePackage', expectedRevision: db.revision, payload: { package: await P.create(input([first])), confirmed: true } });
  db = await repo.read(); const second = { ...first, version: 2, options: ['合成甲', '合成乙'] };
  await repo.command({ action: 'installRulePackage', expectedRevision: db.revision, payload: { package: await P.create(input([second], 2)), confirmed: true } });
  await repo.command({ action: 'setValue', payload: { profileId: db.activeProfileId, fieldId: first.fieldId, value: ['合成乙'] } });
  const before = await repo.read(); const receipts = JSON.stringify(env.disk[P.KEY]);
  await assert.rejects(repo.command({ action: 'rollbackRulePackage', expectedRevision: before.revision, payload: { packageId: 'localapply.synthetic', confirmed: true } }), /选项内/);
  assert.equal(JSON.stringify(await repo.read()), JSON.stringify(before)); assert.equal(JSON.stringify(env.disk[P.KEY]), receipts);
});
