// 日期/电话只桥接已有局部适配器；计划与子控件快照不离开当前页面。
(function (global) {
  'use strict';
  const A = global.LocalApplyFieldAdapters;
  const F = global.LocalApplyFillResult;
  const executions = new WeakMap();

  // 真实子项身份、属性、候选编码及当前值用于一次性计划失效检查，不写持久层。
  function snapshot(item) {
    return Object.entries(item.compound?.parts || { value: item.el }).map(([key, node]) => ({ key, node,
      shape: JSON.stringify({ tag: node.tagName, attrs: ['type', 'name', 'min', 'max', 'readonly', 'placeholder', 'aria-label', 'aria-controls', 'aria-owns', 'aria-disabled', 'aria-readonly'].map((key) => node.getAttribute(key)), disabled: !!node.disabled }),
      value: global.LocalApplyATSX?.range(node) ? global.LocalApplyATSX.dateText(node) : A.dropdown(node) ? A.dropdownText(node) : node.value,
      options: [...(node.options || [])].map((option) => ({ node: option, value: option.value, label: option.textContent, disabled: !!option.disabled || option.getAttribute('aria-disabled') === 'true' || !!option.closest('optgroup[disabled]') })) }));
  }

  // 执行前核对所有子项（包括缺省国码）；选项原地替换或部分值变化同样使计划失效。
  function unchanged(saved, item) {
    const current = snapshot(item);
    return current.length === saved.length && current.every((row, index) => {
      const old = saved[index]; return row.key === old.key && row.node === old.node && row.shape === old.shape && row.value === old.value
        && row.options.length === old.options.length && row.options.every((option, i) => Object.keys(option).every((key) => option[key] === old.options[i][key]));
    });
  }

  // 每次局部交互和延迟回读复核保护边界；只返回固定失败检查名称，不暴露属性或值。
  function guard(context, saved) {
    if (context.signal?.aborted) throw F.failure('cancelled');
    let current; try { current = context.assertActive(); } catch { throw F.failure('stale_context', 'failed', { guardCheck: 'context' }); }
    const item = current || context.item;
    const rows = snapshot(item);
    if (rows.length !== saved.length || rows.some((row, index) => row.key !== saved[index].key || row.node !== saved[index].node)) throw F.failure('stale_context', 'failed', { guardCheck: 'members' });
    if (rows.some((row, index) => row.shape !== saved[index].shape)) throw F.failure('stale_context', 'failed', { guardCheck: 'attributes' });
    if (global.FieldMatchingEngine.restricted(item.field) || rows.some(({ node }) => !node.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true'
      || node.closest('fieldset[disabled],button,a,[role="button"]') || A.exclusion(node, item.field.label)?.category === 'security_control')) throw F.failure('stale_context', 'failed', { guardCheck: 'safety' });
  }

  // 两种固定桥接能力不吸收地址或普通电话文本框，自定义下拉仍由旧局部实现处理。
  function adapter(id) {
    return Object.freeze({ id,
      // 只按已分类的控件能力探测，拒绝多路径接管。
      detect(control, { item }) { return id === 'phone' ? item.compound?.kind === 'phone' : A.handles(item) && !['phone', 'address'].includes(item.compound?.kind); },
      // 准备不打开日历/菜单；保留来源精度及子项句柄，静态错误提前拒绝。
      prepare(control, intent, context) {
        const state = snapshot(context.item);
        try { guard(context, state); } catch { return { error: { ok: false, status: context.signal?.aborted ? 'failed' : 'unsupported', reason: context.signal?.aborted ? '已取消填写' : '日期或电话控件不可操作，请重新扫描' } }; }
        const next = A.plan(context.item, intent.value); if (next.error) return next;
        const { el, compound } = context.item; const hint = el.getAttribute('placeholder') || '';
        const targetPrecision = compound ? compound.parts.day ? 'day' : 'month' : ({ date: 'day', month: 'month', 'datetime-local': 'minute' })[el.type]
          || (/DD/i.test(hint) ? 'day' : /YYYY[-/.]MM/i.test(hint) ? 'month' : 'unknown');
        return { operation: context.accepted(intent.value) ? 'verify-existing' : id === 'date' ? 'fill-date' : 'fill-phone', adapterState: state,
          ...(id === 'date' ? { targetPrecision } : {}),
          // 对侧和焦点入口仅是私有保护快照，计划仍只暴露既有 value 角色句柄。
          targetParts: state.filter(({ key }) => !compound?.atsx || key === 'value').map(({ key }) => ({ key, handle: 'part.' + crypto.randomUUID() })) };
      },
      // 消费私有计划后复用既有事件/日历逻辑，每次动作前复核，失败不走第二路径。
      async execute(plan, context) {
        if (plan.adapterId !== id) throw new Error('日期或电话计划不匹配');
        const state = context.consumePlan(plan); executions.set(plan, state);
        const observed = new Map(state.map((row) => [row.node, row.value]));
        // 只有紧随本次已知写入的目标可更新观察值，不能掩盖其他子项的外部修改。
        const lifecycle = {
          check() { guard(context, state); if (snapshot(context.item).some((row) => observed.get(row.node) !== row.value)) throw F.failure('stale_context', 'failed', { guardCheck: 'value' }); },
          changed(node) { guard(context, state); const row = snapshot(context.item).find((row) => row.node === node); if (row) observed.set(node, row.value); },
          // 日历最终点选后只接纳同一原节点、来源和精度一致的延迟回写，日期读法兼容限定的年龄说明。
          settled(node, expected) {
            guard(context, state);
            const length = { year: 4, month: 7, day: 10 }[expected?.precision]; const source = A.dateValue(context.intent.value);
            // ATSX 只允许当前已点端点的明确年/年月投影；对侧及焦点节点继续使用原观察值。
            if (id === 'date' && context.item.compound?.atsx && node === context.item.el && source?.month && expected?.precision === 'month'
              && (expected.iso === source.iso.slice(0, 7) || expected.partial === true && expected.iso === String(source.year) + '-')) {
              const row = snapshot(context.item).find((row) => row.node === node); if (row.value === expected.iso) observed.set(node, row.value);
              return;
            }
            if (id !== 'date' || context.item.compound || node !== context.item.el || !node.readOnly || !length || source?.iso.slice(0, length) !== expected.iso) throw F.failure('stale_context', 'failed', { guardCheck: 'date_projection' });
            const row = snapshot(context.item).find((row) => row.node === node); const actual = A.dateReadback(context.item);
            if (actual && !actual.time && actual.iso === expected.iso && actual.precision === expected.precision) observed.set(node, row.value);
          }
        };
        try {
          lifecycle.check(); const result = plan.operation === 'verify-existing' ? { ok: true } : await A.fill(context.item, context.intent.value, lifecycle);
          return result.ok ? result : { ...result, status: result.status || 'failed', reason: result.reason || '网页未接受新值、校验失败或受控组件已回退' };
        }
        catch (error) { return context.signal?.aborted ? F.failure('cancelled') : error?.diagnostic ? F.normalize(error) : F.failure('stale_context'); }
      },
      // 完整回读每个子项和控件校验状态，受控回退不能当成成功。
      async verify(plan, context) {
        const state = executions.get(plan); if (!state) return global.LocalApplyFillResult.failure('stale_plan');
        executions.delete(plan);
        return global.LocalApplyFillVerification.run(context, () => guard(context, state), () => A.accepted(context.item, context.intent.value));
      }
    });
  }

  global.LocalApplyDatePhoneControls = Object.freeze({ snapshot, unchanged });
  global.LocalApplyDatePhoneAdapters = Object.freeze(['date', 'phone'].map(adapter));
})(globalThis);
