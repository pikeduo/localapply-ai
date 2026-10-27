// 数据层契约测试：仅合成资料，模拟真实异步 Chrome Storage 与失败注入。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// 创建独立 JS 上下文与持久内存介质，可模拟后台重启和存储异常。
function fixture(initial = {}) {
  const disk = structuredClone(initial);
  const context = vm.createContext({ crypto: webcrypto, console, URL, TextEncoder, TextDecoder, btoa, atob });
  for (const name of ['data/templates.js', 'data/key-vault.js', 'data/resume.js', 'data/resume-catalog.js', 'data/field-matching.js', 'data/applications.js', 'data/local-store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  let failCountdown = null;
  const storage = {
    get: async (names) => structuredClone(Object.fromEntries((Array.isArray(names) ? names : [names]).map((name) => [name, disk[name]]))),
    set: async (value) => {
      if (failCountdown === 0) { failCountdown = null; throw new Error('模拟磁盘错误'); }
      if (failCountdown !== null) failCountdown--;
      Object.assign(disk, structuredClone(value));
    },
    setAccessLevel: async (input) => { assert.equal(input.accessLevel, 'TRUSTED_CONTEXTS'); },
  };
  const store = context.LocalApplyStore;
  return { disk, store, resume: context.LocalApplyResume, catalog: context.LocalApplyResumeCatalog, templates: context.WangshenTemplates, repo: store.createRepository(storage),
    restart: () => store.createRepository(storage), fail: (after = 0) => { failCountdown = after; } };
}

// 执行规范命令，方便测试检查返回 ID。
async function command(repo, action, payload, expectedRevision) { return repo.command({ action, payload, expectedRevision }); }

// 协议字段是 API 设置的兼容扩展，重启保留且备份不携带；未知协议必须拒绝。
test('自定义 Responses 协议独立保存、重启恢复并排除于资料备份', async () => {
  const env = fixture(); const base = await env.repo.readLegacy(); const next = structuredClone(base);
  next.settings.customProviders = { 'custom.protocol': { name: 'protocol-test', baseUrl: 'http://127.0.0.1:9800', protocol: 'responses' } };
  await env.repo.saveLegacy(base, next);
  assert.equal((await env.restart().readLegacy()).settings.customProviders['custom.protocol'].protocol, 'responses');
  assert.ok(!JSON.stringify(await env.repo.exportBackup()).includes('protocol-test'));
  const latest = await env.repo.readLegacy(); const bad = structuredClone(latest);
  bad.settings.customProviders['custom.protocol'].protocol = 'unsupported';
  await assert.rejects(env.repo.saveLegacy(latest, bad), /接口协议无效/);
});
// 从数据库读取某个个人值，不误用重复经历。
function value(db, profileId, fieldId, entryId = null) { return db.fieldValues.find((row) => row.profileId === profileId && row.fieldId === fieldId && row.entryId === entryId)?.value; }
// 创建仅含元数据的公共定义，测试文本均为虚构。
function def(fieldId = 'shared.skill') { return { fieldId, label: '测试技能', type: 'text', group: '技能', aliases: ['能力项'], options: [], description: '测试定义', version: 1 }; }

// 仅用合成资料构造升级前的 Schema v3，保留一项删除、一项自定义及旧格式日期。
async function oldCatalogFixture() {
  const seed = fixture(); await seed.repo.initialize();
  await command(seed.repo, 'createProfile', { name: '合成第二简历' });
  await command(seed.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.birthDate', value: '2000.02（原有文本）' });
  await command(seed.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.ethnic', value: '汉' });
  await command(seed.repo, 'createField', { profileId: 'p1', definition: { label: '合成自定义', group: '合成模块' }, value: '合成保留值' });
  const db = await seed.repo.read();
  const legacy = seed.templates.SOE_LONG_TEMPLATE.map((field) => seed.store.definition({ fieldId: 'builtin.' + field.key,
    label: field.label, type: field.inputType, group: field.group, options: field.options || [],
    aliases: field.patterns.filter((item) => !item.startsWith('re:')), description: '', version: 1 }));
  const retained = new Set(legacy.map((field) => field.fieldId));
  db.fieldDefinitions = [...legacy, ...db.fieldDefinitions.filter((field) => !field.fieldId.startsWith('builtin.'))];
  db.publicFieldIds = [...retained];
  db.bindings = db.bindings.filter((binding) => !binding.fieldId.startsWith('builtin.') || retained.has(binding.fieldId));
  db.fieldValues = db.fieldValues.filter((row) => !row.fieldId.startsWith('builtin.') || retained.has(row.fieldId));
  db.bindings = db.bindings.filter((binding) => binding.profileId !== 'p1' || binding.fieldId !== 'builtin.name');
  db.fieldValues = db.fieldValues.filter((row) => row.profileId !== 'p1' || row.fieldId !== 'builtin.name');
  db.schemaVersion = 3; delete db.applications; // 明确构造历史版本，不能用新库冒充迁移夹具。
  return { env: fixture({ [seed.store.DB_KEY]: JSON.parse(JSON.stringify(db)), [seed.store.API_KEY]: seed.disk[seed.store.API_KEY] }), before: JSON.parse(JSON.stringify(db)) };
}

// v2 库仅删除本次指定的语言遗留项，恢复点及目录标记原子保存，其他模块和用户删字段保持原样。
test('目录 v3 清理旧语言证书及映射，保留英语能力、证书模块和其他自定义资料', async () => {
  const seed = fixture(); await seed.repo.read();
  await command(seed.repo, 'createField', { profileId: 'p1', definition: { ...def('resume.languages'), label: '语言证书', group: '简历资料' }, value: '合成旧语言证书' });
  await command(seed.repo, 'createField', { profileId: 'p1', definition: { ...def('custom.old-language'), group: '语言与技能证书' }, value: '合成旧语言内容' });
  await command(seed.repo, 'createField', { profileId: 'p1', definition: { ...def('custom.unrelated'), group: '技能与其他' }, value: '合成用户自建内容保留' });
  await command(seed.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.englishScore', value: '合成英语保留' });
  await command(seed.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.certificateName', value: '合成证书保留' });
  await command(seed.repo, 'saveMapping', { mappingId: 'map.language', origin: 'https://synthetic.example', path: '/apply', label: '合成语言', fieldId: 'resume.languages', profileId: 'p1', entryId: null });
  const disk = structuredClone(seed.disk); disk[seed.store.CATALOG_KEY] = { version: 2 }; const db = disk[seed.store.DB_KEY];
  db.bindings = db.bindings.filter((row) => row.fieldId !== 'builtin.paperName'); db.fieldValues = db.fieldValues.filter((row) => row.fieldId !== 'builtin.paperName');
  const env = fixture(disk); env.fail(); await assert.rejects(env.repo.read(), /模拟磁盘/); assert.deepEqual(env.disk, disk);
  const after = await env.restart().read(); const removed = new Set(['resume.languages', 'custom.old-language']);
  for (const table of ['fieldDefinitions', 'bindings', 'fieldValues', 'mappingRules']) assert.ok(after[table].every((row) => !removed.has(row.fieldId)));
  assert.equal(value(after, 'p1', 'builtin.englishScore'), '合成英语保留'); assert.equal(value(after, 'p1', 'builtin.certificateName'), '合成证书保留'); assert.equal(value(after, 'p1', 'custom.unrelated'), '合成用户自建内容保留');
  assert.ok(!after.bindings.some((row) => row.fieldId === 'builtin.paperName')); assert.equal(env.disk[seed.store.CATALOG_KEY].version, 3); assert.deepEqual(env.disk[seed.store.RECOVERY_KEY], db);
  assert.deepEqual(await env.restart().read(), after); await command(env.repo, 'restoreRecovery', {}); assert.equal(JSON.stringify((await env.repo.read()).fieldValues), JSON.stringify(db.fieldValues));
});

// 静态目录覆盖全部参考模块；选项不因旧的 200 项限制而被截断。
test('参考目录包含 155 项结构、12 个模块，日期/下拉/多选完整且不含个人值', async () => {
  const env = fixture(); const db = await env.repo.read(); const fields = env.templates.REFERENCE_FIELDS;
  assert.equal(fields.length, 155); assert.equal(new Set(fields.map((field) => field[2])).size, 12);
  assert.equal(db.fieldDefinitions.length, 155); assert.equal(db.bindings.length, 155);
  assert.ok(db.fieldValues.every((row) => row.value === '' || row.value === null));
  for (const field of env.templates.PROFILE_TEMPLATE) assert.ok(db.fieldDefinitions.some((item) => item.fieldId === 'builtin.' + field.key));
  assert.ok(db.fieldDefinitions.every((item) => !env.templates.REMOVED_PROFILE_GROUPS.includes(item.group)));
  assert.equal(db.fieldDefinitions.find((item) => item.fieldId === 'builtin.majorCategory').options.length, 238);
  assert.equal(db.fieldDefinitions.find((item) => item.fieldId === 'builtin.ethnic').options.length, 56);
  for (const key of ['awardDate','certificateDate','publicationDate','familyBirthDate','employmentStartDate']) assert.equal(db.fieldDefinitions.find((item) => item.fieldId === 'builtin.' + key).type, 'date');
  assert.equal(db.fieldDefinitions.find((item) => item.fieldId === 'builtin.currentSalary').type, 'number');
  assert.equal(db.fieldDefinitions.find((item) => item.fieldId === 'builtin.expectedCities').type, 'multiSelect');
  assert.ok(db.fieldDefinitions.every((item) => !Object.hasOwn(item, 'value') && !Object.hasOwn(item, 'widget')));
});

// 地区候选随包分发，不依赖接口；直辖市、普通地级市和区县均可联动。
test('离线地区数据提供完整三级候选，保留原许可证且不包含执行逻辑', () => {
  const context = {}; const source = fs.readFileSync(path.join(__dirname, '../data/regions.js'), 'utf8'); vm.runInNewContext(source, context);
  const regions = context.LocalApplyRegions;
  assert.equal(Object.keys(regions).length, 31); assert.equal(Object.values(regions).reduce((count, cities) => count + Object.keys(cities).length, 0), 341);
  assert.ok(regions['江苏省']['南京市'].includes('玄武区')); assert.ok(regions['北京市']['北京市'].includes('海淀区'));
  assert.ok(Object.values(regions).every((cities) => Object.values(cities).every((districts) => Array.isArray(districts) && districts.every((name) => typeof name === 'string'))));
  assert.ok(fs.readFileSync(path.join(__dirname, '../libs/regions/LICENSE'), 'utf8').includes('Version 2, December 2004'));
});

test('旧 v3 目录只补新空字段，保留旧值、已删除字段、私有定义及全部档案', async () => {
  const { env, before } = await oldCatalogFixture(); const db = await env.repo.read();
  assert.equal(db.schemaVersion, 5); assert.equal(db.revision, before.revision + 1);
  for (const old of before.fieldValues) assert.deepEqual(JSON.parse(JSON.stringify(db.fieldValues.find((row) => row.profileId === old.profileId && row.fieldId === old.fieldId && row.entryId === old.entryId))), old);
  assert.deepEqual(JSON.parse(JSON.stringify(db.profiles)), before.profiles);
  assert.equal(value(db, 'p1', 'builtin.birthDate'), '2000.02（原有文本）'); assert.equal(value(db, 'p1', 'builtin.ethnic'), '汉');
  assert.ok(!db.bindings.some((binding) => binding.profileId === 'p1' && binding.fieldId === 'builtin.name'));
  assert.deepEqual(JSON.parse(JSON.stringify(db.fieldDefinitions.filter((field) => !field.fieldId.startsWith('builtin.')))), before.fieldDefinitions.filter((field) => !field.fieldId.startsWith('builtin.')));
  for (const profile of db.profiles) assert.equal(value(db, profile.profileId, 'builtin.paperName'), null);
  assert.equal(db.fieldDefinitions.find((field) => field.fieldId === 'builtin.ethnic').type, 'select');
  assert.equal(db.fieldDefinitions.find((field) => field.fieldId === 'builtin.ethnic').version, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(await env.restart().read())), JSON.parse(JSON.stringify(db)), '重启不得重复迁移');
  const state = await env.repo.readLegacy(); const next = structuredClone(state);
  next.profiles[0].fields = next.profiles[0].fields.filter((field) => field.key !== 'paperName'); await env.repo.saveLegacy(state, next);
  assert.ok(!(await env.restart().read()).bindings.some((binding) => binding.profileId === 'p1' && binding.fieldId === 'builtin.paperName'), '用户删除新字段后不得补回');
});

test('目录迁移写入失败保留旧库及升级标记，可重试且不覆盖用户改过的标准定义', async () => {
  const { env, before } = await oldCatalogFixture();
  env.disk[env.store.DB_KEY].fieldDefinitions.find((field) => field.fieldId === 'builtin.ethnic').description = '合成用户修改';
  const diskBefore = structuredClone(env.disk); env.fail(); await assert.rejects(env.repo.read(), /模拟磁盘错误/);
  assert.deepEqual(env.disk, diskBefore); assert.equal(env.disk[env.store.CATALOG_KEY], undefined);
  const db = await env.restart().read(); assert.equal(db.revision, before.revision + 1);
  assert.equal(db.fieldDefinitions.find((field) => field.fieldId === 'builtin.ethnic').description, '合成用户修改');
  assert.equal(env.disk[env.store.CATALOG_KEY].version, env.templates.CATALOG_VERSION);
});

test('参考日期、数字及开放城市多选经校验保存、备份往返，新简历不复制旧值', async () => {
  const env = fixture(); await env.repo.initialize();
  for (const [fieldId, next] of [['builtin.awardDate', '2028-02-29'], ['builtin.educationStartDate', '2024-09'], ['builtin.currentSalary', 0], ['builtin.expectedCities', ['合成甲城', '合成乙城']]]) {
    await command(env.repo, 'setValue', { profileId: 'p1', fieldId, value: next });
  }
  await assert.rejects(command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.awardDate', value: '2027-02-29' }), /日期不存在/);
  const second = (await command(env.repo, 'createProfile', { name: '合成空白简历' })).result;
  const db = await env.repo.read(); assert.equal(db.bindings.filter((binding) => binding.profileId === second).length, 155);
  assert.equal(value(db, second, 'builtin.awardDate'), '');
  const backup = await env.repo.exportBackup(); const restored = env.store.parseBackup(backup);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.fieldValues)), JSON.parse(JSON.stringify(db.fieldValues)));
  assert.ok(!JSON.stringify(backup).includes('localapply.fieldCatalog'));
});

test('动态字段新增、版本化编辑、删除及引用清理', async () => {
  const { repo } = fixture(); await repo.initialize();
  const created = await command(repo, 'createField', { profileId: 'p1', definition: { label: '虚构字段' }, value: '合成内容' });
  let db = await repo.read(); const field = db.fieldDefinitions.find((row) => row.fieldId === created.result);
  await command(repo, 'editField', { definition: { ...field, label: '更新字段', version: 2 } });
  db = await repo.read(); assert.equal(db.fieldDefinitions.find((row) => row.fieldId === created.result).label, '更新字段');
  assert.equal(value(db, 'p1', created.result), '合成内容');
  await command(repo, 'deleteField', { fieldId: created.result }); db = await repo.read();
  assert.ok(!db.fieldDefinitions.some((row) => row.fieldId === created.result));
  assert.ok(!db.fieldValues.some((row) => row.fieldId === created.result));
});

// 已有定义绑定只添加空白，不复制其他档案值，也不创建重复定义。
test('工作台添加已有字段保持 ID、档案隔离和幂等，改经历标题不改变引用', async () => {
  const { repo } = fixture(); await repo.initialize(); const fieldId = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '合成共享定义' }, value: '合成私有内容' })).result;
  const profileId = (await command(repo, 'createProfile', { name: '合成第二档案' })).result;
  await command(repo, 'attachField', { fieldId, profileId }); await command(repo, 'attachField', { fieldId, profileId }); let db = await repo.read();
  assert.equal(db.fieldDefinitions.filter((item) => item.fieldId === fieldId).length, 1); assert.equal(db.bindings.filter((item) => item.fieldId === fieldId && item.profileId === profileId).length, 1); assert.equal(value(db, profileId, fieldId), null); assert.equal(value(db, 'p1', fieldId), '合成私有内容');
  const entryId = (await command(repo, 'createEntry', { profileId, kind: 'project', title: '合成旧标题' })).result;
  await command(repo, 'setValue', { profileId, entryId, fieldId, value: '合成项目值' }); await command(repo, 'editEntry', { entryId, title: '合成新标题' }); db = await repo.read();
  assert.equal(db.entries.find((item) => item.entryId === entryId).title, '合成新标题'); assert.equal(db.fieldValues.find((item) => item.entryId === entryId).value, '合成项目值');
  await assert.rejects(command(repo, 'attachField', { fieldId: 'missing', profileId }), /不存在/); await assert.rejects(command(repo, 'editEntry', { entryId, title: 'x', kind: 'education' }), /未声明/);
});

