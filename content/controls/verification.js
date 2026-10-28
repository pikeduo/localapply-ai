// 所有已接入适配器共用有界回读；不写值、不点击、不读取框架私有对象。
(function (global) {
  'use strict';
  const F = global.LocalApplyFillResult;
  const WINDOWS = Object.freeze([120, 120, 260]); // 绝对观察点为 120/240/500ms，覆盖既有重绘窗口。

  // 取消立即释放定时器与监听器，后续只返回失败，不安排迟到操作。
  function delay(ms, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      // 到时和撤销共用清理入口。
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
    });
  }

  // 原节点/安全状态逐次复核；准备时仅允许级联下级暂未启用，最终回读须全部启用。
  function guard(context, preparing = false) {
    if (context.signal?.aborted) return F.failure('cancelled');
    try { context.assertActive(); } catch { return F.failure('stale_context'); }
    const item = context.item; const nodes = [...new Set([item.el, ...(item.members || []), ...Object.values(item.compound?.parts || {})])];
    if (nodes.some((node) => !node.isConnected)) return F.failure('stale_context');
    if (global.FieldMatchingEngine?.restricted(item.field) || /同步更新在线简历/.test(item.field?.label || '')
      || nodes.some((node) => actionNode(node) || global.LocalApplyFieldAdapters?.exclusion?.(node, item.field?.label)?.category === 'security_control')) return F.failure('protected_control', 'unsupported');
    const enabled = preparing && item.compound?.kind === 'address' ? [item.el] : nodes;
    if (enabled.some((node) => node.disabled || node.getAttribute('aria-disabled') === 'true' || node.closest?.('fieldset[disabled]'))) return F.failure('disabled_control', 'unsupported');
    const type = item.control?.type || item.field?.type;
    if (!item.compound && !global.LocalApplyFieldAdapters?.handles(item) && type !== 'combobox'
      && nodes.some((node) => node.readOnly || node.getAttribute('aria-readonly') === 'true')) return F.failure('readonly_control', 'unsupported');
    return null;
  }

  // 保留既有显式 type=button 的 combobox；默认提交按钮、外层按钮和链接仍拒绝。
  function actionNode(node) {
    const action = node.closest?.('button,a,[role="button"]');
    return !!action && !(action === node && node.tagName === 'BUTTON' && node.type === 'button' && node.getAttribute('role') === 'combobox');
  }

  // 只检查当前已授权控件的标准校验标记，不读取可能包含个人值的 validationMessage。
  function invalid(item) {
    return [item.el, ...(item.members || []), ...Object.values(item.compound?.parts || {})]
      .some((node) => node.validity?.valid === false || node.getAttribute('aria-invalid') === 'true');
  }

  // 每次观察仍执行适配器的候选/父级守卫；不吞入原始异常正文。
  function check(context, specific) {
    const blocked = guard(context); if (blocked) return blocked;
    try { const error = specific?.(); return error ? F.normalize(error) : null; }
    catch (error) { return error?.diagnostic ? F.normalize(error) : F.failure(context.signal?.aborted ? 'cancelled' : 'stale_context'); }
  }

  // 至少最后两次回读一致才成功；仅重试读取，任何已接受后的丢失立即失败。
  async function run(context, specific, read = () => context.accepted(context.intent.value)) {
    let blocked = check(context, specific); if (blocked) return blocked;
    let seen = false; let consecutive = 0;
    try {
      if (invalid(context.item)) return F.failure('validation_failed');
      seen = !!read(); // 立即态只记录是否曾被接受，不能提前宣告成功。
      for (const ms of WINDOWS) {
        await delay(ms, context.signal); blocked = check(context, specific); if (blocked) return blocked;
        if (invalid(context.item)) return F.failure('validation_failed');
        const current = !!read();
        if (seen && !current) return F.failure('controlled_reverted');
        seen ||= current; consecutive = current ? consecutive + 1 : 0;
      }
      return consecutive >= 2 ? { ok: true, status: 'success', verifiedAt: new Date().toISOString(), diagnostic: { reasonCode: 'verified' } } : F.failure('value_not_accepted');
    } catch { return F.failure(context.signal?.aborted ? 'cancelled' : 'operation_error'); }
  }
  global.LocalApplyFillVerification = Object.freeze({ run, guard });
})(globalThis);
