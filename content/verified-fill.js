// 阶段三在成熟填写器外增加严格选择和延迟复读验证，不接触提交/验证码/密码。
(function (global) {
  'use strict';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const A = global.LocalApplyFieldAdapters;
  const C = global.LocalApplyFillContract;
  const R = global.LocalApplyAdapterRegistry;
  const preparedPlans = new WeakMap();

  // 扫描器提供独立控件描述；兼容旧的本页调用封套，不使用语义 key 选择写入方式。
  function controlOf(item) { return item.control || global.FieldMatchingEngine.controlDescriptor(item.field); }

  // 按控件描述比较真实选中状态和编辑器分行文本，显示变化不能代替控件接受。
  function accepted(item, expected) {
    const { el, members } = item; const control = controlOf(item);
    if (!el.isConnected || el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false) return false;
    if (A.handles(item)) return A.accepted(item, expected);
    if (['select', 'radio', 'checkbox'].includes(control.type)) return global.LocalApplyNativeChoices.accepted(item, expected);
    if (control.type === 'combobox') {
      if (global.LocalApplyDropdownControls) return global.LocalApplyDropdownControls.accepted(el, expected);
      if (A.dropdown(el)) return A.dropdownAccepted(el, expected);
      const menu = el.getRootNode().getElementById?.(el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
      const selected = [...(menu?.querySelectorAll('[role="option"][aria-selected="true"]') || [])];
      return selected.some((option) => option.textContent.trim() === String(expected) || option.getAttribute('data-value') === String(expected))
        && ('value' in el ? el.value === String(expected) : el.textContent.trim() === String(expected));
    }
    return (el.isContentEditable ? (global.WangshenFiller?.readText?.(el) ?? el.textContent) : el.value) === String(expected);
  }

  // 复读跨过框架事件和延迟重渲染，DOM 回退或校验失败不记成功。
  async function verify(item, value) {
    await wait(120); const first = accepted(item, value);
    await wait(380); const second = accepted(item, value);
    return first && second ? { status: 'success', ok: true, verifiedAt: new Date().toISOString() }
      : { status: 'failed', ok: false, reason: '网页未接受新值、校验失败或受控组件已回退' };
  }

  // 按当前控件读取非空冲突；覆盖许可仍绑定用户刚核对的旧值。
  function conflict(item, value, options) {
    const before = global.LocalApplyPageScanner.readValue(item);
    const occupied = Array.isArray(before) ? before.length > 0 : before !== '' && before !== null && before !== undefined && before !== false && !(controlOf(item).type === 'combobox' && /^(请选择|请选择一项|Select|Please select)$/i.test(before));
    if (options.overwrite && JSON.stringify(before) !== JSON.stringify(options.expectedCurrent)) return { status: 'needs_confirmation', ok: false, reason: '网页内容在确认后已变化，请重新核对差异', conflict: { before, after: value } };
    const different = item.compound ? A.hasConflict(item, value) : occupied && !accepted(item, value);
    if (!options.overwrite && different) return { status: 'needs_confirmation', ok: false, reason: '网页已有不同内容，已保留；核对差异后可单独允许覆盖', conflict: { before, after: value } };
    return null;
  }

  // 原生候选只按现有明确标签/值比较；结构与节点引用仅保存在本页，不进入计划消息。
  function nativeCandidates(item) { return controlOf(item).type === 'select' ? [...item.el.options] : item.members; }

  // 记录会使计划失效的局部结构和候选状态；不收集整个页面 HTML 或其他字段值。
  function structure(item) {
    const type = controlOf(item).type;
    return JSON.stringify({ field: global.FieldMatchingEngine.features(item.field), control: controlOf(item),
      attributes: ['type', 'readonly', 'contenteditable', 'role', 'min', 'max', 'placeholder', 'aria-controls', 'aria-owns', 'aria-disabled', 'aria-readonly', 'aria-autocomplete', 'aria-haspopup', 'multiple', 'name', 'form'].map((name) => item.el.getAttribute(name)),
      candidates: ['select', 'radio', 'checkbox'].includes(type) ? global.LocalApplyNativeChoices.snapshot(item).rows?.map(({ node, ...row }) => row) || [] : [] });
  }

  // 适配器只持有当前项和固定守卫；每次执行/回读重新检查文档授权及原节点。
  function adapterContext(item, intent, options = {}) {
    return { item, intent, signal: options.signal,
      // 扫描器复核 URL/授权/类型/可见性；节点替换不能沿用先前计划。
      assertActive() {
        const current = global.LocalApplyPageScanner.record(intent.binding.scanId, intent.binding.documentId, intent.binding.semanticId);
        if (current.el !== item.el || controlOf(current).fingerprint !== controlOf(item).fingerprint) throw new Error('填写控件已变化');
        if (['radio', 'checkbox'].includes(controlOf(item).type) && (current.members.length !== item.members.length
          || current.members.some((node, index) => node !== item.members[index]))) throw new Error('填写候选已变化');
        return current;
      },
      // 状态读取沿用已有真实性及校验检查，不读取框架私有对象。
      accepted(value) { return accepted(item, value); },
      // 执行器须消费原计划，不能绕过私有身份、来源和非空快照检查。
      consumePlan(plan) { validatePrepared(plan, item, intent, true); return preparedPlans.get(plan).adapterState; }
    };
  }

  // 只准备计划不点击；复杂控件明确委托旧链路，不把未发现的异步选项冒充已解析目标。
  function prepare(item, intent, options = {}) {
    C.validateIntent(intent, { binding: { scanId: item.field.scanId, semanticId: item.field.semanticId } });
    const value = intent.value; const control = controlOf(item); const adapted = A.handles(item); const adapter = R.resolve(control, { item });
    const prepared = adapter?.prepare(control, intent, adapterContext(item, intent, options));
    if (prepared?.error) return prepared;
    if (adapted) { const existing = A.plan(item, value); if (existing.error) return { error: { ...existing.error, diagnostic: { phase: 'plan' } } }; }
    const blocked = conflict(item, value, options); if (blocked) return { error: { ...blocked, diagnostic: { phase: 'protect', reasonCode: 'existing_value_preserved' } } };
    let operation = prepared?.operation || (adapted || ['checkbox', 'combobox'].includes(control.type) ? 'legacy-interaction' : 'write-value'); let targetOption = prepared?.targetOption; let optionNode;
    if (accepted(item, value)) operation = 'verify-existing';
    else if (!adapter && !adapted && ['select', 'radio'].includes(control.type)) {
      const candidates = nativeCandidates(item); const found = candidates.filter((node) => node.value === String(value)
        || (control.type === 'select' ? node.textContent : node.closest('label')?.textContent)?.trim() === String(value));
      if (found.length !== 1) return { error: { status: 'failed', ok: false, reason: '没有唯一的精确选项，未进行模糊选择', diagnostic: { phase: 'options', candidateCount: candidates.length, matchCount: found.length, reasonCode: found.length ? 'ambiguous_option' : 'no_exact_option' } } };
      optionNode = found[0];
      if (optionNode.disabled || optionNode.closest('optgroup[disabled]') || optionNode.getAttribute('aria-disabled') === 'true') return { error: { status: 'unsupported', ok: false, reason: '目标选项已禁用，未执行填写', diagnostic: { phase: 'plan', reasonCode: 'unsupported_control' } } };
      operation = 'select-option'; targetOption = { handle: 'option.' + crypto.randomUUID(), label: (control.type === 'select' ? optionNode.textContent : optionNode.closest('label')?.textContent)?.trim() || '', value: optionNode.value };
    }
    const date = adapted && !['phone', 'address'].includes(item.compound?.kind) ? A.dateValue(value) : null;
    const plan = { version: C.VERSION, planId: 'plan.' + crypto.randomUUID(), intentId: intent.intentId,
      binding: { ...intent.binding }, source: { ...intent.source }, controlFingerprint: control.fingerprint, operation,
      verification: ({ 'write-value': 'value', 'select-option': 'selected-option', 'select-options': 'selected-options', 'set-checked': 'checked-state', 'fill-date': 'date-parts', 'fill-phone': 'phone-parts', 'resolve-option': 'selected-option' })[operation] || 'legacy-delayed', state: ['legacy-interaction', 'fill-date', 'fill-phone', 'resolve-option'].includes(operation) ? 'delegated' : 'ready',
      ...(adapter ? { adapterId: adapter.id } : {}), ...(targetOption ? { targetOption } : {}),
      ...(prepared?.targetOptions ? { targetOptions: prepared.targetOptions } : {}), ...(prepared?.targetParts ? { targetParts: prepared.targetParts } : {}), ...(prepared?.targetPrecision ? { targetPrecision: prepared.targetPrecision } : {}), ...(typeof prepared?.checked === 'boolean' ? { checked: prepared.checked } : {}), ...(date ? { datePrecision: date.precision } : {}) };
    C.validatePlan(plan, intent);
    preparedPlans.set(plan, { item, optionNode, adapterState: prepared?.adapterState, candidates: ['select', 'radio', 'checkbox'].includes(control.type) ? [...nativeCandidates(item)] : null,
      selection: ['select', 'radio', 'checkbox'].includes(control.type) ? nativeCandidates(item).map((node) => control.type === 'select' ? node.selected : node.checked) : null,
      structure: structure(item), current: JSON.stringify(global.LocalApplyPageScanner.readValue(item)),
      intent: JSON.stringify(intent), encoded: JSON.stringify(plan), createdAt: Date.now(), used: false });
    return { plan };
  }

  // 执行前核对本页签发身份、原来源、候选、节点和授权；复制、篡改、过期及重复消费均拒绝。
  function validatePrepared(plan, item, intent, consume = false) {
    C.validatePlan(plan, intent); const saved = preparedPlans.get(plan);
    if (!saved || saved.used || Date.now() - saved.createdAt > 30000 || saved.encoded !== JSON.stringify(plan) || saved.intent !== JSON.stringify(intent)) throw new Error('填写计划已失效，请重新准备');
    const current = global.LocalApplyPageScanner.record(intent.binding.scanId, intent.binding.documentId, intent.binding.semanticId);
    if (saved.item.el !== item.el || current.el !== item.el || structure(current) !== saved.structure
      || ['date', 'phone'].includes(plan.adapterId) && !global.LocalApplyDatePhoneControls.unchanged(saved.adapterState, current)
      || JSON.stringify(global.LocalApplyPageScanner.readValue(current)) !== saved.current
      || saved.candidates && (nativeCandidates(current).length !== saved.candidates.length || nativeCandidates(current).some((node, index) => node !== saved.candidates[index]
        || (controlOf(current).type === 'select' ? node.selected : node.checked) !== saved.selection[index]))
      || saved.optionNode && !nativeCandidates(current).includes(saved.optionNode)) throw new Error('填写控件或候选已变化，请重新准备');
    if (plan.adapterId && R.resolve(controlOf(current), { item: current }) !== R.get(plan.adapterId)) throw new Error('填写适配器已变化');
    if (consume) saved.used = true;
    return plan;
  }

  // 按控件描述选择已有执行路径；语义仅保留既有选项规范化提示，非空保护与延迟回读不变。
  async function write(item, value, options = {}) {
    const { el, members, field } = item; const control = controlOf(item);
    if (A.handles(item)) { const next = A.plan(item, value); if (next.error) return { ...next.error, diagnostic: { phase: 'plan' } }; }
    const blocked = conflict(item, value, options); if (blocked) return { ...blocked, diagnostic: { phase: 'protect', reasonCode: 'existing_value_preserved' } };
    if (accepted(item, value)) return { ...await verify(item, value), diagnostic: { phase: 'verify' } };
    if (A.handles(item)) {
      const result = await A.fill(item, value); if (!result.ok) return { status: result.status || 'failed', ...result };
    } else if (control.type === 'combobox') {
      if (A.dropdown(el)) {
        const result = await A.fillDropdown(el, value, '', field.label); if (!result.ok) return result;
      } else {
        const menu = el.getRootNode().getElementById?.(el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
        const candidates = [...(menu?.querySelectorAll('[role="option"]') || [])].filter((option) => option.textContent.trim() === String(value) || option.getAttribute('data-value') === String(value));
        if (candidates.length !== 1 || candidates[0].matches('button,input,a,[role="button"]') || candidates[0].querySelector('button,input,a,[role="button"]')) return { status: 'unsupported', ok: false, reason: '自定义下拉无唯一安全选项，请在网页手动选择', diagnostic: { phase: 'options', candidateCount: menu?.querySelectorAll('[role="option"]').length || 0, matchCount: candidates.length, reasonCode: !menu ? 'popup_not_found' : candidates.length > 1 ? 'ambiguous_option' : candidates.length ? 'unsupported_control' : 'no_exact_option' } };
        candidates[0].click();
      }
    } else if (['select', 'radio'].includes(control.type)) {
      const candidates = control.type === 'select' ? [...el.options] : members;
      const found = candidates.filter((option) => option.value === String(value) || (control.type === 'select' ? option.textContent : option.closest('label')?.textContent)?.trim() === String(value));
      if (found.length !== 1) return { status: 'failed', ok: false, reason: '没有唯一的精确选项，未进行模糊选择', diagnostic: { phase: 'options', candidateCount: candidates.length, matchCount: found.length, reasonCode: found.length ? 'ambiguous_option' : 'no_exact_option' } };
      if (control.type === 'select') { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, found[0].value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else found[0].click();
    } else if (control.type === 'checkbox') {
      if ((members.length === 1 && typeof value !== 'boolean') || (members.length > 1 && !Array.isArray(value))) return { status: 'unsupported', ok: false, reason: '复选框需要布尔值或明确的选项数组' };
      for (const node of members) { const desired = members.length === 1 ? value : value.includes(node.value); if (node.checked !== desired) node.click(); }
    } else if (el.readOnly) return { status: 'unsupported', ok: false, reason: '只读或复杂日期控件需要网页手动操作' };
    else {
      const result = await global.WangshenFiller.fillElement(el, value, { inputType: control.type, options: field.options });
      if (!result.ok) return { status: 'failed', ...result };
    }
    const result = await verify(item, value);
    if (result.ok) global.WangshenFiller.markFilled(el);
    return { ...result, diagnostic: { phase: 'verify', reasonCode: result.ok ? 'verified' : 'value_not_accepted' } };
  }
  // 文本及原生选择意图交固定注册表执行；复杂控件保留旧路径，失败不双重执行。
  async function fill(item, value, options = {}) {
    A.diagnostic?.(item, true); let result;
    if (options.intent) {
      C.validateIntent(options.intent, { value }); const prepared = prepare(item, options.intent, options);
      if (prepared.error) result = prepared.error;
      else if (prepared.plan.adapterId) {
        const adapter = R.get(prepared.plan.adapterId); const context = adapterContext(item, options.intent, options);
        const attempt = await adapter.execute(prepared.plan, context);
        result = attempt.ok ? await adapter.verify(prepared.plan, context) : attempt;
        if (result.ok) global.WangshenFiller.markFilled(item.el);
        result = { ...result, diagnostic: { ...result.diagnostic, phase: attempt.ok ? 'verify' : 'write' } };
      } else { validatePrepared(prepared.plan, item, options.intent, true); result = await write(item, value, options); }
    } else result = await write(item, value, options); // 保留本页旧调用兼容，消息入口始终要求后台意图。
    const trace = A.diagnostic?.(item) || {};
    const control = controlOf(item);
    const adapter = item.compound?.kind || (A.dropdown(item.el) ? 'moka-dropdown' : ({ select: 'native-select', combobox: 'aria-combobox', radio: 'radio', checkbox: 'checkbox' })[control.type]) || (A.handles(item) ? 'date' : 'text');
    const reasonCode = result.ok ? 'verified' : result.diagnostic?.reasonCode || trace.reasonCode || (/精度|只有年|不能.*补日/.test(result.reason || '') ? 'insufficient_date_precision' : /日期/.test(result.reason || '') && result.status !== 'unsupported' ? 'invalid_date' : result.status === 'unsupported' ? 'unsupported_control' : 'write_rejected');
    return { ...result, diagnostic: { adapter, phase: 'write', ...trace, ...result.diagnostic, reasonCode, controlType: control.type, status: result.status || (result.ok ? 'success' : 'failed') } };
  }
  global.LocalApplyVerifiedFill = { fill, verify, accepted };
  global.LocalApplyFillPlanner = { prepare, validate: validatePrepared }; // 仅隔离内容脚本可见；无消息/模型执行接口。
})(globalThis);