// 重命名仅改名称，拒绝空白与过期确认，不能改变任何资料引用。
test('简历重命名保留 ID 和资料，取消确认及并发版本不能写入', async () => {
  const { repo } = fixture(); await repo.initialize();
  const entryId = (await command(repo, 'createEntry', { profileId: 'p1', kind: 'education', title: '合成院校' })).result;
  await command(repo, 'setValue', { profileId: 'p1', entryId, fieldId: 'builtin.school', value: '合成大学' });
  const before = await repo.read();
  for (const name of ['', '  ']) await assert.rejects(command(repo, 'renameProfile', { profileId: 'p1', name, confirmed: true }, before.revision), /名称/);
  await assert.rejects(command(repo, 'renameProfile', { profileId: 'p1', name: '合成新名', confirmed: false }, before.revision), /确认/);
  await assert.rejects(command(repo, 'renameProfile', { profileId: 'p1', name: '合成新名', confirmed: true }), /版本/);
  assert.deepEqual(await repo.read(), before);
  await command(repo, 'renameProfile', { profileId: 'p1', name: '  合成新名  ', confirmed: true }, before.revision);
  const after = await repo.read(); assert.equal(after.profiles[0].name, '合成新名');
  assert.deepEqual(structuredClone(after), structuredClone({ ...before, revision: before.revision + 1, profiles: before.profiles.map((item) => ({ ...item, name: '合成新名' })) }));
  await assert.rejects(command(repo, 'renameProfile', { profileId: 'p1', name: '过期名', confirmed: true }, before.revision), /版本/);
});

// 删除级联个人资料和草稿，不删除跨简历共享的定义、通用规则或凭据。
test('整份简历删除清理个人引用，保留其他简历并可重启和备份往返', async () => {
  const env = fixture(); const { repo } = env; await repo.initialize();
  const second = (await command(repo, 'createProfile', { name: '合成保留简历' })).result;
  const fieldId = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '合成共享字段' }, value: '合成删除值' })).result;
  await command(repo, 'attachField', { profileId: second, fieldId });
  for (const profileId of ['p1', second]) {
    const entryId = (await command(repo, 'createEntry', { profileId, kind: 'project', title: '合成项目' })).result;
    await command(repo, 'setValue', { profileId, entryId, fieldId, value: profileId === 'p1' ? '合成删除经历值' : '合成保留值' });
    await command(repo, 'saveMapping', { profileId, entryId, fieldId, origin: 'https://example.test', path: '/apply', label: '合成标签' });
  }
  await command(repo, 'saveMapping', { profileId: null, entryId: null, fieldId, origin: 'https://example.test', path: '/apply', label: '合成通用规则' });
  const base = await repo.readLegacy(); const next = structuredClone(base);
  next.drafts = { p1: { question: [{ ts: 1, text: '合成删除草稿' }] }, [second]: { question: [{ ts: 2, text: '合成保留草稿' }] } };
  await repo.saveLegacy(base, next);
  const before = await repo.read(); const api = structuredClone(env.disk[env.store.API_KEY]);
  await command(repo, 'deleteProfile', { profileId: 'p1', confirmed: true }, before.revision);
  const after = await env.restart().read(); assert.equal(after.activeProfileId, second);
  for (const table of ['profiles', 'fieldValues', 'entries', 'bindings', 'mappingRules']) assert.deepEqual(after[table], before[table].filter((row) => row.profileId !== 'p1'));
  assert.deepEqual(after.fieldDefinitions, before.fieldDefinitions); assert.deepEqual(structuredClone(after.drafts), structuredClone({ [second]: before.drafts[second] }));
  assert.deepEqual(env.disk[env.store.API_KEY], api);
  const backup = await repo.exportBackup(); const restored = fixture().repo; await restored.initialize();
  await command(restored, 'importBackup', { backup, mode: 'replace' }, (await restored.read()).revision);
  assert.deepEqual(structuredClone((await restored.read()).fieldValues), structuredClone(after.fieldValues));
  assert.ok(!JSON.stringify(backup).includes('合成删除值') && !JSON.stringify(backup).includes('合成删除草稿'));
  const third = (await command(repo, 'createProfile', { name: '合成第三简历' })).result;
  const deleted = await command(repo, 'deleteProfile', { profileId: third, confirmed: true }, (await repo.read()).revision);
  assert.equal(deleted.result, second); assert.equal((await repo.read()).activeProfileId, second);
});

// 删除必须确认，最后一份、存储异常和旧版本均保持原子性，旧页面不能复活已删除档案。
test('简历删除拒绝未确认、最后一份及过期版本，写入失败保留原数据', async () => {
  const env = fixture(); const { repo } = env; await repo.initialize(); let before = await repo.read();
  await assert.rejects(command(repo, 'deleteProfile', { profileId: 'p1', confirmed: true }, before.revision), /至少保留/);
  const other = (await command(repo, 'createProfile', { name: '合成第二简历' })).result; before = await repo.read();
  await assert.rejects(command(repo, 'deleteProfile', { profileId: 'p1', confirmed: false }, before.revision), /确认/);
  await assert.rejects(command(repo, 'deleteProfile', { profileId: 'p1', confirmed: true }), /版本/);
  await assert.rejects(command(repo, 'deleteProfile', { profileId: 'missing', confirmed: true }, before.revision), /不存在/);
  await assert.rejects(command(repo, 'deleteProfile', { profileId: 'p1', confirmed: true }, before.revision - 1), /版本/);
  env.fail(); await assert.rejects(command(repo, 'deleteProfile', { profileId: 'p1', confirmed: true }, before.revision), /磁盘/);
  assert.deepEqual(await repo.read(), before);
  const base = await repo.readLegacy(); const stale = structuredClone(base); stale.profiles.find((item) => item.id === other).name = '旧页修改';
  await command(repo, 'deleteProfile', { profileId: other, confirmed: true }, before.revision);
  await assert.rejects(repo.saveLegacy(base, stale), /已删除/);
  assert.equal((await repo.read()).profiles.length, 1);
});

test('字段定义只含元数据，个人值和 API 分开存储', async () => {
  const { repo, disk, templates } = fixture();
  const legacy = templates.defaultState(); legacy.settings.apiKeys = { zhipu: 'fake-unit-secret' };
  disk.wangshenAutofill = legacy;
  await repo.initialize(); await command(repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成姓名唯一标记' });
  const db = await repo.read();
  assert.ok(!JSON.stringify(db.fieldDefinitions).includes('合成姓名唯一标记'));
  assert.ok(!JSON.stringify(db).includes('fake-unit-secret'));
  assert.equal(disk['localapply.apiSettings'].apiKeys.zhipu, 'fake-unit-secret');
  await assert.rejects(command(repo, 'mergePublicFields', { kind: 'localapply-public-fields', version: 1, fields: [{ ...def(), value: '禁止夹带' }] }), /未声明/);
});

test('两套档案独立，false/0 通过类型化字段保留', async () => {
  const { repo } = fixture(); await repo.initialize();
  const second = (await command(repo, 'createProfile', { name: '合成档案乙' })).result;
  await command(repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成甲' });
  await command(repo, 'setValue', { profileId: second, fieldId: 'builtin.name', value: '合成乙' });
  const numeric = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '数量', type: 'number' }, value: 0 })).result;
  const boolean = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '状态', type: 'boolean' }, value: false })).result;
  const db = await repo.read(); assert.equal(value(db, 'p1', 'builtin.name'), '合成甲'); assert.equal(value(db, second, 'builtin.name'), '合成乙');
  assert.equal(value(db, 'p1', numeric), 0); assert.equal(value(db, 'p1', boolean), false);
});

