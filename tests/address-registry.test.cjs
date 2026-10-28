// 省市区路径和保护策略的合成单元；真实扫描/异步框架由 Playwright 验证。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// 仅替换原生 setter/DOM，计划和级联路径编排使用生产实现，不模拟测试成功结果。
function fixture(value = '甲省 / 同名市 / 中心区', cascade = true) {
  let writes = 0; let marks = 0; let active = true;
  const context = vm.createContext({ Date, setTimeout, clearTimeout, AbortController, crypto: require('node:crypto').webcrypto, Event: class { constructor(type) { this.type = type; } }, FocusEvent: class {}, HTMLSelectElement: class {} });
  for (const file of ['data/templates.js','data/field-matching.js','data/fill-contract.js', 'data/fill-result.js','content/field-adapters.js','content/controls/verification.js', 'content/controls/text.js','content/controls/native.js','content/controls/date-phone.js','content/controls/dropdown.js','content/controls/address.js','content/controls/registry.js','content/verified-fill.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  // 标签与编码故意不同；同名市在甲乙省中分别使用不同代码。
  function option(value, textContent) { return { value, textContent, disabled: false, getAttribute: () => null, closest: () => null }; }
  // 可变节点接口用于验证候选、属性、部分值和节点身份的失效保护。
  function select(key, options) {
    const attrs = { 'aria-label': key }; const node = { tagName: 'SELECT', type: 'select-one', attrs, options, value: '', isConnected: true, disabled: false, readOnly: false,
      getAttribute: (key) => attrs[key] ?? null, closest: () => null, matches: () => false, dispatchEvent(event) { if (event.type === 'change') node.onChange?.(); } };
    Object.defineProperty(node, 'selectedOptions', { get: () => node.options.filter((option) => option.value === node.value) }); return node;
  }
  const empty = () => option('', '请选择');
  const parts = { province: select('省', [empty(), option('pa', '甲省'), ...(cascade ? [option('pb', '乙省')] : [])]), city: select('市', [empty(), option('old-city', '同名市')]), district: select('区', [empty(), option('old-district', '中心区')]) };
  if (cascade) {
    parts.city.disabled = true; parts.district.disabled = true;
    parts.province.onChange = () => { parts.city.disabled = true; setTimeout(() => { parts.city.options = [empty(), option('ca', '同名市')]; parts.city.disabled = false; }, 100); };
    parts.city.onChange = () => { parts.district.disabled = true; setTimeout(() => { parts.district.options = [empty(), option('da', '中心区')]; parts.district.disabled = false; }, 100); };
  }
  const M = context.FieldMatchingEngine; const field = { scanId: 'scan.synthetic', label: '现居地址', name: '', placeholder: '', options: [], group: '', kind: '', degree: '', index: 0, type: 'text', layout: 'address:province-city-district' }; field.semanticId = M.semanticId(field);
  const item = { el: parts.province, members: [parts.province], compound: { kind: 'address', parts }, field, control: M.controlDescriptor(field) };
  Object.defineProperty(context.HTMLSelectElement.prototype, 'value', { set(value) { writes++; this.value = value; } });
  context.LocalApplyPageScanner = { record() { if (!active) throw new Error('撤销'); return item; }, readValue: (item) => context.LocalApplyFieldAdapters.read(item) };
  context.WangshenFiller = { fillElement() { throw new Error('不能回退旧路径'); }, markFilled() { marks++; } };
  const db = { revision: 1, activeProfileId: 'profile.a', profiles: [{ profileId: 'profile.a' }], entries: [], fieldDefinitions: [{ fieldId: 'field.a', type: 'text' }], fieldValues: [{ profileId: 'profile.a', fieldId: 'field.a', entryId: null, value }] };
  const C = context.LocalApplyFillContract; const intent = C.createIntent(db, 'profile.a', { fieldId: 'field.a', entryId: null }, field, { sessionId: 'session.a', documentId: 'document.a', tabId: 42 });
  return { context, item, intent, C, parts, option, planner: context.LocalApplyFillPlanner, writes: () => writes, marks: () => marks, revoke: () => { active = false; }, fill: (options = {}) => context.LocalApplyVerifiedFill.fill(item, value, { intent, ...options }) };
}

test('计划只有省市区固定角色，准备零写入；异步候选按当前父级编码选择并三级回读', async () => {
  const env = fixture(); const plan = env.planner.prepare(env.item, env.intent).plan;
  assert.equal(plan.adapterId, 'address'); assert.equal(plan.operation, 'fill-address'); assert.equal(plan.state, 'delegated'); assert.deepEqual([...plan.targetParts].map((part) => part.key), ['province','city','district']); assert.equal(env.writes(), 0);
  const result = await env.fill(); assert.equal(result.status, 'success', result.reason); assert.deepEqual(Object.values(env.parts).map((node) => node.value), ['pa','ca','da']); assert.equal(env.writes(), 3);
  assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 3);
});

test('相同城市名但父级路径不同不复用旧候选；无换代证据时不点选城市', async () => {
  for (const disabled of [false,true]) {
    const env = fixture(); env.parts.province.options[2].disabled = disabled; env.parts.province.onChange = () => { env.parts.city.disabled = false; env.parts.district.disabled = false; };
    const result = await env.fill(); assert.equal(result.status, 'unsupported'); assert.equal(env.parts.city.value, ''); assert.equal(env.parts.district.value, ''); assert.equal(env.writes(), 1);
  }
});

test('部分相同上级不重写，不同下级及会清空既有下级的上级修改必须保留', async () => {
  let env = fixture(undefined, false); env.parts.province.value = 'pa'; assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 2);
  env = fixture(); env.parts.city.value = 'old-city'; assert.equal((await env.fill()).status, 'needs_confirmation'); assert.equal(env.writes(), 0);
  env = fixture(); env.parts.province.value = 'pb'; assert.equal((await env.fill()).status, 'needs_confirmation'); assert.equal(env.writes(), 0);
});

