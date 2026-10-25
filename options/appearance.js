// 仅保存界面明暗偏好，不读取资料、密钥或个人数据库；文件页按目录隔离。
(() => {
  const storageKey = 'localapply.appearance:' + new URL('.', location.href).pathname;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let selected = null;
  try { const saved = localStorage.getItem(storageKey); if (['light', 'dark'].includes(saved)) selected = saved; } catch { /* 存储不可用时，本页仍可切换。 */ }

  // 在样式加载前设置主题，按钮描述始终表示下一次点击的目标模式。
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('themeToggle'); if (!button) return;
    const dark = theme === 'dark'; const label = dark ? '切换至明亮模式' : '切换至暗黑模式';
    button.title = label; button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(dark));
    document.getElementById('themeIcon').textContent = dark ? '☀' : '☾';
    document.getElementById('themeLabel').textContent = dark ? '明亮' : '暗黑';
  }

  // 滚动以当前模块的真实文档高度为准；尊重系统减少动画偏好。
  function scrollPage(bottom) {
    window.scrollTo({ top: bottom ? document.documentElement.scrollHeight : 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  applyTheme(selected || (systemTheme.matches ? 'dark' : 'light'));
  systemTheme.addEventListener('change', () => { if (!selected) applyTheme(systemTheme.matches ? 'dark' : 'light'); });
  // 只同步同一设置目录的显示偏好，不触碰表单草稿或重新加载页面。
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    selected = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
    applyTheme(selected || (systemTheme.matches ? 'dark' : 'light'));
  });
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme);
    document.getElementById('themeToggle').addEventListener('click', () => {
      selected = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(selected);
      try { localStorage.setItem(storageKey, selected); } catch { /* 不让存储限制中断本页操作。 */ }
    });
    document.getElementById('scrollTop').addEventListener('click', () => scrollPage(false));
    document.getElementById('scrollBottom').addEventListener('click', () => scrollPage(true));
  });
})();
