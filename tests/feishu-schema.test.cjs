// 飞书 Schema 专项纯测试：真实配置副本、合成个人值；无浏览器、无网络、无用户资料。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

// 独立加载生产模块，防止配置或资料缓存跨测试污染。
function runtime() {
  const ctx = vm.createContext({ URL, crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob });
  for (const file of ['templates', 'feishu-schema', 'field-matching', 'mapping-compat', 'providers', 'key-vault', 'resume', 'applications', 'local-store']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', file + '.js'), 'utf8'), ctx);
  return ctx;
}

// 两份配置仅含企业表单元数据，随测试保留；临时交接目录不参与测试依赖。
function sample(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/feishu-schema', name + '.website-info.json'), 'utf8')); }

// 合成扫描封套保留旧指纹；飞书证据只在本次消息内附加。
function field(M, label = '所在地点', group = '基本信息', kind = '', evidence) {
  const row = { scanId: 'scan.synthetic', label, group, kind, degree: '', index: 0, type: 'text', name: '', placeholder: '', options: [] };
  row.semanticId = M.semanticId(row); if (evidence) row.feishu = evidence; return row;
}

// 代码只作为证据，不携带个人值、来源条目或 DOM 选择器。
function evidence(groupCode = 'basic_info', fieldCode = 'current_city', state = 'linked', part = 'value') {
  return { version: 1, scope: 'fs.0123456789abcdef', key: 'fs.abcdef0123456789', groupCode, fieldCode, state, part };
}

test('飞书 Schema：v5/v2 字段、可见性、重复性和必填冲突归一化', () => {
  const S = runtime().LocalApplyFeishuSchema;
  for (const [name, version, groups, fields, visible, custom] of [['moonton', 5, 13, 51, 33, 5], ['modelbest', 2, 12, 46, 21, 0]]) {
    const result = S.parse(JSON.stringify(sample(name)), S.pageScope(`https://${name}.jobs.feishu.cn/campus/resume/123/apply`));
    assert.equal(result.status, 'ready'); const normalized = result.schema;
    assert.equal(normalized.version, version); assert.equal(normalized.groups.length, groups); assert.equal(normalized.fields.length, fields);
    assert.equal(normalized.fields.filter((row) => row.effectiveVisible).length, visible); assert.equal(normalized.fields.filter((row) => !row.is_predefined).length, custom);
    assert.ok(normalized.groups.find((row) => row.code === 'education_list').repeatable);
    assert.ok(normalized.fields.find((row) => row.code === 'birthday').is_predefined);
    assert.equal(normalized.fields.find((row) => row.code === 'birthday').datePrecision, 2);
    if (name === 'moonton') {
      assert.ok(normalized.fields.filter((row) => row.groupCode === 'career_list').every((row) => !row.effectiveVisible));
      assert.ok(normalized.requiredConflicts.includes('internship_list.company'));
      const options = normalized.fields.find((row) => row.label === '获取职位信息的渠道').options;
      assert.ok(options.some((row, i) => options.some((other, j) => i !== j && other.label === row.label && other.value !== row.value)));
      assert.ok(options.some((row) => row.active_status === 2));
    }
    assert.ok(!JSON.stringify(normalized).includes('web_visual_ui_config'));
  }
});

test('飞书 Schema：两企业共有46条标准路径，受控表只映射30条明确含义', () => {
  const S = runtime().LocalApplyFeishuSchema;
  const schemas = ['moonton', 'modelbest'].map((name) => S.parse(JSON.stringify(sample(name))).schema);
  const standard = schemas.map((schema) => schema.fields.filter((row) => row.is_predefined).map((row) => row.groupCode + '.' + row.code).sort());
  assert.deepEqual(standard[0], standard[1]); assert.equal(standard[0].length, 46);
  const supported = schemas[0].fields.filter((row) => S.target(row.groupCode, row.code) || S.target(row.groupCode, row.code, 'start'));
  assert.equal(supported.length, 30);
  assert.equal(S.target('basic_info', 'name'), 'builtin.name'); assert.equal(S.target('project_list', 'name'), 'builtin.projectName');
  assert.equal(S.target('award_list', 'name'), 'builtin.awardName'); assert.equal(S.target('career_list', 'desc'), 'builtin.employmentDescription');
  assert.equal(S.target('internship_list', 'desc'), 'builtin.internshipDescription');
  assert.equal(S.target('education_list', 'start_end_time', 'start'), 'builtin.educationStartDate');
  assert.equal(S.target('education_list', 'start_end_time', 'end'), 'builtin.graduationDate');
  for (const code of ['identification', 'age', 'experience_years', 'preferred_city_list']) assert.equal(S.target('basic_info', code), null);
  assert.equal(S.target('education_list', 'academic_ranking'), null); assert.equal(S.target('language_list', 'proficiency'), null);
  assert.equal(S.target('__proto__', 'name'), null);
});

test('飞书 Schema：精确域名/申请路由和网站路径门控，不硬编码企业和职位', () => {
  const S = runtime().LocalApplyFeishuSchema;
  assert.ok(S.pageScope('https://new-company.jobs.feishu.cn/index/resume/987654/apply?from=x'));
  // 数字站点路径由企业配置声明，不能因首字符为数字漏掉申请页；其他域名和路由边界保持严格。
  assert.equal(S.pageScope('https://poizon.jobs.feishu.cn/578078/resume/7670391208300775699/apply?from=test')?.path, '578078');
  assert.equal(S.pageScope('https://new-company.jobs.feishu.cn/123abc/resume/987654/apply')?.path, '123abc');
  for (const url of ['http://moonton.jobs.feishu.cn/campus/resume/1/apply', 'https://jobs.feishu.cn/campus/resume/1/apply', 'https://moonton.jobs.feishu.cn.evil.test/campus/resume/1/apply', 'https://moonton.jobs.feishu.cn/campus/position/1/detail', 'https://moonton.jobs.feishu.cn:8080/campus/resume/1/apply', 'https://poizon.jobs.feishu.cn/578078/extra/resume/1/apply', 'https://poizon.jobs.feishu.cn/' + '1'.repeat(42) + '/resume/1/apply']) assert.equal(S.pageScope(url), null);
  assert.equal(S.parse(JSON.stringify(sample('moonton')), { path: 'social' }).status, 'scope_mismatch');
});

// 得物下载源码只有配置，无已渲染表单；使用公共元数据副本验证v11，不包含个人资料。
test('飞书 Schema：数字站点v11保留可见性和自定义边界，仍拒绝坏结构和未知版本', () => {
  const S = runtime().LocalApplyFeishuSchema; const raw = sample('poizon');
  const page = S.pageScope('https://poizon.jobs.feishu.cn/578078/resume/123456/apply');
  const result = S.parse(JSON.stringify(raw), page); assert.equal(result.status, 'ready');
  const schema = result.schema; assert.equal(schema.version, 11); assert.equal(schema.path, '578078');
  assert.equal(schema.groups.length, 22); assert.equal(schema.fields.length, 174); assert.equal(schema.fields.filter((row) => row.effectiveVisible).length, 34);
  assert.equal(schema.requiredConflicts.length, 4);
  for (const code of ['career_list', 'language_list']) assert.ok(schema.fields.filter((row) => row.groupCode === code).every((row) => !row.effectiveVisible));
  const custom = schema.fields.find((row) => row.label === '家庭现居住地'); assert.equal(custom.is_predefined, false); assert.equal(custom.code, ''); assert.equal(S.target(custom.groupCode, custom.code), null);
  const role = schema.fields.find((row) => row.groupCode === 'project_list' && row.code === 'role'); assert.equal(role.effectiveVisible, true); assert.equal(S.target(role.groupCode, role.code), 'builtin.projectRole');
  assert.equal(S.parse(JSON.stringify(raw), { path: '578079' }).status, 'scope_mismatch');
  for (const version of [6, 10, 12, '11']) { const bad = structuredClone(raw); bad.website_info.resume_form_schema.version = version; assert.equal(S.parse(JSON.stringify(bad), page).status, 'unsupported_version'); }
  const bad = structuredClone(raw); bad.website_info.resume_form_schema.object_list[0].children[0].attributes.parent = 'wrong'; assert.equal(S.parse(JSON.stringify(bad), page).status, 'invalid_structure');
});

test('飞书 Schema：空白、损坏、未知版本、错误父子和超限数据安全回退', () => {
  const S = runtime().LocalApplyFeishuSchema;
  for (const [input, status] of [['', 'empty_schema'], ['{', 'invalid_json'], ['x'.repeat(S.LIMIT + 1), 'size_limit'], ['{}', 'invalid_structure']]) assert.equal(S.parse(input).status, status);
  for (const mutate of [
    (raw) => { delete raw.tenant_info.tenant_id_md5; },
    (raw) => { raw.website_info.resume_form_schema.object_list[1].children[0].attributes.parent = 'wrong'; },
    (raw) => { raw.website_info.resume_form_schema.object_list[1].children[0].attributes.visible = 'true'; },
    (raw) => { raw.website_info.resume_form_schema.object_list[1].children[0].attributes.name.zh_cn = '<script>'; },
    (raw) => { raw.website_info.resume_form_schema.object_list.push(raw.website_info.resume_form_schema.object_list[0]); }
  ]) { const raw = sample('moonton'); mutate(raw); assert.equal(S.parse(JSON.stringify(raw)).status, 'invalid_structure'); }
  const raw = sample('moonton'); raw.website_info.resume_form_schema.version = 99; assert.equal(S.parse(JSON.stringify(raw)).status, 'unsupported_version');
  assert.equal(S.parse('{"__proto__":{}}').status, 'invalid_structure');
  let deep = {}; for (let i = 0; i < 30; i++) deep = { child: deep }; assert.equal(S.parse(JSON.stringify(deep)).status, 'size_limit');
});

test('飞书 Schema：递归父级可见性与必填差异保留，HTML夹具内容一致', () => {
  const S = runtime().LocalApplyFeishuSchema; const raw = sample('moonton');
  const groups = raw.website_info.resume_form_schema.object_list; const basic = groups.find((row) => row.attributes.field_type.name === 'basic_info');
  const child = basic.children[0];
  basic.children = [{ id: 'synthetic-nested-group', attributes: { ...basic.attributes, parent: basic.id, visible: false, field_type: { type: 'group', name: 'nested_basic' }, name: { zh_cn: '嵌套合成组' } }, children: [child] }];
  child.attributes.parent = 'synthetic-nested-group';
  const parsed = S.parse(JSON.stringify(raw)); assert.equal(parsed.status, 'ready'); assert.equal(parsed.schema.fields.find((row) => row.id === child.id).effectiveVisible, false);
  assert.equal(parsed.schema.groups.find((row) => row.code === 'nested_basic').parent, basic.id);
  for (const company of ['moonton', 'modelbest']) {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/feishu-schema', company + '.inline-script.fixture.html'), 'utf8');
    const body = html.match(/<script id="js-websiteInfo" type="text\/json">([\s\S]*?)<\/script>/)[1];
    assert.deepEqual(JSON.parse(body), sample(company));
  }
});

test('飞书 Schema：诊断只保留固定原因和有界数量，不保留原配置或资料', () => {
  const S = runtime().LocalApplyFeishuSchema;
  const counts = Object.fromEntries(['version', 'groups', 'fields', 'visible', 'requiredConflicts', 'associated', 'custom', 'hidden', 'ambiguous', 'unsupported', 'control_conflict', 'unassociated'].map((key) => [key, 0]));
  const result = S.diagnostic({ ...counts, status: 'invalid_json', value: '禁止个人内容', tenant_id_md5: '禁止企业ID', html: '禁止HTML' });
  assert.equal(result.status, 'invalid_json'); assert.equal(result.value, undefined); assert.equal(result.tenant_id_md5, undefined);
  assert.equal(S.diagnostic({ ...counts, status: '任意异常正文' }), null); assert.equal(S.diagnostic({ ...counts, status: 'ready', fields: 1000000 }), null);
});

test('飞书 Schema：扫描证据严格白名单且不改变历史 features/semanticId', () => {
  const ctx = runtime(); const M = ctx.FieldMatchingEngine; const plain = field(M); const linked = field(M, undefined, undefined, undefined, evidence());
  assert.equal(M.validateField(linked), linked); assert.equal(M.semanticId(linked), plain.semanticId); assert.deepEqual(M.features(linked), M.features(plain));
  for (const extra of [{ value: '禁止个人值' }, { selector: '#wrong' }, { state: 'execute' }, { scope: 'http://wrong' }, { fieldCode: '<script>' }]) {
    const bad = structuredClone(linked); Object.assign(bad.feishu, extra); assert.throws(() => M.validateField(bad));
  }
});

test('飞书 Schema：本地资料匹配增强、缺值、不确定项和历史规则优先', async () => {
  const ctx = runtime(); const M = ctx.FieldMatchingEngine; const disk = {};
  const repo = ctx.LocalApplyStore.createRepository({ get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, disk[key]])), set: async (values) => Object.assign(disk, structuredClone(values)), setAccessLevel: async () => {} });
  let db = await repo.read(); const profileId = db.activeProfileId;
  await repo.command({ action: 'setValue', payload: { profileId, fieldId: 'builtin.currentCity', value: '合成城市' } }); db = await repo.read();
  const plain = field(M); const linked = field(M, undefined, undefined, undefined, evidence());
  assert.equal(M.match(db, profileId, 'https://a.jobs.feishu.cn', [plain])[0].target, null);
  const enhanced = M.match(db, profileId, 'https://a.jobs.feishu.cn', [linked])[0]; assert.equal(enhanced.status, 'matched'); assert.equal(enhanced.target.fieldId, 'builtin.currentCity'); assert.equal(enhanced.source, 'schema');
  const birthday = field(M, '出生日期', '基本信息', '', evidence('basic_info', 'birthday'));
  assert.equal(M.match(db, profileId, 'https://a.jobs.feishu.cn', [birthday])[0].status, 'missing_value');
  for (const state of ['custom', 'hidden', 'ambiguous', 'control_conflict', 'unsupported']) {
    const blocked = field(M, '姓名', '基本信息', '', evidence('basic_info', 'name', state));
    const row = M.match(db, profileId, 'https://a.jobs.feishu.cn', [blocked])[0]; assert.equal(row.target, null); assert.equal(row.status, 'needs_confirmation');
  }
  const origin = 'https://a.jobs.feishu.cn';
  db.mappingRules.push({ profileId, origin, semanticId: linked.semanticId, features: M.features(linked), fieldId: 'builtin.name', entryId: null, confirmed: true, lastVerifiedAt: '2026-01-01' });
  assert.equal(M.match(db, profileId, origin, [linked])[0].target.fieldId, 'builtin.name');
  assert.equal(M.match(db, profileId, 'https://b.jobs.feishu.cn', [linked])[0].target.fieldId, 'builtin.currentCity');
});