test('多段教育/实习/工作/项目按 entryId 保存，跨档案引用被拒绝', async () => {
  const { repo } = fixture(); await repo.initialize();
  for (const kind of ['education', 'internship', 'employment', 'project']) {
    for (let index = 0; index < 2; index++) {
      const entryId = (await command(repo, 'createEntry', { profileId: 'p1', kind, title: '合成经历' + index })).result;
      await command(repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.school', entryId, value: kind + index });
    }
  }
  const db = await repo.read(); assert.equal(db.entries.length, 8);
  assert.equal(db.fieldValues.filter((row) => row.entryId !== null).length, 8);
  const other = (await command(repo, 'createProfile', { name: '档案乙' })).result;
  await assert.rejects(command(repo, 'setValue', { profileId: other, fieldId: 'builtin.school', entryId: db.entries[0].entryId, value: '越界' }), /不属于/);
});

test('原多档案和 API 迁移，不丢失自定义字段/禁用策略且旧源不变', async () => {
  const { repo, disk, templates, restart } = fixture();
  const legacy = templates.defaultState(); legacy.profiles.push(templates.makeProfile('旧档案乙', 'all', 'p2'));
  legacy.profiles[0].fields[0].value = '旧合成姓名'; legacy.profiles[0].fields[0].autoFill = false;
  legacy.profiles[1].fields.push({ fid: 'old-custom', key: 'c_old', label: '自定义', value: '原自定义值', group: '其他', inputType: 'text', custom: true });
  legacy.settings.apiKeys = { custom: 'fake-migration-secret' }; disk.wangshenAutofill = structuredClone(legacy);
  const before = JSON.stringify(disk.wangshenAutofill); const migrated = await repo.initialize();
  assert.equal(migrated.profiles.length, 2);
  assert.equal(value(migrated, 'p1', 'builtin.name'), '旧合成姓名');
  assert.equal((await repo.readLegacy()).profiles[0].fields[0].autoFill, false);
  assert.equal((await repo.readLegacy()).profiles[1].fields.find((row) => row.fid === 'old-custom').value, '原自定义值');
  assert.equal(JSON.stringify(disk.wangshenAutofill), before);
  assert.equal(JSON.stringify(await restart().initialize()), JSON.stringify(migrated));
});

test('迁移写失败保留原数据，重新初始化可恢复', async () => {
  const env = fixture(); env.disk.wangshenAutofill = env.templates.defaultState();
  const before = JSON.stringify(env.disk.wangshenAutofill); env.fail();
  await assert.rejects(env.repo.initialize(), /模拟磁盘/);
  assert.equal(JSON.stringify(env.disk.wangshenAutofill), before);
  assert.equal((await env.restart().initialize()).schemaVersion, 5);
});

test('完整备份往返恢复重复经历、自定义字段和映射；默认排除 Key', async () => {
  const { repo } = fixture(); await repo.initialize();
  const fieldId = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '动态测试' }, value: '自定义内容' })).result;
  const entryId = (await command(repo, 'createEntry', { profileId: 'p1', kind: 'project', title: '合成项目' })).result;
  await command(repo, 'setValue', { profileId: 'p1', fieldId, entryId, value: '合成项目描述' });
  await command(repo, 'saveMapping', { origin: 'https://recruit.example.test', path: '/apply', label: '项目', fieldId, profileId: 'p1', entryId });
  const exported = await repo.exportBackup(); assert.ok(!JSON.stringify(exported).includes('apiKeys'));
  const other = fixture(); await other.repo.initialize(); const preview = await other.repo.previewImport(JSON.stringify(exported), 'replace');
  await command(other.repo, 'importBackup', { backup: exported, mode: 'replace' }, preview.revision);
  const first = await repo.read(); const second = await other.repo.read(); first.revision = second.revision;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('合并冲突保留当前，覆盖有恢复点，重复导入不重复记录', async () => {
  const { repo } = fixture(); await repo.initialize(); const old = await repo.exportBackup();
  await command(repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '保留当前合成值' });
  let preview = await repo.previewImport(old, 'merge'); assert.ok(preview.conflicts > 0);
  await command(repo, 'importBackup', { backup: old, mode: 'merge' }, preview.revision);
  assert.equal(value(await repo.read(), 'p1', 'builtin.name'), '保留当前合成值');
  preview = await repo.previewImport(old, 'replace'); await command(repo, 'importBackup', { backup: old, mode: 'replace' }, preview.revision);
  assert.equal(value(await repo.read(), 'p1', 'builtin.name'), '');
  await command(repo, 'restoreRecovery', {}); assert.equal(value(await repo.read(), 'p1', 'builtin.name'), '保留当前合成值');
  const count = (await repo.read()).fieldValues.length;
  preview = await repo.previewImport(old, 'merge'); await command(repo, 'importBackup', { backup: old, mode: 'merge' }, preview.revision);
  assert.equal((await repo.read()).fieldValues.length, count);
});

test('损坏 JSON、未来版本、文件对象属性和悬空引用均不能破坏数据库', async () => {
  const { repo } = fixture(); await repo.initialize(); const snapshot = JSON.stringify(await repo.read());
  const original = await repo.exportBackup();
  const bad = [']wrong', { ...original, schemaVersion: 99 }, { ...original, originalFile: '禁止内容' },
    { ...original, database: { ...original.database, fieldValues: [{ profileId: 'missing', fieldId: 'missing' }] } }];
  for (const backup of bad) {
    await assert.rejects(repo.previewImport(backup, 'replace'));
    await assert.rejects(command(repo, 'importBackup', { backup, mode: 'replace' }, (await repo.read()).revision));
  }
  assert.equal(JSON.stringify(await repo.read()), snapshot);
});

test('旧版档案备份可导入；未来旧备份版本不能导入', async () => {
  const { repo, templates } = fixture(); await repo.initialize();
  const legacy = templates.defaultState(); legacy.profiles[0].fields[0].value = '旧备份合成值';
  const backup = { kind: 'wangshen-autofill-backup', version: 1, profiles: legacy.profiles, activeProfileId: 'p1' };
  const preview = await repo.previewImport(backup, 'replace');
  await command(repo, 'importBackup', { backup, mode: 'replace' }, preview.revision);
  assert.equal(value(await repo.read(), 'p1', 'builtin.name'), '旧备份合成值');
  await assert.rejects(repo.previewImport({ ...backup, version: 2 }, 'merge'), /版本/);
});

test('旧备份含动态字段时重复合并不产生重复定义；重复 key 保留各自的值', async () => {
  const { repo, templates } = fixture(); await repo.initialize();
  const old = templates.defaultState();
  old.profiles[0].fields.push({ ...old.profiles[0].fields[0], fid: 'second-name', value: '第二个合成姓名' });
  old.profiles[0].fields.push({ fid: 'custom-test', key: 'c_test', label: '自定义合成字段', group: '其他', inputType: 'text', value: '合成自定义内容', custom: true });
  const backup = { kind: 'wangshen-autofill-backup', version: 1, profiles: old.profiles, activeProfileId: 'p1' };
  for (let index = 0; index < 2; index++) {
    const preview = await repo.previewImport(backup, 'merge');
    await command(repo, 'importBackup', { backup, mode: 'merge' }, preview.revision);
  }
  const db = await repo.read();
  assert.equal(db.fieldDefinitions.filter((row) => row.label === '自定义合成字段').length, 1);
  assert.equal(db.fieldValues.filter((row) => row.value === '第二个合成姓名').length, 1);
});

test('公共元数据按版本合并，已有个人值保留，同版本冲突失败', async () => {
  const { repo } = fixture(); await repo.initialize();
  const pack = { kind: 'localapply-public-fields', version: 1, fields: [def()] };
  await command(repo, 'mergePublicFields', pack);
  await command(repo, 'setValue', { profileId: 'p1', fieldId: 'shared.skill', value: '合成个人技能' });
  await command(repo, 'mergePublicFields', { ...pack, fields: [{ ...def(), label: '新版本名称', version: 2 }] });
  assert.equal(value(await repo.read(), 'p1', 'shared.skill'), '合成个人技能');
  await assert.rejects(command(repo, 'mergePublicFields', { ...pack, fields: [{ ...def(), label: '冲突版本', version: 2 }] }), /冲突/);
});

test('新增定义拒绝夹带 value，不兼容类型编辑不会破坏值', async () => {
  const { repo } = fixture(); await repo.initialize();
  await assert.rejects(command(repo, 'createField', { profileId: 'p1', definition: { label: '夹带字段', value: '秘密' } }), /未声明/);
  const fieldId = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '测试' }, value: '合成文字' })).result;
  const field = (await repo.read()).fieldDefinitions.find((row) => row.fieldId === fieldId);
  await assert.rejects(command(repo, 'editField', { definition: { ...field, type: 'number', version: 2 } }), /数字/);
  assert.equal(value(await repo.read(), 'p1', fieldId), '合成文字');
});

test('公共导出不含私有字段标签、值、档案、Key 或记录，接收方字段空白', async () => {
  const { repo } = fixture(); await repo.initialize();
  await command(repo, 'createField', { profileId: 'p1', definition: { label: '合成私人标题' }, value: '合成私有值' });
  await command(repo, 'publishDefinition', { definition: def() });
  const pack = await repo.exportPublicFields(); const text = JSON.stringify(pack);
  for (const secret of ['合成私人标题', '合成私有值', 'profileId', 'apiKey', 'ledger', 'updatedAt']) assert.ok(!text.includes(secret), secret);
  const receiving = fixture(); await receiving.repo.initialize();
  await command(receiving.repo, 'mergePublicFields', pack);
  const state = await receiving.repo.readLegacy(); assert.equal(state.profiles[0].fields.find((row) => row.key === 'shared.skill').value, '');
  await command(receiving.repo, 'mergePublicFields', pack);
  assert.equal((await receiving.repo.read()).fieldDefinitions.filter((row) => row.fieldId === 'shared.skill').length, 1);
});

test('后台重新创建仓库仍读取原存储；旧 UI 修改不丢失重复经历', async () => {
  const { repo, restart } = fixture(); await repo.initialize();
  const entryId = (await command(repo, 'createEntry', { profileId: 'p1', kind: 'education' })).result;
  await command(repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.school', entryId, value: '合成学院' });
  const base = await repo.readLegacy(); const next = structuredClone(base); next.profiles[0].fields[0].value = '保存的合成姓名';
  await repo.saveLegacy(base, next);
  const fresh = restart(); assert.equal(value(await fresh.read(), 'p1', 'builtin.school', entryId), '合成学院');
  assert.equal((await fresh.readLegacy()).profiles[0].fields[0].value, '保存的合成姓名');
});

test('不同字段并发三方合并；同字段冲突拒绝，预览过期拒绝', async () => {
  const { repo } = fixture(); await repo.initialize();
  const base = await repo.readLegacy(); const a = structuredClone(base); const b = structuredClone(base);
  a.profiles[0].fields[0].value = '合成姓名'; b.profiles[0].fields[1].value = '男';
  await Promise.all([repo.saveLegacy(base, a), repo.saveLegacy(base, b)]);
  const current = await repo.readLegacy(); assert.equal(current.profiles[0].fields[0].value, '合成姓名'); assert.equal(current.profiles[0].fields[1].value, '男');
  b.profiles[0].fields[0].value = '冲突姓名'; await assert.rejects(repo.saveLegacy(base, b), /已变化/);
  const backup = await repo.exportBackup(); const preview = await repo.previewImport(backup, 'replace');
  await command(repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.email', value: 'synthetic@example.test' });
  await assert.rejects(command(repo, 'importBackup', { backup, mode: 'replace' }, preview.revision), /重新预览/);
});

test('旧 UI 连续新增、编辑、删除字段，不受默认 options 展示差异影响', async () => {
  const { repo } = fixture(); await repo.initialize();
  let base = await repo.readLegacy(); let next = structuredClone(base);
  next.profiles[0].fields.push({ fid: 'new-ui-field', key: 'c_ui', label: '界面字段', value: '', group: '其他', inputType: 'text', sensitive: false, autoFill: true, material: false, custom: true });
  await repo.saveLegacy(base, next);
  base = structuredClone(next); next.profiles[0].fields.at(-1).value = '界面合成值'; await repo.saveLegacy(base, next);
  base = structuredClone(next); next.profiles[0].fields.pop(); await repo.saveLegacy(base, next);
  assert.ok(!(await repo.read()).fieldDefinitions.some((row) => row.label === '界面字段'));
});

test('私人备份不能通过 publicFieldIds 绕过公共元数据审核', async () => {
  const { repo } = fixture(); await repo.initialize();
  const fieldId = (await command(repo, 'createField', { profileId: 'p1', definition: { label: '合成私有标题' }, value: '合成私有值' })).result;
  const backup = await repo.exportBackup(); backup.database.publicFieldIds.push(fieldId);
  const preview = await repo.previewImport(backup, 'replace');
  await command(repo, 'importBackup', { backup, mode: 'replace' }, preview.revision);
  assert.ok(!JSON.stringify(await repo.exportPublicFields()).includes('合成私有标题'));
});

test('迁移中断于 API 保存之后仍保留旧源，可重试；导入落盘失败不改变当前库', async () => {
  const env = fixture(); env.disk.wangshenAutofill = env.templates.defaultState();
  env.disk.wangshenAutofill.profiles[0].fields[0].value = '迁移合成值';
  const old = JSON.stringify(env.disk.wangshenAutofill); env.fail(1);
  await assert.rejects(env.repo.initialize(), /模拟磁盘/);
  assert.equal(env.disk['localapply.database'], undefined);
  assert.equal(JSON.stringify(env.disk.wangshenAutofill), old);
  await env.repo.initialize(); const backup = await env.repo.exportBackup();
  await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '当前合成值' });
  const before = JSON.stringify(await env.repo.read()); const preview = await env.repo.previewImport(backup, 'replace');
  env.fail(1); // 恢复点写入成功，随后新库写入失败。
  await assert.rejects(command(env.repo, 'importBackup', { backup, mode: 'replace' }, preview.revision), /模拟磁盘/);
  assert.equal(JSON.stringify(await env.repo.read()), before);
  assert.ok(env.disk['localapply.recovery']);
});

test('自定义服务商、每家模型与 Key 独立保存，重启可读，备份不含配置', async () => {
  const { repo, restart } = fixture();
  const base = await repo.readLegacy(); const next = structuredClone(base);
  next.settings.provider = 'custom.unit'; next.settings.model = 'synthetic-model';
  next.settings.customProviders = { 'custom.unit': { name: '测试地址', baseUrl: 'http://127.0.0.1:9000/v1' } };
  next.settings.providerModels = { deepseek: { model: 'synthetic-deepseek', visionModel: '' }, 'custom.unit': { model: 'synthetic-model', visionModel: '' } };
  next.settings.apiKeys['custom.unit'] = 'fake-custom-unit-key';
  await repo.saveLegacy(base, next);
  const after = await restart().readLegacy(); assert.equal(after.settings.customProviders['custom.unit'].baseUrl, 'http://127.0.0.1:9000/v1');
  assert.equal(after.settings.providerModels.deepseek.model, 'synthetic-deepseek');
  assert.equal(after.settings.apiKeys['custom.unit'], 'fake-custom-unit-key');
  const exported = JSON.stringify(await repo.exportBackup()); assert.ok(!exported.includes('customProviders')); assert.ok(!exported.includes('fake-custom-unit-key'));
});

