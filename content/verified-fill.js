// 阶段三在成熟填写器外增加严格选择和延迟复读验证，不接触提交/验证码/密码。
(function (global) {
  'use strict';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const A = global.LocalApplyFieldAdapters;

  // 比较实际选中状态；避免下拉框显示文本变化但没有选中有效 option 的假成功。
  function accepted(item, expected) {
    const { el, members, field } = item;
    if (!el.isConnected || el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false) return false;
    if (A.handles(item)) return A.accepted(item, expected);
    if (field.type === 'checkbox') {
      if (members.length === 1) return typeof expected === 'boolean' && el.checked === expected;
      return Array.isArray(expected) && JSON.stringify(members.filter((node) => node.checked).map((node) => node.value).sort()) === JSON.stringify([...expected].map(String).sort());
    }
    if (field.type === 'radio') return members.some((node) => node.checked && (node.value === String(expected) || node.closest('label')?.textContent.trim() === String(expected)));
    if (field.type === 'select') return [...el.selectedOptions].some((option) => option.value === String(expected) || option.textContent.trim() === String(expected));
    if (field.type === 'combobox') {
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

  // 写入前仅读取该项的实际状态，非空冲突返回差异；覆盖许可绑定用户刚核对的旧值。
  function conflict(item, value, options) {
    const before = global.LocalApplyPageScanner.readValue(item);
    const occupied = Array.isArray(before) ? before.length > 0 : before !== '' && before !== null && before !== undefined && before !== false && !(item.field.type === 'combobox' && /^(请选择|请选择一项|Select|Please select)$/i.test(before));
    if (options.overwrite && JSON.stringify(before) !== JSON.stringify(options.expectedCurrent)) return { status: 'needs_confirmation', ok: false, reason: '网页内容在确认后已变化，请重新核对差异', conflict: { before, after: value } };
    const different = item.compound ? A.hasConflict(item, value) : occupied && !accepted(item, value);
    if (!options.overwrite && different) return { status: 'needs_confirmation', ok: false, reason: '网页已有不同内容，已保留；核对差异后可单独允许覆盖', conflict: { before, after: value } };
    return null;
  }

  // 精确选择已有选项；复合日期/电话走适配器，任何路径都不得自动覆盖不同的现有值。
  async function write(item, value, options = {}) {
    const { el, members, field } = item;
    if (A.handles(item)) { const next = A.plan(item, value); if (next.error) return { ...next.error, diagnostic: { phase: 'plan' } }; }
    const blocked = conflict(item, value, options); if (blocked) return { ...blocked, diagnostic: { phase: 'protect', reasonCode: 'existing_value_preserved' } };
    if (accepted(item, value)) return { ...await verify(item, value), diagnostic: { phase: 'verify' } };
    if (A.handles(item)) {
      const result = await A.fill(item, value); if (!result.ok) return { status: result.status || 'failed', ...result };
    } else if (field.type === 'combobox') {
      if (A.dropdown(el)) {
        const result = await A.fillDropdown(el, value, '', field.label); if (!result.ok) return result;
      } else {
        const menu = el.getRootNode().getElementById?.(el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
        const candidates = [...(menu?.querySelectorAll('[role="option"]') || [])].filter((option) => option.textContent.trim() === String(value) || option.getAttribute('data-value') === String(value));
        if (candidates.length !== 1 || candidates[0].matches('button,input,a,[role="button"]') || candidates[0].querySelector('button,input,a,[role="button"]')) return { status: 'unsupported', ok: false, reason: '自定义下拉无唯一安全选项，请在网页手动选择', diagnostic: { phase: 'options', candidateCount: menu?.querySelectorAll('[role="option"]').length || 0, matchCount: candidates.length, reasonCode: !menu ? 'popup_not_found' : candidates.length > 1 ? 'ambiguous_option' : candidates.length ? 'unsupported_control' : 'no_exact_option' } };
        candidates[0].click();
      }
    } else if (['select', 'radio'].includes(field.type)) {
      const candidates = field.type === 'select' ? [...el.options] : members;
      const found = candidates.filter((option) => option.value === String(value) || (field.type === 'select' ? option.textContent : option.closest('label')?.textContent)?.trim() === String(value));
      if (found.length !== 1) return { status: 'failed', ok: false, reason: '没有唯一的精确选项，未进行模糊选择', diagnostic: { phase: 'options', candidateCount: candidates.length, matchCount: found.length, reasonCode: found.length ? 'ambiguous_option' : 'no_exact_option' } };
      if (field.type === 'select') { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, found[0].value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else found[0].click();
    } else if (field.type === 'checkbox') {
      if ((members.length === 1 && typeof value !== 'boolean') || (members.length > 1 && !Array.isArray(value))) return { status: 'unsupported', ok: false, reason: '复选框需要布尔值或明确的选项数组' };
      for (const node of members) { const desired = members.length === 1 ? value : value.includes(node.value); if (node.checked !== desired) node.click(); }
    } else if (el.readOnly) return { status: 'unsupported', ok: false, reason: '只读或复杂日期控件需要网页手动操作' };
    else {
      const result = await global.WangshenFiller.fillElement(el, value, { inputType: field.type, options: field.options });
      if (!result.ok) return { status: 'failed', ...result };
    }
    const result = await verify(item, value);
    if (result.ok) global.WangshenFiller.markFilled(el);
    return { ...result, diagnostic: { phase: 'verify', reasonCode: result.ok ? 'verified' : 'value_not_accepted' } };
  }
  // 写入结果附带固定诊断阶段，保留原有保护和回读行为，绝不携带实际值或候选文字。
  async function fill(item, value, options = {}) {
    A.diagnostic?.(item, true); const result = await write(item, value, options); const trace = A.diagnostic?.(item) || {};
    const adapter = item.compound?.kind || (A.dropdown(item.el) ? 'moka-dropdown' : ({ select: 'native-select', combobox: 'aria-combobox', radio: 'radio', checkbox: 'checkbox' })[item.field.type]) || (A.handles(item) ? 'date' : 'text');
    const reasonCode = result.ok ? 'verified' : result.diagnostic?.reasonCode || trace.reasonCode || (/精度|只有年|不能.*补日/.test(result.reason || '') ? 'insufficient_date_precision' : /日期/.test(result.reason || '') && result.status !== 'unsupported' ? 'invalid_date' : result.status === 'unsupported' ? 'unsupported_control' : 'write_rejected');
    return { ...result, diagnostic: { adapter, phase: 'write', ...trace, ...result.diagnostic, reasonCode, controlType: item.field.type, status: result.status || (result.ok ? 'success' : 'failed') } };
  }
  global.LocalApplyVerifiedFill = { fill, verify, accepted };
})(globalThis);
