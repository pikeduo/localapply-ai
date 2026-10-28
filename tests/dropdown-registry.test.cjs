// 下拉三阶段使用合成局部 DOM；真实归属/框架及重绘由浏览器测试补足。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// 只替换局部 DOM 探测，不替换真实查询/候选句柄/点选/验证算法。
function fixture() {
  const document = { activeElement: null }; let clicks = 0; let writes = 0;
  const context = vm.createContext({ document, setTimeout, clearTimeout, Date, AbortController, crypto: require('node:crypto').webcrypto, Event: class { constructor(type) { this.type = type; } }, HTMLInputElement: class {} });
  // 候选拥有真实可变确认状态，用于区分输入搜索与实际选择。
  function option(text = '男', code = 'M') { const attrs = { 'data-value': code, 'aria-selected': 'false' }; return { textContent: text, isConnected: true, attrs, disabled: false,
    getAttribute: (key) => attrs[key] ?? null, matches: () => false, closest: () => null, querySelector: () => null,
    click() { clicks++; if (!el.reject) { attrs['aria-selected'] = 'true'; el.value = text; } } }; }
  const nodes = [option()]; const menu = { isConnected: true, getAttribute: () => null, matches: () => true, querySelectorAll: (selector) => selector.includes('aria-selected') ? nodes.filter((node) => node.attrs['aria-selected'] === 'true') : nodes };
  const attrs = { role: 'combobox', 'aria-controls': 'menu', type: 'text' }; const root = { getElementById: (key) => key === 'menu' ? menu : null };
  const el = { tagName: 'INPUT', value: '', isConnected: true, disabled: false, readOnly: false, attrs, getAttribute: (key) => attrs[key] ?? null, getRootNode: () => root,
    focus() { document.activeElement = el; }, blur() { document.activeElement = null; }, dispatchEvent() {}, closest: () => null };
  Object.defineProperty(context.HTMLInputElement.prototype, 'value', { set(value) { writes++; this.value = value; } });
  // 共享生产语义比较，只用桩代替浏览器排版与菜单定位。
  context.LocalApplyFieldAdapters = { dropdown: () => null, handles: () => false, exclusion: () => null, optionEqual: (a, b) => a === b };
  context.LocalApplyDropdownDOM = { usable: (node) => node.isConnected && !node.disabled, optionLabel: (node) => node.textContent.trim(), popupRoots: () => [menu], trace() {},
    async openControl(node, calendar, lifecycle) { lifecycle.check(); node.focus(); lifecycle.changed(node); return new Set([menu]); } };
  for (const file of ['data/templates.js', 'data/field-matching.js', 'data/fill-contract.js', 'data/fill-result.js', 'content/controls/verification.js', 'content/controls/dropdown.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  return { el, nodes, menu, attrs, document, option, context, U: context.LocalApplyDropdownControls, C: context.LocalApplyFillContract, adapter: context.LocalApplyDropdownAdapters[0], clicks: () => clicks, writes: () => writes };
}

test('查询、准备及点选分离：前两阶段零点击，真实选中才能接受，句柄一次性', async () => {
  const env = fixture(); const state = await env.U.query(env.el, '男', { lifecycle: { check() {} } });
  assert.equal(env.writes(), 1); assert.equal(env.U.accepted(env.el, '男'), false); assert.equal(env.clicks(), 0);
  const choice = await env.U.prepareChoice(state); assert.equal(env.clicks(), 0); assert.deepEqual(Object.keys(choice), ['handle']);
  assert.equal((await env.U.commitChoice(state, choice)).ok, true); assert.equal(env.clicks(), 1); assert.equal(env.U.accepted(env.el, '男'), true);
  await assert.rejects(env.U.commitChoice(state, choice)); assert.equal(env.clicks(), 1);
});

test('鼠标按下时取消或重绘候选，不再向旧节点发送抬起/点击',async()=>{
  for(const mode of ['cancel','replace']){const env=fixture();env.context.window={};env.context.MouseEvent=class{constructor(type){this.type=type;}};const controller=new AbortController();const events=[];
    const state=await env.U.query(env.el,'男',{signal:controller.signal,lifecycle:{check(){}}});const choice=await env.U.prepareChoice(state);const node=env.nodes[0];node.dispatchEvent=(event)=>{events.push(event.type);if(mode==='cancel')controller.abort();else{env.nodes[0]=env.option();node.isConnected=false;}};
    await assert.rejects(env.U.commitChoice(state,choice));assert.deepEqual(events,['mousedown']);assert.equal(env.clicks(),0);
  }
});

test('伪造/跨会话候选、准备后替换/标签变化及重复候选都不点击', async () => {
  for (const mode of ['copy', 'replace', 'label', 'duplicate']) {
    const env = fixture(); const state = await env.U.query(env.el, '男'); const choice = await env.U.prepareChoice(state);
    if (mode === 'replace') env.nodes[0] = env.option(); if (mode === 'label') env.nodes[0].textContent = '女'; if (mode === 'duplicate') env.nodes.push(env.option('男', 'other'));
    await assert.rejects(env.U.commitChoice(state, mode === 'copy' ? JSON.parse(JSON.stringify(choice)) : choice)); assert.equal(env.clicks(), 0);
  }
});

test('取消、失焦、输入外部变化、关联菜单变化后无点选，迟到候选也不能恢复', async () => {
  for (const mode of ['cancel', 'blur', 'edit', 'relation']) {
    const env = fixture(); env.nodes.length = 0; const controller = new AbortController(); const state = await env.U.query(env.el, '男', { signal: controller.signal });
    const pending = env.U.prepareChoice(state); setTimeout(() => { if (mode === 'cancel') controller.abort(); if (mode === 'blur') env.document.activeElement = {}; if (mode === 'edit') env.el.value = '网页手填'; if (mode === 'relation') env.attrs['aria-controls'] = 'foreign'; }, 10);
    await assert.rejects(pending); env.nodes.push(env.option()); await new Promise((resolve) => setTimeout(resolve, 90)); assert.equal(env.clicks(), 0); env.U.close(state);
  }
});

test('新查询使旧请求失效，跨请求候选句柄不能执行', async () => {
  const env = fixture(); const old = await env.U.query(env.el, '男'); const choice = await env.U.prepareChoice(old); const next = await env.U.query(env.el, '男');
  await assert.rejects(env.U.commitChoice(old, choice)); await assert.rejects(env.U.commitChoice(next, choice)); assert.equal(env.clicks(), 0);
});

test('超时/缺少关联/重复/禁用和受保护候选均无额外点击', async () => {
  for (const mode of ['timeout', 'relation', 'duplicate', 'disabled', 'protected']) {
    const env = fixture(); if (mode === 'timeout') env.nodes.length = 0; if (mode === 'relation') env.attrs['aria-controls'] = 'missing';
    if (mode === 'duplicate') env.nodes.push(env.option('男', 'other')); if (mode === 'disabled') env.nodes[0].disabled = true;
    if (mode === 'protected') { env.nodes[0].textContent = '同意协议'; env.nodes[0].attrs['data-value'] = 'M'; }
    const result = await env.U.interact(env.el, mode === 'protected' ? 'M' : '男'); assert.equal(result.ok, false); assert.equal(env.clicks(), 0);
  }
});

test('框架拒绝选择时不能把查询文本判成功，错误/取消恢复且保持手填内容', async () => {
  const env = fixture(); env.el.reject = true; const result = await env.U.interact(env.el, '男'); assert.equal(result.ok, true); assert.equal(env.U.accepted(env.el, '男'), false);
  env.el.reject = false; assert.equal((await env.U.interact(env.el, '男')).ok, true); assert.equal(env.U.accepted(env.el, '男'), true);
});

test('下拉外层计划只能 resolve-option/delegated，不允许夹带目标脚本或跨能力操作', () => {
  const env = fixture(); const C = env.C; const intent = { version: 1, intentId: 'intent.a', binding: { sessionId: 's', tabId: 1, documentId: 'd', scanId: 'scan.a', semanticId: 'semantic.0123456789abcdef' }, source: { profileId: 'p', fieldId: 'f', entryId: null, revision: 1 }, valueType: C.projectDefinition({ type: 'select' }), value: '男' };
  const plan = { version: 1, planId: 'plan.a', intentId: intent.intentId, binding: intent.binding, source: intent.source, controlFingerprint: 'control.v1.0123456789abcdef', operation: 'resolve-option', verification: 'selected-option', state: 'delegated', adapterId: 'dropdown' };
  C.validatePlan(plan, intent);
  for (const extra of [{ state: 'ready' }, { javascript: 'alert(1)' }, { adapterId: 'text' }, { targetOption: { handle: 'option.x', value: 'M', label: '男' } }]) assert.throws(() => C.validatePlan({ ...plan, ...extra }, intent));
});
