// 文本适配器只使用当前字段和成熟赋值原语，不搜索或点击任何下拉候选。
(function (global) {
  'use strict';
  const inputTypes = ['text', 'email', 'tel', 'number', 'url'];

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
    return null;
  }

  // 等待仅用于回读；取消时立即结束并释放监听器，不安排迟到写入。
  function delay(ms, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      // 定时器和取消共享清理入口，避免遗留监听器。
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
    });
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
        context.consumePlan(plan);
        if (plan.operation === 'verify-existing') return { ok: true };
        try {
          const result = global.WangshenFiller.fillTextOnly(context.item.el, context.intent.value);
          return result.ok ? { ok: true } : { ok: false, status: 'failed', reason: '网页未接受文本或受控组件已回退' };
        } catch { return { ok: false, status: 'failed', reason: '网页拒绝文本写入' }; }
      },
      // 跨两个观察窗口检查校验状态和重绘回退，撤销后不再报告成功。
      async verify(plan, context) {
        for (const ms of [120, 380]) {
          await delay(ms, context.signal); const error = guard(context); if (error) return error;
          if (!context.accepted(context.intent.value)) return { ok: false, status: 'failed', reason: '网页未接受新值、校验失败或受控组件已回退' };
        }
        return { ok: true, status: 'success', verifiedAt: new Date().toISOString() };
      }
    });
  }

  global.LocalApplyTextAdapters = Object.freeze(['text', 'textarea', 'contenteditable'].map(adapter));
})(globalThis);
