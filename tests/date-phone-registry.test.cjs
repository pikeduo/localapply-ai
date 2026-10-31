// 日期/电话桥接守卫的合成节点测试；日历与真实框架另由浏览器验证。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

// 构造实际生产适配器的局部运行时，禁止回退到旧全页候选入口。
function fixture(kind = 'date', value = '2028-06', type = 'month') {
  let writes = 0; let marks = 0; let active = true;
  const context = vm.createContext({ Date, setTimeout, clearTimeout, AbortController, crypto: require('node:crypto').webcrypto,
    Event: class { constructor(type) { this.type = type; } }, FocusEvent: class {}, HTMLSelectElement: class {} });
  for (const file of ['data/templates.js', 'data/field-matching.js', 'data/fill-contract.js', 'data/fill-result.js', 'content/field-adapters.js', 'content/controls/verification.js', 'content/controls/text.js', 'content/controls/native.js', 'content/controls/date-phone.js', 'content/controls/dropdown.js', 'content/controls/address.js', 'content/controls/registry.js', 'content/verified-fill.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  // 子项属性和选项都可由用例独立改变，验证原地变化不能复用私有计划。
  function input(type, value = '', choices) {
    const attrs = { type }; const node = { tagName: choices ? 'SELECT' : 'INPUT', type, value, attrs, options: choices || [], disabled: false, readOnly: false, isConnected: true,
      getAttribute: (key) => attrs[key] ?? null, closest: () => null, matches: () => false, dispatchEvent(event) { if (event.type === 'change') node.onChange?.(); } };
    Object.defineProperty(node, 'selectedOptions', { get: () => node.options.filter((row) => row.value === node.value) }); return node;
  }
  // 选项不携带用户资料；编码与标签故意不同，验证不是直接拼接 DOM 值。
  function option(value, textContent) { return { value, textContent, disabled: false, getAttribute: () => null, closest: () => null }; }
  let parts; let el = input(type);
  if (kind === 'split') { parts = { year: input('select-one', '', [option('', '请选择'), option('year2028', '2028年')]), month: input('select-one', '', [option('', '请选择'), option('month6', '6月')]) }; el = parts.year; }
  if (kind === 'phone') { parts = { country: input('select-one', 'cn', [option('cn', '中国 (+86)'), option('gb', '英国 (+44)')]), number: input('tel') }; el = parts.number; }
  const field = { scanId: 'scan.synthetic', label: kind === 'phone' ? '手机号' : '出生日期', name: '', placeholder: '', options: [], group: '', kind: '', degree: '', index: 0, type: parts ? kind === 'phone' ? 'tel' : 'month' : type };
  const M = context.FieldMatchingEngine; field.semanticId = M.semanticId(field);
  const item = { el, members: [el], field, control: M.controlDescriptor(field), ...(parts ? { compound: { kind: kind === 'phone' ? 'phone' : 'date', parts } } : {}) };
  context.LocalApplyPageScanner = { record() { if (!active) throw new Error('撤销'); return item; }, readValue: (item) => context.LocalApplyFieldAdapters.read(item) };
  // 测试只替代原生 setter/事件，准备、保护、计划消费、写入编排和回读均使用生产实现。
  function write(node, value) { writes++; node.value = String(value); node.onChange?.(); }
  Object.defineProperty(context.HTMLSelectElement.prototype, 'value', { set(value) { writes++; this.value = value; } });
  context.WangshenFiller = { setValue: write, fillTextOnly(node, value) { write(node, value); return { ok: node.value === value }; }, fillElement() { throw new Error('禁止旧候选回退'); }, markFilled() { marks++; } };
  const db = { revision: 1, activeProfileId: 'profile.a', profiles: [{ profileId: 'profile.a' }], entries: [], fieldDefinitions: [{ fieldId: 'field.a', type: 'text' }], fieldValues: [{ profileId: 'profile.a', fieldId: 'field.a', entryId: null, value }] };
  const C = context.LocalApplyFillContract; const intent = C.createIntent(db, 'profile.a', { fieldId: 'field.a', entryId: null }, field, { sessionId: 'session.a', documentId: 'document.a', tabId: 42 });
  return { item, intent, C, context, planner: context.LocalApplyFillPlanner, option, writes: () => writes, marks: () => marks, revoke: () => { active = false; }, fill: (options = {}) => context.LocalApplyVerifiedFill.fill(item, value, { intent, ...options }) };
}

test('日期计划保留来源精度和明确子项，准备零写入；年月不补日和时间', async () => {
  for (const [type, value] of [['month', '2028-06-30'], ['date', '2028-06-30'], ['datetime-local', '2028-06-30T12:34']]) {
    const env = fixture('date', value, type); const plan = env.planner.prepare(env.item, env.intent).plan;
    assert.equal(plan.adapterId, 'date'); assert.equal(plan.operation, 'fill-date'); assert.equal(plan.state, 'delegated'); assert.equal(plan.datePrecision, 'day'); assert.equal(plan.targetParts[0].key, 'value'); assert.equal(env.writes(), 0);
    assert.equal(plan.targetPrecision, { date: 'day', month: 'month', 'datetime-local': 'minute' }[type]);
    assert.equal((await env.fill()).status, 'success'); assert.equal(env.item.el.value, type === 'month' ? '2028-06' : value);
  }
  for (const [type, value] of [['date', '2028-06'], ['datetime-local', '2028-06-30']]) { const env = fixture('date', value, type); assert.equal((await env.fill()).status, 'needs_confirmation'); assert.equal(env.writes(), 0); }
});

test('拆分年月标签/编码独立，部分相同年份不重写；不同子项及完整网页值保留', async () => {
  const env = fixture('split'); env.item.compound.parts.year.value = 'year2028';
  const plan = env.planner.prepare(env.item, env.intent).plan; assert.deepEqual([...plan.targetParts].map((part) => part.key), ['year', 'month']);
  assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 1); assert.equal(env.item.compound.parts.month.value, 'month6');
  assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 1);
  const occupied = fixture('split'); occupied.item.compound.parts.year.options.push(occupied.option('year2027', '2027年')); occupied.item.compound.parts.year.value = 'year2027'; assert.equal((await occupied.fill()).status, 'needs_confirmation'); assert.equal(occupied.writes(), 0);
});

