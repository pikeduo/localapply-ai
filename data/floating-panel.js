// 悬浮窗口授权：只有用户主动打开时签发短期令牌，绑定标签页、完整 URL 和文档。
(function (global) {
  'use strict';
  const KEY = 'localapply.panelSessions';
  // 会话可跨后台休眠恢复，但不进入个人库、配置或备份。
  function create(browser, diagnostics, onClose = () => {}) {
    const sessions = new Map();
    const restored = browser.storage.session?.get(KEY).then((data) => { for (const item of data[KEY] || []) if (Date.now() - item.createdAt < 1800000) sessions.set(item.tabId, item); }).catch(() => {});
    // 仅保存当前存活会话，不保存资料或网页内容。
    async function persist() { if (browser.storage.session) await browser.storage.session.set({ [KEY]: [...sessions.values()].slice(-20) }); }
    // 旧标签页重载扩展后可按需补注入；重复入口由模块自身的幂等保护处理。
    async function page(tabId, message) {
      try { return await browser.tabs.sendMessage(tabId, message, { frameId: 0 }); }
      catch {
        await browser.scripting.executeScript({ target: { tabId }, files: ['data/templates.js','data/field-matching.js','content/field-adapters.js','content/field-scanner.js','content/detector.js','content/filler.js','content/verified-fill.js','content/page-presence.js','content/floatbar.js'] });
        return browser.tabs.sendMessage(tabId, message, { frameId: 0 });
      }
    }
    // 打开只由工具栏或可信内容脚本的真实点击调用；不自动授权字段读取。
    async function open(tabId) {
      await restored; const tab = await browser.tabs.get(tabId);
      if (!/^https?:\/\//.test(tab.url || '')) throw new Error('此页面不能显示悬浮卡片，请切换到招聘网页后点击插件');
      const probe = await page(tabId, { type: 'wsa:floatingProbe' });
      if (probe?.open) { await close(tabId); return; }
      const item = { tabId, url: tab.url, documentId: probe?.documentId, token: crypto.randomUUID(), createdAt: Date.now() };
      if (!item.documentId) throw new Error('页面未连接，请刷新页面后重试');
      sessions.set(tabId, item); await persist();
      const response = await page(tabId, { type: 'wsa:floatingOpen', url: browser.runtime.getURL('panel/panel.html') + '?token=' + item.token });
      if (!response?.ok) { sessions.delete(tabId); await persist(); throw new Error('悬浮卡片加载失败'); }
      await diagnostics.append('panel.open').catch(() => {}); // 日志存储失败不能中断已打开的卡片。
    }
    // 每次私有请求都验证扩展 iframe、令牌、顶层 URL 与当前文档，拒绝伪造嵌入。
    async function authorize(sender, message) {
      await restored;
      if (sender.id !== browser.runtime.id || !sender.tab || !sender.frameId || sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('panel/panel.html')) return null;
      const item = sessions.get(sender.tab.id);
      if (!item || message.panelToken !== item.token || Date.now() - item.createdAt >= 1800000) return null;
      const tab = await browser.tabs.get(item.tabId); if (tab.url !== item.url) return null;
      const probe = await browser.tabs.sendMessage(item.tabId, { type: 'wsa:floatingProbe' }, { frameId: 0 });
      return probe?.open && probe.documentId === item.documentId ? item : null;
    }
    // 关闭立即撤销令牌，再移除网页中的扩展 iframe。
    async function close(tabId) { await restored; onClose(tabId); sessions.delete(tabId); await persist(); await browser.tabs.sendMessage(tabId, { type: 'wsa:floatingClose' }, { frameId: 0 }).catch(() => {}); await diagnostics.append('panel.close').catch(() => {}); }
    // 导航/关闭标签页清除旧会话，刷新不能沿用旧确认。
    async function invalidate(tabId) { await restored; if (sessions.delete(tabId)) await persist(); }
    return { open, authorize, close, invalidate };
  }
  global.LocalApplyFloatingPanel = { create };
})(globalThis);
