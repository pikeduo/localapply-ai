// 原生选择的计划、非空保护及失效守卫；合成 DOM 桩不代替真实框架 E2E。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// 构造具有原生事件/setter 接口的局部节点，禁止旧通用路径，保持实际生产计划校验。
function fixture(type = 'select', value = '男', multiple = false) {
  const root = {}; let writes = 0; let marks = 0; let active = true;
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, Date, setTimeout, clearTimeout, AbortController,
    Event: class { constructor(type) { this.type = type; } }, HTMLSelectElement: class {}, HTMLOptionElement: class {} });
  for (const file of ['data/templates.js', 'data/field-matching.js', 'data/fill-contract.js', 'content/field-adapters.js', 'content/controls/text.js', 'content/controls/native.js', 'content/controls/date-phone.js', 'content/controls/dropdown.js', 'content/controls/address.js', 'content/controls/registry.js', 'content/verified-fill.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  // 标签通过原生 labels 暴露，另保留属性供测试模拟禁用/标签变更。
  function node(label, code, tagName = 'INPUT') {
    const attrs = {}; const row = { tagName, type, name: 'synthetic', form: null, textContent: label, labels: [{ textContent: label }], value: code,
      selected: false, checked: false, disabled: false, isConnected: true, attrs, getAttribute: (key) => attrs[key] ?? null,
      getRootNode: () => root, closest: (selector) => selector === 'label' ? { textContent: label } : null,
      dispatchEvent() {}, click() { writes++; if (type === 'radio') item.members.forEach((member) => { member.checked = member === row; }); else row.checked = !row.checked; row.onClick?.(); } };
    return row;
  }
  const rows = [node('男', 'M', type === 'select' ? 'OPTION' : 'INPUT'), node('女', 'F', type === 'select' ? 'OPTION' : 'INPUT')];
  const single = type === 'checkbox' && typeof value === 'boolean';
  const el = type === 'select' ? node('合成性别', '', 'SELECT') : rows[0]; el.multiple = multiple; el.options = rows;
  const M = context.FieldMatchingEngine; const field = { scanId: 'scan.synthetic', label: '合成性别', name: '', placeholder: '', options: [], group: '', kind: '', degree: '', index: 0, type }; field.semanticId = M.semanticId(field);
  const item = { el, members: type === 'select' || single ? [el] : rows, field, control: M.controlDescriptor(field) };
  Object.defineProperty(context.HTMLSelectElement.prototype, 'value', { set(next) { writes++; this.value = next; this.options.forEach((row) => { row.selected = row.value === next; }); } });
  Object.defineProperty(context.HTMLOptionElement.prototype, 'selected', { set(next) { writes++; this.selected = next; } });
  context.LocalApplyPageScanner = {
    // 撤销后同一节点也不能继续写入或返回成功。
    record() { if (!active) throw new Error('授权失效'); return item; },
    readValue() { return type === 'select' ? multiple ? rows.filter((row) => row.selected).map((row) => row.value) : el.value : type === 'radio' ? item.members.find((row) => row.checked)?.value || '' : single ? el.checked : item.members.filter((row) => row.checked).map((row) => row.value); }
  };
  context.WangshenFiller = { fillElement() { throw new Error('禁止回退旧路径'); }, markFilled() { marks++; } };
  const storageType = single ? 'boolean' : Array.isArray(value) ? 'multiSelect' : 'select'; const C = context.LocalApplyFillContract;
  const db = { revision: 1, activeProfileId: 'profile.a', profiles: [{ profileId: 'profile.a' }], entries: [], fieldDefinitions: [{ fieldId: 'field.a', type: storageType }], fieldValues: [{ profileId: 'profile.a', fieldId: 'field.a', entryId: null, value }] };
  const intent = C.createIntent(db, 'profile.a', { fieldId: 'field.a', entryId: null }, field, { sessionId: 'session.a', documentId: 'document.a', tabId: 42 });
  return { context, C, item, rows, node, intent, planner: context.LocalApplyFillPlanner, writes: () => writes, marks: () => marks,
    fill: (options = {}) => context.LocalApplyVerifiedFill.fill(item, value, { intent, ...options }), revoke: () => { active = false; } };
}

test('select/radio 精确标签解析为 M 编码，prepare 零写入，实际选中且相同值不重复操作', async () => {
  for (const type of ['select', 'radio']) {
    const env = fixture(type); const plan = env.planner.prepare(env.item, env.intent).plan;
    assert.equal(plan.adapterId, type); assert.equal(plan.targetOption.value, 'M'); assert.equal(env.writes(), 0);
    assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 1); assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 1);
  }
});