test('明确逐项覆盖仍复核原路径，正常级联清空仅在已确认覆盖中允许', async () => {
  const env = fixture(); env.parts.province.value = 'pb'; env.parts.city.value = 'old-city'; env.parts.district.value = 'old-district';
  const change = env.parts.province.onChange;
  env.parts.province.onChange = () => { env.parts.city.value = ''; env.parts.district.value = ''; change(); };
  assert.equal((await env.fill({ overwrite:true, expectedCurrent:'过期路径' })).status,'needs_confirmation'); assert.equal(env.writes(),0);
  assert.equal((await env.fill({ overwrite:true, expectedCurrent:'乙省 / 同名市 / 中心区' })).status,'success'); assert.deepEqual(Object.values(env.parts).map((node)=>node.value),['pa','ca','da']);
});

test('自由文本、缺失层级、海外自由地址不补省市区，重复候选拒绝', async () => {
  for (const value of ['甲省同名市中心区', '甲省 / 同名市', 'San Francisco, CA', '甲省 / / 中心区']) { const env = fixture(value); assert.equal((await env.fill()).status, 'needs_confirmation'); assert.equal(env.writes(), 0); }
  const env = fixture(); env.parts.province.options.push(env.option('other', '甲省')); assert.equal((await env.fill()).status, 'unsupported'); assert.equal(env.writes(), 0);
});

test('子项/候选/父级绑定/部分值变化使未执行计划失效；固定契约拒绝伪角色和重复句柄', () => {
  for (const mode of ['node','candidate','value','binding']) {
    const env = fixture(); const plan = env.planner.prepare(env.item, env.intent).plan;
    if (mode === 'node') env.parts.city = { ...env.parts.city }; if (mode === 'candidate') env.parts.city.options[1] = { ...env.parts.city.options[1] }; if (mode === 'value') env.parts.city.value = 'old-city';
    if (mode === 'binding') env.parts.city.attrs['data-parent-value'] = 'pb';
    assert.throws(() => env.planner.validate(plan, env.item, env.intent)); assert.equal(env.writes(), 0);
  }
  const env = fixture(); const plan = env.planner.prepare(env.item, env.intent).plan;
  for (const extra of [{ adapterId: 'phone' }, { targetParts: [{ key: 'country', handle: 'part.x' }] }, { targetParts: plan.targetParts.map((part) => ({ ...part, handle: 'part.same' })) }, { datePrecision: 'month' }]) assert.throws(() => env.C.validatePlan({ ...plan, ...extra }, env.intent));
});

test('取消/撤销/其他子项变化后无迟到下级写入，保留已填省份及用户新内容', async () => {
  for (const mode of ['cancel','revoke','edit']) {
    const env = fixture(); const controller = new AbortController(); const change = env.parts.province.onChange;
    env.parts.province.onChange = () => { change(); setTimeout(() => { if (mode === 'cancel') controller.abort(); if (mode === 'revoke') env.revoke(); if (mode === 'edit') env.parts.city.value = '用户手填'; }, 20); };
    const result = await env.fill({ signal: controller.signal }); assert.equal(result.status, 'failed'); await new Promise((resolve) => setTimeout(resolve, 180)); assert.equal(env.writes(), 1); assert.equal(env.parts.province.value, 'pa'); assert.equal(env.parts.district.value, ''); assert.equal(env.marks(), 0);
    if (mode === 'edit') assert.equal(env.parts.city.value, '用户手填');
  }
});

test('受控回退和区县校验失败不记成功，完整静态旧表单保持兼容', async () => {
  const env = fixture(undefined, false); env.parts.district.onChange = () => { setTimeout(() => { env.parts.city.value = ''; }, 30); }; assert.equal((await env.fill()).status, 'failed'); assert.equal(env.marks(), 0);
  const invalid = fixture(undefined, false); invalid.parts.district.onChange = () => { invalid.parts.district.attrs['aria-invalid'] = 'true'; }; assert.equal((await invalid.fill()).status, 'failed'); assert.equal(invalid.marks(), 0);
  const nativeRole = fixture(undefined,false); Object.values(nativeRole.parts).forEach((node)=>{node.attrs.role='combobox';}); assert.equal((await nativeRole.fill()).status,'success'); assert.equal(nativeRole.writes(),3);
});
