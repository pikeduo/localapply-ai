// 文本适配器只使用当前字段和成熟赋值原语，不搜索或点击任何下拉候选。
(function (global) {
  'use strict';
  const inputTypes = ['text', 'email', 'tel', 'number', 'url'];
  const executions = new WeakSet();

  // 取消或文档失效均返回固定原因；只读/菜单控件不能被普通文本路径绕过。
  function guard(context, writing = false) {
    if (context.signal?.aborted) return { ok: false, status: 'failed', reason: '已取消填写' };
    try { context.assertActive(); } catch { return { ok: false, status: 'failed', reason: '页面或控件已变化，已停止填写' }; }
    const { el, field } = context.item;
    if (global.FieldMatchingEngine.restricted(field) || /同步更新在线简历/.test(field.label)
      || el.closest('button,a,[role="button"]')) return { ok: false, status: 'unsupported', reason: '受保护控件不允许自动填写' };
    if (writing && (el.readOnly || el.getAttribute('aria-readonly') === 'true')) return { ok: false, status: 'unsupported', reason: '只读控件需要网页手动操作' };
    if (el.getAttribute('role') === 'combobox' || /^(list|both)$/.test(el.getAttribute('aria-autocomplete') || '')
      || /^(true|listbox|tree|grid|dialog)$/.test(el.getAttribute('aria-haspopup') || '')) return { ok: false, status: 'unsupported', reason: '此控件需要选项适配器，未按普通文本填写' };
    // 旧补全框未提供关联/选中证据时也不能按文本假报成功；仅检查同一父容器的直接列表。
    if(el.tagName==='INPUT'&&el.parentElement?.querySelector(':scope > ul,:scope > ol')&&el.parentElement.querySelectorAll('input,textarea,select,[role="combobox"]').length===1)return {ok:false,status:'unsupported',reason:'此输入包含未关联的候选列表，请在网页手动选择'};
    return null;
  }

  // 按真实标签/控件描述识别三种文本能力，复合项和已知菜单留给原适配器。
  function detect(id, control, context) {
    const { item } = context; const el = item.el;
    if (global.LocalApplyFieldAdapters.handles(item) || global.LocalApplyFieldAdapters.dropdown(el)) return false;
    if (id === 'text') return el.tagName === 'INPUT' && inputTypes.includes(control.type);
    if (id === 'textarea') return el.tagName === 'TEXTAREA' && control.type === 'textarea';
    return el.isContentEditable && control.type === 'contenteditable';
  }

  // 固定工厂只供打包代码创建三项能力；外部不能注册执行函数。
  function adapter(id) {
    return Object.freeze({ id,
      // 探测不读取个人值、不改变焦点或网页状态。
      detect(control, context) { return detect(id, control, context); },
      // 准备只给出固定操作，冲突保护及私有计划仍由统一填写器持有。
      prepare(control, intent, context) {
        const error = guard(context, true); if (error) return { error };
        return { operation: context.accepted(intent.value) ? 'verify-existing' : 'write-value' };
      },
      // 消费本页私有计划后至多赋值一次，写入尝试不能代替延迟验证。
      execute(plan, context) {
        const error = guard(context, true); if (error) return error;
        if (plan.adapterId !== id || !['write-value', 'verify-existing'].includes(plan.operation)) throw new Error('文本填写计划不匹配');
        context.consumePlan(plan); executions.add(plan);
        if (plan.operation === 'verify-existing') return { ok: true };
        try {
          const result = global.WangshenFiller.fillTextOnly(context.item.el, context.intent.value);
          return result.ok ? { ok: true } : { ok: false, status: 'failed', reason: '网页未接受文本或受控组件已回退' };
        } catch { return { ok: false, status: 'failed', reason: '网页拒绝文本写入' }; }
      },
      // 只验证已消费的原计划；共用回读检查校验和重绘，不能重放验证成功。
      async verify(plan, context) {
        if (!executions.delete(plan)) return global.LocalApplyFillResult.failure('stale_plan');
        return global.LocalApplyFillVerification.run(context, () => guard(context));
      }
    });
  }

  global.LocalApplyTextAdapters = Object.freeze(['text', 'textarea', 'contenteditable'].map(adapter));
})(globalThis);
