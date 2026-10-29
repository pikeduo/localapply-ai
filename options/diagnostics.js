// 扩展设置页与悬浮卡片共用诊断入口；文件独立模式不读取扩展日志。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id); if (!$('diagnosticsPanel')) return;
  let refreshTimer; let loadVersion = 0;
  // 从受限后台读取已持久化记录；仅最新请求可更新视图，迟到响应不覆盖清理结果。
  async function load() {
    const version = ++loadVersion;
    const result = await sendMessage('diagnostics:read'); if (!result.ok) throw new Error(result.error);
    if (version !== loadVersion) return result;
    const status = $('logsStorageStatus');
    if (status) { status.textContent = result.storage?.lastWriteFailed ? '最近一次日志写入失败，当前显示的是之前已保存的记录；请检查扩展本地存储后重试。' : '日志自动保存在本浏览器扩展的 chrome.storage.local（localapply.diagnostics），重启后保留；点击“导出日志”另存为 JSON 文件。'; status.className = result.storage?.lastWriteFailed ? 'err' : 'muted'; }
    // 使用官方实际占用统计，只展示字节与固定配额提示，不自动清理个人数据。
    if (status && result.databaseStorage) {
      const info = result.databaseStorage;
      if (info.totalBytes !== null) status.textContent += ` 本地占用 ${info.totalBytes} 字节，数据库 ${info.dbBytes} 字节。`;
      if (info.warning) { status.textContent += ' ' + info.warning; status.className = 'err'; }
    }
    $('logsOutput').textContent = result.rows.length ? result.rows.slice().reverse().map((row) => JSON.stringify(row)).join('\n') : '暂无日志'; return result;
  }
  // 统一显示诊断操作错误，不生成递归日志。
  async function run(operation) { try { await operation(); } catch (error) { $('logsOutput').textContent = error.message || '日志操作失败'; } }
  $('logsRefresh').addEventListener('click', () => run(load)); $('diagnosticsPanel').addEventListener('toggle', () => { if ($('diagnosticsPanel').open) run(load); });
  $('logsExport').addEventListener('click', () => run(async () => { const result = await load(); const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'localapply-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  $('logsClear').addEventListener('click', () => run(async () => { if (!confirm('确认清空本机运行日志？此操作不影响资料和配置。')) return; const result = await sendMessage('diagnostics:clear', { confirmed: true }); if (!result.ok) throw new Error(result.error); await load(); }));
  // 文件页保留诊断模块与原因提示，但不读取扩展日志或展示不可用的操作。
  if (location.protocol === 'file:') { $('fileDiagnosticsNotice').hidden = false; if ($('logsStorageStatus')) $('logsStorageStatus').hidden = true; $('diagnosticsPanel').querySelector('.row').hidden = true; $('logsOutput').hidden = true; return; }
  // 只在日志可见时合并本地变更通知；关闭卡片不会清除扩展中的历史记录。
  chrome.storage.onChanged.addListener((changes, area) => { if (area !== 'local' || !changes['localapply.diagnostics'] || !$('diagnosticsPanel').open || !$('diagnosticsPanel').getClientRects().length) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => run(load), 150); });
  window.addEventListener('pagehide', () => clearTimeout(refreshTimer));
  // 设置页运行错误统一交给后台脱敏；卡片已有同类处理，避免重复记录。
  function report(error) { sendMessage('diagnostics:uiError', { error: String(error?.message || error || ''), stack: String(error?.stack || '') }).catch(() => {}); }
  if (location.pathname === '/options/options.html') {
    window.addEventListener('error', (event) => report(event.error || '界面脚本错误'));
    window.addEventListener('unhandledrejection', (event) => report(event.reason));
  }
})(globalThis);
