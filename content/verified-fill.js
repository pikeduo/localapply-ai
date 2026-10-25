// 阶段三在成熟填写器外增加严格选择和延迟复读验证，不接触提交/验证码/密码。
(function (global) {
  'use strict';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 比较实际选中状态；避免下拉框显示文本变化但没有选中有效 option 的假成功。
  function accepted(item, expected) {
    const { el, members, field } = item;
    if (!el.isConnected || el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false) return false;
    if (field.type === 'checkbox') {
      if (members.length === 1) return typeof expected === 'boolean' && el.checked === expected;
      return Array.isArray(expected) && JSON.stringify(members.filter((node) => node.checked).map((node) => node.value).sort()) === JSON.stringify([...expected].map(String).sort());
    }
    if (field.type === 'radio') return members.some((node) => node.checked && (node.value === String(expected) || node.closest('label')?.textContent.trim() === String(expected)));
    if (field.type === 'select') return [...el.selectedOptions].some((option) => option.value === String(expected) || option.textContent.trim() === String(expected));
    if (field.type === 'combobox') {
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

  // 精确选择 radio/select/ARIA option，不使用包含匹配操作高风险选项。
  async function fill(item, value) {
    const { el, members, field } = item;
    if (field.type === 'combobox') {
      const menu = el.getRootNode().getElementById?.(el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
      const candidates = [...(menu?.querySelectorAll('[role="option"]') || [])].filter((option) => option.textContent.trim() === String(value) || option.getAttribute('data-value') === String(value));
      if (candidates.length !== 1 || candidates[0].matches('button,input,a,[role="button"]') || candidates[0].querySelector('button,input,a,[role="button"]')) return { status: 'unsupported', ok: false, reason: '自定义下拉无唯一安全选项，请在网页手动选择' };
      candidates[0].click();
    } else if (['select', 'radio'].includes(field.type)) {
      const candidates = field.type === 'select' ? [...el.options] : members;
      const found = candidates.filter((option) => option.value === String(value) || (field.type === 'select' ? option.textContent : option.closest('label')?.textContent)?.trim() === String(value));
      if (found.length !== 1) return { status: 'failed', ok: false, reason: '没有唯一的精确选项，未进行模糊选择' };
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
    return result;
  }
  global.LocalApplyVerifiedFill = { fill, verify, accepted };
})(globalThis);
