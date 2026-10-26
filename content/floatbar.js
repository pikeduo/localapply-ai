// 右下角可拖动检测提示与填写卡片。私有界面放入扩展 iframe，宿主页面只看到空的封闭 Shadow host。
(function (global) {
  'use strict';
  if (global.WangshenFloatbar) return;
  let host; let shadow; let frame; let badge; let enabled = true; let dismissed = false; let collapsed = false; let position = null; let previousFocus;
  let badgePosition = null; let badgeDrag = null; let suppressBadgeClick = false;
  // 提示默认靠右下角；拖动位置只留在当前页面内存，缩窗后始终保留可点击区域。
  function layoutBadge() {
    if (!host || !badge || badge.hidden || frame) return;
    if (!badgePosition) {
      for (const [key, value] of Object.entries({ left: 'auto', top: 'auto', right: '18px', bottom: '18px' })) host.style.setProperty(key, value, 'important');
      return;
    }
    const rect = badge.getBoundingClientRect();
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
  // 封闭 Shadow DOM 隐藏私有界面；固定内容宽度避免缩窗时旧 left 反过来挤窄提示。
  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement('div'); host.id = 'wsa-floatbar-host';
    shadow = host.attachShadow({ mode: 'closed' });
    for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', width: 'max-content', 'max-width': 'calc(100vw - 20px)', bottom: '18px', right: '18px', 'z-index': '2147483000', display: 'block' })) host.style.setProperty(key, value, 'important');
    const style = document.createElement('style'); style.textContent = 'iframe{display:block;width:min(440px,calc(100vw - 20px));height:min(78vh,760px);border:1px solid #e1e7f0;border-radius:18px;background:#fff;box-shadow:0 12px 45px #17284b30}button{box-sizing:border-box;max-width:calc(100vw - 20px);font:14px/1.4 system-ui,"Microsoft YaHei",sans-serif;border:1px solid #cbdcff;border-radius:12px;background:#fff;color:#2257d9;padding:12px 15px;box-shadow:0 6px 22px #15295220;cursor:grab;touch-action:none;user-select:none}button.dragging{cursor:grabbing}button:focus-visible{outline:3px solid #8ab5ff}';
    badge = document.createElement('button'); badge.type = 'button'; badge.textContent = '检测到网申表单 · 打开填写助手'; badge.hidden = true;
    badge.title = '点击打开填写助手，按住可拖动位置';
    badge.addEventListener('pointerdown', startBadgeDrag); badge.addEventListener('pointermove', moveBadgeDrag);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) badge.addEventListener(name, endBadgeDrag);
    // 只响应真实用户点击，网页合成事件不能申请私有卡片会话。
    badge.addEventListener('click', (event) => { const dragged = suppressBadgeClick && event.detail !== 0; suppressBadgeClick = false; if (dragged) { event.preventDefault(); return; } if (event.isTrusted) chrome.runtime.sendMessage({ type: 'wsa:openPanel' }).catch(() => {}); });
    shadow.append(style, badge); document.documentElement.append(host);
  }
  // 自动检测到简历填写页后展示右下角提示；重复检测保留拖动位置，不自动打开私有卡片。
  function onPresence(result) { ensure(); badge.hidden = !!frame || !enabled || dismissed || result.kind !== 'application'; badge.textContent = `检测到网申表单 · ${result.count} 个控件 · 打开填写助手`; host.style.setProperty('display', frame || !badge.hidden ? 'block' : 'none', 'important'); layoutBadge(); }
  // 扩展后台确认用户打开后才创建私有 iframe，不向宿主网页发送资料。
  function open(url) { ensure(); previousFocus = document.activeElement; frame?.remove(); collapsed = false; frame = document.createElement('iframe'); frame.src = url; frame.title = 'LocalApply AI 填写助手'; frame.referrerPolicy = 'no-referrer'; shadow.append(frame); badge.hidden = true; host.style.setProperty('display', 'block', 'important'); layout(); frame.addEventListener('load', () => frame?.focus()); }
  // 关闭释放 iframe；换页时重置提示，用户主动关闭则在本页保持收起。
  function close(dismiss = true) { frame?.remove(); frame = null; dismissed = dismiss; if (host) host.style.setProperty('display', 'none', 'important'); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); }
  // 保留旧检测回调以兼容旧填写器，只更新非敏感页面提示。
  function onDetection() { onPresence(global.LocalApplyPagePresence?.get() || { kind: 'other', count: 0 }); }
  // 用户关闭自动提示后仍可通过工具栏主动打开卡片。
  function setSettings(settings) { enabled = settings.autoFloatbar !== false; onDetection(); }
  chrome.runtime.sendMessage({ type: 'wsa:contentSettings' }).then((response) => { if (response?.settings) setSettings(response.settings); }).catch(() => {});
  window.addEventListener('resize', () => layout());
  global.WangshenFloatbar = { onPresence, onDetection, setSettings, open, close, layout, isOpen: () => !!frame?.isConnected };
})(globalThis);
