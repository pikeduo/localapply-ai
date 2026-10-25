// 扩展设置页与悬浮卡片共用诊断入口；文件独立模式不读取扩展日志。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id); if (!$('diagnosticsPanel')) return;
  // 从受限后台取得脱敏记录，直接显示固定字段 JSON，不渲染 HTML。
  async function load() { const result = await sendMessage('diagnostics:read'); if (!result.ok) throw new Error(result.error); $('logsOutput').textContent = result.rows.length ? result.rows.slice().reverse().map((row) => JSON.stringify(row)).join('\n') : '暂无日志'; return result; }
  // 统一显示诊断操作错误，不生成递归日志。
  async function run(operation) { try { await operation(); } catch (error) { $('logsOutput').textContent = error.message || '日志操作失败'; } }
  $('logsRefresh').addEventListener('click', () => run(load)); $('diagnosticsPanel').addEventListener('toggle', () => { if ($('diagnosticsPanel').open) run(load); });
  $('logsExport').addEventListener('click', () => run(async () => { const result = await load(); const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'localapply-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  $('logsClear').addEventListener('click', () => run(async () => { if (!confirm('确认清空本机运行日志？此操作不影响资料和配置。')) return; const result = await sendMessage('diagnostics:clear', { confirmed: true }); if (!result.ok) throw new Error(result.error); await load(); }));
  // 文件页保留诊断模块与原因提示，但不读取扩展日志或展示不可用的操作。
  if (location.protocol === 'file:') { $('fileDiagnosticsNotice').hidden = false; $('diagnosticsPanel').querySelector('.row').hidden = true; $('logsOutput').hidden = true; return; }
  // 设置页运行错误统一交给后台脱敏；卡片已有同类处理，避免重复记录。
  function report(error) { sendMessage('diagnostics:uiError', { error: String(error?.message || error || ''), stack: String(error?.stack || '') }).catch(() => {}); }
  if (location.pathname === '/options/options.html') {
    window.addEventListener('error', (event) => report(event.error || '界面脚本错误'));
    window.addEventListener('unhandledrejection', (event) => report(event.reason));
  }
})(globalThis);
