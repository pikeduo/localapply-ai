// AI 候选预算仅使用合成元数据及有值标记，不联网、不执行模型或页面代码。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
const context = vm.createContext({});
for (const name of ['templates', 'field-matching', 'field-suggestions']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/' + name + '.js'), 'utf8'), context);
const S = context.FieldSuggestions;

// 模拟后添加的相关字段，refs 携带多余值只用于验证出口投影不会泄漏。
function fixture(count = 250) {
  const definitions = Array.from({ length: count }, (_, i) => ({ fieldId: 'public.synthetic.' + String(i).padStart(4, '0'), label: '合成项目' + i,
    group: '其他', type: 'text', aliases: [], options: [] }));
  const sources = definitions.map((def, i) => ({ ref: 'source.' + i, fieldId: def.fieldId, kind: '', hasValue: i === count - 1, value: '不得发送的合成私密值', profileId: '不得发送的档案' }));
  const fields = [{ scanId: 'scan.synthetic', label: '入读方向补充', kind: 'education', group: '教育背景' }];
  definitions[count - 1].label = '入读方向'; definitions[count - 1].group = '教育背景';
  return { definitions, sources, fields };
}

test('AI目录预算：超过200个字段，后添加的相关定义和来源引用仍可发送', () => {
  const input = fixture(); const { payload, coverage } = S.catalogPreview(input.definitions, input.sources, input.fields);
  assert.equal(payload.catalog.length, 200); assert.equal(coverage.omitted, 50); assert.equal(coverage.available, 250);
  assert.ok(payload.catalog.some((def) => def.fieldId === 'public.synthetic.0249')); assert.ok(payload.sources.some((row) => row.ref === 'source.249'));
  assert.ok(!JSON.stringify(payload).includes('不得发送')); assert.equal(coverage.strategy, 'context-label-round-robin');
});

test('AI目录预算：明确分类轮流分配，顺序稳定，零分候选也可人工查看', () => {
  const input = fixture(400); input.fields.push({ scanId: 'scan.second', label: '其他未知情况', kind: 'employment', group: '工作经历' });
  input.fields[0].label = '未知教育条目'; input.fields[1].label = '未知工作条目';
  input.definitions.forEach((def, i) => { def.group = i < 200 ? '教育背景' : '工作经历'; });
  const before = JSON.stringify(input); const result = S.catalogPreview(input.definitions, input.sources, input.fields);
  assert.equal(result.payload.catalog.filter((def) => def.group === '教育背景').length, 100);
  assert.equal(result.payload.catalog.filter((def) => def.group === '工作经历').length, 100);
  assert.equal(JSON.stringify(input), before);
  input.definitions.reverse(); assert.equal(JSON.stringify(S.catalogPreview(input.definitions, input.sources, input.fields)), JSON.stringify(result));
});

test('AI目录预算：字符预算包含来源，不截断引用组，提示被省略数量', () => {
  const input = fixture(100); input.definitions.forEach((def) => { def.options = Array.from({ length: 100 }, () => '合'.repeat(80)); });
  const { payload, coverage } = S.catalogPreview(input.definitions, input.sources, input.fields);
  assert.ok(JSON.stringify(payload).length <= 60000); assert.ok(coverage.omitted > 0);
  assert.ok(payload.sources.every((row) => payload.catalog.some((def) => def.fieldId === row.fieldId)));
  assert.equal(payload.sources.length, payload.catalog.length);
  assert.throws(() => S.catalogPreview(input.definitions, input.sources, [{ label: '合'.repeat(60001) }]), /减少选择/);
});

test('AI目录预算：继续脱敏元数据，未绑定定义不发出，模型提示说明目录非全量', () => {
  const input = fixture(); input.definitions[249].label = '合成邮箱 demo@example.test'; input.definitions[249].aliases = ['sk-synthetic-key'];
  input.definitions.push({ fieldId: 'unbound', label: '不发送的未绑定定义', group: '其他', type: 'text', aliases: [], options: [] });
  const { payload, coverage } = S.catalogPreview(input.definitions, input.sources, input.fields); const text = JSON.stringify(payload);
  assert.equal(coverage.available, 250); assert.ok(!text.includes('unbound') && !text.includes('demo@example.test') && !text.includes('sk-synthetic-key'));
  assert.ok(S.messages(payload)[0].content.includes('候选子集'));
});