test('电话缺省国码不当成已填号码，显式国际号码可拆分，已有不同号码保持', async () => {
  const env = fixture('phone', '+44 2070000000'); const plan = env.planner.prepare(env.item, env.intent).plan;
  assert.equal(plan.adapterId, 'phone'); assert.equal(plan.datePrecision, undefined); assert.deepEqual([...plan.targetParts].map((part) => part.key), ['country', 'number']);
  assert.equal((await env.fill()).status, 'success'); assert.equal(env.item.compound.parts.country.value, 'gb'); assert.equal(env.item.el.value, '2070000000');
  assert.equal((await env.fill()).status, 'success'); assert.equal(env.writes(), 2);
  const occupied = fixture('phone', '+44 2070000000'); occupied.item.el.value = '13800000000'; assert.equal((await occupied.fill()).status, 'needs_confirmation'); assert.equal(occupied.writes(), 0);
  const unknown = fixture('phone', '+81 9012345678'); assert.equal((await unknown.fill()).status, 'needs_confirmation'); assert.equal(unknown.writes(), 0);
});

test('私有计划绑定所有子项和值，换节点/候选/部分值以及精度篡改全部拒绝', () => {
  for (const mutation of ['node', 'option', 'value', 'precision']) {
    const env = fixture('split'); const plan = env.planner.prepare(env.item, env.intent).plan; const parts = env.item.compound.parts;
    if (mutation === 'node') parts.month = { ...parts.month };
    if (mutation === 'option') parts.month.options[1] = { ...parts.month.options[1] };
    if (mutation === 'value') parts.month.value = 'month6';
    if (mutation === 'precision') plan.datePrecision = 'day';
    assert.throws(() => env.planner.validate(plan, env.item, env.intent)); assert.equal(env.writes(), 0);
  }
});

test('固定计划拒绝伪子项/额外属性/重复句柄/跨能力操作，不把节点写进封套', () => {
  const env = fixture('split'); const plan = env.planner.prepare(env.item, env.intent).plan;
  for (const extra of [{ adapterId: 'phone' }, { datePrecision: 'time' }, { targetParts: [{ key: 'submit', handle: 'part.a' }] }, { targetParts: [{ ...plan.targetParts[0], selector: 'button' }] }, { targetParts: [{ key: 'year', handle: 'part.a' }, { key: 'month', handle: 'part.a' }] }]) assert.throws(() => env.C.validatePlan({ ...plan, ...extra }, env.intent));
  assert.ok(!JSON.stringify(plan).includes('node')); assert.ok(!JSON.stringify(plan).includes('year2028'));
});

