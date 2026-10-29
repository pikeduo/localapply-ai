// 公共选项语义使用合成枚举；不读取个人库，也不按相似度或候选顺序猜选。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/value-resolver.js'), 'utf8'), context);
const V = context.LocalApplyValueResolver;

// 候选数组只传允许的标签/编码，不传页面节点或私有信息。
function options(...labels) { return labels.map((label, index) => ({ label, value: 'code.' + index })); }

test('选项语义：工作经验明确等价及字段ID隔离，来源保持原样', () => {
  const source = '不足一年'; const rows = options('在校生', '应届毕业生', '1 年以下', '1年', '1年以上'); const before = structuredClone(rows);
  const result = V.resolve('builtin.workExperience', source, rows); assert.equal(result.status, 'resolved'); assert.equal(result.index, 2); assert.equal(result.reasonCode, 'explicit_equivalent');
  assert.equal(V.resolve('private.workExperience', source, rows).status, 'incompatible');
  for (const value of ['1年以内', '1年及以下', '一年以上', '0.5年', '6个月']) assert.equal(V.equivalent('builtin.workExperience', value, '1年以下'), false);
  assert.equal(V.equivalent('builtin.workExperience', '应届生', '应届毕业生'), true); assert.equal(V.equivalent('builtin.workExperience', '在校生', '应届生'), false);
  assert.deepEqual(rows, before); assert.equal(source, '不足一年');
});

test('选项语义：同义候选重复、重复编码及禁用目标仍拒绝', () => {
  assert.equal(V.resolve('builtin.workExperience', '1年以下', options('不足一年', '1 年以下')).status, 'ambiguous');
  assert.equal(V.resolve('builtin.gender', '男', [{ label: '男', value: 'M' }, { label: '其他', value: 'M' }]).status, 'ambiguous');
  assert.equal(V.resolve('builtin.gender', '男', [{ label: '男性', value: 'M', disabled: true }]).reasonCode, 'unsupported_control');
  assert.equal(V.resolve('builtin.gender', '男', [{ label: '男性', value: 'M', protected: true }]).status, 'incompatible');
});

test('选项语义：原生编码与明确性别同义兼容，不截断学校校区或合并学历学位', () => {
  const rows = [{ label: '男性', value: 'M' }, { label: '女性', value: 'F' }];
  assert.equal(V.resolve('builtin.gender', '男', rows).index, 0); assert.equal(V.resolve('builtin.gender', 'M', rows).reasonCode, 'exact');
  assert.equal(V.equivalent('builtin.school', '合成大学（A校区）', '合成大学'), false);
  assert.equal(V.equivalent('builtin.degree', '学士', '本科'), false);
  assert.equal(V.equivalent('builtin.birthDate', '2000-06-01', '2000-06'), false);
  assert.equal(V.normalize('１\u200b 年以下'), '1 年以下');
});

test('选项语义：空候选、错误输入、恶意标签不触发代码或首项回退', () => {
  for (const rows of [[], [{}], Array.from({ length: 501 }, () => ({ label: '男', value: 'M' }))]) assert.notEqual(V.resolve('builtin.gender', '男', rows).status, 'resolved');
  assert.equal(V.resolve('builtin.gender', null, options('男')).status, 'incompatible');
  assert.equal(V.resolve('builtin.gender', 'globalThis.__optionExecuted=true', options('男')).status, 'incompatible');
  assert.equal(context.__optionExecuted, undefined);
});
