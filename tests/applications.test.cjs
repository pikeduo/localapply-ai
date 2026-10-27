// 阶段五领域与迁移测试：仅合成岗位、隔离存储和确定性网页响应，不联网。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
// 加载实际发行模块，存储失败发生在写入前，避免用复制实现掩盖原子性问题。
function fixture(initial = {}) {
  const disk = structuredClone(initial); let failing = false; const context = vm.createContext({ crypto: require('node:crypto').webcrypto, URL, Date, TextEncoder, TextDecoder, btoa, atob });
  for (const name of ['templates', 'key-vault', 'resume', 'resume-catalog', 'field-matching', 'applications', 'local-store', 'job-tracking']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/' + name + '.js'), 'utf8'), context);
  const storage = { get: async (names) => structuredClone(Object.fromEntries((Array.isArray(names) ? names : [names]).map((key) => [key, disk[key]]))), setAccessLevel: async () => {}, set: async (values) => { if (failing) { failing = false; throw new Error('合成磁盘错误'); } Object.assign(disk, structuredClone(values)); } };
  return { context, disk, storage, A: context.LocalApplyApplications, store: context.LocalApplyStore, repo: context.LocalApplyStore.createRepository(storage), fail: () => { failing = true; } };
}
// 合成岗位包含可移除的跟踪参数，不含真实公司、职位或用户资料。
function job(overrides = {}) { return { companyName: '合成科技', jobTitle: '合成开发工程师', jobUrl: 'https://jobs.example.test/jobs/123?utm_source=test&token=synthetic-secret', jobId: '123', jobSource: '合成招聘', location: '合成甲城', employmentType: '全职', summary: '合成职位摘要', ...overrides }; }
// 用户明确确认后才执行保存，并绑定最新库版本。
async function save(env, record = job(), extra = {}) { const db = await env.repo.read(); return env.repo.command({ action: 'saveApplication', expectedRevision: db.revision, payload: { record, confirmed: true, newRound: false, ...extra } }); }
// 从规范库中查找申请，不读取任何兼容填充台账。
async function application(env, id) { return (await env.repo.read()).applications.find((record) => record.applicationId === id); }

test('申请默认仅收藏，显式确认及版本不可省略，凭据和简历不受影响', async () => {
  const env = fixture(); const before = await env.repo.read();
  for (const payload of [{ record: job(), newRound: false }, { record: job(), newRound: false, confirmed: false }]) await assert.rejects(env.repo.command({ action: 'saveApplication', payload, expectedRevision: before.revision }), /确认/);
  await assert.rejects(env.repo.command({ action: 'saveApplication', payload: { record: job(), newRound: false, confirmed: true } }), /版本/);
  assert.deepEqual(await env.repo.read(), before); const saved = await save(env); const row = await application(env, saved.result.applicationId);
  assert.equal(row.status, 'saved'); assert.equal(row.appliedAt, null); assert.equal(row.round, 1); assert.equal(row.history.length, 1); assert.equal(row.jobUrl, 'https://jobs.example.test/jobs/123');
  assert.deepEqual((await env.repo.read()).fieldValues, before.fieldValues); assert.equal((await env.repo.read()).ledger.length, 0);
});

test('同岗位仅补空白，不覆盖状态或备注，新轮次明确创建且保持独立', async () => {
  const env = fixture(); const first = await save(env, job({ location: '', notes: '合成私有备注', status: 'interview' }));
  const duplicate = await save(env, job({ notes: '不应覆盖', status: 'applied' })); assert.equal(duplicate.result.duplicate, true);
  const row = await application(env, first.result.applicationId); assert.equal(row.location, '合成甲城'); assert.equal(row.status, 'interview'); assert.equal(row.notes, '合成私有备注');
  const next = await save(env, job(), { newRound: true }); assert.notEqual(next.result.applicationId, first.result.applicationId); assert.equal((await application(env, next.result.applicationId)).round, 2); assert.equal((await env.repo.read()).applications.length, 2);
});

test('岗位去重优先站点 ID；无 ID 时采用规范链接、公司和名称，保留不同站点', async () => {
  const env = fixture(); await save(env); await save(env, job({ jobUrl: 'https://jobs.example.test/jobs/123?utm_campaign=other', jobTitle: '更名但同 ID' })); assert.equal((await env.repo.read()).applications.length, 1);
  await save(env, job({ jobUrl: 'https://another.example.test/jobs/123' })); await save(env, job({ jobId: '', jobTitle: '不同岗位' })); assert.equal((await env.repo.read()).applications.length, 3);
  assert.equal(env.A.cleanUrl('https://jobs.example.test/open?jobId=17&email=synthetic&session=x#token'), 'https://jobs.example.test/open?jobId=17');
});

test('状态、日期、备注、标签、待办和归档可编辑，变更进入有序时间线', async () => {
  const env = fixture(); const first = await save(env); let row = await application(env, first.result.applicationId);
  const edit = { ...Object.fromEntries(env.A.EDIT_KEYS.map((key) => [key, row[key]])), status: 'applied', notes: '合成备注', tags: ['校招'], todos: [{ id: 'todo.synthetic', text: '准备面试', done: false }], archived: true };
  await save(env, edit, { applicationId: row.applicationId }); row = await application(env, row.applicationId); assert.ok(row.appliedAt); assert.equal(row.history.at(-1).status, 'applied'); assert.equal(row.archived, true); assert.equal(row.todos[0].done, false);
  await save(env, { ...edit, status: 'custom:已沟通', appliedAt: row.appliedAt }, { applicationId: row.applicationId }); row = await application(env, row.applicationId); assert.equal(env.A.statusLabel(row.status), '已沟通'); assert.equal(row.history.length, 3);
});

test('列表和导出复用搜索、状态、日期、城市、平台、类型及归档筛选', async () => {
  const env = fixture(); await save(env, job({ status: 'applied', appliedAt: '2026-10-01T00:00:00.000Z', notes: '重点关注' })); await save(env, job({ jobId: '456', jobUrl: 'https://jobs.example.test/jobs/456', location: '合成乙城', archived: true })); const all = (await env.repo.read()).applications;
  assert.equal(env.A.filter(all, { search: '关注', status: 'applied', from: '2026-10-01', to: '2026-10-01', city: '合成甲城', source: '合成招聘', type: '全职' }).length, 1);
  assert.equal(env.A.filter(all, { archived: 'archived' }).length, 1); assert.equal(env.A.filter(all, { archived: 'all' }).length, 2); assert.equal(env.A.filter(all, { from: '2027-01-01' }).length, 0);
});

test('独立 JSON 往返、冲突保留及去重，错误导入不写库', async () => {
  const env = fixture(); await save(env); const exported = env.A.exportPackage((await env.repo.read()).applications); const other = fixture(); const db = await other.repo.read();
  const result = await other.repo.command({ action: 'importApplications', expectedRevision: db.revision, payload: { backup: exported, confirmed: true } }); assert.equal(result.result.added, 1);
  const again = await other.repo.command({ action: 'importApplications', expectedRevision: result.revision, payload: { backup: exported, confirmed: true } }); assert.equal(again.result.duplicates, 1);
  const conflict = JSON.parse(JSON.stringify(exported)); conflict.applications[0].notes = '导入的冲突备注'; assert.equal(env.A.importPlan((await other.repo.read()).applications, env.A.parsePackage(conflict)).conflicts, 1);
  const before = await other.repo.read(); for (const invalid of [{ ...exported, schemaVersion: 2 }, { ...exported, apiKey: 'synthetic' }, { ...exported, applications: [{ ...exported.applications[0], history: [] }] }]) await assert.rejects(other.repo.command({ action: 'importApplications', expectedRevision: before.revision, payload: { backup: invalid, confirmed: true } })); assert.deepEqual(await other.repo.read(), before);
});

test('CSV 含 BOM、中文和安全转义，公式、引号及换行不执行', async () => {
  const env = fixture(); await save(env, job({ companyName: '=1+1', notes: '合成"备注\n第二行' })); const csv = env.A.csv((await env.repo.read()).applications);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\'=1+1"')); assert.ok(csv.includes('合成""备注\n第二行')); assert.ok(csv.includes('\r\n')); assert.ok(!csv.includes('apiKey'));
});

