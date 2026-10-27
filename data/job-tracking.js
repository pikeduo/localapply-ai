// 岗位会话只保存短期待确认元数据；实际申请记录必须经唯一仓库和用户确认写入。
(function (global) {
  'use strict';
  const KEY = 'localapply.jobSessions'; const TTL = 10 * 60 * 1000;
  // 依赖注入便于测试；会话不进入普通备份，后台休眠恢复后仍需核对当前标签。
  function create(repository, browser) {
    let queue = Promise.resolve();
    // 串行读取会话，限制数量和有效期，不保留失效的网页内容。
    async function load() { const data = await browser.storage.session?.get(KEY); return (Array.isArray(data?.[KEY]) ? data[KEY] : []).filter((item) => Number.isInteger(item.tabId) && Date.now() - item.createdAt < TTL && item.createdAt <= Date.now()).slice(-20); }
    // 单个会话异常不阻塞其他页面，避免提交与成功反馈互相覆盖。
    function run(work) { const task = queue.then(work); queue = task.catch(() => {}); return task; }
    // 只接收本扩展顶层内容脚本的提交/反馈，不能让网页消息读到个人库。
    function observe(sender, message) {
      return run(async () => {
        if (sender.id !== browser.runtime.id || !sender.tab || sender.frameId !== 0 || !/^https?:\/\//.test(sender.url || '')) throw new Error('岗位反馈来源无效');
        // Chrome 的 sender.url 在 SPA 导航后可能仍为注入时地址，当前地址由后台查标签取得。
        const currentUrl = (await browser.tabs.get(sender.tab.id)).url;
        if (!/^https?:\/\//.test(currentUrl || '') || new URL(currentUrl).origin !== new URL(sender.url).origin) return {};
        const rows = await load(); const index = rows.findIndex((item) => item.tabId === sender.tab.id);
        if (message.type === 'jobs:submitted') {
          const candidate = global.LocalApplyApplications.candidate(message.candidate);
          if (!candidate.companyName || !candidate.jobTitle || candidate.jobUrl !== global.LocalApplyApplications.cleanUrl(currentUrl) || typeof message.documentId !== 'string' || message.documentId.length > 100) return {};
          const probe = await browser.tabs.sendMessage(sender.tab.id, { type: 'jobs:inspect' }, { frameId: 0 });
          if (!probe.ok || probe.documentId !== message.documentId) return {};
          if (index >= 0) rows.splice(index, 1);
          // 采用捕获阶段的提交前状态；后台回查时同步提交可能已经显示成功。
          rows.push({ tabId: sender.tab.id, origin: new URL(currentUrl).origin, candidate, documentId: message.documentId, createdAt: Date.now(), feedback: 'unknown', allowSuccess: ['unknown', 'failed'].includes(message.feedbackBefore) });
        } else if (message.type === 'jobs:feedback' && index >= 0 && ['success', 'failed', 'unknown'].includes(message.status)) {
          const item = rows[index]; if (new URL(currentUrl).origin !== item.origin) return {};
          if (message.status !== 'success') item.allowSuccess = true;
          if (message.status !== 'success' || item.allowSuccess) item.feedback = message.status;
        }
        await browser.storage.session?.set({ [KEY]: rows }); return { successSuggested: rows.find((item) => item.tabId === sender.tab.id)?.feedback === 'success' };
      });
    }
    // 由已授权卡片主动请求当前岗位；只返回候选及待确认建议，不自动创建记录。
    async function scan(tabId) {
      const tab = await browser.tabs.get(tabId); if (!/^https?:\/\//.test(tab.url || '')) throw new Error('请在普通职位网页中识别岗位');
      const snapshot = await browser.tabs.sendMessage(tabId, { type: 'jobs:inspect' }, { frameId: 0 });
      if (!snapshot?.ok) throw new Error('岗位识别未连接，请刷新网页或手动添加');
      const pending = (await load()).find((item) => item.tabId === tabId && item.origin === new URL(tab.url).origin);
      const candidate = global.LocalApplyApplications.candidate(pending?.feedback === 'success' ? pending.candidate : snapshot.candidate);
      const database = await repository.read(); const existing = database.applications.filter((row) => global.LocalApplyApplications.identity(row) === global.LocalApplyApplications.identity(candidate)).sort((a, b) => b.round - a.round)[0];
      return { candidate, existing: existing || null, feedback: pending?.feedback || 'unknown', successSuggested: pending?.feedback === 'success', recognized: !!snapshot.recognized || pending?.feedback === 'success', documentId: snapshot.documentId };
    }
    // 标签关闭立即删除待确认会话；导航保留十分钟以支持真实提交后的成功页。
    function close(tabId) { return run(async () => { await browser.storage.session?.set({ [KEY]: (await load()).filter((item) => item.tabId !== tabId) }); }); }
    return { observe, scan, close };
  }
  global.LocalApplyJobTracking = { create, KEY };
})(globalThis);