test('静态禁用/重复选项和只读子项在写入前拒绝，不产生半填结果', async () => {
  for (const mode of ['disabled', 'duplicate', 'readonly']) {
    const env = fixture('split'); const month = env.item.compound.parts.month;
    if (mode === 'disabled') month.options[1].disabled = true;
    if (mode === 'duplicate') month.options.push(env.option('other', '6月'));
    if (mode === 'readonly') month.readOnly = true;
    assert.equal((await env.fill()).ok, false); assert.equal(env.writes(), 0);
  }
});

// 失败检查必须可区分，同时保留停止后续写入和已完成值不回滚的行为。
test('取消、授权撤销或其他子项变化后不再写下一项，不清理已完成网页值', async () => {
  for (const mode of ['cancel', 'revoke', 'change', 'attributes']) {
    const env = fixture('split'); const controller = new AbortController(); const { year, month } = env.item.compound.parts;
    year.onChange = () => { if (mode === 'cancel') controller.abort(); if (mode === 'revoke') env.revoke(); if (mode === 'change') month.value = '网页手填'; if (mode === 'attributes') month.attrs.placeholder = 'synthetic-private'; };
    const result = await env.fill({ signal: controller.signal }); assert.equal(result.status, 'failed');
    if (mode !== 'cancel') assert.equal(result.diagnostic.guardCheck, { revoke: 'context', change: 'value', attributes: 'attributes' }[mode]);
    assert.ok(!JSON.stringify(result).includes('synthetic-private'));
    assert.equal(env.writes(), 1); assert.equal(year.value, 'year2028'); assert.equal(month.value, mode === 'change' ? '网页手填' : ''); assert.equal(env.marks(), 0);
  }
});

test('受控组件回退、子项校验失败和取消验证不记成功，也不重试写入', async () => {
  let env = fixture(); const pending = env.fill(); setTimeout(() => { env.item.el.value = ''; }, 30); assert.equal((await pending).status, 'failed'); assert.equal(env.writes(), 1); assert.equal(env.marks(), 0);
  env = fixture('phone', '+44 2070000000'); env.item.el.onChange = () => { env.item.el.attrs['aria-invalid'] = 'true'; }; assert.equal((await env.fill()).status, 'failed'); assert.equal(env.marks(), 0);
  env = fixture(); const controller = new AbortController(); controller.abort(); assert.equal((await env.fill({ signal: controller.signal })).ok, false); assert.equal(env.writes(), 0);
});

// 修改已有年月的年份时，只接受保留原月份的延迟回写；不能吞掉月份或对侧外部变化。
test('ATSX改年回写保留原月，目标月份或对侧被改动仍停止', async () => {
  for(const mode of ['retained','month-changed','peer-changed']) {
    const env=fixture('date','2028-06'); const {el}=env.item; el.value='2018-09'; const peer={...el,value:'2019-06'};
    env.item.compound={kind:'date',atsx:true,parts:{value:el,peer}};
    env.context.LocalApplyATSX={range:(node)=>node===el || node===peer,dateText:(node)=>node.value,exclusion:()=>null};
    // 只替代组件的异步回写；执行器的原节点、来源投影、子项守卫均保留生产实现。
    env.context.LocalApplyFieldAdapters.fill=async(item,value,lifecycle)=>{
      lifecycle.check(); lifecycle.changed(el); await Promise.resolve(); el.value=mode==='month-changed'?'2028-10':'2028-09';
      if(mode==='peer-changed')peer.value='2000-01';
      lifecycle.settled(el,{iso:'2028-',precision:'month',partial:true}); lifecycle.check();
      el.value='2028-06'; lifecycle.settled(el,{iso:'2028-06',precision:'month'}); lifecycle.check(); return {ok:true};
    };
    const state=env.context.LocalApplyDatePhoneControls.snapshot(env.item); const adapter=env.context.LocalApplyDatePhoneAdapters.find((adapter)=>adapter.id==='date');
    const result=await adapter.execute({adapterId:'date',operation:'fill-date'},{item:env.item,intent:env.intent,assertActive:()=>env.item,consumePlan:()=>state});
    assert.equal(result.ok,mode==='retained',JSON.stringify(result)); if(mode!=='retained')assert.equal(result.diagnostic.guardCheck,'value');
    assert.equal(peer.value,mode==='peer-changed'?'2000-01':'2019-06');
  }
});
