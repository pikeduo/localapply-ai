// 日期/电话只桥接已有局部适配器；计划与子控件快照不离开当前页面。
(function (global) {
  'use strict';
  const A = global.LocalApplyFieldAdapters;
  const executions = new WeakMap();

  // 真实子项身份、属性、候选编码及当前值用于一次性计划失效检查，不写持久层。
  function snapshot(item) {
    return Object.entries(item.compound?.parts || { value: item.el }).map(([key, node]) => ({ key, node,
      shape: JSON.stringify({ tag: node.tagName, attrs: ['type', 'name', 'min', 'max', 'readonly', 'placeholder', 'aria-label', 'aria-controls', 'aria-owns', 'aria-disabled', 'aria-readonly'].map((key) => node.getAttribute(key)), disabled: !!node.disabled }),
      value: A.dropdown(node) ? A.dropdownText(node) : node.value,
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

  // 每次局部交互和延迟回读检查授权、成员身份与安全属性，不读取无关字段。
  function guard(context, saved) {
    if (context.signal?.aborted) throw new Error('已取消填写');
    const current = context.assertActive(); const item = current || context.item;
    const rows = snapshot(item);
    if (rows.length !== saved.length || rows.some((row, index) => row.key !== saved[index].key || row.node !== saved[index].node || row.shape !== saved[index].shape)) throw new Error('日期或电话子控件已变化，请重新扫描');
    if (global.FieldMatchingEngine.restricted(item.field) || rows.some(({ node }) => !node.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true'
      || node.closest('fieldset[disabled],button,a,[role="button"]') || A.exclusion(node, item.field.label)?.category === 'security_control')) throw new Error('日期或电话控件不可操作，已停止填写');
  }

  // 观察窗口支持及时取消，只做回读，不安排任何迟到写入。
  function delay(ms, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      // 共用清理入口释放定时器及信号监听器。
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
    });
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
          targetParts: state.map(({ key }) => ({ key, handle: 'part.' + crypto.randomUUID() })) };
      },
      // 消费私有计划后复用既有事件/日历逻辑，每次动作前复核，失败不走第二路径。
      async execute(plan, context) {
        if (plan.adapterId !== id) throw new Error('日期或电话计划不匹配');
        const state = context.consumePlan(plan); executions.set(plan, state);
        const observed = new Map(state.map((row) => [row.node, row.value]));
        // 只有紧随本次已知写入的目标可更新观察值，不能掩盖其他子项的外部修改。
        const lifecycle = {
          check() { guard(context, state); if (snapshot(context.item).some((row) => observed.get(row.node) !== row.value)) throw new Error('日期或电话内容已变化，已停止填写'); },
          changed(node) { guard(context, state); const row = snapshot(context.item).find((row) => row.node === node); if (row) observed.set(node, row.value); }
        };
        try {
          lifecycle.check(); const result = plan.operation === 'verify-existing' ? { ok: true } : await A.fill(context.item, context.intent.value, lifecycle);
          return result.ok ? result : { ...result, status: result.status || 'failed', reason: result.reason || '网页未接受新值、校验失败或受控组件已回退' };
        }
        catch { return { ok: false, status: 'failed', reason: context.signal?.aborted ? '已取消填写' : '日期或电话控件、内容或授权已变化，已停止填写' }; }
      },
      // 完整回读每个子项和控件校验状态，受控回退不能当成成功。
      async verify(plan, context) {
        const state = executions.get(plan); if (!state) return { ok: false, status: 'failed', reason: '填写计划尚未执行' };
        for (const ms of [120, 380]) {
          await delay(ms, context.signal);
          try { guard(context, state); } catch { return { ok: false, status: 'failed', reason: context.signal?.aborted ? '已取消填写' : '日期或电话控件已变化，已停止验证' }; }
          if (context.item.el.validity?.valid === false || context.item.el.getAttribute('aria-invalid') === 'true' || !A.accepted(context.item, context.intent.value)) return { ok: false, status: 'failed', reason: '网页未接受新值、校验失败或受控组件已回退' };
        }
        return { ok: true, status: 'success', verifiedAt: new Date().toISOString() };
      }
    });
  }

  global.LocalApplyDatePhoneControls = Object.freeze({ snapshot, unchanged });
  global.LocalApplyDatePhoneAdapters = Object.freeze(['date', 'phone'].map(adapter));
})(globalThis);
