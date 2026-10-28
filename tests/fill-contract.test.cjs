// 最小填写契约与私有计划守卫：合成资料/局部 DOM 桩，不联网，不替代浏览器验收。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 载入生产契约与填写验证器，保留真实匹配/日期逻辑，只替代原生节点接口。
function fixture(storageType = 'select', value = '男', controlType = 'select') {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, Date, setTimeout });
  for (const file of ['data/templates.js', 'data/field-matching.js', 'data/fill-contract.js', 'content/field-adapters.js', 'content/controls/text.js', 'content/controls/registry.js', 'content/verified-fill.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const db = { revision: 7, activeProfileId: 'profile.a', profiles: [{ profileId: 'profile.a' }, { profileId: 'profile.b' }], entries: [{ profileId: 'profile.b', entryId: 'entry.b' }],
    fieldDefinitions: [{ fieldId: 'builtin.synthetic', type: storageType }], fieldValues: [{ profileId: 'profile.a', fieldId: 'builtin.synthetic', entryId: null, value }] };
  const M = context.FieldMatchingEngine; const C = context.LocalApplyFillContract;
  const field = { scanId: 'scan.synthetic', label: '合成字段', name: '', placeholder: '', options: [], group: '', kind: '', degree: '', index: 0, type: controlType }; field.semanticId = M.semanticId(field);
  const intent = C.createIntent(db, 'profile.a', { fieldId: 'builtin.synthetic', entryId: null }, field, { sessionId: 'session.a', documentId: 'document.a', tabId: 42 });
  // 桩只提供本步骤实际读取的接口；不模拟点击成功或伪造框架状态。
  const option = (label, code) => ({ textContent: label, value: code, disabled: false, getAttribute: () => null, closest: () => null });
  const attrs = { type: controlType }; const el = { tagName: controlType === 'select' ? 'SELECT' : 'INPUT', type: controlType, value: '', isConnected: true, options: [option('男', 'M'), option('女', 'F')], selectedOptions: [], getAttribute: (name) => attrs[name] ?? null, matches: () => false, closest: () => null };
  const item = { el, members: [el], field, control: M.controlDescriptor(field) }; let current = item;
  context.LocalApplyPageScanner = { record: () => current, readValue: (next) => next.el.value };
  return { context, db, field, intent, item, C, planner: context.LocalApplyFillPlanner, attrs, option, current: (next) => { current = next; } };
}

// 旧字段 type 仅作为资料投影来源，改变网页类型不会修改枚举或历史日期原文。
test('逻辑类型投影覆盖七种旧定义，保留 0、false、自定义枚举和日期精度', () => {
  const expected = { text: 'string', textarea: 'string', select: 'enum', number: 'number', boolean: 'boolean', date: 'date', multiSelect: 'string-array' };
  for (const [storageType, logicalType] of Object.entries(expected)) {
    const value = storageType === 'number' ? 0 : storageType === 'boolean' ? false : storageType === 'multiSelect' ? ['合成城市'] : storageType === 'date' ? '2001-06' : '自定义原文';
    const env = fixture(storageType, value, 'text'); const before = JSON.stringify(env.db);
    assert.equal(env.intent.valueType.logicalType, logicalType); assert.deepEqual(JSON.parse(JSON.stringify(env.intent.value)), value); assert.equal(JSON.stringify(env.db), before);
    assert.equal(env.intent.valueType.editorHint, storageType);
  }
});

// 不用格式正确代替来源证明，跨档案经历、已删除字段和值缺失均不能签发意图。
test('意图只能从当前档案实际来源签发，明确核对版本和文档', () => {
  const env = fixture(); const binding = { sessionId: 'session.a', documentId: 'document.a', tabId: 42 };
  assert.throws(() => env.C.createIntent(env.db, 'profile.a', { fieldId: 'builtin.synthetic', entryId: 'entry.b' }, env.field, binding), /当前档案/);
  assert.throws(() => env.C.createIntent(env.db, 'profile.b', { fieldId: 'builtin.synthetic', entryId: null }, env.field, binding), /档案已变化/);
  assert.throws(() => env.C.createIntent(env.db, 'profile.a', { fieldId: 'builtin.missing', entryId: null }, env.field, binding), /缺少实际资料/);
  for (const expected of [{ binding: { documentId: 'document.other' } }, { binding: { scanId: 'scan.other' } }, { source: { revision: 8 } }, { source: { entryId: 'entry.b' } }, { value: '不同值' }]) assert.throws(() => env.C.validateIntent(env.intent, expected));
});

