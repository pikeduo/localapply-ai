// 原生选择能力只操作当前控件的真实候选；节点和编码留在本页私有计划中。
(function (global) {
  'use strict';
  const executions = new WeakMap();

  // 统一读取正式选项标签，支持原生 for/aria 标签，不搜索无关容器正文。
  function label(node) {
    if (node.tagName === 'OPTION') return (node.label || node.textContent || '').trim();
    const root = node.getRootNode?.();
    const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => root?.getElementById?.(id)?.textContent || '').join(' ').trim();
    return (labelled || node.getAttribute('aria-label') || [...(node.labels || [])].map((el) => el.textContent).join(' ') || node.closest('label')?.textContent || '').trim();
  }

  // 只按实际标签和控件类型探测，日期/电话复合项及自定义菜单不被接管。
  function detect(id, control, { item }) {
    if (global.LocalApplyFieldAdapters.handles(item) || global.LocalApplyFieldAdapters.dropdown(item.el)) return false;
    return control.type === id && (id === 'select' ? item.el.tagName === 'SELECT' : item.el.tagName === 'INPUT' && item.el.type === id);
  }

  // 固定错误仅附白名单数量/原因码，不能把候选标签、编码或资料值写入日志。
  function failure(reason, status = 'unsupported', reasonCode = status === 'unsupported' ? 'unsupported_control' : 'write_rejected', counts = {}) {
    return { ok: false, status, reason, diagnostic: { phase: 'options', reasonCode, ...counts } };
  }

  // 拒绝认证、协议和网站操作节点，检查发生在读取候选值/选中状态之前。
  function protectedNode(node) {
    const hint = ['type', 'name', 'id', 'autocomplete', 'aria-label'].map((key) => node.getAttribute(key)).join(' ');
    return /password|captcha|one-time-code|验证码|密码/i.test(hint) || node.closest('button,a,[role="button"]')
      || global.FieldMatchingEngine.restricted({ label: label(node), group: '' }) || /同步更新在线简历/.test(label(node));
  }

  // 仅快照当前 select.options 或扫描器给出的同组节点，完整保留节点身份和禁用状态。
  function snapshot(item) {
    const select = item.el.tagName === 'SELECT'; const nodes = select ? [...item.el.options] : [...item.members];
    if (!nodes.length || nodes.length > 500 || protectedNode(item.el) || global.FieldMatchingEngine.restricted(item.field)
      || /同步更新在线简历/.test(item.field.label)) return { error: failure('受保护或无法确定的控件不自动填写') };
    if (nodes.some((node) => select ? node.tagName !== 'OPTION' : node.tagName !== 'INPUT' || node.type !== item.el.type
      || node.name !== item.el.name || node.form !== item.el.form || node.getRootNode?.() !== item.el.getRootNode?.() || protectedNode(node))) return { error: failure('候选不属于同一安全原生控件') };
    // 单选按 name/form/root 联动，复选按扫描分组；遗漏隐藏/禁用成员时不清除或忽略它们的状态。
    if (!select && item.el.name) {
      const group = item.el.closest('form,fieldset,[role="group"]');
      const actual = [...(item.el.getRootNode?.().querySelectorAll?.('input[type="' + item.el.type + '"]') || nodes)]
        .filter((node) => node.name === item.el.name && node.form === item.el.form && (item.el.type === 'radio' || node.closest('form,fieldset,[role="group"]') === group));
      if (actual.length !== nodes.length || actual.some((node) => !nodes.includes(node))) return { error: failure('原生选项组包含未授权或不可操作的候选，请手动选择') };
    }
    return { rows: nodes.map((node) => ({ node, label: label(node), value: node.value,
      disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true' || !!node.closest('optgroup[disabled],fieldset[disabled]'),
      protected: select && protectedNode(node) })), multiple: select && !!item.el.multiple };
  }

  // 使用可信来源 fieldId 解析明确等价；标签/编码和候选身份仍须唯一，不猜选首项。
  function resolve(item, value, fieldId = '') {
    const state = snapshot(item); if (state.error) return state;
    const { rows } = state; const type = item.control?.type || item.field.type;
    const singleCheck = type === 'checkbox' && rows.length === 1;
    const many = type === 'checkbox' && !singleCheck || state.multiple;
    if (singleCheck ? typeof value !== 'boolean' : many ? !Array.isArray(value) || !value.length : !['string', 'number'].includes(typeof value)) return { error: failure('原生控件需要明确的布尔值、单选值或选项数组') };
    const targets = [];
    for (const wanted of singleCheck ? [] : many ? value : [value]) {
      const resolution = global.LocalApplyValueResolver?.resolve(fieldId, wanted, rows);
      if (resolution && resolution.status !== 'resolved') return { error: failure('选项缺失、存在歧义或不可操作，未进行猜选', resolution.reasonCode === 'unsupported_control' ? 'unsupported' : 'failed', resolution.reasonCode, { candidateCount: rows.length, matchCount: resolution.matchCount }) };
      const found = resolution ? [rows[resolution.index]] : rows.filter((row) => row.value === String(wanted) || row.label === String(wanted));
      const counts = { candidateCount: rows.length, matchCount: found.length };
      if (found.length !== 1) return { error: failure('没有唯一的精确选项，未进行模糊选择', 'failed', found.length ? 'ambiguous_option' : 'no_exact_option', counts) };
      const target = found[0];
      if (rows.some((row) => row !== target && (row.value === target.value || target.label && row.label === target.label)) || targets.includes(target)) return { error: failure('候选标签或编码存在歧义，未进行选择', 'failed', 'ambiguous_option', counts) };
      if (target.disabled || target.protected) return { error: failure('目标选项已禁用或受保护，未执行填写') };
      targets.push(target);
    }
    // 多选只操作明确需要变化的节点；受保护项不会因取消选择而被点击。
    const desired = rows.map((row) => singleCheck ? value : targets.includes(row));
    if (rows.some((row, index) => (row.disabled || row.protected) && selected(item, row.node) !== desired[index])) return { error: failure('选中状态涉及禁用或受保护选项，未执行填写') };
    return { ...state, desired, singleCheck, many, targets };
  }

  // 原生选中状态是验证来源，不以可见文字或搜索输入代替选择结果。
  function selected(item, node) { return item.el.tagName === 'SELECT' ? node.selected : node.checked; }

  // 完整比较选中集合，确保编码正确且没有多选遗漏、框架回退或浏览器校验错误。
  function matches(item, state) {
    return state.rows.every((row, index) => row.node.isConnected !== false && row.node.getAttribute('aria-invalid') !== 'true'
      && row.node.validity?.valid !== false && !row.node.indeterminate && selected(item, row.node) === state.desired[index])
      && item.el.getAttribute('aria-invalid') !== 'true' && item.el.validity?.valid !== false;
  }

  // 非空保护与准备复用同一来源语义，已经等价的选中集合只验证、不再次点击。
  function accepted(item, value, fieldId = '') { const state = resolve(item, value, fieldId); return !state.error && matches(item, state); }

  // 每次动作/回读重新核对原节点和候选；取消、换文档、换候选均停止，不重走旧路径。
  function guard(context, state) {
    if (context.signal?.aborted) return failure('已取消填写', 'failed');
    try { context.assertActive(); } catch { return failure('页面或控件已变化，已停止填写', 'failed'); }
    const { el } = context.item;
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true' || el.closest('fieldset[disabled]')) return failure('禁用或只读控件需要网页手动操作');
    const current = snapshot(context.item); if (current.error) return current.error;
    if (state && (current.multiple !== state.multiple || current.rows.length !== state.rows.length || current.rows.some((row, index) => {
      const previous = state.rows[index]; return row.node !== previous.node || row.value !== previous.value || row.label !== previous.label || row.disabled !== previous.disabled || row.protected !== previous.protected;
    }))) return failure('候选已变化，请重新扫描准备', 'failed');
    return null;
  }

  // 候选描述只有本页随机句柄及当前真实标签/编码，不成为持久化业务规则。
  function option(row) { return { handle: 'option.' + crypto.randomUUID(), label: row.label, value: row.value }; }

  // 三个固定能力共用原生事件和守卫，没有动态加载或任意脚本入口。
  function adapter(id) {
    return Object.freeze({ id,
      // 探测只使用控件结构，不读取用户选中值。
      detect(control, context) { return detect(id, control, context); },
      // 先解析真实候选，再生成最小固定操作；准备阶段零点击、零写入。
      prepare(control, intent, context) {
        const blocked = guard(context); if (blocked) return { error: blocked };
        const state = resolve(context.item, intent.value, intent.source.fieldId); if (state.error) return state;
        const operation = matches(context.item, state) ? 'verify-existing' : state.singleCheck ? 'set-checked' : state.many ? 'select-options' : 'select-option';
        return { operation, adapterState: state,
          ...(operation === 'select-option' ? { targetOption: option(state.targets[0]) } : {}),
          ...(operation === 'select-options' ? { targetOptions: state.targets.map(option) } : {}),
          ...(operation === 'set-checked' ? { checked: intent.value } : {}) };
      },
      // 消费本页私有计划后只走原生 setter 或 click，拒绝后不尝试旧通用填写器。
      execute(plan, context) {
        const blocked = guard(context); if (blocked) return blocked;
        if (plan.adapterId !== id) throw new Error('原生控件填写计划不匹配');
        const state = context.consumePlan(plan); const stale = guard(context, state); if (stale) return stale;
        executions.set(plan, state);
        if (plan.operation === 'verify-existing') return { ok: true };
        try {
          const { item } = context;
          if (id === 'select') {
            if (state.many) for (let index = 0; index < state.rows.length; index++) Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected').set.call(state.rows[index].node, state.desired[index]);
            else Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(item.el, state.targets[0].value);
            item.el.dispatchEvent(new Event('input', { bubbles: true })); item.el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const pending = state.rows.map((row) => selected(item, row.node));
            const changes = id === 'radio' ? [state.rows.indexOf(state.targets[0])] : state.rows.map((row, index) => index).filter((index) => pending[index] !== state.desired[index]);
            for (const index of changes) {
              const error = guard(context, state); if (error) return error;
              if (state.rows.some((row, i) => selected(item, row.node) !== pending[i])) return failure('选中状态在填写期间变化，已停止操作', 'failed');
              state.rows[index].node.click();
              for (let i = 0; i < pending.length; i++) pending[i] = id === 'radio' ? state.desired[i] : i === index ? state.desired[i] : pending[i];
              if (state.rows[index].node.checked !== state.desired[index]) return failure('网页拒绝选中状态，未重复点击', 'failed');
            }
          }
          return { ok: true };
        } catch { return failure('网页拒绝原生选项写入', 'failed'); }
      },
      // 跨框架重绘窗口回读完整选中集合，失败不记成功也不重试点击。
      async verify(plan, context) {
        const state = executions.get(plan); if (!state) return global.LocalApplyFillResult.failure('stale_plan');
        executions.delete(plan);
        return global.LocalApplyFillVerification.run(context, () => guard(context, state), () => matches(context.item, state));
      }
    });
  }

  global.LocalApplyNativeChoices = Object.freeze({ accepted, snapshot });
  global.LocalApplyNativeAdapters = Object.freeze(['select', 'radio', 'checkbox'].map(adapter));
})(globalThis);
