// 右下角可拖动检测提示与填写卡片。私有界面放入扩展 iframe，宿主页面只看到空的封闭 Shadow host。
(function (global) {
  'use strict';
  if (global.WangshenFloatbar) return;
  let host; let shadow; let frame; let badge; let enabled = true; let launcher = false; let collapsed = false; let position = null; let previousFocus;
  let badgePosition = null; let badgeDrag = null; let suppressBadgeClick = false; let badgeSummary;
  let jobSuccess = false; let openedUrl = '';
  // 提示与右边留出 32px、底部留出 96px；小视口自动收缩留白，拖动位置只留在当前页面内存。
  function layoutBadge() {
    if (!host || !badge || badge.hidden || frame) return;
    const rect = badge.getBoundingClientRect();
    if (!badgePosition) {
      const right = Math.min(32, Math.max(10, (innerWidth - rect.width) / 2));
      const bottom = Math.min(96, Math.max(10, innerHeight - rect.height - 10));
      for (const [key, value] of Object.entries({ left: 'auto', top: 'auto', right: right + 'px', bottom: bottom + 'px' })) host.style.setProperty(key, value, 'important');
      return;
    }
    badgePosition.x = Math.max(10, Math.min(badgePosition.x, innerWidth - rect.width - 10));
    badgePosition.y = Math.max(10, Math.min(badgePosition.y, innerHeight - rect.height - 10));
    for (const [key, value] of Object.entries({ left: badgePosition.x + 'px', top: badgePosition.y + 'px', right: 'auto', bottom: 'auto' })) host.style.setProperty(key, value, 'important');
  }
  // 指针捕获使鼠标和触屏都能拖动；小幅抖动仍算点击，拖动结束不误打开卡片。
  function startBadgeDrag(event) {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || frame) return;
    const rect = badge.getBoundingClientRect(); suppressBadgeClick = false;
    badgeDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    badge.setPointerCapture(event.pointerId);
  }
  // 超过拖动阈值后才改变位置，布局函数统一限制视口边界。
  function moveBadgeDrag(event) {
    if (!badgeDrag || badgeDrag.id !== event.pointerId) return;
    const dx = event.clientX - badgeDrag.x; const dy = event.clientY - badgeDrag.y;
    if (!badgeDrag.moved && Math.hypot(dx, dy) < 5) return;
    badgeDrag.moved = true; badge.classList.add('dragging'); event.preventDefault();
    badgePosition = { x: badgeDrag.left + dx, y: badgeDrag.top + dy }; layoutBadge();
  }
  // 释放、取消或丢失指针捕获都结束拖动，防止残留按下状态。
  function endBadgeDrag(event) {
    if (!badgeDrag || badgeDrag.id !== event.pointerId) return;
    suppressBadgeClick = badgeDrag.moved; badgeDrag = null; badge.classList.remove('dragging');
    if (badge.hasPointerCapture(event.pointerId)) badge.releasePointerCapture(event.pointerId);
  }
  // 只在当前页面内保存布局；视口改变时将卡片限制在可见区域，便于避开网页提交区。
  function layout(change = {}) {
    if (!host) return;
    if (!frame) { layoutBadge(); return; }
    if (typeof change.collapsed === 'boolean') collapsed = change.collapsed;
    const width = Math.min(collapsed ? 260 : 440, innerWidth - 20); const height = collapsed ? 64 : Math.min(760, innerHeight * .78, innerHeight - 20);
    if (!position) position = { x: innerWidth - width - 18, y: 18 };
    position.x += Number.isFinite(change.dx) ? change.dx : 0; position.y += Number.isFinite(change.dy) ? change.dy : 0;
    position.x = Math.max(10, Math.min(position.x, innerWidth - width - 10)); position.y = Math.max(10, Math.min(position.y, innerHeight - height - 10));
    for (const [key, value] of Object.entries({ left: position.x + 'px', top: position.y + 'px', right: 'auto', bottom: 'auto' })) host.style.setProperty(key, value, 'important');
    frame.style.width = width + 'px'; frame.style.height = height + 'px';
  }
  // 创建固定图标和分层文案；动态检测数量只写 textContent，不向宿主暴露任何个人资料。
  function createBadge() {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'detection-badge'; button.hidden = true;
    button.title = '点击打开填写助手，按住可拖动位置';
    const icon = document.createElement('span'); icon.className = 'badge-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3.5v5h4M9 12h5M9 15.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="m15 17 1.5 1.5L20 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const copy = document.createElement('span'); copy.className = 'badge-copy';
    const heading = document.createElement('strong'); heading.className = 'badge-heading'; heading.textContent = '检测到简历填写页';
    badgeSummary = document.createElement('span'); badgeSummary.className = 'badge-summary';
    const hint = document.createElement('span'); hint.className = 'badge-hint'; hint.textContent = 'LocalApply · 按住可拖动';
    copy.append(heading, badgeSummary, hint);
    const arrow = document.createElement('span'); arrow.className = 'badge-arrow'; arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.append(icon, copy, arrow); return button;
  }
  // 封闭 Shadow DOM 隐藏私有界面；固定内容宽度避免缩窗时旧 left 反过来挤窄提示。
  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement('div'); host.id = 'wsa-floatbar-host';
    shadow = host.attachShadow({ mode: 'closed' });
    for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', width: 'max-content', 'max-width': 'calc(100vw - 20px)', bottom: '96px', right: '32px', 'z-index': '2147483000', display: 'block' })) host.style.setProperty(key, value, 'important');
    const style = document.createElement('style'); style.textContent = `
      iframe{display:block;width:min(440px,calc(100vw - 20px));height:min(78vh,760px);border:1px solid #e1e7f0;border-radius:18px;background:#fff;box-shadow:0 12px 45px #17284b30}
      .detection-badge{box-sizing:border-box;display:flex;align-items:center;gap:12px;width:320px;max-width:calc(100vw - 40px);padding:16px;border:1px solid #dce6f7;border-radius:18px;background:linear-gradient(120deg,#fff 45%,#f3f7ff);color:#203655;font:14px/1.45 system-ui,"Microsoft YaHei",sans-serif;text-align:left;box-shadow:0 12px 38px #284c7e1a,0 2px 8px #284c7e08,inset 0 1px 0 #fff;cursor:grab;touch-action:none;user-select:none;transition:border-color .18s,box-shadow .18s}
      .detection-badge[hidden]{display:none}
      .detection-badge:hover{border-color:#adc6f0;box-shadow:0 16px 42px #284c7e24,0 3px 10px #284c7e0b}
      .detection-badge.dragging{cursor:grabbing;border-color:#8fb2ed;box-shadow:0 18px 44px #284c7e2b}
      .detection-badge:focus-visible{outline:3px solid #8ab5ff;outline-offset:4px}
      .badge-icon{display:grid;place-items:center;flex:0 0 42px;height:46px;border-radius:13px;background:linear-gradient(145deg,#397af6,#4261e7);color:#fff;box-shadow:0 4px 12px #3d70ed29}
      .badge-icon svg{width:27px;height:27px}.badge-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}
      .badge-heading{font-size:14px;font-weight:650;letter-spacing:.2px}.badge-heading::before{content:"";display:inline-block;width:6px;height:6px;margin:0 6px 2px 0;border-radius:50%;background:#25ad89}
      .badge-summary{font-size:11px;color:#6d7e97}.badge-hint{font-size:10px;color:#96a3b7}
      .badge-arrow{display:grid;place-items:center;flex:0 0 26px;height:26px;border-radius:50%;color:#4d76cf;background:#e9f0fd}.badge-arrow svg{width:15px;height:15px}
      /* 主动收起后复用同一拖动按钮，小球不包含简历内容或已授权会话。 */
      .detection-badge.is-launcher{justify-content:center;width:56px;height:56px;padding:0;border:1px solid #ffffff80;border-radius:50%;background:linear-gradient(145deg,#397af6,#4261e7);box-shadow:0 6px 22px #365bce40}
      .is-launcher .badge-copy,.is-launcher .badge-arrow{display:none}.is-launcher .badge-icon{flex:0 0 40px;height:40px;background:none;box-shadow:none}
      .detection-badge.is-launcher.has-notice{position:relative}.is-launcher.has-notice::after{content:"";position:absolute;top:1px;right:1px;width:10px;height:10px;border:2px solid #fff;border-radius:50%;background:#25ad89}
      @media(prefers-reduced-motion:reduce){.detection-badge{transition:none}}
    `;
    badge = createBadge();
    badge.addEventListener('pointerdown', startBadgeDrag); badge.addEventListener('pointermove', moveBadgeDrag);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) badge.addEventListener(name, endBadgeDrag);
    // 只响应真实用户点击，网页合成事件不能申请私有卡片会话。
    badge.addEventListener('click', (event) => { const dragged = suppressBadgeClick && event.detail !== 0; suppressBadgeClick = false; if (dragged) { event.preventDefault(); return; } if (event.isTrusted) chrome.runtime.sendMessage({ type: 'wsa:openPanel' }).catch(() => {}); });
    shadow.append(style, badge); document.documentElement.append(host);
  }
  // 自动提示与小球共用安全入口；新成功提示保留圆点和无障碍说明，不自动打开或保存申请。
  function onPresence(result) {
    ensure(); badge.hidden = !!frame || (!launcher && (!enabled || !jobSuccess && result.kind !== 'application'));
    badge.classList.toggle('is-launcher', launcher);
    badge.classList.toggle('has-notice', jobSuccess);
    badge.querySelector('.badge-heading').textContent = jobSuccess ? '检测到投递成功，是否记录？' : '检测到简历填写页';
    badgeSummary.textContent = jobSuccess ? '点击核对岗位 · 确认后才保存申请' : `${result.count} 个控件 · 点击打开填写助手`;
    badge.title = jobSuccess ? '检测到投递成功，点击核对岗位并确认记录' : launcher ? '打开 LocalApply，按住可拖动' : '点击打开填写助手，按住可拖动位置';
    badge.setAttribute('aria-label', jobSuccess ? '检测到投递成功，点击核对岗位并确认记录，按住可拖动' : launcher ? '打开 LocalApply 填写助手，按住可拖动' : `检测到简历填写页，${result.count} 个控件。点击打开填写助手，按住可拖动`);
    host.style.setProperty('display', frame || !badge.hidden ? 'block' : 'none', 'important'); layoutBadge();
  }
  // 只接收后台核验后的布尔建议，不在网页提示中暴露岗位记录或个人资料。
  function onJobFeedback(status, suggested) { jobSuccess = status === 'success' && suggested === true; onDetection(); }
  // 延迟发现 SPA 导航时仅关闭旧 URL 的卡片，保留导航后用户重新授权的卡片。
  function onNavigation() { if (!frame || openedUrl !== location.href) { jobSuccess = false; close(false); } }
  // 后台确认新的文档令牌后从提示/小球创建私有 iframe，不继承已关闭的授权。
  function open(url) { ensure(); previousFocus = document.activeElement; frame?.remove(); launcher = false; collapsed = false; openedUrl = location.href; frame = document.createElement('iframe'); frame.src = url; frame.title = 'LocalApply AI 填写助手'; frame.referrerPolicy = 'no-referrer'; shadow.append(frame); badge.hidden = true; host.style.setProperty('display', 'block', 'important'); layout(); frame.addEventListener('load', () => frame?.focus()); }
  // × 仍释放 iframe 和任务，由小球提供重新打开入口；导航关闭则不沿用旧页面的小球状态。
  function close(showLauncher = true) { frame?.remove(); frame = null; openedUrl = ''; launcher = showLauncher; if (showLauncher) onDetection(); else if (host) host.style.setProperty('display', 'none', 'important'); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); }
  // 保留旧检测回调以兼容旧填写器，只更新非敏感页面提示。
  function onDetection() { onPresence(global.LocalApplyPagePresence?.get() || { kind: 'other', count: 0 }); }
  // 用户关闭自动提示后仍可通过工具栏主动打开卡片。
  function setSettings(settings) { enabled = settings.autoFloatbar !== false; onDetection(); }
  chrome.runtime.sendMessage({ type: 'wsa:contentSettings' }).then((response) => { if (response?.settings) setSettings(response.settings); }).catch(() => {});
  window.addEventListener('resize', () => layout());
  global.WangshenFloatbar = { onPresence, onDetection, onJobFeedback, onNavigation, setSettings, open, close, layout, isOpen: () => !!frame?.isConnected };
})(globalThis);
