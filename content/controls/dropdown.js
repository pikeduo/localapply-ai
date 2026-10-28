// 搜索下拉分为查询、私有候选准备和点选；只接受本控件的关联菜单，不执行外部脚本。
(function (global) {
  'use strict';
  const A = global.LocalApplyFieldAdapters; const D = global.LocalApplyDropdownDOM;
  const active = new WeakMap(); const receipts = new WeakMap(); const choices = new WeakMap();
  const executed = new WeakSet();

  // 固定状态仅带白名单原因码；不把标签、编码、搜索词或原始异常带入诊断。
  function failure(reason, code = 'unsupported_control', status = 'unsupported') { return { ok: false, status, reason, diagnostic: { reasonCode: code } }; }

  // ARIA 必须精确关联一个本根节点内的菜单；多 ID、跨根或非列表结构不猜测归属。
  function linkId(el) {
    const key = el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '';
    return key && !/\s/.test(key.trim()) ? key.trim() : '';
  }
  // 菜单可在打开后才挂载；ID 必须明确且唯一，准备点选后仍核对原菜单节点。
  function linked(el) {
    const key = linkId(el); if (!key) return null; const root = el.getRootNode();
    if (root.querySelectorAll && root.querySelectorAll('#' + CSS.escape(key)).length !== 1) return null;
    const menu = root.getElementById?.(key);
    return menu?.matches('[role="listbox"]') && menu.getAttribute('aria-multiselectable') !== 'true' ? menu : null;
  }

  // 输入与显示值分别观察；查询文字不会独立构成选中证据。
  function display(el) { return A.dropdown(el) ? A.dropdownText(el) : 'value' in el ? el.value : el.textContent.trim(); }
  // 安全属性不随菜单开合变化；关系由 ARIA 或本次打开的唯一 portal 另行核对。
  function shape(el) { return JSON.stringify(['type', 'name', 'role', 'readonly', 'aria-disabled', 'aria-label', 'aria-autocomplete'].map((key) => el.getAttribute(key))); }
  // 仅对当前控件读取查询值及确认显示，其他个人字段不在观察范围内。
  function observed(el) { return JSON.stringify([el.value ?? null, display(el)]); }
  // 只允许正式候选本身及安全后代，提交/链接/输入和协议操作永不点击。
  function safe(node) {
    return D.usable(node) && !node.matches('button,input,a,[role="button"]') && !node.closest('button,a') && !node.querySelector('button,input,a,[role="button"]')
      && !global.FieldMatchingEngine.restricted({ label: D.optionLabel(node), group: '' }) && !/同步更新在线简历/.test(D.optionLabel(node));
  }
  // 候选必须来自绑定列表或成熟 Moka 局部菜单，不扫描其他弹层的相似文字。
  function candidates(state) {
    const menu = state.moka ? D.popupFor(state.el, state.before) : linked(state.el);
    const rows = state.moka ? A.dropdownOptions(state.el) : [...(menu?.querySelectorAll('[role="option"]') || [])].filter(safe);
    return { menu, rows };
  }
  // 值编码可显式匹配，标签只复用原有有界等价规则，不新增业务语义猜测。
  function matches(node, state) { return A.optionEqual(D.optionLabel(node), state.value, state.fieldLabel, state.unit) || node.getAttribute('data-value') === state.value; }
  // 同一已点选候选的确认标记及显示值都须保持；单有搜索文本/折叠状态不能冒充成功。
  function accepted(el, value) {
    const expected = String(value); const saved = receipts.get(el); const actual = display(el);
    if (saved && [saved.value, saved.label, saved.code].includes(expected) && [saved.label, saved.code, saved.value].includes(actual)) {
      if (A.dropdown(el)) return true;
      if (saved.node.getAttribute('aria-selected') === 'true' || saved.code !== null && el.getAttribute('data-value') === saved.code) return true;
    }
    if (A.dropdown(el)) return false;
    const selected = [...(linked(el)?.querySelectorAll('[role="option"][aria-selected="true"]') || [])];
    return selected.length === 1 && matches(selected[0], { value: expected, fieldLabel: '', unit: '' })
      && [D.optionLabel(selected[0]), selected[0].getAttribute('data-value')].includes(actual);
  }
  // 取消结束等待且释放监听器；计时器只回读，不安排任何迟到点选。
  function delay(ms, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      // 正常到时与取消共用释放入口。
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
    });
  }
  // 每次动作前核对本次会话、原节点/属性/内容和焦点；新查询自动使旧会话失效。
  function check(state, focus = true) {
    if (state.signal?.aborted) throw failure('已取消填写', 'write_rejected', 'failed');
    if (state.closed || active.get(state.el) !== state) throw failure('下拉查询已失效，已停止填写', 'write_rejected', 'failed');
    state.lifecycle?.check();
    const button = state.el.closest('button');
    if (state.el.closest('a') || button && (button !== state.el || button.type !== 'button')) throw failure('下拉触发器包含提交或链接操作，未自动打开');
    if (!state.el.isConnected || state.el.disabled || state.el.getAttribute('aria-disabled') === 'true' || shape(state.el) !== state.shape
      || A.exclusion(state.el, state.fieldLabel)?.category === 'security_control' || observed(state.el) !== state.observed) throw failure('下拉控件或内容已变化，已停止填写', 'write_rejected', 'failed');
    if (!state.moka) {
      const current = linked(state.el); const id = linkId(state.el);
      if (id !== state.linkId && !(state.committed && !id) || state.choice && current !== state.menu && !(state.committed && !current)) throw failure('下拉关联菜单已变化，请重新扫描', 'popup_not_found', 'failed');
      if (!state.choice && !state.committed) state.menu = current;
    }
    if (focus && !(document.activeElement === state.el || state.owner?.contains(document.activeElement))) throw failure('焦点已离开当前字段，已停止选择', 'focus_lost');
  }
  // 只在已知的当前节点动作之后更新观察值；父级日期/电话仍检查其他子项。
  function changed(state) { state.lifecycle?.changed?.(state.el); state.observed = observed(state.el); }

  // 第一阶段只打开本控件并查询，返回会话，不把搜索输入当成完成。
  async function query(el, value, options = {}) {
    const owner = A.dropdown(el); const state = { el, value: String(value), fieldLabel: options.fieldLabel || '', unit: options.unit || '', signal: options.signal,
      lifecycle: options.lifecycle, owner, moka: !!owner, linkId: linkId(el), menu: owner ? null : linked(el), shape: shape(el), observed: observed(el), started: Date.now(), closed: false };
    state.trace = { adapter: owner ? 'moka-dropdown' : 'aria-combobox', phase: 'open', candidateCount: 0, matchCount: 0, searchable: el.tagName === 'INPUT' && !el.readOnly && (!owner || !owner.classList.contains('select')) };
    active.set(el, state); receipts.delete(el);
    try {
      check(state, false); if (!owner && !state.linkId) throw failure('没有明确关联的 ARIA 列表，请在网页选择', 'popup_not_found');
      el.focus(); check(state);
      const lifecycle = { check: () => check(state), changed: () => changed(state) };
      state.before = await D.openControl(el, false, lifecycle); check(state);
      if (state.trace.searchable) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, state.value);
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); changed(state);
      }
      return state;
    } catch (error) { state.trace.reasonCode = error?.diagnostic?.reasonCode || 'write_rejected'; if (active.get(el) === state) D.trace(el, state.trace); close(state); throw error; }
  }

  // 第二阶段有界等待并准备唯一真实候选；私有身份和节点快照不能由 JSON 伪造。
  async function prepareChoice(state) {
    let previous = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(60, state.signal); check(state);
      const { menu, rows } = candidates(state); const visible = D.popupRoots(); const found = rows.filter((node) => matches(node, state));
      Object.assign(state.trace, { phase: 'options', candidateCount: rows.length, matchCount: found.length, associatedPopup: !!menu || rows.length > 0,
        popupRelation: state.moka ? menu ? state.el.getAttribute('aria-controls') || state.el.getAttribute('aria-owns') ? 'aria' : 'portal' : rows.length ? 'local' : 'none' : menu ? 'aria' : 'none', popupCount: visible.length,
        newPopupCount: visible.filter((node) => !state.before.has(node)).length, focused: true, elapsedMs: Date.now() - state.started });
      if (found.length > 1) throw failure('存在多个精确候选，未进行猜选', 'ambiguous_option');
      if (rows.length > 500) throw failure('候选数量超出安全范围，请手动选择');
      const node = found[0];
      if (node && previous === node && menu?.getAttribute('aria-busy') !== 'true' && state.el.getAttribute('aria-busy') !== 'true') {
        const selection = Object.freeze({ handle: 'choice.' + crypto.randomUUID() });
        choices.set(selection, { state, node, menu, label: D.optionLabel(node), code: node.getAttribute('data-value'), at: Date.now(), used: false }); state.choice = selection; return selection;
      }
      previous = node || null;
    }
    throw failure('下拉未出现属于此字段的唯一精确选项，请在网页选择', !state.trace.associatedPopup ? 'popup_not_found' : !state.trace.candidateCount ? 'options_not_found' : 'no_exact_option');
  }

  // 第三阶段再次核对候选归属/身份/内容后只点一次；准备后重绘或失焦不能用旧节点。
  async function commitChoice(state, selection) {
    try {
      check(state); const saved = choices.get(selection); const current = candidates(state); const found = current.rows.filter((node) => matches(node, state));
      if (!saved || saved.used || saved.state !== state || state.choice !== selection || Date.now() - saved.at > 3000 || current.menu !== saved.menu || found.length !== 1 || found[0] !== saved.node || !safe(saved.node)
        || D.optionLabel(saved.node) !== saved.label || saved.node.getAttribute('data-value') !== saved.code) throw failure('准备的候选已变化，未执行点选', 'write_rejected', 'failed');
      saved.used = true;
      // 沿用成熟填写器的鼠标事件顺序；mousedown 已确认选中时不再补 click，每次动作前仍复核取消。
      if(saved.node.dispatchEvent&&global.MouseEvent){
        for(const type of ['mousedown','mouseup']){check(state);checkCandidate(state,saved);saved.node.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));changed(state);if(accepted(state.el,state.value))break;}
      }
      if(!accepted(state.el,state.value)){check(state);checkCandidate(state,saved);saved.node.click();changed(state);}
      state.committed = true;
      receipts.set(state.el, { value: state.value, label: saved.label, code: saved.code, node: saved.node });
      await delay(60, state.signal); check(state, false); state.el.blur(); changed(state);
      state.trace.phase = 'select'; state.trace.reasonCode = 'option_selected';
      return { ok: true };
    } catch (error) { close(state); throw error; }
  }
  // 鼠标事件之间也复核唯一候选和原节点；重绘/标签变化不能继续向已脱离的旧节点发动作。
  function checkCandidate(state,saved){const current=candidates(state);const found=current.rows.filter((node)=>matches(node,state));if(current.menu!==saved.menu||found.length!==1||found[0]!==saved.node||!safe(saved.node)||D.optionLabel(saved.node)!==saved.label||saved.node.getAttribute('data-value')!==saved.code)throw failure('点选期间候选已变化，已停止选择','write_rejected','failed');}
  // 释放本次活动候选，迟到响应不能重新激活旧会话；不点击网页关闭/提交按钮。
  function close(state) { state.closed = true; state.choice = null; }
  // 旧日期/电话子项也复用相同三阶段管线，失败不转入原单体路径。
  async function interact(el, value, options = {}) {
    let state;
    try { state = await query(el, value, options); const selected = await prepareChoice(state); return await commitChoice(state, selected); }
    catch (error) { if (state) Object.assign(state.trace, { reasonCode: error?.diagnostic?.reasonCode || 'write_rejected', focused: document.activeElement === el || !!state.owner?.contains(document.activeElement) }); return error?.diagnostic ? error : failure('下拉控件、内容或授权已变化，已停止填写', 'write_rejected', 'failed'); }
    finally { if (state) { if (active.get(el) === state) D.trace(el, state.trace); close(state); } }
  }

  // 单个固定能力只接管独立下拉；日期/电话/地址继续由各自编排器持有子项归属。
  const adapter = Object.freeze({ id: 'dropdown',
    // 只按明确 combobox 或成熟 Moka 外壳识别，不接管普通文本。
    detect(control, { item }) { return !A.handles(item) && control.type === 'combobox' && (!!A.dropdown(item.el) || item.el.getAttribute('role') === 'combobox'); },
    // 外层计划只声明待解析操作，不打开菜单或声称异步目标已准备完成。
    prepare(control, intent, context) {
      if (!['string', 'number'].includes(typeof intent.value)) return { error: failure('此下拉需要明确单选值，不自动处理多选') };
      if (global.FieldMatchingEngine.restricted(context.item.field) || /同步更新在线简历/.test(context.item.field.label)) return { error: failure('受保护字段不自动选择') };
      return { operation: context.accepted(intent.value) ? 'verify-existing' : 'resolve-option' };
    },
    // 消费唯一外层计划后才查询；所有回调继续核对原文档/来源及控件节点。
    async execute(plan, context) {
      if (plan.adapterId !== 'dropdown') throw new Error('下拉计划不匹配'); context.consumePlan(plan);
      executed.add(plan);
      if (context.signal?.aborted) return failure('已取消填写', 'write_rejected', 'failed');
      if (plan.operation === 'verify-existing') return { ok: true };
      return interact(context.item.el, context.intent.value, { fieldLabel: context.item.field.label, signal: context.signal, lifecycle: { check: () => context.assertActive() } });
    },
    // 真正选中证据和页面显示须跨重绘窗口保持，搜索文字/仅关闭菜单均不足以成功。
    async verify(plan, context) {
      if (!executed.delete(plan)) return global.LocalApplyFillResult.failure('stale_plan');
      return global.LocalApplyFillVerification.run(context);
    }
  });
  global.LocalApplyDropdownControls = Object.freeze({ query, prepareChoice, commitChoice, close, interact, accepted });
  global.LocalApplyDropdownAdapters = Object.freeze([adapter]);
})(globalThis);