test('口令保险库认证后清理旧明文，错误口令/锁定/后台重启均不能读取 Key', async () => {
  const seed = fixture().templates.defaultState(); seed.settings.apiKeys = { zhipu: 'synthetic-private-secret' };
  const env = fixture({ wangshenAutofill: seed }); await env.repo.initialize();
  await env.repo.vaultCommand('setup', { password: 'test-passphrase' });
  assert.ok(!JSON.stringify(env.disk).includes('synthetic-private-secret'));
  assert.equal((await env.repo.readAiSettings()).apiKeys.zhipu, 'synthetic-private-secret');
  assert.deepEqual(Object.keys((await env.repo.readLegacy()).settings.apiKeys), []);
  assert.equal(env.disk.wangshenAutofill.profiles[0].id, seed.profiles[0].id);
  const restarted = env.restart(); const before = JSON.stringify(env.disk);
  await assert.rejects(restarted.readAiSettings(), /锁定/);
  await assert.rejects(restarted.vaultCommand('unlock', { password: 'wrong-password' }), /口令错误/);
  assert.equal(JSON.stringify(env.disk), before);
  await restarted.vaultCommand('unlock', { password: 'test-passphrase' });
  const settings = (await restarted.readLegacy()).settings;
  await restarted.vaultCommand('setKey', { providerId: 'deepseek', key: 'synthetic-replacement', revision: settings.vault.revision });
  assert.ok(!JSON.stringify(env.disk).includes('synthetic-replacement'));
  await assert.rejects(restarted.vaultCommand('setKey', { providerId: 'deepseek', key: 'stale-value', revision: settings.vault.revision }), /已变化/);
  await restarted.vaultCommand('lock');
  assert.ok((await restarted.read()).profiles.length);
  assert.ok(!JSON.stringify(await restarted.exportBackup()).includes('ciphertext'));
  await restarted.vaultCommand('unlock', { password: 'test-passphrase' });
  assert.equal((await restarted.readAiSettings()).apiKeys.deepseek, 'synthetic-replacement');
  const record = env.disk['localapply.keyVault']; record.ciphertext = (record.ciphertext[0] === 'A' ? 'B' : 'A') + record.ciphertext.slice(1);
  await assert.rejects(restarted.readAiSettings(), /保险库已损坏/);
});

test('保险库迁移清理中断后旧数据可恢复，解锁重试才完成清理', async () => {
  const seed = fixture().templates.defaultState(); seed.settings.apiKeys = { zhipu: 'synthetic-migration-secret' };
  const env = fixture({ wangshenAutofill: seed }); await env.repo.initialize();
  env.fail(1); // 首次密文写成功，清理明文阶段失败。
  await assert.rejects(env.repo.vaultCommand('setup', { password: 'test-passphrase' }), /模拟磁盘/);
  assert.equal(env.disk['localapply.keyVault'].migrationPending, true);
  assert.equal(env.disk.wangshenAutofill.settings.apiKeys.zhipu, 'synthetic-migration-secret');
  const restarted = env.restart(); await restarted.vaultCommand('unlock', { password: 'test-passphrase' });
  assert.equal(env.disk['localapply.keyVault'].migrationPending, false);
  assert.ok(!JSON.stringify(env.disk).includes('synthetic-migration-secret'));
});

test('简历来源校验、确认导入、重复文件去重、档案隔离及备份来源往返', async () => {
  const env = fixture(); const files = require('./resume-fixtures.cjs');
  const source = { type: 'docx', mode: 'text', pages: [files.text], text: files.text };
  const normalized = env.resume.normalize(files.parsed(), source);
  assert.equal(normalized.find((row) => row.key === 'gpa').checked, false);
  assert.equal(normalized.find((row) => row.key === 'name').checked, true);
  const rows = normalized.filter((row) => row.checked).map(({ kind, index, key, value, evidence }) => ({ kind, index, key, value, evidence }));
  const payload = { profileId: 'p1', fingerprint: 'a'.repeat(64), rows, overwrite: false };
  const before = await env.repo.read();
  await assert.rejects(command(env.repo, 'importResume', { ...payload, rows: [{ ...rows[0], hiddenFile: 'forbidden' }] }, before.revision), /契约/);
  assert.equal((await env.repo.read()).revision, before.revision);
  await command(env.repo, 'importResume', payload, before.revision);
  let db = await env.repo.read(); assert.equal(db.entries.length, 5);
  assert.equal(value(db, 'p1', 'builtin.name'), 'Test Person');
  assert.ok(db.fieldValues.find((v) => v.fieldId === 'builtin.name').evidence.verified);
  await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: 'User edit' });
  assert.ok(!(await env.repo.read()).fieldValues.find((v) => v.fieldId === 'builtin.name').evidence);
  await command(env.repo, 'importResume', payload, (await env.repo.read()).revision);
  db = await env.repo.read(); assert.equal(db.entries.length, 5); assert.equal(value(db, 'p1', 'builtin.name'), 'User edit');
  const second = (await command(env.repo, 'createProfile', { name: '第二份简历' })).result;
  await command(env.repo, 'importResume', { ...payload, profileId: second }, (await env.repo.read()).revision);
  db = await env.repo.read(); assert.equal(db.entries.length, 10); assert.equal(value(db, second, 'builtin.name'), 'Test Person');
  assert.ok(!JSON.stringify(await env.repo.exportPublicFields()).includes('Test Person'));
  const backup = await env.repo.exportBackup(); const target = fixture().repo;
  await command(target, 'importBackup', { backup, mode: 'replace' }, (await target.previewImport(backup, 'replace')).revision);
  assert.ok((await target.read()).fieldValues.some((row) => row.evidence?.fingerprint === payload.fingerprint));
  const revision = (await env.repo.read()).revision; env.fail();
  await assert.rejects(command(env.repo, 'importResume', { ...payload, overwrite: true }, revision), /模拟磁盘/);
  assert.equal((await env.repo.read()).revision, revision);
});

test('Schema v2 数据/备份/恢复点升级到 v5，失败不改原版本，未知版本拒绝', async () => {
  const seed = fixture(); await seed.repo.initialize();
  const v2 = structuredClone(seed.disk); v2['localapply.database'].schemaVersion = 2; delete v2['localapply.database'].applications;
  const env = fixture(v2); env.fail();
  await assert.rejects(env.repo.read(), /模拟磁盘/);
  assert.equal(env.disk['localapply.database'].schemaVersion, 2);
  const db = await env.repo.read(); assert.equal(db.schemaVersion, 5); assert.equal(db.revision, 1);
  assert.equal((await env.restart().read()).revision, 1);
  const backup = await seed.repo.exportBackup(); backup.schemaVersion = backup.database.schemaVersion = 2; delete backup.database.applications;
  const preview = await env.repo.previewImport(backup, 'replace');
  await command(env.repo, 'importBackup', { backup, mode: 'replace' }, preview.revision);
  env.disk['localapply.recovery'].schemaVersion = 2; delete env.disk['localapply.recovery'].applications;
  await command(env.repo, 'restoreRecovery', {}); assert.equal((await env.repo.read()).schemaVersion, 5);
  const future = fixture({ ...v2, 'localapply.database': { ...v2['localapply.database'], schemaVersion: 100 } });
  await assert.rejects(future.repo.read(), /版本/); assert.equal(future.disk['localapply.database'].schemaVersion, 100);
});

test('默认直接保存 Key 无需口令，迁移旧明文后重启可用且备份不含自动密钥', async () => {
  const old = fixture().templates.defaultState(); old.settings.apiKeys = { zhipu: 'fake-legacy-local-key' };
  const env = fixture({ wangshenAutofill: old }); await env.repo.initialize(); const before = await env.repo.read();
  await env.repo.vaultCommand('setKey', { providerId: 'deepseek', key: 'fake-direct-local-key', revision: 0, localRevision: 0 });
  assert.ok(!JSON.stringify(env.disk).includes('fake-direct-local-key')); assert.ok(!JSON.stringify(env.disk).includes('fake-legacy-local-key'));
  const state = await env.repo.readLegacy(); assert.equal(state.settings.vault.enabled, false); assert.equal(state.settings.keyStatus.deepseek, true);
  assert.deepEqual(Object.keys(state.settings.apiKeys), []);
  const settings = await env.restart().readAiSettings(); assert.equal(settings.apiKeys.deepseek, 'fake-direct-local-key'); assert.equal(settings.apiKeys.zhipu, 'fake-legacy-local-key');
  assert.deepEqual(await env.repo.read(), before);
  assert.ok(!JSON.stringify(await env.repo.exportBackup()).includes('deviceKey'));
  await assert.rejects(env.repo.vaultCommand('setKey', { providerId: 'deepseek', key: 'stale-value', revision: 0, localRevision: 0 }), /已变化/);
});

test('口令可选开启和取消，错误口令不写入，取消后整个仓库重启无需解锁', async () => {
  const env = fixture(); await env.repo.initialize();
  await env.repo.vaultCommand('setKey', { providerId: 'zhipu', key: 'fake-optional-key', revision: 0 });
  await env.repo.vaultCommand('setup', { password: 'test-passphrase' });
  assert.equal(env.disk['localapply.deviceKeys'], null);
  const restarted = env.restart(); await assert.rejects(restarted.readAiSettings(), /锁定/);
  const before = JSON.stringify(env.disk);
  await assert.rejects(restarted.vaultCommand('disable', { password: 'wrong-password' }), /口令错误/); assert.equal(JSON.stringify(env.disk), before);
  await restarted.vaultCommand('disable', { password: 'test-passphrase' });
  assert.equal(env.disk['localapply.keyVault'], null); assert.ok(!JSON.stringify(env.disk).includes('fake-optional-key'));
  assert.equal((await env.restart().readAiSettings()).apiKeys.zhipu, 'fake-optional-key');
});

test('旧密钥锁定时可直接重填新 Key，旧密文保留；删除覆盖不恢复旧 Key', async () => {
  const old = fixture().templates.defaultState(); old.settings.apiKeys = { zhipu: 'fake-old-protected', deepseek: 'fake-other-protected' };
  const env = fixture({ wangshenAutofill: old }); await env.repo.initialize(); await env.repo.vaultCommand('setup', { password: 'test-passphrase' });
  const repo = env.restart(); const encrypted = JSON.stringify(env.disk['localapply.keyVault']);
  await repo.vaultCommand('setKey', { providerId: 'zhipu', key: 'fake-reentered-key', revision: 1 });
  assert.equal(JSON.stringify(env.disk['localapply.keyVault']), encrypted);
  assert.equal((await repo.readAiSettings()).apiKeys.zhipu, 'fake-reentered-key');
  const base = await repo.readLegacy(); const next = structuredClone(base); next.settings.provider = 'deepseek'; await repo.saveLegacy(base, next);
  await assert.rejects(repo.readAiSettings(), /锁定/);
  await repo.vaultCommand('setKey', { providerId: 'zhipu', key: '', revision: 1 });
  await repo.vaultCommand('unlock', { password: 'test-passphrase' });
  const settings = await repo.readAiSettings(); assert.equal(settings.apiKeys.deepseek, 'fake-other-protected'); assert.equal(settings.apiKeys.zhipu, '');
});

test('无口令迁移中断可恢复；口令迁移中断后的新 Key 不会在重试时丢失', async () => {
  const old = fixture().templates.defaultState(); old.settings.apiKeys = { zhipu: 'fake-old-migration' };
  const env = fixture({ wangshenAutofill: old }); await env.repo.initialize(); env.fail(1);
  await assert.rejects(env.repo.vaultCommand('setKey', { providerId: 'deepseek', key: 'fake-new-migration', revision: 0 }), /模拟磁盘/);
  const repo = env.restart(); assert.equal((await repo.readAiSettings()).apiKeys.deepseek, 'fake-new-migration');
  await repo.vaultCommand('setKey', { providerId: 'zhipu', key: 'fake-old-migration', revision: 0 });
  assert.ok(!JSON.stringify(env.disk).includes('fake-new-migration'));
  env.fail(2); await assert.rejects(repo.vaultCommand('setup', { password: 'test-passphrase' }), /模拟磁盘/);
  const pending = env.restart(); const state = await pending.readLegacy(); assert.equal(state.settings.vault.pendingMigration, true);
  await pending.vaultCommand('setKey', { providerId: 'zhipu', key: 'fake-after-interruption', revision: state.settings.vault.revision });
  await pending.vaultCommand('unlock', { password: 'test-passphrase' });
  assert.equal((await pending.readAiSettings()).apiKeys.zhipu, 'fake-after-interruption'); assert.equal(env.disk['localapply.deviceKeys'], null);
});

test('另一页面取消并重设口令后，旧会话失效但仍可无口令重填新 Key', async () => {
  const env = fixture(); await env.repo.initialize(); await env.repo.vaultCommand('setup', { password: 'first-passphrase' });
  const other = env.restart(); await other.vaultCommand('disable', { password: 'first-passphrase' });
  await other.vaultCommand('setup', { password: 'second-passphrase' });
  const current = await env.repo.readLegacy(); assert.equal(current.settings.vault.unlocked, false);
  await env.repo.vaultCommand('setKey', { providerId: 'zhipu', key: 'fake-new-tab-key', revision: current.settings.vault.revision });
  assert.equal((await env.repo.readAiSettings()).apiKeys.zhipu, 'fake-new-tab-key');
});

