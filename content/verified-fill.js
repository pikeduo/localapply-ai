// 阶段三在成熟填写器外增加严格选择和延迟复读验证，不接触提交/验证码/密码。
(function (global) {
  'use strict';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const A = global.LocalApplyFieldAdapters;
  const C = global.LocalApplyFillContract;
  const preparedPlans = new WeakMap();

  // 扫描器提供独立控件描述；兼容旧的本页调用封套，不使用语义 key 选择写入方式。
  function controlOf(item) { return item.control || global.FieldMatchingEngine.controlDescriptor(item.field); }

  // 按控件描述比较实际选中状态，避免仅显示文本变化而未选中有效 option 的假成功。
  function accepted(item, expected) {
    const { el, members } = item; const control = controlOf(item);
    if (!el.isConnected || el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false) return false;
    if (A.handles(item)) return A.accepted(item, expected);
    if (control.type === 'checkbox') {
      if (members.length === 1) return typeof expected === 'boolean' && el.checked === expected;
      return Array.isArray(expected) && JSON.stringify(members.filter((node) => node.checked).map((node) => node.value).sort()) === JSON.stringify([...expected].map(String).sort());
    }
    if (control.type === 'radio') return members.some((node) => node.checked && (node.value === String(expected) || node.closest('label')?.textContent.trim() === String(expected)));
    if (control.type === 'select') return [...el.selectedOptions].some((option) => option.value === String(expected) || option.textContent.trim() === String(expected));
    if (control.type === 'combobox') {
      if (A.dropdown(el)) return A.dropdownAccepted(el, expected);
      const menu = el.getRootNode().getElementById?.(el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
      const selected = [...(menu?.querySelectorAll('[role="option"][aria-selected="true"]') || [])];
      return selected.some((option) => option.textContent.trim() === String(expected) || option.getAttribute('data-value') === String(expected))
        && ('value' in el ? el.value === String(expected) : el.textContent.trim() === String(expected));
    }
    return (el.isContentEditable ? el.textContent : el.value) === String(expected);
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
      attributes: ['type', 'readonly', 'min', 'max', 'placeholder', 'aria-controls', 'aria-owns', 'aria-disabled'].map((name) => item.el.getAttribute(name)),
      candidates: ['select', 'radio'].includes(type) ? nativeCandidates(item).map((node) => ({ value: node.value,
        label: (type === 'select' ? node.textContent : node.closest('label')?.textContent)?.trim() || '', disabled: !!node.disabled || !!node.closest('optgroup[disabled]') })) : [] });
  }

  // 只准备计划不点击；复杂控件明确委托旧链路，不把未发现的异步选项冒充已解析目标。
  function prepare(item, intent, options = {}) {
    C.validateIntent(intent, { binding: { scanId: item.field.scanId, semanticId: item.field.semanticId } });
    const value = intent.value; const control = controlOf(item); const adapted = A.handles(item);
    if (adapted) { const existing = A.plan(item, value); if (existing.error) return { error: { ...existing.error, diagnostic: { phase: 'plan' } } }; }
    const blocked = conflict(item, value, options); if (blocked) return { error: { ...blocked, diagnostic: { phase: 'protect', reasonCode: 'existing_value_preserved' } } };
    let operation = adapted || ['checkbox', 'combobox'].includes(control.type) ? 'legacy-interaction' : 'write-value'; let targetOption; let optionNode;
    if (accepted(item, value)) operation = 'verify-existing';
    else if (!adapted && ['select', 'radio'].includes(control.type)) {
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
      verification: ({ 'write-value': 'value', 'select-option': 'selected-option' })[operation] || 'legacy-delayed', state: operation === 'legacy-interaction' ? 'delegated' : 'ready',
      ...(targetOption ? { targetOption } : {}), ...(date ? { datePrecision: date.precision } : {}) };
    C.validatePlan(plan, intent);
    preparedPlans.set(plan, { item, optionNode, structure: structure(item), current: JSON.stringify(global.LocalApplyPageScanner.readValue(item)),
      intent: JSON.stringify(intent), encoded: JSON.stringify(plan), createdAt: Date.now(), used: false });
    return { plan };
  }

  // 执行前核对本页签发身份、原来源、候选、节点和授权；复制、篡改、过期及重复消费均拒绝。
  function validatePrepared(plan, item, intent, consume = false) {
    C.validatePlan(plan, intent); const saved = preparedPlans.get(plan);
    if (!saved || saved.used || Date.now() - saved.createdAt > 30000 || saved.encoded !== JSON.stringify(plan) || saved.intent !== JSON.stringify(intent)) throw new Error('填写计划已失效，请重新准备');
    const current = global.LocalApplyPageScanner.record(intent.binding.scanId, intent.binding.documentId, intent.binding.semanticId);
    if (saved.item.el !== item.el || current.el !== item.el || structure(current) !== saved.structure
      || JSON.stringify(global.LocalApplyPageScanner.readValue(current)) !== saved.current
      || saved.optionNode && !nativeCandidates(current).includes(saved.optionNode)) throw new Error('填写控件或候选已变化，请重新准备');
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
  // 意图通过最小计划守卫后仍调用旧写入器；诊断只含旧白名单，不返回意图、计划或来源值。
  async function fill(item, value, options = {}) {
    A.diagnostic?.(item, true); let result;
    if (options.intent) {
      C.validateIntent(options.intent, { value }); const prepared = prepare(item, options.intent, options);
      if (prepared.error) result = prepared.error;
      else { validatePrepared(prepared.plan, item, options.intent, true); result = await write(item, value, options); }
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
