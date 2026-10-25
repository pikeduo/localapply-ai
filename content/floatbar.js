// 页面右上角卡片与轻量提示。私有界面放入扩展 iframe，宿主页面只看到空的封闭 Shadow host。
(function (global) {
  'use strict';
  if (global.WangshenFloatbar) return;
  let host; let shadow; let frame; let badge; let enabled = true; let dismissed = false; let collapsed = false; let position = null; let previousFocus;
  // 只在当前页面内保存布局；视口改变时将卡片限制在可见区域，便于避开网页提交区。
  function layout(change = {}) {
    if (!frame || !host) return;
    if (typeof change.collapsed === 'boolean') collapsed = change.collapsed;
    const rect = host.getBoundingClientRect();
    if (!position) position = { x: rect.left, y: rect.top };
    position.x += Number.isFinite(change.dx) ? change.dx : 0; position.y += Number.isFinite(change.dy) ? change.dy : 0;
    const width = Math.min(collapsed ? 260 : 440, innerWidth - 20); const height = collapsed ? 64 : Math.min(760, innerHeight * .78, innerHeight - 20);
    position.x = Math.max(10, Math.min(position.x, innerWidth - width - 10)); position.y = Math.max(10, Math.min(position.y, innerHeight - height - 10));
    for (const [key, value] of Object.entries({ left: position.x + 'px', top: position.y + 'px', right: 'auto' })) host.style.setProperty(key, value, 'important');
    frame.style.width = width + 'px'; frame.style.height = height + 'px';
  }
  // 封闭 Shadow DOM 隐藏会话令牌与 iframe URL，网页脚本不能读取简历预览。
  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement('div'); host.id = 'wsa-floatbar-host';
    shadow = host.attachShadow({ mode: 'closed' });
    for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', top: '18px', right: '18px', 'z-index': '2147483000', display: 'block' })) host.style.setProperty(key, value, 'important');
    const style = document.createElement('style'); style.textContent = 'iframe{display:block;width:min(440px,calc(100vw - 20px));height:min(78vh,760px);border:1px solid #e1e7f0;border-radius:18px;background:#fff;box-shadow:0 12px 45px #17284b30}button{font:14px/1.4 system-ui,"Microsoft YaHei",sans-serif;border:1px solid #cbdcff;border-radius:12px;background:#fff;color:#2257d9;padding:12px 15px;box-shadow:0 6px 22px #15295220;cursor:pointer}button:focus-visible{outline:3px solid #8ab5ff}';
    badge = document.createElement('button'); badge.type = 'button'; badge.textContent = '检测到网申表单 · 打开填写助手'; badge.hidden = true;
    // 只响应真实用户点击，网页合成事件不能申请私有卡片会话。
    badge.addEventListener('click', (event) => { if (event.isTrusted) chrome.runtime.sendMessage({ type: 'wsa:openPanel' }).catch(() => {}); });
    shadow.append(style, badge); document.documentElement.append(host);
  }
  // 自动提示只展示布尔检测结果；不自动打开含个人资料的卡片。
  function onPresence(result) { ensure(); badge.hidden = !!frame || !enabled || dismissed || result.kind !== 'application'; badge.textContent = `检测到网申表单 · ${result.count} 个控件 · 打开填写助手`; host.style.setProperty('display', frame || !badge.hidden ? 'block' : 'none', 'important'); }
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