// 合成四类旧经历及其他档案，验证批量清理仅影响当前简历的经历关系。
async function cleanupFixture() {
  const env = fixture(); await env.repo.initialize();
  const other = (await command(env.repo, 'createProfile', { name: '合成另一简历' })).result;
  for (const [profileId, kinds] of [['p1', ['education', 'internship', 'employment', 'project']], [other, ['education']]]) {
    for (const kind of kinds) {
      const entryId = (await command(env.repo, 'createEntry', { profileId, kind, title: '合成旧经历' })).result;
      await command(env.repo, 'setValue', { profileId, entryId, fieldId: 'builtin.school', value: '合成经历值' });
      await command(env.repo, 'saveMapping', { profileId, entryId, fieldId: 'builtin.school', origin: 'https://example.test', path: '/apply', label: '合成学校' });
    }
  }
  await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.school', value: '合成基础值' });
  await env.repo.vaultCommand('setKey', { providerId: 'zhipu', key: 'fake-cleanup-key', revision: 0 });
  return { ...env, other };
}

test('清空旧经历需确认和版本，保留基础字段、其他简历、密钥并支持重启恢复', async () => {
  const env = await cleanupFixture(); const before = await env.repo.read();
  const settings = structuredClone(env.disk['localapply.apiSettings']); const keys = structuredClone(env.disk['localapply.deviceKeys']);
  for (const [payload, revision] of [[{ profileId: 'p1' }, before.revision], [{ profileId: 'p1', confirmed: true }, undefined], [{ profileId: 'p1', confirmed: true }, before.revision - 1], [{ profileId: 'missing', confirmed: true }, before.revision]]) {
    await assert.rejects(command(env.repo, 'clearResumeEntries', payload, revision));
    assert.deepEqual(await env.repo.read(), before);
  }
  const result = await command(env.repo, 'clearResumeEntries', { profileId: 'p1', confirmed: true }, before.revision);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { entries: 4, values: 4, mappings: 4 });
  const after = await env.restart().read();
  assert.ok(after.entries.every((entry) => entry.profileId === env.other));
  assert.ok(!after.fieldValues.some((row) => row.profileId === 'p1' && row.entryId !== null));
  assert.ok(!after.mappingRules.some((row) => row.profileId === 'p1'));
  assert.equal(value(after, 'p1', 'builtin.school'), '合成基础值');
  for (const table of ['fieldDefinitions', 'bindings', 'profiles']) assert.deepEqual(after[table], before[table]);
  for (const table of ['entries', 'fieldValues', 'mappingRules']) assert.deepEqual(after[table].filter((row) => row.profileId === env.other), before[table].filter((row) => row.profileId === env.other));
  assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before)); assert.deepEqual(env.disk['localapply.apiSettings'], settings); assert.deepEqual(env.disk['localapply.deviceKeys'], keys);
  await command(env.repo, 'clearResumeEntries', { profileId: 'p1', confirmed: true }, after.revision);
  assert.equal((await env.repo.read()).revision, after.revision); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
  await command(env.restart(), 'restoreRecovery', {}); const restored = await env.repo.read();
  for (const table of ['entries', 'fieldValues', 'mappingRules', 'fieldDefinitions']) assert.deepEqual(restored[table], before[table]);
  assert.equal((await env.repo.readAiSettings()).apiKeys.zhipu, 'fake-cleanup-key');
});

test('旧经历清理的恢复点或主库写入失败时不丢失当前资料', async () => {
  for (const failureAt of [0, 1]) {
    const env = await cleanupFixture(); const before = await env.repo.read(); env.fail(failureAt);
    await assert.rejects(command(env.repo, 'clearResumeEntries', { profileId: 'p1', confirmed: true }, before.revision), /模拟磁盘/);
    assert.deepEqual(await env.restart().read(), before);
  }
});

// 全字段清空覆盖隐藏、动态、类型化及旧经历值，保留原有定义和各档案的结构。
test('清空字段内容需确认和版本，原子清空当前档案并支持恢复', async () => {
  const env = await cleanupFixture();
  for (const [label, type, content] of [['合成数字', 'number', 0], ['合成布尔', 'boolean', false], ['合成多选', 'multiSelect', ['合成选项']]]) await command(env.repo, 'createField', { profileId: 'p1', definition: { label, type, group: '合成清空测试' }, value: content });
  await command(env.repo, 'importResume', { profileId: 'p1', fingerprint: 'f'.repeat(64), rows: [{ kind: 'basic', index: 0, key: 'name', value: '合成待清空姓名', evidence: { kind: 'manual', excerpt: '合成来源片段', page: 0, verified: false } }], overwrite: true }, (await env.repo.read()).revision);
  const before = await env.repo.read(); const settings = structuredClone(env.disk['localapply.apiSettings']); const keys = structuredClone(env.disk['localapply.deviceKeys']);
  const base = await env.repo.readLegacy(); const stale = structuredClone(base); stale.profiles.find((profile) => profile.id === 'p1').fields.find((field) => field.key === 'school').value = '合成旧页写回';
  for (const [payload, revision] of [[{ profileId: 'p1' }, before.revision], [{ profileId: 'p1', confirmed: true }, undefined], [{ profileId: 'p1', confirmed: true }, before.revision - 1], [{ profileId: 'missing', confirmed: true }, before.revision], [{ profileId: 'p1', confirmed: true, extra: true }, before.revision]]) {
    await assert.rejects(command(env.repo, 'clearProfileValues', payload, revision)); assert.deepEqual(await env.repo.read(), before);
  }
  const result = await command(env.repo, 'clearProfileValues', { profileId: 'p1', confirmed: true }, before.revision); const after = await env.restart().read();
  assert.equal(result.result.values, 9, '四段经历、基础院校、姓名和三项类型化字段均被清空；空值不计数');
  assert.ok(after.fieldValues.filter((row) => row.profileId === 'p1').every((row) => row.value === null && row.evidence === undefined));
  assert.equal(after.fieldValues.length, before.fieldValues.length);
  for (const table of ['profiles', 'fieldDefinitions', 'bindings', 'entries', 'mappingRules', 'drafts']) assert.deepEqual(after[table], before[table]);
  assert.deepEqual(after.fieldValues.filter((row) => row.profileId === env.other), before.fieldValues.filter((row) => row.profileId === env.other));
  assert.deepEqual(env.disk['localapply.apiSettings'], settings); assert.deepEqual(env.disk['localapply.deviceKeys'], keys); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
  await assert.rejects(env.repo.saveLegacy(base, stale), /资料已变化/);
  const empty = await command(env.repo, 'clearProfileValues', { profileId: 'p1', confirmed: true }, after.revision); assert.equal(empty.result.values, 0); assert.equal((await env.repo.read()).revision, after.revision); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
  await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '' });
  await command(env.repo, 'setValue', { profileId: 'p1', fieldId: before.fieldDefinitions.find((field) => field.label === '合成多选').fieldId, value: [] });
  const blank = await env.repo.read(); const noChange = await command(env.repo, 'clearProfileValues', { profileId: 'p1', confirmed: true }, blank.revision); assert.equal(noChange.result.values, 0); assert.equal((await env.repo.read()).revision, blank.revision); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
  await command(env.restart(), 'restoreRecovery', {}); assert.deepEqual((await env.repo.read()).fieldValues, before.fieldValues);
});

// 恢复点或主库落盘失败均不得造成半份简历被清空。
test('清空字段内容写入失败时保持原库及字段值', async () => {
  for (const failureAt of [0, 1]) {
    const env = fixture(); await env.repo.initialize(); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成失败保护值' }); const before = await env.repo.read(); env.fail(failureAt);
    await assert.rejects(command(env.repo, 'clearProfileValues', { profileId: 'p1', confirmed: true }, before.revision), /模拟磁盘/); assert.deepEqual(await env.restart().read(), before);
  }
});