test('同标签不同编码、同码不同标签、标签/编码交叉命中均拒绝，禁用和受保护选项零写入', async () => {
  for (const [label, code] of [['男', 'other'], ['其他', 'M'], ['M', '男']]) {
    const env = fixture(); env.rows.push(env.node(label, code, 'OPTION')); const result = await env.fill(); assert.equal(result.status, 'failed'); assert.equal(result.diagnostic.reasonCode, 'ambiguous_option'); assert.equal(env.writes(), 0);
  }
  for (const type of ['select', 'radio']) {
    const env = fixture(type); env.rows[0].disabled = true; assert.equal((await env.fill()).status, 'unsupported'); assert.equal(env.writes(), 0);
  }
  const protectedOption = fixture('select', '同意协议'); protectedOption.rows[0].textContent = '同意协议'; assert.equal((await protectedOption.fill()).status, 'unsupported'); assert.equal(protectedOption.writes(), 0);
});

test('已有不同选择保留；单项明确覆盖仍复核原值，非空多选集合不被覆盖', async () => {
  const env = fixture(); env.item.el.value = 'F'; env.rows[1].selected = true;
  assert.equal((await env.fill()).status, 'needs_confirmation'); assert.equal(env.writes(), 0);
  assert.equal((await env.fill({ overwrite: true, expectedCurrent: '错误原值' })).status, 'needs_confirmation');
  assert.equal((await env.fill({ overwrite: true, expectedCurrent: 'F' })).status, 'success');
  const many = fixture('select', ['男'], true); many.rows[1].selected = true; assert.equal((await many.fill()).status, 'needs_confirmation'); assert.equal(many.writes(), 0);
});

test('单复选框只接受布尔值，false 保留且无多余点击；复选组和多选下拉按完整选项集合回读', async () => {
  for (const value of [true, false]) {
    const env = fixture('checkbox', value); const plan = env.planner.prepare(env.item, env.intent).plan;
    assert.equal(plan.operation, value ? 'set-checked' : 'verify-existing'); assert.equal((await env.fill()).status, 'success'); assert.equal(env.item.el.checked, value); assert.equal(env.writes(), value ? 1 : 0);
  }
  for (const type of ['checkbox', 'select']) {
    const env = fixture(type, ['男', '女'], type === 'select'); const plan = env.planner.prepare(env.item, env.intent).plan;
    assert.equal(plan.operation, 'select-options'); assert.deepEqual([...plan.targetOptions].map((row) => row.value), ['M', 'F']); assert.equal((await env.fill()).status, 'success');
    assert.ok(env.rows.every((row) => type === 'select' ? row.selected : row.checked)); assert.equal(env.writes(), 2);
  }
});

test('复选组缺选项或重复来源值拒绝，不能把没有填入的值算作成功', async () => {
  for (const value of [['男', '不存在'], ['男', 'M']]) { const env = fixture('checkbox', value); assert.equal((await env.fill()).status, 'failed'); assert.equal(env.writes(), 0); }
});

test('隐藏/禁用同名单选成员使不完整组拒绝，原生只读和错误布尔资料不写入', async () => {
  const hidden = fixture('radio'); const root = hidden.item.el.getRootNode(); const extra = hidden.node('额外候选', 'X'); extra.disabled = true;
  root.querySelectorAll = () => [...hidden.rows, extra]; assert.equal((await hidden.fill()).status, 'unsupported'); assert.equal(hidden.writes(), 0);
  const readonly = fixture(); readonly.item.el.attrs['aria-readonly'] = 'true'; assert.equal((await readonly.fill()).status, 'unsupported'); assert.equal(readonly.writes(), 0);
  const wrong = fixture('checkbox', '男'); wrong.item.members = [wrong.item.el]; assert.equal((await wrong.fill()).status, 'unsupported'); assert.equal(wrong.writes(), 0);
});