test('飞书 Schema：多条经历仍需当前整条来源绑定，不能按 Schema 顺序取首条', async () => {
  const ctx = runtime(); const M = ctx.FieldMatchingEngine; const disk = {};
  const repo = ctx.LocalApplyStore.createRepository({ get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, disk[key]])), set: async (values) => Object.assign(disk, structuredClone(values)), setAccessLevel: async () => {} });
  const profileId = (await repo.read()).activeProfileId;
  await repo.command({ action: 'setValue', payload: { profileId, fieldId: 'builtin.school', value: '合成学校甲' } });
  const entryId = (await repo.command({ action: 'createEntry', payload: { profileId, kind: 'education', title: '合成记录' } })).result;
  await repo.command({ action: 'setValue', payload: { profileId, fieldId: 'builtin.school', entryId, value: '合成学校乙' } });
  const db = await repo.read(); const row = field(M, '学校名称', '教育经历', 'education', evidence('education_list', 'school'));
  const result = M.match(db, profileId, 'https://a.jobs.feishu.cn', [row])[0]; assert.equal(result.status, 'needs_confirmation'); assert.equal(result.target, null); assert.equal(result.candidates.length, 2);
  assert.equal(db.schemaVersion, 5); assert.ok(!JSON.stringify(db).includes('fs.0123456789abcdef'));
});