// 构造目录 v1 的 175 字段合成库，含旧模块值、映射以及用户已移除的参考字段。
async function obsoleteCatalogFixture() {
  const seed = fixture(); await seed.repo.initialize(); await command(seed.repo, 'createProfile', { name: '合成第二简历' });
  await command(seed.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成保留姓名' });
  await command(seed.repo, 'createField', { profileId: 'p1', definition: { label: '合成旧模块自定义字段', group: '技能与其他' }, value: '合成旧分类内容' });
  const db = await seed.repo.read(); const current = new Set(seed.templates.PROFILE_TEMPLATE.map((field) => field.key));
  for (const field of seed.templates.SOE_LONG_TEMPLATE.filter((field) => !current.has(field.key))) {
    const fieldId = 'builtin.' + field.key; db.fieldDefinitions.push(seed.store.definition({ fieldId, label: field.label, type: field.inputType, group: field.group, options: field.options || [], aliases: [], description: '', version: 1 })); db.publicFieldIds.push(fieldId);
    for (const profile of db.profiles) {
      db.bindings.push({ profileId: profile.profileId, fieldId, fid: 'retired.' + field.key, key: field.key, sensitive: false, autoFill: false, material: !!field.material, custom: false });
      db.fieldValues.push({ profileId: profile.profileId, fieldId, entryId: null, value: '合成旧分类内容', updatedAt: new Date().toISOString(), source: 'manual' });
    }
  }
  db.mappingRules.push({ mappingId: 'obsolete.mapping', profileId: 'p1', entryId: null, fieldId: 'builtin.github', origin: 'https://example.test', path: '/apply', label: '合成旧映射' });
  db.bindings = db.bindings.filter((row) => row.profileId !== 'p1' || row.fieldId !== 'builtin.paperName'); db.fieldValues = db.fieldValues.filter((row) => row.profileId !== 'p1' || row.fieldId !== 'builtin.paperName');
  seed.store.validate(db);
  return { env: fixture({ ...seed.disk, [seed.store.DB_KEY]: JSON.parse(JSON.stringify(db)), [seed.store.CATALOG_KEY]: { version: 1 } }), before: JSON.parse(JSON.stringify(db)) };
}

test('目录 v2 删除六个旧模块及字段引用，保留参考字段、删除选择与恢复点', async () => {
  const { env, before } = await obsoleteCatalogFixture(); const db = await env.repo.read();
  assert.equal(db.fieldDefinitions.length, 155); assert.equal(db.schemaVersion, 5); assert.equal(db.revision, before.revision + 1);
  assert.equal(db.mappingRules.length, 0); assert.ok(db.fieldDefinitions.every((field) => !env.templates.REMOVED_PROFILE_GROUPS.includes(field.group)));
  assert.equal(value(db, 'p1', 'builtin.name'), '合成保留姓名'); assert.ok(!db.fieldValues.some((row) => row.value === '合成旧分类内容'));
  assert.ok(!db.bindings.some((row) => row.profileId === 'p1' && row.fieldId === 'builtin.paperName'), '新版本不能重新补回已移除的参考字段');
  assert.deepEqual(JSON.parse(JSON.stringify(db.profiles)), before.profiles); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
  assert.equal(env.disk[env.store.CATALOG_KEY].version, env.templates.CATALOG_VERSION); assert.deepEqual(await env.restart().read(), db);
  const recovery = structuredClone(env.disk['localapply.recovery']); await env.repo.read(); assert.deepEqual(env.disk['localapply.recovery'], recovery);
});

test('旧模块清理及标记原子保存，失败不改变原资料或恢复点', async () => {
  const { env, before } = await obsoleteCatalogFixture(); const disk = structuredClone(env.disk); env.fail();
  await assert.rejects(env.repo.read(), /模拟磁盘/); assert.deepEqual(env.disk, disk); assert.deepEqual(env.disk[env.store.DB_KEY], before);
  const db = await env.restart().read(); assert.equal(db.fieldDefinitions.length, 155); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
});

// 仅规范模型给出的日期表示，不补齐未给出的月份/日期，也不推算年龄。
test('出生日期保留年/月/日精度，中文及数字格式可无损规范化', () => {
  const { resume } = fixture();
  for (const [raw, expected] of [['1997 年 8 月', '1997-08'], ['1997.8', '1997-08'], ['1997/08', '1997-08'], ['1997年', '1997'], ['1988年2月29日', '1988-02-29'], ['1988/2/29', '1988-02-29'], ['1997-02-29', '1997-02-29'], ['1997年13月', '1997年13月'], ['农历八月', '农历八月']]) assert.equal(resume.normalizeBirthDate(raw), expected);
  assert.match(resume.prompt(), /birthDate:出生日期/); assert.match(resume.prompt(), /只有年月绝不补日/); assert.match(resume.prompt(), /不得根据年龄推算/);
});

// 兼容模型结构化生日别名，保留来源且默认不选；同义键冲突不能静默覆盖。
test('出生年月模型候选归入 birthDate，重复别名合并且冲突拒绝', () => {
  const { resume } = fixture(); const source = { type: 'docx', mode: 'vision', pages: ['合成页面'] };
  const raw = { basic: { birthYearMonth: { value: '1997 年 8 月', evidence: '出生年月：1997 年 8 月', page: 1 }, birthday: { value: '1997-08', evidence: '合成同义项', page: 1 } } }; const before = structuredClone(raw);
  const rows = resume.normalize(raw, source); assert.equal(rows.length, 1); assert.equal(rows[0].key, 'birthDate'); assert.equal(rows[0].value, '1997-08'); assert.equal(rows[0].checked, false); assert.equal(rows[0].evidence.excerpt, '出生年月：1997 年 8 月'); assert.equal(rows[0].evidence.verified, false); assert.deepEqual(raw, before);
  for (const key of ['birthDate', 'birth_date', 'dateOfBirth', '出生年月', '出生日期', '生日']) assert.equal(resume.normalize({ basic: { [key]: raw.basic.birthYearMonth } }, source)[0].key, 'birthDate');
  assert.throws(() => resume.normalize({ basic: { birthDate: raw.basic.birthYearMonth, birthday: { ...raw.basic.birthday, value: '1998-07' } } }, source), /不一致/);
});

// 出生年月写入原有基础字段；重绑仍标敏感，手工校对和覆盖策略保持原有约束。
test('出生年月确认后写入既有出生日期，保持精度、来源和覆盖策略', async () => {
  const env = fixture(); const before = await env.repo.read(); const base = await env.repo.readLegacy(); const next = structuredClone(base); next.profiles[0].fields = next.profiles[0].fields.filter((field) => field.key !== 'birthDate'); await env.repo.saveLegacy(base, next);
  const normalized = env.resume.normalize({ basic: { birthDate: { value: '1997 年 8 月', evidence: '出生年月：1997 年 8 月', page: 1 } } }, { type: 'docx', mode: 'vision', pages: ['合成页面'] });
  const rows = normalized.map(({ kind, index, key, value, evidence }) => ({ kind, index, key, value, evidence })); const payload = { profileId: 'p1', fingerprint: 'b'.repeat(64), rows, overwrite: false };
  assert.ok(!value(await env.repo.read(), 'p1', 'builtin.birthDate')); await command(env.repo, 'importResume', payload, (await env.repo.read()).revision);
  let db = await env.repo.read(); assert.equal(value(db, 'p1', 'builtin.birthDate'), '1997-08'); assert.equal(db.fieldDefinitions.length, before.fieldDefinitions.length); assert.ok(!db.fieldDefinitions.some((field) => field.fieldId === 'resume.birthDate')); assert.equal(db.bindings.find((row) => row.fieldId === 'builtin.birthDate').sensitive, true);
  assert.equal(db.fieldValues.find((row) => row.fieldId === 'builtin.birthDate').evidence.excerpt, '出生年月：1997 年 8 月');
  const edited = { ...payload, rows: [{ ...rows[0], value: '1998年7月', evidence: { kind: 'manual', excerpt: '', page: 0, verified: false } }] };
  const keep = await command(env.repo, 'importResume', edited, db.revision); assert.equal(keep.result.kept, 1); assert.equal(value(await env.repo.read(), 'p1', 'builtin.birthDate'), '1997-08');
  await command(env.repo, 'importResume', { ...edited, overwrite: true }, (await env.repo.read()).revision); db = await env.restart().read(); assert.equal(value(db, 'p1', 'builtin.birthDate'), '1998-07'); assert.equal(db.fieldValues.find((row) => row.fieldId === 'builtin.birthDate').evidence.kind, 'manual');
  assert.equal(value(env.store.parseBackup(await env.repo.exportBackup()), 'p1', 'builtin.birthDate'), '1998-07');
});

// 政治面貌必须明确提供，不从其他经历推断；仅精确同义简称允许对应下拉选项。
test('政治面貌纳入模型契约，明确同义键和值归一，歧义或冲突不猜测', () => {
  const { resume } = fixture(); const source = { type: 'docx', mode: 'vision', pages: ['合成页面'] }; const cell = { value: '团员', evidence: '政治面貌：团员', page: 1 };
  assert.match(resume.prompt(), /politicalStatus:政治面貌/); assert.match(resume.prompt(), /不推断政治面貌/);
  for (const key of ['politicalStatus', 'political_status', 'politicalAffiliation', '政治面貌', '政治状态']) {
    const rows = resume.normalize({ basic: { [key]: cell } }, source); assert.equal(rows[0].key, 'politicalStatus'); assert.equal(rows[0].value, '共青团员'); assert.equal(rows[0].checked, false); assert.equal(rows[0].evidence.excerpt, cell.evidence);
  }
  assert.equal(resume.normalizePoliticalStatus('中国共产党党员'), '中共党员'); assert.equal(resume.normalizePoliticalStatus('预备党员'), '中共预备党员');
  for (const value of ['党员', '无党派人士', '中国民主同盟盟员']) assert.equal(resume.normalizePoliticalStatus(value), value);
  assert.equal(resume.normalize({ basic: { politicalStatus: cell, 政治面貌: { ...cell, value: '共青团员' } } }, source).length, 1);
  assert.throws(() => resume.normalize({ basic: { politicalStatus: cell, 政治面貌: { ...cell, value: '群众' } } }, source), /政治面貌.*不一致/);
  assert.ok(!resume.normalize({ basic: { name: { value: '合成姓名', evidence: '合成姓名', page: 1 } } }, source).some((row) => row.key === 'politicalStatus'));
});

// 确认后写回已有 select 定义，保留来源和未知原文值，不改公共选项，也不默认覆盖已填写内容。
test('政治面貌导入写入既有下拉字段，来源、覆盖和自定义原文值保留', async () => {
  const env = fixture(); const before = await env.repo.read(); const definition = before.fieldDefinitions.find((field) => field.fieldId === 'builtin.politicalStatus'); assert.equal(definition.type, 'select');
  const evidence = { kind: 'vision', excerpt: '政治面貌：团员', page: 1, verified: false }; const payload = { profileId: 'p1', fingerprint: 'c'.repeat(64), overwrite: false, rows: [{ kind: 'basic', index: 0, key: 'politicalStatus', value: '团员', evidence }] };
  await command(env.repo, 'importResume', payload, before.revision); let db = await env.repo.read(); assert.equal(value(db, 'p1', 'builtin.politicalStatus'), '共青团员'); assert.deepEqual(db.fieldDefinitions.find((field) => field.fieldId === definition.fieldId), definition); assert.equal(db.fieldDefinitions.length, before.fieldDefinitions.length); assert.equal(db.fieldValues.find((row) => row.fieldId === definition.fieldId).evidence.excerpt, evidence.excerpt);
  const changed = { ...payload, rows: [{ ...payload.rows[0], value: '无党派人士', evidence: { kind: 'manual', excerpt: '', page: 0, verified: false } }] };
  assert.equal((await command(env.repo, 'importResume', changed, db.revision)).result.kept, 1); assert.equal(value(await env.repo.read(), 'p1', definition.fieldId), '共青团员');
  await command(env.repo, 'importResume', { ...changed, overwrite: true }, (await env.repo.read()).revision); db = await env.restart().read(); assert.equal(value(db, 'p1', definition.fieldId), '无党派人士'); assert.deepEqual(db.fieldDefinitions.find((field) => field.fieldId === definition.fieldId).options, definition.options);
});

// 模型缺失值只代表没有提供资料，不能替代原值；畸形非空字段仍按契约拒绝。
test('简历缺失、null 与空白字段跳过，不转换为清空或推断值', () => {
  const { resume } = fixture(); const source = { type: 'docx', mode: 'vision', pages: ['合成页面'] };
  const rows = resume.normalize({ basic: { name: { value: '合成新姓名', evidence: '合成新姓名', page: 1 }, phone: null, email: { value: null }, gpa: { value: '  ' } }, education: null }, source);
  assert.equal(rows.length, 1); assert.equal(rows[0].key, 'name'); assert.equal(rows[0].checked, false);
  assert.throws(() => resume.normalize({ basic: { phone: { value: 123 } } }, source), /格式/);
  assert.throws(() => resume.normalize({ basic: null, education: [] }, source), /没有符合/);
});

// 自动导入只覆盖返回的非空行，保留缺失字段及其他档案；来源不能冒充人工已核对。
test('简历自动导入优先覆盖已提取值，缺失保留，写前恢复点可撤销', async () => {
  const env = fixture(); await env.repo.initialize(); const other = (await command(env.repo, 'createProfile', { name: '合成保留档案' })).result;
  for (const [fieldId, content] of [['builtin.name', '合成旧姓名'], ['builtin.phone', '13900000000'], ['builtin.email', 'keep@example.test'], ['builtin.birthDate', '1988'], ['builtin.politicalStatus', '群众']]) await command(env.repo, 'setValue', { profileId: 'p1', fieldId, value: content });
  await command(env.repo, 'setValue', { profileId: other, fieldId: 'builtin.name', value: '合成另一姓名' });
  const cell = (value) => ({ value, evidence: '合成明确资料', page: 1 });
  const normalized = env.resume.normalize({ basic: { name: cell('合成新姓名'), birthDate: cell('1994年6月'), politicalStatus: cell('团员'), phone: null, email: { value: null }, gpa: cell(' ') } }, { type: 'docx', mode: 'vision', pages: ['合成页面'] });
  const before = await env.repo.read(); const result = await command(env.repo, 'autoImportResume', { profileId: 'p1', fingerprint: 'd'.repeat(64), rows: normalized.map(({ kind, index, key, value, evidence }) => ({ kind, index, key, value, evidence })), overwrite: true }, before.revision);
  assert.equal(result.result.saved, 3); assert.equal(result.result.overwritten, 3); const after = await env.restart().read();
  assert.equal(value(after, 'p1', 'builtin.name'), '合成新姓名'); assert.equal(value(after, 'p1', 'builtin.birthDate'), '1994-06'); assert.equal(value(after, 'p1', 'builtin.politicalStatus'), '共青团员'); assert.equal(value(after, 'p1', 'builtin.phone'), '13900000000'); assert.equal(value(after, 'p1', 'builtin.email'), 'keep@example.test');
  assert.equal(after.fieldValues.find((row) => row.profileId === 'p1' && row.fieldId === 'builtin.name').source, 'ai-imported'); assert.equal(after.fieldValues.find((row) => row.profileId === 'p1' && row.fieldId === 'builtin.name').evidence.verified, false);
  assert.deepEqual(after.fieldDefinitions, before.fieldDefinitions); assert.deepEqual(after.fieldValues.filter((row) => row.profileId === other), before.fieldValues.filter((row) => row.profileId === other)); assert.equal(JSON.stringify(env.disk['localapply.recovery']), JSON.stringify(before));
  await command(env.repo, 'restoreRecovery', {}); assert.deepEqual((await env.repo.read()).fieldValues, before.fieldValues);
});

// 自动覆盖必须具备有效目标、版本和完整行契约；恢复点或主库失败均不能出现部分写入。
test('自动导入的版本、结构和写入失败保护原资料', async () => {
  for (const failureAt of [0, 1]) {
    const env = fixture(); await env.repo.initialize(); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成原值' }); const before = await env.repo.read();
    const payload = { profileId: 'p1', fingerprint: 'e'.repeat(64), overwrite: true, rows: [{ kind: 'basic', index: 0, key: 'name', value: '合成新值', evidence: { kind: 'vision', excerpt: '合成新值', page: 1, verified: false } }] };
    await assert.rejects(command(env.repo, 'autoImportResume', payload)); await assert.rejects(command(env.repo, 'autoImportResume', payload, before.revision - 1)); await assert.rejects(command(env.repo, 'autoImportResume', { ...payload, overwrite: false }, before.revision)); await assert.rejects(command(env.repo, 'autoImportResume', { ...payload, rows: [] }, before.revision));
    env.fail(failureAt); await assert.rejects(command(env.repo, 'autoImportResume', payload, before.revision), /模拟磁盘/); assert.deepEqual(await env.restart().read(), before);
  }
});

// 全目录只包含当前档案绑定的元数据，不把个人值、已移除字段或其他档案定义发给模型。
test('完整简历解析目录覆盖 155 字段及自定义类型，移除后不补回，提示词不带个人值', async () => {
  const env = fixture(); await env.repo.initialize(); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成不得发送的原姓名' });
  const custom = (await command(env.repo, 'createField', { profileId: 'p1', definition: { label: '合成是非项', group: '自定义', type: 'boolean' }, value: false })).result;
  let db = await env.repo.read(); let fields = env.catalog.catalog(db, 'p1'); assert.equal(fields.length, 156); assert.equal(fields.find((field) => field.fieldId === custom).type, 'boolean'); assert.ok(fields.some((field) => field.fieldId === 'builtin.paperName'));
  assert.ok(!JSON.stringify(fields).includes('合成不得发送的原姓名')); assert.ok(!fields.some((field) => Object.hasOwn(field, 'value'))); assert.match(env.catalog.prompt(fields), /builtin\.employmentDepartment/); assert.match(env.catalog.prompt(fields), /record=0,1,2/);
  const base = await env.repo.readLegacy(); const next = structuredClone(base); next.profiles.find((profile) => profile.id === 'p1').fields = next.profiles.find((profile) => profile.id === 'p1').fields.filter((field) => field.key !== 'wechat'); await env.repo.saveLegacy(base, next); db = await env.repo.read(); fields = env.catalog.catalog(db, 'p1'); assert.ok(!fields.some((field) => field.fieldId === 'builtin.wechat'));
});

// 对目录每一种控件类型生成合成候选，验证不再受旧的 12 基础字段白名单限制。
test('155 项目录候选全部可解析，数字零、布尔否、多选及日期精度不丢失', async () => {
  const env = fixture(); const db = await env.repo.read(); const fields = env.catalog.catalog(db, 'p1'); const source = { type: 'docx', mode: 'vision', pages: ['合成图'] };
  const raw = { fields: fields.map((field) => ({ fieldId: field.fieldId, record: 0, value: field.type === 'number' ? 0 : field.type === 'multiSelect' ? ['合成城市'] : field.type === 'date' || field.fieldId === 'builtin.birthDate' ? '2001 年 2 月' : field.type === 'select' ? field.options[0] : '合成原文', evidence: '合成来源', page: 1 })) };
  const result = env.catalog.analyze(raw, source, fields); assert.equal(result.rows.length, 155); assert.ok(result.items.every((item) => item.status === 'ready')); env.catalog.validateRows(result.rows, fields);
  const saved = await command(env.repo, 'autoImportResume', { profileId: 'p1', fingerprint: '3'.repeat(64), catalog: fields, rows: result.rows, overwrite: true }, db.revision); assert.equal(saved.result.saved, 155); assert.equal((await env.repo.read()).fieldValues.filter((row) => row.value !== null && row.value !== '').length, 155);
  assert.equal(result.rows.find((row) => row.fieldId === 'builtin.currentSalary').value, 0); assert.equal(result.rows.find((row) => row.fieldId === 'builtin.birthDate').value, '2001-02'); assert.equal(result.rows.find((row) => row.fieldId === 'builtin.certificateDate').value, '2001-02'); assert.equal(JSON.stringify(result.rows.find((row) => row.fieldId === 'builtin.expectedCities').value), '["合成城市"]');
  const boolean = { fieldId: 'custom.boolean', label: '合成确认', group: '自定义', type: 'boolean', options: [], aliases: [], description: '', version: 1 };
  assert.equal(env.catalog.analyze({ fields: [{ fieldId: boolean.fieldId, value: '否' }] }, source, [boolean]).rows[0].value, false);
});

// 错误候选保留可读原因，冲突不覆盖；未知或恶意文本不能扩展字段定义和执行代码。
test('解析报告区分未匹配、缺失、错误类型及冲突，旧结构可按明确目录映射', async () => {
  const env = fixture(); const fields = env.catalog.catalog(await env.repo.read(), 'p1'); const source = { type: 'pdf', mode: 'vision', pages: ['合成图'] };
  const result = env.catalog.analyze({ fields: [
    { fieldId: 'builtin.name', value: '合成甲' }, { fieldId: 'builtin.name', value: '合成乙' },
    { fieldId: 'builtin.phone', value: null }, { fieldId: 'builtin.email', value: ' ' }, { fieldId: 'builtin.currentSalary', value: '两万元' },
    { fieldId: 'builtin.internshipEndDate', value: '至今' }, { fieldId: 'builtin.expectedCities', value: '合成市' },
    { fieldId: 'unknown', value: '<script>throw 1</script>' }, { fieldId: 'builtin.wechat', value: '<img src=x onerror=alert(1)>' },
    { fieldId: 'builtin.projectName', record: 101, value: '合成项目' },
  ], unmapped: [{ label: '合成未映射', value: '原文保留' }] }, source, fields);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].fieldId, 'builtin.wechat'); assert.equal(result.items.filter((item) => item.status === 'conflict').length, 2); assert.equal(result.items.filter((item) => item.status === 'missing').length, 2); assert.equal(result.items.filter((item) => item.status === 'invalid').length, 4); assert.equal(result.items.filter((item) => item.status === 'unmatched').length, 2);
  const old = env.catalog.analyze({ basic: { gender: { value: '男' }, ethnic: { value: '汉族' } }, employment: [{ company: { value: '合成企业' }, role: { value: '合成岗位' } }] }, source, fields);
  assert.equal(old.rows.length, 4); assert.ok(old.rows.some((row) => row.fieldId === 'builtin.employmentCompany' && row.index === 0));
});

