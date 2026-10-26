// 自动判断页面是否像网申表单：只观察控件元数据，不读取 value 或建立填写授权。
(function (global) {
  'use strict';
  if (global.LocalApplyPagePresence) return;
  let current = { kind: 'other', count: 0 }; let timer; let lastUrl = location.href; let lastSignature = '';
  // 只读取显式标签和邻近分组标题；无障碍引用在当前 DOM 根内解析，不读取控件值。
  function labelsFor(element) {
    const root = element.getRootNode();
    const referenced = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 8)
      .map((id) => root.getElementById?.(id)?.textContent?.slice(0, 300) || '');
    const group = element.closest('.form-item,.form-group,.ant-form-item,.el-form-item,fieldset,[role=group]');
    const local = group?.querySelector('legend,.form-item-label,.control-label,.ant-form-item-label,.el-form-item__label,.label');
    return [...Array.from(element.labels || []).map((label) => label.textContent.slice(0, 300)), ...referenced, local?.textContent.slice(0, 300) || ''];
  }
  // 排除插件自身、隐藏控件、搜索、认证及协议，检测结果只包含类型和数量。
  function inspect() {
    const roots = [document]; const fields = []; let authentication = 0;
    for (let index = 0; index < roots.length && index < 8; index++) {
      for (const element of roots[index].querySelectorAll('*')) if (element.shadowRoot && !element.id.startsWith('wsa-') && roots.length < 8) roots.push(element.shadowRoot);
      for (const element of roots[index].querySelectorAll('input,textarea,select,[role=combobox],[role=textbox],[contenteditable=true]')) {
        if (fields.length >= 300 || element.closest('[id^=wsa-],[hidden],[aria-hidden=true]') || !element.getClientRects().length || element.disabled || ['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) continue;
        const type = (element.getAttribute('type') || '').toLowerCase();
        const metadata = [element.getAttribute('name'),element.id,element.getAttribute('autocomplete'),element.getAttribute('aria-label'),element.getAttribute('placeholder'),...labelsFor(element)].join(' ');
        if (type === 'password' || /captcha|验证码|one-time-code|短信验证/i.test(metadata)) { authentication++; continue; }
        if (['hidden','submit','button','reset','search'].includes(type) || /搜索|search|同意|协议|隐私|consent|agreement/i.test(metadata)) continue;
        fields.push(metadata.slice(0, 300));
      }
    }
    const heading = [document.title, ...Array.from(document.querySelectorAll('h1,h2,[role=heading]')).slice(0, 12).map((item) => item.textContent.slice(0, 100))].join(' ').slice(0, 1500);
    const job = /招聘|简历|网申|职位申请|求职|应聘|job application|apply for|resume|career/i.test(heading);
    const resumeFields = fields.filter((label) => /毕业|院校|学历|专业|教育|工作经历|项目|实习|school|education|degree|resume/i.test(label)).length;
    const kind = authentication > 0 && fields.length <= 3 ? 'login' : fields.length >= 3 && (job || resumeFields >= 2) ? 'application' : 'other';
    current = { kind, count: fields.length }; global.WangshenFloatbar?.onPresence(current);
    const signature = JSON.stringify(current);
    if (signature !== lastSignature) { lastSignature = signature; chrome.runtime.sendMessage({ type: 'diagnostics:presence', ...current }).catch(() => {}); }
    return current;
  }
  // 合并动态变化且限定等待时间；页面持续刷新样式时也不能无限推迟表单检测。
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; inspect(); }, 650); }
  // 排除插件自身更新，并观察异步显隐、标签变化，支持先挂载再显示的表单。
  const observer = new MutationObserver((records) => { if (records.some((record) => !record.target.closest?.('[id^=wsa-]'))) schedule(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden','style','class','aria-hidden','disabled','type','placeholder','aria-label','aria-labelledby','autocomplete','name','id','role','contenteditable'] });
  window.addEventListener('popstate', schedule); window.addEventListener('hashchange', schedule);
  setInterval(() => { if (lastUrl !== location.href) { lastUrl = location.href; lastSignature = ''; schedule(); global.WangshenFloatbar?.close(false); } }, 1000);
  global.LocalApplyPagePresence = { inspect, get: () => current }; schedule();
})(globalThis);
