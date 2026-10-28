// 页面任务只持有取消信号和随机操作标识；不保存值、不安排重试，也不暴露给网页。
(function (global) {
  'use strict';
  if (global.LocalApplyPageTasks) return;
  const active = new Map(); const cancelled = new Map();
  // 有界保留取消墓碑，阻止已发出但晚到的同批请求再次点击；只驻留当前文档。
  function prune() { for (const [id, at] of cancelled) if (Date.now() - at > 1800000) cancelled.delete(id); while (cancelled.size > 100) cancelled.delete(cancelled.keys().next().value); }
  // 取消一个后台签发的批次，同批正在等待的查询/回读共用 AbortSignal。
  function cancel(id) { prune(); cancelled.set(id, Date.now()); active.get(id)?.abort(); prune(); }
  // 新授权、关闭及页面离开立即终止全部任务，保留已写入网页的内容。
  function cancelAll() { for (const id of active.keys()) cancel(id); }
  // 每个批次同时最多一个页面操作；旧单项调用也能在页面撤销时统一中止。
  async function run(id, action) {
    const operationId = id || 'operation.' + crypto.randomUUID(); prune();
    if (!/^operation\.[\w.-]{1,100}$/.test(operationId) || active.has(operationId)) throw new Error('填写任务格式错误或仍在进行');
    if (cancelled.has(operationId)) return global.LocalApplyFillResult.failure('cancelled');
    const controller = new AbortController(); active.set(operationId, controller);
    try { return await action(controller.signal); } finally { if (active.get(operationId) === controller) active.delete(operationId); }
  }
  global.addEventListener?.('pagehide', cancelAll);
  global.LocalApplyPageTasks = Object.freeze({ VERSION:1, run, cancel, cancelAll });
})(globalThis);