// 同一模块首段覆盖基础字段，其余段按稳定 ID 保留；不生成新定义，也不覆盖缺失值和其他简历。
test('目录导入原子写回模块、保留多段及类型，备份重启和恢复完整兼容 v4', async () => {
  const env = fixture(); await env.repo.initialize(); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.phone', value: '13900000000' }); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.school', value: '合成旧学校' });
  const other = (await command(env.repo, 'createProfile', { name: '合成隔离' })).result; const before = await env.repo.read(); const catalog = env.catalog.catalog(before, 'p1');
  const raw = { fields: [{ fieldId: 'builtin.school', value: '合成第一学校' }, { fieldId: 'builtin.school', record: 1, value: '合成第二学校' }, { fieldId: 'builtin.major', record: 1, value: '合成第二专业' }, { fieldId: 'builtin.employmentCompany', value: '合成工作单位' }, { fieldId: 'builtin.projectName', value: '合成项目' }, { fieldId: 'builtin.currentSalary', value: 0 }, { fieldId: 'builtin.expectedCities', value: ['合成城市'] }] };
  const rows = env.catalog.analyze(raw, { type: 'pdf', mode: 'vision', pages: ['合成图'] }, catalog).rows; const payload = { profileId: 'p1', fingerprint: 'f'.repeat(64), overwrite: true, catalog, rows };
  const out = await command(env.repo, 'autoImportResume', payload, before.revision); assert.equal(out.result.saved, 7); assert.equal(out.result.overwritten, 1); assert.equal(out.result.details.find((row) => row.fieldId === 'builtin.school' && row.index === 0).status, 'overwritten');
  const db = await env.restart().read(); assert.equal(value(db, 'p1', 'builtin.school'), '合成第一学校'); assert.equal(value(db, 'p1', 'builtin.phone'), '13900000000'); assert.equal(value(db, 'p1', 'builtin.employmentCompany'), '合成工作单位'); assert.equal(value(db, 'p1', 'builtin.currentSalary'), 0); assert.equal(db.entries.length, 1); const entryId = db.entries[0].entryId; assert.equal(value(db, 'p1', 'builtin.school', entryId), '合成第二学校'); assert.equal(value(db, 'p1', 'builtin.major', entryId), '合成第二专业'); assert.ok(!db.fieldValues.some((row) => row.profileId === other && row.value === '合成第一学校')); assert.deepEqual(db.fieldDefinitions, before.fieldDefinitions);
  const backup = env.store.parseBackup(await env.repo.exportBackup()); assert.deepEqual(backup.fieldValues, db.fieldValues); assert.equal(db.schemaVersion, 5);
  await command(env.repo, 'autoImportResume', payload, db.revision); assert.equal((await env.repo.read()).entries.length, 1); await command(env.repo, 'restoreRecovery', {}); assert.deepEqual((await env.repo.read()).fieldValues, db.fieldValues);
  const old = (await command(env.repo, 'createEntry', { profileId: 'p1', kind: 'education', title: '合成旧记录' })).result; await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.school', entryId: old, value: '合成待清理学校' }); const latest = await env.repo.read();
  const cleared = await command(env.repo, 'clearResumeEntries', { profileId: 'p1', confirmed: true }, latest.revision); assert.equal(cleared.result.entries, 1); assert.equal((await env.repo.read()).entries[0].entryId, entryId); assert.equal(value(await env.repo.read(), 'p1', 'builtin.school', entryId), '合成第二学校');
});

// 目录和每条行必须由后台重验；客户端不能补回已删除字段、伪造类型或宣称已人工核实。
test('目录导入拒绝过期目录、断裂目标、伪造行及来源，手动模式仍保留未授权覆盖', async () => {
  const env = fixture(); const before = await env.repo.read(); const catalog = env.catalog.catalog(before, 'p1'); const rows = env.catalog.analyze({ fields: [{ fieldId: 'builtin.name', value: '合成姓名' }] }, { type: 'pdf', mode: 'vision', pages: ['合成图'] }, catalog).rows; const payload = { profileId: 'p1', fingerprint: '1'.repeat(64), catalog, rows, overwrite: true };
  for (const changed of [{ catalog: [] }, { profileId: 'not-a-profile' }, { rows: [{ ...rows[0], fieldId: 'not-a-field' }] }, { rows: [{ ...rows[0], value: false }] }, { rows: [{ ...rows[0], evidence: { ...rows[0].evidence, verified: true } }] }]) await assert.rejects(command(env.repo, 'autoImportResume', { ...payload, ...changed }, before.revision));
  assert.deepEqual(await env.repo.read(), before); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成手填原值' });
  const kept = await command(env.repo, 'importResume', { ...payload, overwrite: false }, (await env.repo.read()).revision); assert.equal(kept.result.kept, 1); assert.equal(kept.result.details[0].status, 'kept'); assert.equal(value(await env.repo.read(), 'p1', 'builtin.name'), '合成手填原值');
});

// 独立覆盖目录导入的两个落盘点，不能用 UI 故障注入代替真实存储失败保护。
test('目录自动导入恢复点或主库写入失败均保留原库', async () => {
  for (const failAt of [0, 1]) {
    const env = fixture(); const before = await env.repo.read(); const catalog = env.catalog.catalog(before, 'p1'); const rows = env.catalog.analyze({ fields: [{ fieldId: 'builtin.englishScore', value: '合成分数' }] }, { type: 'docx', mode: 'vision', pages: ['合成图'] }, catalog).rows;
    env.fail(failAt); await assert.rejects(command(env.repo, 'autoImportResume', { profileId: 'p1', fingerprint: '2'.repeat(64), catalog, rows, overwrite: true }, before.revision), /模拟磁盘/); assert.deepEqual(await env.restart().read(), before);
  }
});

