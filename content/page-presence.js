// 自动判断页面是否像网申表单：只观察控件元数据，不读取 value 或建立填写授权。
(function (global) {
  'use strict';
  if (global.LocalApplyPagePresence) return;
  let current = { kind: 'other', count: 0 }; let timer; let lastUrl = location.href; let lastSignature = '';
  // 排除插件自身、隐藏控件、搜索、认证及协议，检测结果只包含类型和数量。
  function inspect() {
    const roots = [document]; const fields = []; let authentication = 0;
    for (let index = 0; index < roots.length && index < 8; index++) {
      for (const element of roots[index].querySelectorAll('*')) if (element.shadowRoot && !element.id.startsWith('wsa-') && roots.length < 8) roots.push(element.shadowRoot);
      for (const element of roots[index].querySelectorAll('input,textarea,select,[role=combobox]')) {
        if (fields.length >= 300 || element.closest('[id^=wsa-]') || !element.getClientRects().length || element.disabled) continue;
        const type = (element.getAttribute('type') || '').toLowerCase();
        const metadata = [element.getAttribute('name'),element.id,element.getAttribute('autocomplete'),element.getAttribute('aria-label'),element.getAttribute('placeholder'),...(Array.from(element.labels || []).map((label) => label.textContent))].join(' ');
        if (type === 'password' || /captcha|验证码|one-time-code|短信验证/i.test(metadata)) { authentication++; continue; }
        if (['hidden','submit','button','reset','search'].includes(type) || /搜索|search|同意|协议|隐私|consent|agreement/i.test(metadata)) continue;
        fields.push(metadata.slice(0, 300));
      }
    }
    const heading = [document.title, document.querySelector('h1')?.textContent || ''].join(' ').slice(0, 300);
    const job = /招聘|简历|网申|职位申请|求职|应聘|job application|apply for|resume|career/i.test(heading);
    const resumeFields = fields.filter((label) => /毕业|院校|学历|专业|教育|工作经历|项目|实习|school|education|degree|resume/i.test(label)).length;
    const kind = authentication > 0 && fields.length <= 3 ? 'login' : fields.length >= 3 && (job || resumeFields >= 2) ? 'application' : 'other';
    current = { kind, count: fields.length }; global.WangshenFloatbar?.onPresence(current);
    const signature = JSON.stringify(current);
    if (signature !== lastSignature) { lastSignature = signature; chrome.runtime.sendMessage({ type: 'diagnostics:presence', ...current }).catch(() => {}); }
    return current;
  }
  // 合并动态表单变化，避免逐个 DOM 变动触发全页扫描。
  function schedule() { clearTimeout(timer); timer = setTimeout(inspect, 650); }
  // 排除插件自身更新，并观察异步显隐、标签变化，支持先挂载再显示的表单。
  const observer = new MutationObserver((records) => { if (records.some((record) => !record.target.closest?.('[id^=wsa-]'))) schedule(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden','style','class','aria-hidden','disabled','type','placeholder','aria-label','name'] });
  window.addEventListener('popstate', schedule); window.addEventListener('hashchange', schedule);
  setInterval(() => { if (lastUrl !== location.href) { lastUrl = location.href; lastSignature = ''; schedule(); global.WangshenFloatbar?.close(false); } }, 1000);
  global.LocalApplyPagePresence = { inspect, get: () => current }; schedule();
})(globalThis);