test('新计划拒绝越权能力、额外候选属性、重复编码和非布尔勾选', () => {
  const env = fixture('checkbox', ['男', '女']); const plan = env.planner.prepare(env.item, env.intent).plan;
  for (const extra of [{ adapterId: 'text' }, { adapterId: 'radio' }, { targetOptions: [{ ...plan.targetOptions[0], selector: '#submit' }] }, { targetOptions: [plan.targetOptions[0], { ...plan.targetOptions[0], handle: 'option.other' }] }]) assert.throws(() => env.C.validatePlan({ ...plan, ...extra }, env.intent));
  const single = fixture('checkbox', true); const check = single.planner.prepare(single.item, single.intent).plan;
  assert.throws(() => single.C.validatePlan({ ...check, checked: 'true' }, single.intent)); assert.throws(() => single.C.validatePlan({ ...check, checked: false }, single.intent));
  const scalar = fixture(); const choice = scalar.planner.prepare(scalar.item, scalar.intent).plan; const { targetOption, ...base } = choice;
  assert.throws(() => scalar.C.validatePlan({ ...base, operation: 'select-options', verification: 'selected-options', targetOptions: [targetOption] }, scalar.intent));
});

test('计划拒绝候选同形替换、ARIA 禁用、复选状态变化和跨组成员，不储存 DOM', () => {
  for (const type of ['select', 'radio', 'checkbox']) {
    const env = fixture(type, type === 'checkbox' ? ['男'] : '男'); let plan = env.planner.prepare(env.item, env.intent).plan;
    assert.ok(!JSON.stringify(plan).includes('node')); assert.ok(!JSON.stringify(plan).includes('adapterState'));
    const previous = env.rows[1]; env.rows[1] = { ...previous }; assert.throws(() => env.planner.validate(plan, env.item, env.intent), /候选已变化/); env.rows[1] = previous;
    plan = env.planner.prepare(env.item, env.intent).plan; env.rows[0].attrs['aria-disabled'] = 'true'; assert.throws(() => env.planner.validate(plan, env.item, env.intent), /候选已变化/); delete env.rows[0].attrs['aria-disabled'];
    plan = env.planner.prepare(env.item, env.intent).plan; if (type === 'select') env.rows[0].selected = true; else env.rows[0].checked = true;
    assert.throws(() => env.planner.validate(plan, env.item, env.intent), /候选已变化/);
  }
  const foreign = fixture('radio'); foreign.rows[1].name = 'other'; assert.equal(foreign.planner.prepare(foreign.item, foreign.intent).error.status, 'unsupported');
});

test('受控回退、校验失败、取消及撤销不记成功，复选批次取消后不再点下一项', async () => {
  let env = fixture('radio'); env.rows[0].onClick = () => setTimeout(() => { env.rows[0].checked = false; }, 30); assert.equal((await env.fill()).status, 'failed'); assert.equal(env.writes(), 1); assert.equal(env.marks(), 0);
  env = fixture('checkbox', true); env.rows[0].onClick = () => { env.item.el.attrs['aria-invalid'] = 'true'; }; assert.equal((await env.fill()).status, 'failed'); assert.equal(env.marks(), 0);
  env = fixture(); const pending = env.fill(); setTimeout(env.revoke, 20); assert.equal((await pending).status, 'failed'); assert.equal(env.marks(), 0);
  const controller = new AbortController(); env = fixture('checkbox', ['男', '女']); env.rows[0].onClick = () => controller.abort(); assert.equal((await env.fill({ signal: controller.signal })).status, 'failed'); assert.equal(env.writes(), 1); assert.equal(env.rows[1].checked, false);
  env = fixture(); const before = new AbortController(); before.abort(); assert.equal((await env.fill({ signal: before.signal })).status, 'failed'); assert.equal(env.writes(), 0);
});