// v3→v4 只扩展模块类型，必须在单次落盘中保留旧恢复点；失败不得动资料或凭据。
test('模块 Schema v4 原子迁移 v3 数据、备份及恢复点，不改旧字段/值/凭据', async () => {
  const seed = fixture(); await seed.repo.initialize(); await command(seed.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成升级保留' }); await seed.repo.vaultCommand('setKey', { providerId: 'zhipu', key: 'synthetic-schema-key', revision: 0 });
  const disk = structuredClone(seed.disk); disk[seed.store.DB_KEY].schemaVersion = 3; delete disk[seed.store.DB_KEY].applications; const old = structuredClone(disk[seed.store.DB_KEY]); const env = fixture(disk); env.fail(); await assert.rejects(env.repo.read(), /模拟磁盘/); assert.deepEqual(env.disk, disk);
  const db = await env.restart().read(); assert.equal(db.schemaVersion, 5); assert.equal(db.revision, old.revision + 1); for (const table of ['profiles','fieldDefinitions','fieldValues','entries','bindings','mappingRules']) assert.deepEqual(JSON.parse(JSON.stringify(db[table])), old[table]); assert.deepEqual(env.disk[env.store.RECOVERY_KEY], old); assert.deepEqual(env.disk[env.store.DEVICE_KEY], disk[seed.store.DEVICE_KEY]); assert.equal((await env.restart().read()).revision, db.revision);
  const oldBackup = { kind: 'localapply-ai-backup', formatVersion: 1, schemaVersion: 3, exportedAt: new Date().toISOString(), database: old }; assert.equal(env.store.parseBackup(oldBackup).schemaVersion, 5); await command(env.repo, 'restoreRecovery', {}); assert.equal(value(await env.repo.read(), 'p1', 'builtin.name'), '合成升级保留'); assert.equal((await env.repo.readAiSettings()).apiKeys.zhipu, 'synthetic-schema-key');
});

// 所有可重复模块共用定义；新增空记录不创建字段或复制其他记录的值。
test('八个模块可添加独立空记录，版本/档案/模块边界严格，共享定义不增殖', async () => {
  const env = fixture(); const before = await env.repo.read(); const catalog = env.catalog.catalog(before, 'p1'); assert.equal(Object.keys(env.templates.RECORD_GROUPS).length, 8); assert.ok(!Object.values(env.templates.RECORD_GROUPS).includes('英语能力'));
  for (const [kind, group] of Object.entries(env.templates.RECORD_GROUPS)) {
    const latest = await env.repo.read(); const added = await command(env.repo, 'addModuleRecord', { profileId: 'p1', group }, latest.revision); const entry = (await env.repo.read()).entries.find((entry) => entry.entryId === added.result); assert.equal(entry.kind, kind); assert.ok(entry.entryId.startsWith('catalog.')); assert.equal(entry.order, 1);
  }
  const db = await env.repo.read(); assert.equal(db.entries.length, 8); assert.deepEqual(db.fieldDefinitions, before.fieldDefinitions); assert.deepEqual(db.fieldValues, before.fieldValues); assert.equal(JSON.stringify(env.catalog.catalog(db, 'p1')), JSON.stringify(catalog));
  await assert.rejects(command(env.repo, 'addModuleRecord', { profileId: 'p1', group: '教育背景' })); await assert.rejects(command(env.repo, 'addModuleRecord', { profileId: 'other-profile', group: '教育背景' }, db.revision)); await assert.rejects(command(env.repo, 'addModuleRecord', { profileId: 'p1', group: '基本信息' }, db.revision));
});

// 三条不同奖项必须使用独立 record；乱序字段和预先手动添加的空槽位不能造成混写。
test('三条获奖记录乱序导入无冲突，复用手动槽位且所有字段按条目正确保存', async () => {
  const env = fixture(); let db = await env.repo.read(); const slot = (await command(env.repo, 'addModuleRecord', { profileId: 'p1', group: '获奖经历' }, db.revision)).result; db = await env.repo.read(); const catalog = env.catalog.catalog(db, 'p1');
  const raw = { fields: [2,0,1].flatMap((record) => [['awardName','合成奖项' + record], ['awardCategory','合成类别' + record], ['awardRank','合成等级' + record], ['awardLevel','合成级别' + record]].map(([key, value]) => ({ fieldId: 'builtin.' + key, record, value, evidence: value, page: 1 }))) };
  const analysis = env.catalog.analyze(raw, { type: 'pdf', mode: 'vision', pages: ['合成页面'] }, catalog); assert.equal(analysis.rows.length, 12); assert.ok(!analysis.items.some((item) => item.status === 'conflict')); assert.match(env.catalog.prompt(catalog), /获奖经历/); assert.match(env.catalog.prompt(catalog), /不同记录必须使用不同 record/);
  const payload = { profileId: 'p1', fingerprint: '4'.repeat(64), catalog, rows: analysis.rows, overwrite: true }; await command(env.repo, 'autoImportResume', payload, db.revision); db = await env.restart().read(); assert.equal(db.entries.length, 2); assert.equal(value(db, 'p1', 'builtin.awardName'), '合成奖项0'); assert.equal(value(db, 'p1', 'builtin.awardName', slot), '合成奖项1');
  const third = db.entries.find((entry) => entry.entryId !== slot); assert.equal(value(db, 'p1', 'builtin.awardName', third.entryId), '合成奖项2'); assert.equal(value(db, 'p1', 'builtin.awardRank', slot), '合成等级1'); assert.equal(value(db, 'p1', 'builtin.awardRank', third.entryId), '合成等级2'); assert.equal(db.fieldDefinitions.length, catalog.length);
  await command(env.repo, 'autoImportResume', { ...payload, fingerprint: '5'.repeat(64) }, db.revision); assert.equal((await env.repo.read()).entries.length, 2); assert.ok(!JSON.stringify(await env.repo.exportPublicFields()).includes('合成奖项'));
});

// 同一 record 内重复但矛盾的字段仍需拒绝，不能为了消除冲突擅自拆成新的奖项。
test('多记录导入不放宽真实冲突检查，家庭/证书/论文按各自模板隔离', async () => {
  const env = fixture(); const db = await env.repo.read(); const catalog = env.catalog.catalog(db, 'p1'); const source = { type: 'docx', mode: 'vision', pages: ['合成图'] };
  const conflicting = env.catalog.analyze({ fields: [{ fieldId: 'builtin.awardName', record: 0, value: '合成甲' }, { fieldId: 'builtin.awardName', record: 0, value: '合成乙' }] }, source, catalog); assert.equal(conflicting.rows.length, 0); assert.equal(conflicting.items.filter((item) => item.status === 'conflict').length, 2);
  const raw = { fields: [0,1].flatMap((record) => [['familyName1','合成家庭' + record], ['certificateName','合成证书' + record], ['paperName','合成论文' + record]].map(([key,value]) => ({ fieldId: 'builtin.' + key, record, value }))) }; const rows = env.catalog.analyze(raw, source, catalog).rows;
  await command(env.repo, 'autoImportResume', { profileId: 'p1', fingerprint: '6'.repeat(64), catalog, rows, overwrite: true }, db.revision); const after = await env.repo.read(); assert.equal(after.entries.length, 3); for (const kind of ['family','certificate','publication']) assert.equal(after.entries.filter((entry) => entry.kind === kind).length, 1); assert.equal(value(after, 'p1', 'builtin.name'), value(db, 'p1', 'builtin.name'));
});

// 兼容备份用 v3 可表达的私有平面字段保存新增记录，原 v4 库和公开定义绝不能被降级改写。
test('v4 新模块兼容导出 v3 保留值/证据/映射，可再次导入且不含凭据', async () => {
  const env = fixture(); let db = await env.repo.read(); const entryId = (await command(env.repo, 'addModuleRecord', { profileId: 'p1', group: '获奖经历' }, db.revision)).result;
  await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.awardName', entryId, value: '合成回滚奖项' }); await command(env.repo, 'saveMapping', { profileId: 'p1', fieldId: 'builtin.awardName', entryId, origin: 'https://example.test', path: '/apply', label: '合成奖项' }); db = await env.repo.read();
  const backup = await env.repo.exportBackup(3); assert.equal(backup.schemaVersion, 3); env.store.validate(backup.database, 3); assert.ok(backup.database.entries.every((entry) => ['education','internship','employment','project'].includes(entry.kind))); const row = backup.database.fieldValues.find((row) => row.value === '合成回滚奖项'); assert.equal(row.entryId, null); assert.ok(row.fieldId.startsWith('compat.')); assert.ok(backup.database.bindings.some((binding) => binding.profileId === 'p1' && binding.fieldId === row.fieldId)); assert.ok(!backup.database.publicFieldIds.includes(row.fieldId)); assert.equal(backup.database.mappingRules[0].fieldId, row.fieldId); assert.equal(backup.database.mappingRules[0].entryId, null);
  assert.deepEqual(await env.repo.read(), db); assert.equal(env.store.parseBackup(backup).schemaVersion, 5); const plan = await env.repo.previewImport(backup, 'replace'); await command(env.repo, 'importBackup', { backup, mode: 'replace' }, plan.revision); assert.ok((await env.repo.read()).fieldValues.some((row) => row.value === '合成回滚奖项')); await assert.rejects(env.repo.exportBackup(99));
});

// 删除附加条目需明确确认，级联仅影响该记录；恢复点和落盘失败均有独立验证。
test('模块记录删除保护共享字段与其他记录，确认/版本/故障和恢复均正确', async () => {
  for (const failureAt of [null,0,1]) {
    const env = fixture(); let db = await env.repo.read(); const entryId = (await command(env.repo, 'addModuleRecord', { profileId: 'p1', group: '证书信息' }, db.revision)).result; await command(env.repo, 'setValue', { profileId: 'p1', entryId, fieldId: 'builtin.certificateName', value: '合成证书内容' }); db = await env.repo.read(); const payload = { profileId: 'p1', entryId, confirmed: true };
    await assert.rejects(command(env.repo, 'deleteModuleRecord', { ...payload, confirmed: false }, db.revision)); await assert.rejects(command(env.repo, 'deleteModuleRecord', { ...payload, profileId: 'other' }, db.revision)); await assert.rejects(command(env.repo, 'deleteModuleRecord', payload));
    if (failureAt !== null) { env.fail(failureAt); await assert.rejects(command(env.repo, 'deleteModuleRecord', payload, db.revision), /模拟磁盘/); assert.deepEqual(await env.restart().read(), db); }
    else { await command(env.repo, 'deleteModuleRecord', payload, db.revision); assert.equal((await env.repo.read()).entries.length, 0); assert.deepEqual((await env.repo.read()).fieldDefinitions, db.fieldDefinitions); await command(env.repo, 'restoreRecovery', {}); assert.deepEqual((await env.repo.read()).fieldValues, db.fieldValues); }
  }
});

// 八模块的首条删除均应只移除指定内容，下一条整体迁入平面槽，字段定义和第三条保持独立。
test('模块首条删除按顺序保留其他经历、自定义字段、来源和映射，且支持恢复', async () => {
  const slots = [['教育背景','school'], ['实习经历','internshipCompany'], ['工作经历','employmentCompany'], ['项目经历','projectName'], ['家庭成员','familyName1'], ['获奖经历','awardName'], ['证书信息','certificateName'], ['论文期刊','paperName']];
  for (const [group, key] of slots) {
    const env = fixture(); await env.repo.read(); const fieldId = 'builtin.' + key;
    const other = (await command(env.repo, 'createProfile', { name: '合成另一份简历' })).result;
    await command(env.repo, 'setValue', { profileId: other, fieldId, value: '合成其他档案保留' });
    await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.name', value: '合成本人保留' });
    await command(env.repo, 'createField', { profileId: 'p1', definition: { ...def('custom.record-delete'), group }, value: '合成首条自定义' });
    await command(env.repo, 'setValue', { profileId: 'p1', fieldId, value: '合成首条删除' });
    let db = await env.repo.read(); const second = (await command(env.repo, 'addModuleRecord', { profileId: 'p1', group }, db.revision)).result;
    db = await env.repo.read(); const third = (await command(env.repo, 'addModuleRecord', { profileId: 'p1', group }, db.revision)).result;
    await command(env.repo, 'setValue', { profileId: 'p1', entryId: second, fieldId, value: '合成第二条保留', source: 'ai-imported' });
    await command(env.repo, 'setValue', { profileId: 'p1', entryId: second, fieldId: 'custom.record-delete', value: '合成第二条自定义' });
    await command(env.repo, 'setValue', { profileId: 'p1', entryId: third, fieldId, value: '合成第三条保留' });
    for (const [mappingId, entryId, profileId] of [['map.primary',null,'p1'], ['map.second',second,'p1'], ['map.third',third,'p1'], ['map.other',null,other], ['map.general',null,null]]) await command(env.repo, 'saveMapping', { mappingId, entryId, profileId, fieldId, origin: 'https://synthetic.example', path: '/apply', label: '合成字段' });
    db = await env.repo.read(); const promoted = db.fieldValues.filter((row) => row.entryId === second).map((row) => ({ ...row, entryId: null }));
    await command(env.repo, 'deleteModuleRecord', { profileId: 'p1', group, entryId: null, confirmed: true }, db.revision);
    const after = await env.restart().read(); assert.equal(JSON.stringify(after.fieldValues.filter((row) => row.profileId === 'p1' && promoted.some((item) => item.fieldId === row.fieldId) && row.entryId === null)), JSON.stringify(promoted));
    assert.ok(!after.entries.some((entry) => entry.entryId === second)); assert.ok(after.entries.some((entry) => entry.entryId === third));
    assert.equal(value(after, 'p1', fieldId, third), '合成第三条保留'); assert.equal(value(after, other, fieldId), '合成其他档案保留'); assert.equal(value(after, 'p1', 'builtin.name'), '合成本人保留');
    assert.deepEqual(after.fieldDefinitions, db.fieldDefinitions); assert.deepEqual(after.bindings, db.bindings);
    assert.equal(JSON.stringify(after.mappingRules), JSON.stringify(db.mappingRules.filter((rule) => rule.mappingId !== 'map.primary').map((rule) => ({ ...rule, entryId: rule.entryId === second ? null : rule.entryId }))));
    await command(env.repo, 'restoreRecovery', {}); const restored = await env.repo.read(); for (const table of ['fieldValues','entries','mappingRules']) assert.deepEqual(restored[table], db[table]);
  }
});

// 首条删除也须确认、精确模块和最新版本；两个落盘点失败时均不能半删个人资料。
test('模块首条删除验证确认和版本，存储失败不改变资料', async () => {
  for (const failureAt of [0, 1]) {
    const env = fixture(); await env.repo.read(); await command(env.repo, 'setValue', { profileId: 'p1', fieldId: 'builtin.awardName', value: '合成首条奖项' });
    const db = await env.repo.read(); const payload = { profileId: 'p1', group: '获奖经历', entryId: null, confirmed: true };
    for (const bad of [{ ...payload, confirmed: false }, { ...payload, profileId: 'missing' }, { ...payload, group: '基本信息' }, { ...payload, group: undefined }, { ...payload, entryId: undefined }]) await assert.rejects(command(env.repo, 'deleteModuleRecord', bad, db.revision));
    await assert.rejects(command(env.repo, 'deleteModuleRecord', payload)); await assert.rejects(command(env.repo, 'deleteModuleRecord', payload, db.revision - 1));
    env.fail(failureAt); await assert.rejects(command(env.repo, 'deleteModuleRecord', payload, db.revision), /模拟磁盘/); assert.deepEqual(await env.restart().read(), db);
  }
});

// 删掉最后一条时只保留绑定空模板；重复删除不能覆盖刚保存的恢复点，零值/布尔及证据也要清除。
test('模块最后一条删除清除值和证据，空模板重复操作保留恢复点', async () => {
  const env = fixture(); let db = await env.repo.read(); const catalog = env.catalog.catalog(db, 'p1');
  const rows = env.catalog.analyze({ fields: [{ fieldId: 'builtin.awardName', record: 0, value: '合成有来源奖项', evidence: '合成来源', page: 1 }] }, { type: 'docx', mode: 'vision', pages: ['合成图'] }, catalog).rows;
  await command(env.repo, 'autoImportResume', { profileId: 'p1', fingerprint: '3'.repeat(64), catalog, rows, overwrite: true }, db.revision);
  for (const [type, value] of [['number',0], ['boolean',false]]) await command(env.repo, 'createField', { profileId: 'p1', definition: { ...def('custom.delete-' + type), type, group: '获奖经历' }, value });
  db = await env.repo.read(); const payload = { profileId: 'p1', group: '获奖经历', entryId: null, confirmed: true }; await command(env.repo, 'deleteModuleRecord', payload, db.revision);
  const cleared = await env.repo.read(); const fieldIds = new Set(cleared.fieldDefinitions.filter((field) => field.group === '获奖经历').map((field) => field.fieldId));
  assert.ok(!cleared.fieldValues.some((row) => row.profileId === 'p1' && row.entryId === null && fieldIds.has(row.fieldId))); assert.deepEqual(cleared.bindings, db.bindings);
  const recovery = structuredClone(env.disk[env.store.RECOVERY_KEY]); await command(env.repo, 'deleteModuleRecord', payload, cleared.revision); assert.equal((await env.repo.read()).revision, cleared.revision); assert.deepEqual(env.disk[env.store.RECOVERY_KEY], recovery);
  await command(env.repo, 'restoreRecovery', {}); assert.deepEqual((await env.repo.read()).fieldValues, db.fieldValues);
});

// v3 数据不得偷渡 v4 类型；只有经过已知版本校验和原子升级后才能使用新增模块。
test('伪装 v3 的新增模块及未知版本在写入前拒绝', async () => {
  const seed = fixture(); const db = await seed.repo.read(); db.schemaVersion = 3; delete db.applications; db.entries.push({ entryId: 'catalog.invalid', profileId: 'p1', kind: 'award', title: '', order: 1 }); const env = fixture({ [seed.store.DB_KEY]: db }); await assert.rejects(env.repo.read(), /类型/); assert.deepEqual(env.disk[seed.store.DB_KEY], JSON.parse(JSON.stringify(db)));
});