// 恶意属性不能成为代码；即使资料值看似代码，它也只按普通字符串处理。
test('意图和计划严格拒绝额外属性、错误 JSON 类型与任意操作', () => {
  const env = fixture(); const prepared = env.planner.prepare(env.item, env.intent); assert.ok(prepared.plan);
  for (const extra of [{ javascript: 'globalThis.compromised=true' }, { xpath: '//button' }, { execute: () => {} }, { operation: 'submit' }]) {
    assert.throws(() => env.C.validateIntent({ ...env.intent, ...extra }));
    assert.throws(() => env.C.validatePlan({ ...prepared.plan, ...extra }, env.intent));
  }
  for (const value of [null, [], {}, false, 1, () => {}]) assert.throws(() => env.C.validateIntent({ ...env.intent, value }));
  assert.throws(() => env.C.validateIntent({ ...env.intent, valueType: { ...env.intent.valueType, logicalType: 'string' } }));
  const guarded = { ...env.intent }; Object.defineProperty(guarded, 'value', { enumerable: true, get() { throw new Error('不应执行 getter'); } }); assert.throws(() => env.C.validateIntent(guarded), /契约格式/);
  const literal = fixture('text', '<script>globalThis.compromised=true</script>', 'text'); literal.C.validateIntent(literal.intent); assert.equal(literal.context.compromised, undefined);
});

// label→编码必须来自唯一当前候选；重复、禁用及不存在的候选没有可用计划。
test('原生计划从唯一真实标签取得 M 编码，拒绝歧义与禁用目标', () => {
  const env = fixture(); const prepared = env.planner.prepare(env.item, env.intent); const plan = prepared.plan;
  assert.equal(plan.operation, 'select-option'); assert.equal(plan.targetOption.label, '男'); assert.equal(plan.targetOption.value, 'M'); assert.equal(plan.verification, 'selected-option'); assert.equal(env.item.el.value, '');
  env.item.el.options.push(env.option('男', 'other')); assert.equal(env.planner.prepare(env.item, env.intent).error.diagnostic.reasonCode, 'ambiguous_option');
  env.item.el.options.pop(); env.item.el.options[0].disabled = true; assert.equal(env.planner.prepare(env.item, env.intent).error.status, 'unsupported');
  env.item.el.options = [env.option('未知', 'X')]; assert.equal(env.planner.prepare(env.item, env.intent).error.diagnostic.reasonCode, 'no_exact_option');
});

// 仅持有 JSON 计划不足以执行，原节点、候选、当前值、来源和一次性私有身份都须保持有效。
test('私有计划拒绝复制、篡改、候选变化、节点替换和值变化及重复消费', () => {
  const env = fixture(); let plan = env.planner.prepare(env.item, env.intent).plan;
  assert.throws(() => env.planner.validate(JSON.parse(JSON.stringify(plan)), env.item, env.intent), /计划已失效/);
  plan.targetOption.value = 'F'; assert.throws(() => env.planner.validate(plan, env.item, env.intent), /计划已失效/);
  plan = env.planner.prepare(env.item, env.intent).plan; env.item.el.options[0].textContent = '已改变'; assert.throws(() => env.planner.validate(plan, env.item, env.intent), /候选已变化/);
  env.item.el.options[0].textContent = '男'; plan = env.planner.prepare(env.item, env.intent).plan; env.current({ ...env.item, el: { ...env.item.el } }); assert.throws(() => env.planner.validate(plan, env.item, env.intent), /控件或候选/);
  env.current(env.item); plan = env.planner.prepare(env.item, env.intent).plan; env.item.el.value = '外部值'; assert.throws(() => env.planner.validate(plan, env.item, env.intent), /控件或候选/);
  env.item.el.value = ''; plan = env.planner.prepare(env.item, env.intent).plan; env.planner.validate(plan, env.item, env.intent, true); assert.throws(() => env.planner.validate(plan, env.item, env.intent), /计划已失效/);
});

// 延用既有日期精度守卫，不为日历补日；复杂链路明确 delegated，不能冒充已确定选项。
test('年月资料遇到年月日控件时无计划，复杂控件保留明确委托状态', () => {
  const partial = fixture('date', '2001-06', 'date'); const result = partial.planner.prepare(partial.item, partial.intent); assert.equal(result.plan, undefined); assert.match(result.error.reason, /精度不足/); assert.equal(partial.item.el.value, '');
  const full = fixture('date', '2001-06-15', 'date'); const plan = full.planner.prepare(full.item, full.intent).plan; assert.equal(plan.state, 'delegated'); assert.equal(plan.datePrecision, 'day'); assert.equal(plan.operation, 'legacy-interaction');
});
