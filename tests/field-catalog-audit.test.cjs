// 词典审计只用合成元数据；不连接用户档案、第三方扩展或网络。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { auditCatalog, repositoryCatalog } = require('../tools/audit-field-catalog.cjs');

// 构造同组/跨组/重复与正则标记，所有字段均为公共测试定义。
function fixture() {
  return { fields: [
    { key: 'school', label: '学校', group: '教育背景', patterns: ['学校', '院校', ' 院校：', '', 're:(a+)+$'] },
    { key: 'firstSchool', label: '第一学历院校', group: '教育背景', patterns: ['院校'] },
    { key: 'employer', label: '单位', group: '工作经历', patterns: ['学校'] },
  ], indexKeys: ['school', 'firstSchool', 'employer'], synonyms: [{ key: 'missing', patterns: ['不存在'] }] };
}

// 同组碰撞与跨分类歧义分别报告，不能按出现顺序选一个目标。
test('公共词典审计：规范化碰撞、空别名、失效目标和上下文分类', () => {
  const report = auditCatalog(fixture());
  assert.ok(report.findings.some((row) => row.code === 'same_group_collision' && row.normalized === '院校' && row.keys.join() === 'firstSchool,school'));
  assert.ok(report.findings.some((row) => row.code === 'context_required' && row.normalized === '学校' && row.groups.join() === '工作经历,教育背景'));
  assert.equal(report.summary.counts.normalized_duplicate, 1); assert.equal(report.summary.counts.empty_alias, 1);
  assert.equal(report.summary.counts.missing_target, 1); assert.equal(report.summary.counts.regex_review, 1);
  assert.equal(report.summary.fields, 3); assert.equal(report.summary.groups, 2);
});

// 审计不能执行输入正则或代码；明显会卡顿的表达式也只进入审查提示。
test('公共词典审计：正则和恶意字符串仅作为元数据，素材不参与匹配', () => {
  const input = fixture(); const attack = 'globalThis.__auditExecuted = true';
  input.fields[0].patterns.push(attack, 're:' + '(a+)+$'.repeat(50));
  input.synonyms.push({ key: 'school', material: true, patterns: ['院校', attack] });
  const before = structuredClone(input); const report = auditCatalog(input);
  assert.equal(globalThis.__auditExecuted, undefined); assert.deepEqual(input, before);
  assert.equal(report.summary.counts.regex_review, 2);
  assert.ok(!report.findings.some((row) => row.scope === 'synonyms' && row.code === 'same_group_collision'));
});

// 合法跨模块复用独立提示；不误判为模块内冲突或自动合并。
test('公共词典审计：教育与工作同名可由上下文区分，顺序不影响报告', () => {
  const input = fixture(); input.fields[0].patterns = ['院校', '院校'];
  const report = auditCatalog(input); assert.equal(report.summary.counts.duplicate_alias, 1);
  input.fields.reverse(); input.synonyms.reverse(); input.indexKeys.reverse(); input.fields.forEach((row) => row.patterns.reverse());
  assert.deepEqual(auditCatalog(input), report);
  assert.equal(report.summary.counts.context_required, 1);
});

// 任何意外个人属性一律拒绝，错误消息不回显输入内容。
test('公共词典审计：拒绝个人值、未知属性、超限和错误输入', () => {
  for (const mutate of [
    (input) => { input.fields[0].value = '合成私密内容'; },
    (input) => { input.profiles = []; },
    (input) => { input.fields[0].patterns.push('x'.repeat(1001)); },
    (input) => { input.synonyms[0].material = '是'; },
    (input) => { input.fields[0].key = '<script>'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => auditCatalog(input), { message: '审计仅接受有界公共词典元数据' }); }
  assert.throws(() => auditCatalog(null), /公共词典元数据/);
});

// 重复 key 必须显式展示，不让 Map 覆盖掩盖定义问题。
test('公共词典审计：同 key 重复与规范化后的空名称都有记录', () => {
  const input = fixture(); input.fields.push({ ...input.fields[0], label: '必填：', patterns: [] });
  const report = auditCatalog(input); assert.equal(report.summary.counts.duplicate_key, 1); assert.equal(report.summary.counts.empty_metadata, 1);
});

// 固定仓库投影只包含公共元数据，能重复生成同一报告，不包含时间/个人库。
test('公共词典审计：真实仓库元数据稳定投影，命令行无需浏览器或工作目录', () => {
  const catalog = repositoryCatalog(); const report = auditCatalog(catalog);
  assert.ok(report.summary.fields > 100); assert.ok(report.summary.indexKeys >= report.summary.fields);
  assert.deepEqual(auditCatalog(repositoryCatalog()), report);
  assert.ok(catalog.fields.every((row) => Object.keys(row).sort().join() === 'group,key,label,patterns'));
  const script = path.resolve(__dirname, '../tools/audit-field-catalog.cjs');
  const result = spawnSync(process.execPath, [script, '--json'], { cwd: path.parse(script).root, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), report);
  const rejected = spawnSync(process.execPath, [script, '--input', '不读取的个人路径'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(rejected.status, 1); assert.ok(!rejected.stderr.includes('个人路径'));
});
