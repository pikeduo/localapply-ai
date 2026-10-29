// 飞书 ATSX 的结构桥接；仅使用明确局部 DOM，不读取框架私有状态或执行站点脚本。
(function (global) {
  'use strict';
  if (global.LocalApplyATSX) return;
  const kinds = { 'resumeEditForm-education': 'education', 'resumeEditForm-career': 'employment', 'resumeEditForm-internship': 'internship', 'resumeEditForm-project': 'project' };
  const datePopups = new WeakMap();

  // 仅接受下载页面中可核对的模块外壳，避免相似类名被当成招聘表单。
  function section(el) {
    const outer = el.closest?.('.createFormSection-container');
    const rows = [...(outer?.children || [])].filter((node) => node.querySelector(':scope > .createFormSection-left .createFormSection-text') && node.querySelector(':scope > .createFormSection-right'));
    return rows.length === 1 ? rows[0] : null;
  }
  // 标签只取字段名，排除说明、已有内容和搜索候选。
  function label(el) {
    const field = el.closest?.('.atsx-form-item');
    return field?.querySelector(':scope > .atsx-form-item-label .customResumeForm-fieldName')?.textContent
      || field?.querySelector(':scope > .atsx-form-item-label > label')?.textContent || '';
  }
  // 模块标题和直接记录容器共同决定上下文，不按字段 ID 的数组下标绑定个人资料。
  function context(el) {
    const block = section(el); if (!block) return null;
    const group = block.querySelector(':scope > .createFormSection-left .createFormSection-text').textContent;
    const declared = Object.entries(kinds).find(([key]) => block.classList.contains(key))?.[1] || '';
    const kind = global.WangshenTemplates.recordKind(group.trim()) === declared ? declared : '';
    const list = block.querySelector(':scope > .createFormSection-right > .createFormSection-formList');
    const records = [...(list?.children || [])].filter((node) => node.classList.contains('resumeEditForm-item'));
    return { group, kind, degree: '', index: Math.max(0, records.indexOf(el.closest('.resumeEditForm-item'))) };
  }
  // 搜索输入归属于唯一的单选外壳；原生控件及多选不由此接管。
  function select(el) {
    const shell = el.matches?.('.atsx-select-selection[role="combobox"]') ? el : el.closest?.('.atsx-select-selection[role="combobox"]');
    const owner = shell?.closest('.atsx-select');
    if (!owner || !section(owner) || !shell.classList.contains('atsx-select-selection--single') || owner.querySelectorAll('.atsx-select-selection[role="combobox"]').length !== 1) return null;
    const inputs = [...shell.querySelectorAll('input.atsx-select-search__field')];
    return { shell, owner, input: inputs.length === 1 ? inputs[0] : null, combo: owner.classList.contains('atsx-select-combobox') };
  }
  // 非搜索单选使用独立显示节点；自动补全仍保留查询文字用于非空保护，但不据此认定已选择。
  function selected(el) {
    const info = select(el); if (!info) return null;
    const rows = [...info.shell.querySelectorAll('.atsx-select-selection-selected-value')];
    return rows.length === 1 ? rows[0].textContent.trim() : null;
  }
  // 仅在已授权的单项读取阶段访问查询值，扫描阶段不得调用。
  function selectValue(el) { const info = select(el); return selected(el) || (info?.combo ? info.input?.value : '') || ''; }
  // 只检查当前字段的 ATSX 标准错误样式，不读取可能包含个人信息的校验正文。
  function invalid(el) { const field = section(el) && el.closest('.atsx-form-item'); return !!field && (field.classList.contains('has-error') || !!field.querySelector('.atsx-form-item-control.has-error,.atsx-form-item-control-wrapper.has-error')); }
  // 原生控件列表之外补充两个真实年月点击区，隐藏输入只作组件焦点入口。
  function controls(root) { return [...root.querySelectorAll('.atsx-date-picker-period-month > .atsx-date-picker-period-month-label')].filter((node) => section(node)); }
  // 起止角色来自同一控件内的两个直接子项，不跨模块拼装。
  function range(el) {
    const owner = el.closest?.('.atsx-date-picker-period-month'); if (!owner || !section(owner)) return null;
    const ends = [...owner.children].filter((node) => node.classList.contains('atsx-date-picker-period-month-label'));
    const helpers = [...owner.querySelectorAll(':scope > input.atsx-date-picker-period-hidden-input')];
    if (ends.length !== 2 || !ends.includes(el) || helpers.length !== 1) return null;
    const year = el.querySelector(':scope > .atsx-date-picker-period-month-label-year'); const month = el.querySelector(':scope > .atsx-date-picker-period-month-label-month');
    return year && month ? { owner, ends, helper: helpers[0], year, month, index: ends.indexOf(el) } : null;
  }
  // 年月占位符不是个人值；部分内容仍返回非空，防止覆盖用户只选了一半的日期。
  function dateText(el) {
    const info = range(el); if (!info) return '';
    if (el.querySelector('.atsx-date-picker-period-month-label-toToday')) return '至今';
    const year = info.year.textContent.trim(); const month = info.month.textContent.trim();
    return /^\d{4}$/.test(year) || /^\d{1,2}$/.test(month) ? (/^\d{4}$/.test(year) ? year : '') + '-' + (/^\d{1,2}$/.test(month) ? month.padStart(2, '0') : '') : '';
  }
  // 排除同一单选的内部查询框、日期焦点辅助框及无经历/协议操作。
  function exclusion(el) {
    if (!section(el)) return null;
    if (section(el).querySelector('.noExperience-container input[type="checkbox"]:checked')) return { category: 'site_action', reason: '网页已声明没有工作经历，保留用户选择' };
    if (el.matches('input.atsx-select-search__field') && select(el) || el.matches('input.atsx-date-picker-period-hidden-input')) return { category: 'compound_part', reason: '组件内部查询或焦点入口，不创建独立资料字段' };
    if (el.closest('.noExperience-container')) return { category: 'site_action', reason: '无经历声明由用户自行选择' };
    if (el.closest('.atsx-date-picker-dropdown,.atsx-select-dropdown')) return { category: 'compound_part', reason: '组件候选不创建资料字段' };
    return null;
  }
  // 每个日期端点拥有自己的语义及对侧保护快照，布局复用既有白名单。
  function groups(nodes) {
    const out = new Map();
    for (const el of nodes) {
      const info = range(el); if (!info) continue;
      out.set(el, { kind: 'date', atsx: true, anchor: el, parts: { value: el, peer: info.ends[1 - info.index], focus: info.helper }, label: info.index ? '结束日期' : '开始日期', type: 'month', layout: 'date:year-month' });
    }
    return out;
  }
  // 只接受已知四种经历的直接记录和唯一结构化添加动作，不使用任意包含“添加”的元素。
  function records(block) {
    if (section(block) !== block) return null;
    const kind = context(block)?.kind; if (!kind) return null;
    const body = block.querySelector(':scope > .createFormSection-right'); const list = body.querySelector(':scope > .createFormSection-formList');
    const items = [...(list?.children || [])].filter((node) => node.classList.contains('resumeEditForm-item'));
    const possible = [...body.querySelectorAll(':scope > .createFormSection-addBtn,.formOperate-addBtn')];
    let add = possible.filter((node) => node.tagName === 'DIV' && node.textContent.trim() === '添加' && !node.closest('a,button,[role="link"],[hidden],[inert],[aria-hidden="true"],[disabled],[aria-disabled="true"]') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    if (possible.length !== add.length || block.querySelector('.noExperience-container input[type="checkbox"]:checked')) add = [];
    // 多条记录各有一个同类添加入口时只用最后一条；额外按钮或任一缺失仍按歧义拒绝。
    if (items.length > 1 && add.length === items.length && items.every((item) => add.filter((node) => item.contains(node)).length === 1)) add = add.filter((node) => items.at(-1).contains(node));
    return { block, kind, records: items, add };
  }
  // 异常仅带固定错误信息，网页文字、候选和实际日期不进入日志。
  function fail(reason = '飞书年月候选没有唯一匹配，请手动选择') { return { ok: false, status: 'unsupported', reason }; }
  // 有界等候只更新当前年月端点的已知预期变化；其他端点和会话继续由父守卫保护。
  async function wait(ms, lifecycle) { await new Promise((resolve) => setTimeout(resolve, ms)); lifecycle?.check(); }
  // 仅操作本次端点主动打开的唯一两列年月面板；不点日历导航或至今，不写隐藏辅助输入。
  async function fillDate(item, next, lifecycle) {
    const el = item.el; const info = range(el); if (!info || !next.date.month) return fail();
    const visible = (node) => node.isConnected && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden],[inert],[aria-hidden="true"],[disabled],[aria-disabled="true"]');
    const panels = () => [...document.querySelectorAll('.atsx-date-picker-period-month-panel')].filter(visible);
    const original = new Set(panels()); lifecycle?.check(); el.click(); lifecycle?.changed(el);
    let panel;
    for (let attempt = 0; attempt < 15; attempt++) {
      await wait(40, lifecycle);
      const opened = panels().filter((node) => !original.has(node));
      if (opened.length > 1) return fail('年月弹层归属不明确，未进行选择');
      const cached = datePopups.get(el);
      if (opened.length === 1) { panel = opened[0]; break; }
      if (!opened.length && cached && panels().includes(cached)) { panel = cached; break; }
    }
    if (!panel || !info.owner.contains(document.activeElement) || !el.classList.contains('atsx-date-picker-period-month-label-focus')) return fail('年月弹层未与当前端点建立关联，请关闭已有日历后重试');
    const lists = [...panel.querySelectorAll('.atsx-date-picker-period-month-panel-list')]; if (lists.length !== 2) return fail();
    for (const [index, value] of [[0, String(next.date.year)], [1, String(next.date.month).padStart(2, '0')]]) {
      lifecycle?.check();
      if (!visible(panel) || !info.owner.contains(document.activeElement) || !el.classList.contains('atsx-date-picker-period-month-label-focus')) return fail('焦点或年月端点已变化，已停止选择');
      const rows = [...lists[index].querySelectorAll('.atsx-date-picker-period-month-panel-list-item')].filter(visible);
      const found = rows.filter((node) => node.textContent.trim() === value && node.getAttribute('data-cy') === value);
      if (found.length !== 1 || rows.length > 500 || found[0].tagName !== 'DIV' || found[0].querySelector('a,button,input') || found[0].closest('a,button')) return fail();
      const beforeClick = new Set(panels()); found[0].click(); lifecycle?.changed(el);
      await new Promise((resolve) => setTimeout(resolve, 50));
      lifecycle?.settled?.(el, { iso: index ? next.value : String(next.date.year) + '-', precision: 'month', partial: index === 0 }); lifecycle?.check();
      const actual = index ? info.month.textContent.trim() : info.year.textContent.trim();
      if (Number(actual) !== Number(value)) return fail('网页未接受所选年月');
      // 开始月份点选后组件可自动打开结束面板；仅缓存本次动作产生且角色明确的唯一新弹层。
      if (index === 1 && info.index === 0 && info.ends[1].classList.contains('atsx-date-picker-period-month-label-focus')) {
        const nextPanels = panels().filter((node) => !beforeClick.has(node)); if (nextPanels.length === 1) datePopups.set(info.ends[1], nextPanels[0]);
      }
    }
    // 完整范围才触发组件失焦提交；开始端点保留组件编辑态供下一项继续，不制造半填校验错误。
    const complete = info.ends.every((node) => { const text = dateText(node); return text === '至今' || global.LocalApplyFieldAdapters.dateValue(text)?.precision === 'month'; });
    if (complete) { info.helper.blur(); lifecycle?.changed(el); }
    await wait(60, lifecycle);
    return dateText(el) === next.value ? { ok: true } : fail('年月结果未保持，未认定填写成功');
  }
  global.LocalApplyATSX = Object.freeze({ section, label, context, select, selected, selectValue, invalid, controls, range, dateText, exclusion, groups, records, fillDate });
})(globalThis);