test('申请严格拒绝可执行链接、额外数据、伪造事件与异常日期', async () => {
  const env = fixture(); const before = await env.repo.read();
  for (const record of [job({ jobUrl: 'javascript:alert(1)' }), job({ jobUrl: 'https://user:secret@jobs.example.test/' }), job({ status: 'automatic' }), job({ status: 'custom:' }), job({ appliedAt: '2026-02-30T00:00:00.000Z' }), job({ secret: 'synthetic' })]) await assert.rejects(save(env, record));
  assert.deepEqual(await env.repo.read(), before); await save(env); const packageData = env.A.exportPackage((await env.repo.read()).applications); packageData.applications[0].history[0].source = 'web-auto'; assert.throws(() => env.A.parsePackage(packageData));
});

test('v4→v5 原子迁移保留全部旧表及凭据，失败不改变存储，恢复点可升级', async () => {
  const seed = fixture(); await seed.repo.read(); const disk = structuredClone(seed.disk); const old = disk[seed.store.DB_KEY]; old.schemaVersion = 4; delete old.applications;
  const env = fixture(disk); env.fail(); await assert.rejects(env.repo.read(), /磁盘/); assert.deepEqual(env.disk, disk);
  const db = await env.repo.read(); assert.equal(db.schemaVersion, 5); assert.equal(db.applications.length, 0); assert.deepEqual(env.disk[env.store.RECOVERY_KEY], old);
  for (const key of ['profiles', 'fieldValues', 'entries', 'bindings', 'mappingRules', 'fieldDefinitions']) assert.deepEqual(JSON.parse(JSON.stringify(db[key])), old[key]);
  assert.deepEqual(env.disk[env.store.API_KEY], disk[seed.store.API_KEY]); await env.repo.command({ action: 'restoreRecovery', payload: {} }); assert.equal((await env.repo.read()).schemaVersion, 5);
});

