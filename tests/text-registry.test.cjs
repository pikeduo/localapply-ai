// 固定注册表与文本调度单元测试；合成节点只证明守卫，不替代真实框架浏览器测试。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// 在独立隔离世界载入实际契约/注册表，赋值桩禁止进入旧候选搜索路径。
function fixture(type = 'text', value = '合成文本') {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, Date, setTimeout, clearTimeout, AbortController });
  for (const file of ['data/templates.js', 'data/field-matching.js', 'data/fill-contract.js', 'data/fill-result.js', 'content/field-adapters.js', 'content/controls/verification.js', 'content/controls/text.js', 'content/controls/native.js', 'content/controls/date-phone.js', 'content/controls/dropdown.js', 'content/controls/address.js', 'content/controls/registry.js', 'content/verified-fill.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  const M = context.FieldMatchingEngine; const C = context.LocalApplyFillContract;
  const field = { scanId: 'scan.synthetic', label: '合成字段', name: '', placeholder: '', options: [], group: '', kind: '', degree: '', index: 0, type }; field.semanticId = M.semanticId(field);
  const attrs = { type: type === 'textarea' || type === 'contenteditable' ? null : type }; let active = true; let writes = 0; let marks = 0;
  const el = { tagName: type === 'textarea' ? 'TEXTAREA' : type === 'contenteditable' ? 'DIV' : 'INPUT', type, isContentEditable: type === 'contenteditable', isConnected: true,
    disabled: false, readOnly: false, value: '', textContent: '', getAttribute: (name) => attrs[name] ?? null, closest: () => null, matches: () => false };
  const item = { el, members: [el], field, control: M.controlDescriptor(field) };
  context.LocalApplyPageScanner = { record() { if (!active || !el.isConnected || el.disabled) throw new Error('授权失效'); return item; }, readValue: () => el.isContentEditable ? el.textContent : el.value };
  context.WangshenFiller = {
    // 只统计本地赋值，旧路径一旦调用就使测试失败。
    fillTextOnly(node, next) { writes++; if (node.isContentEditable) node.textContent = String(next); else node.value = String(next); return { ok: true }; },
    fillElement() { throw new Error('不应进入旧候选搜索'); }, markFilled() { marks++; }
  };
  const db = { revision: 1, activeProfileId: 'profile.a', profiles: [{ profileId: 'profile.a' }], entries: [], fieldDefinitions: [{ fieldId: 'field.a', type: 'text' }], fieldValues: [{ profileId: 'profile.a', fieldId: 'field.a', entryId: null, value }] };
  const intent = C.createIntent(db, 'profile.a', { fieldId: 'field.a', entryId: null }, field, { sessionId: 'session.a', documentId: 'document.a', tabId: 42 });
  return { context, item, intent, attrs, C, registry: context.LocalApplyAdapterRegistry, planner: context.LocalApplyFillPlanner,
    fill: (options = {}) => context.LocalApplyVerifiedFill.fill(item, value, { intent, ...options }), writes: () => writes, marks: () => marks, revoke: () => { active = false; } };
}

// 模拟错误打包能力，验证生产注册表实际拒绝重复/未知项，而非仅检查常量列表。
function loadRegistry(adapters) {
  const context = vm.createContext({ LocalApplyTextAdapters: adapters, LocalApplyNativeAdapters: [], LocalApplyDatePhoneAdapters: [], LocalApplyDropdownAdapters: [], LocalApplyAddressAdapters: [], LocalApplyFillContract: { ADAPTER_IDS: ['text', 'textarea', 'contenteditable'] } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content/controls/registry.js'), 'utf8'), context); return context.LocalApplyAdapterRegistry;
}

// 测试能力没有副作用，始终命中用于制造冲突，不能成为产品动态注册入口。
function fakeAdapter(id) { return { id, detect: () => true, prepare: () => {}, execute: () => {}, verify: () => {} }; }

test('注册项冻结、唯一且固定白名单；不存在动态注册入口，多重命中拒绝', () => {
  const env = fixture(); assert.deepEqual([...env.registry.ids], ['text', 'textarea', 'contenteditable', 'select', 'radio', 'checkbox', 'date', 'phone', 'dropdown', 'address']);
  assert.ok(Object.isFrozen(env.registry) && Object.isFrozen(env.registry.ids)); assert.equal(env.registry.register, undefined); assert.equal(env.registry.get('remote.js'), null);
  assert.throws(() => env.registry.ids.push('remote')); assert.ok(Object.isFrozen(env.registry.get('text')));
  assert.throws(() => loadRegistry([fakeAdapter('text'), fakeAdapter('text')]), /白名单或发生重复/);
  assert.throws(() => loadRegistry([fakeAdapter('remote')]), /白名单或发生重复/);
  assert.throws(() => loadRegistry([{ ...fakeAdapter('text'), javascript: '任意代码' }]), /白名单或发生重复/);
  assert.throws(() => loadRegistry([fakeAdapter('text'), fakeAdapter('textarea')]).resolve({}, {}), /存在歧义/);
});

test('探测按控件能力区分文本、textarea、contenteditable，日期和下拉不被接管', () => {
  for (const type of ['text', 'email', 'tel', 'number', 'url', 'textarea', 'contenteditable']) {
    const env = fixture(type); const id = ['textarea', 'contenteditable'].includes(type) ? type : 'text';
    assert.equal(env.registry.resolve(env.item.control, { item: env.item }).id, id); assert.equal(env.writes(), 0);
  }
  for (const type of ['combobox', 'select']) { const env = fixture(type); assert.equal(env.registry.resolve(env.item.control, { item: env.item }), null); }
});

// 原生编辑器以块节点表示换行时，实际读值保留分行而非压成连串文本。
test('富文本回读保留可见换行，原生输入和无布局桩仍按原值读取', () => {
  const env = fixture(); vm.runInContext(fs.readFileSync(path.join(ROOT, 'content/filler.js'), 'utf8'), env.context);
  const read = env.context.WangshenFiller.readText;
  assert.equal(read({ isContentEditable: true, innerText: '第一行\n第二行', textContent: '第一行第二行' }), '第一行\n第二行');
  assert.equal(read({ isContentEditable: true, textContent: '无布局合成文本' }), '无布局合成文本'); assert.equal(read({ value: '原生值' }), '原生值');
});

test('三类文本准备无写入，计划消费后单次赋值和延迟验证，不进入旧候选搜索', async () => {
  for (const type of ['text', 'textarea', 'contenteditable']) {
    const env = fixture(type); const plan = env.planner.prepare(env.item, env.intent).plan;
    assert.equal(plan.adapterId, type); assert.equal(plan.operation, 'write-value'); assert.equal(env.writes(), 0);
    const result = await env.fill(); assert.equal(result.status, 'success'); assert.equal(env.writes(), 1); assert.equal(env.marks(), 1);
    assert.ok(!JSON.stringify(result).includes(plan.planId)); assert.ok(!JSON.stringify(result).includes('合成文本'));
  }
});

test('计划拒绝未知能力、委托操作冒充文本，以及适配器执行中的伪造计划', () => {
  const env = fixture(); const plan = env.planner.prepare(env.item, env.intent).plan;
  assert.throws(() => env.C.validatePlan({ ...plan, adapterId: 'moka' }, env.intent));
  assert.throws(() => env.C.validatePlan({ ...plan, operation: 'legacy-interaction', verification: 'legacy-delayed', state: 'delegated' }, env.intent));
  plan.adapterId = 'textarea'; assert.throws(() => env.planner.validate(plan, env.item, env.intent), /已失效/); assert.equal(env.writes(), 0);
});

test('网页非空保留、相同内容只验证、只读与未适配菜单拒绝且不回退', async () => {
  let env = fixture(); env.item.el.value = '已有不同内容'; let result = await env.fill(); assert.equal(result.status, 'needs_confirmation'); assert.equal(env.writes(), 0);
  env = fixture(); env.item.el.value = '合成文本'; result = await env.fill(); assert.equal(result.status, 'success'); assert.equal(env.writes(), 0);
  env = fixture(); env.item.el.readOnly = true; result = await env.fill(); assert.equal(result.status, 'unsupported'); assert.equal(env.writes(), 0);
  env = fixture(); env.attrs['aria-autocomplete'] = 'list'; result = await env.fill(); assert.equal(result.status, 'unsupported'); assert.equal(env.writes(), 0);
});

test('取消前零写入，写入后的取消停止回读且无迟到赋值或成功标记', async () => {
  const controller = new AbortController(); controller.abort(); const before = fixture(); let result = await before.fill({ signal: controller.signal }); assert.equal(result.status, 'failed'); assert.equal(before.writes(), 0);
  const during = fixture(); const signal = new AbortController(); const pending = during.fill({ signal: signal.signal }); setTimeout(() => signal.abort(), 20);
  result = await pending; assert.equal(result.status, 'failed'); assert.match(result.reason, /已取消/); await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(during.writes(), 1); assert.equal(during.marks(), 0);
});

test('授权撤销和受控回退不报成功、不重试，受保护字段准备时拒绝', async () => {
  let env = fixture(); let pending = env.fill(); setTimeout(env.revoke, 20); let result = await pending; assert.equal(result.status, 'failed'); assert.equal(env.marks(), 0);
  env = fixture(); pending = env.fill(); setTimeout(() => { env.item.el.value = ''; }, 30); result = await pending; assert.equal(result.status, 'failed'); assert.equal(env.writes(), 1); assert.equal(env.marks(), 0);
  for (const label of ['密码', '验证码', '同意协议', '同步更新在线简历']) {
    env = fixture(); env.item.field.label = label; result = env.planner.prepare(env.item, env.intent); assert.equal(result.error.status, 'unsupported'); assert.equal(env.writes(), 0);
  }
});