test('申请进入完整备份及恢复，兼容 v4/v3 不含新表，公共定义无私人记录', async () => {
  const env = fixture(); const saved = await save(env); const full = await env.repo.exportBackup(); assert.equal(full.database.applications.length, 1); assert.ok(!JSON.stringify(await env.repo.exportPublicFields()).includes('合成科技'));
  for (const version of [3, 4]) { const old = await env.repo.exportBackup(version); assert.equal(old.schemaVersion, version); assert.equal(old.database.applications, undefined); assert.equal(env.store.parseBackup(old).applications.length, 0); }
  const target = fixture(); const preview = await target.repo.previewImport(full, 'merge'); assert.equal(preview.applicationsAdded, 1); await target.repo.command({ action: 'importBackup', expectedRevision: preview.revision, payload: { backup: full, mode: 'merge' } }); assert.ok(await application(target, saved.result.applicationId));
});

// 旧备份没有申请表，覆盖前必须明确显示删除数，取消预览不能改变原库。
test('旧备份覆盖预览显示申请移除数量，合并保留申请，恢复点可撤销覆盖', async () => {
  const env = fixture(); await save(env); const before = await env.repo.read(); const old = await env.repo.exportBackup(4);
  const merged = await env.repo.previewImport(old, 'merge'); assert.equal(merged.applicationsRemoved, 0);
  const preview = await env.repo.previewImport(old, 'replace'); assert.equal(preview.applicationsRemoved, 1); assert.deepEqual(await env.repo.read(), before);
  await env.repo.command({ action: 'importBackup', expectedRevision: preview.revision, payload: { backup: old, mode: 'replace' } }); assert.equal((await env.repo.read()).applications.length, 0);
  await env.repo.command({ action: 'restoreRecovery', payload: {} }); assert.deepEqual((await env.repo.read()).applications, before.applications);
});

test('申请写入、过期版本及删除失败保护原库，删除不影响另一轮和简历', async () => {
  const env = fixture(); const first = await save(env); const second = await save(env, job(), { newRound: true }); const before = await env.repo.read();
  await assert.rejects(env.repo.command({ action: 'deleteApplication', expectedRevision: before.revision - 1, payload: { applicationId: first.result.applicationId, confirmed: true } }), /变化/);
  env.fail(); await assert.rejects(save(env, job({ jobId: '789' })), /磁盘/); assert.deepEqual(await env.repo.read(), before);
  await env.repo.command({ action: 'deleteApplication', expectedRevision: before.revision, payload: { applicationId: first.result.applicationId, confirmed: true } }); const after = await env.repo.read(); assert.ok(after.applications.some((row) => row.applicationId === second.result.applicationId)); assert.deepEqual(after.fieldValues, before.fieldValues);
});

// 使用真实岗位会话模块检查成功反馈边界；浏览器端真实点击另由 Playwright 验证。
async function tracking() {
  const env = fixture(); await env.repo.read(); let feedback = 'unknown'; let url = 'https://jobs.example.test/jobs/123';
  const browser = { runtime: { id: 'synthetic-extension' }, storage: { session: env.storage }, tabs: { get: async () => ({ url }), sendMessage: async () => ({ ok: true, documentId: 'document.synthetic', candidate: env.A.candidate(job()), feedback, recognized: true }) } };
  const sender = { id: browser.runtime.id, tab: { id: 42 }, frameId: 0, url }; const service = env.context.LocalApplyJobTracking.create(env.repo, browser);
  return { ...env, service, sender, feedback: (value) => { feedback = value; }, url: (value) => { url = value; sender.url = value; } };
}

test('没有用户提交时，成功反馈不会建议已投递或自动建立记录', async () => {
  const env = await tracking(); await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); const view = await env.service.scan(42); assert.equal(view.successSuggested, false); assert.equal((await env.repo.read()).applications.length, 0);
});

test('用户提交、失败、成功、取消和关闭只改变待确认会话，确认前不入库', async () => {
  const env = await tracking(); await env.service.observe(env.sender, { type: 'jobs:submitted', candidate: env.A.candidate(job()), documentId: 'document.synthetic', feedbackBefore: 'unknown' });
  assert.equal((await env.service.scan(42)).successSuggested, false); await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'failed' }); assert.equal((await env.service.scan(42)).feedback, 'failed');
  await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); assert.equal((await env.service.scan(42)).successSuggested, true); assert.equal((await env.repo.read()).applications.length, 0);
  await env.service.close(42); assert.equal((await env.service.scan(42)).successSuggested, false);
});

test('提交前已有成功提示不构成新成功；跨域和伪造内容脚本反馈被拒绝', async () => {
  const env = await tracking(); env.feedback('success'); await env.service.observe(env.sender, { type: 'jobs:submitted', candidate: env.A.candidate(job()), documentId: 'document.synthetic', feedbackBefore: 'success' }); await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); assert.equal((await env.service.scan(42)).successSuggested, false);
  await assert.rejects(env.service.observe({ ...env.sender, frameId: 1 }, { type: 'jobs:feedback', status: 'success' }), /来源/);
  await assert.rejects(env.service.observe({ ...env.sender, id: 'other' }, { type: 'jobs:feedback', status: 'success' }), /来源/); env.url('https://other.example.test/success'); await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); assert.equal((await env.service.scan(42)).successSuggested, false);
});

// 同步页面可能在后台回查前已成功，成功依据必须使用捕获阶段的提交前状态。
test('同步成功回查不会吞掉新提交反馈，缺少提交前状态仍保守忽略', async () => {
  const env = await tracking(); env.feedback('success');
  await env.service.observe(env.sender, { type: 'jobs:submitted', candidate: env.A.candidate(job()), documentId: 'document.synthetic', feedbackBefore: 'unknown' });
  await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); assert.equal((await env.service.scan(42)).successSuggested, true);
  await env.service.observe(env.sender, { type: 'jobs:submitted', candidate: env.A.candidate(job()), documentId: 'document.synthetic' });
  await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); assert.equal((await env.service.scan(42)).successSuggested, false);
});

// SPA 的消息来源地址可能仍指向初始文档，不能用旧路径拒绝同文档的当前岗位。
test('SPA 提交核对后台标签地址与文档，旧 sender.url 不丢失有效提交', async () => {
  const env = await tracking(); env.sender.url = 'https://jobs.example.test/careers';
  await env.service.observe(env.sender, { type: 'jobs:submitted', candidate: env.A.candidate(job()), documentId: 'document.synthetic', feedbackBefore: 'unknown' });
  await env.service.observe(env.sender, { type: 'jobs:feedback', status: 'success' }); assert.equal((await env.service.scan(42)).successSuggested, true);
  await env.service.close(42); await env.service.observe(env.sender, { type: 'jobs:submitted', candidate: env.A.candidate(job({ jobUrl: 'https://jobs.example.test/jobs/other' })), documentId: 'document.synthetic', feedbackBefore: 'unknown' });
  assert.equal((await env.service.scan(42)).successSuggested, false);
});
