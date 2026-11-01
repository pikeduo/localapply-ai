// 自动判断页面是否像网申表单：只观察控件元数据，不读取 value 或建立填写授权。
(function (global) {
  'use strict';
  if (global.LocalApplyPagePresence) return;
  let current = { kind: 'other', count: 0 }; let timer; let lastUrl = location.href; let lastSignature = '';
  // 优先读取字段自身的显式标签，复用 ATSX 标签桥接；不将整组标题重复算作每个字段的语义。
  function labelsFor(element) {
    const root = element.getRootNode();
    const referenced = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 8)
      .map((id) => root.getElementById?.(id)?.textContent?.slice(0, 300) || '');
    const explicit = [...Array.from(element.labels || []).map((label) => label.textContent.slice(0, 300)), ...referenced];
    if (explicit.some((label) => label.trim())) return explicit;
    const atsx = global.LocalApplyATSX?.label(element); if (atsx) return [atsx.slice(0, 300)];
    const group = element.closest('.form-item,.form-group,.ant-form-item,.el-form-item');
    const local = group?.querySelector('legend,.form-item-label,.control-label,.ant-form-item-label,.el-form-item__label,.label');
    return [local?.textContent.slice(0, 300) || ''];
  }
  // 只统计明确的资料语义；同类字段重复出现不会增加证据，“项目”等泛词不作为简历信号。
  function fieldKind(metadata, type) {
    const kinds = [
      ['school', /毕业院校|院校|学校名称|学校|\bschool\b|\buniversity\b|\bcollege\b/i],
      ['major', /专业|\bmajor\b|field.of.study/i],
      ['degree', /学历|学位|\bdegree\b/i],
      ['employment', /工作经历|工作经验|工作年限|实习经历|任职公司|实习单位|work.experience|employment.history/i],
      ['project', /项目经历|项目名称|project.(?:name|title|experience)/i],
      ['intention', /求职意向|应聘职位|期望(?:职位|薪资)|到岗日期|expected.salary|desired.position/i],
      ['name', /姓名|全名|(?:full|first|last|given|family|applicant)[\s_-]*name|\bname\b/i],
      ['phone', /手机|电话|mobile|phone|\btel\b/i],
      ['email', /邮箱|电子邮件|e[\s_-]*mail/i],
      ['birth', /出生日期|出生年月|birth[\s_-]*(?:date|day)|birthday/i]
    ];
    return kinds.find(([, pattern]) => pattern.test(metadata))?.[0] || (type === 'tel' ? 'phone' : type === 'email' ? 'email' : '');
  }
  // 明确表单优先隔离；无 form 的组件按局部模块分区，防止全页零散控件凑成申请表。
  function fieldScope(element) {
    return element.closest('form,[role=form]') || element.closest('fieldset,[role=group],section,.form-section,.createFormSection-container,[class^="apply-block-"],[class*=" apply-block-"]') || element.getRootNode();
  }
  // 简短申请表需要本地申请标题或按钮；招聘文章、站点标题和“career”本身不能触发提示。
  function applicationContext(scope) {
    const headings = Array.from(scope.querySelectorAll('legend,h1,h2,h3,[role=heading]')).slice(0, 12);
    const siblings = scope.parentElement?.querySelectorAll(':scope > h1,:scope > h2,:scope > h3,:scope > [role=heading]') || [];
    const labels = [scope.getAttribute?.('aria-label') || '', ...headings, ...siblings].map((item) => typeof item === 'string' ? item : item.textContent.slice(0, 100));
    const explicit = /简历填写|填写简历|完善简历|编辑简历|在线简历|职位申请|申请职位|岗位申请|招聘申请|应聘(?:申请|登记)|job.application|apply.for/i;
    if (labels.some((text) => !/教程|攻略|指南|如何|怎么|\bguide\b|how.to/i.test(text) && explicit.test(text))) return true;
    return Array.from(scope.querySelectorAll('button')).slice(0, 20).some((button) => !button.disabled && button.getClientRects().length && /^(?:提交申请|提交简历|投递简历|立即申请|立即投递|submit application|apply now)$/i.test(button.textContent.trim()));
  }
  // 至少三个有效控件及独立语义：明确申请区支持基本联系方式，其余需要两类经历或求职资料。
  function isApplication(fields, scope) {
    if (fields.length < 3) return false;
    const known = fields.map((field) => field.kind).filter(Boolean); const kinds = new Set(known);
    if (known.length < 3) return false;
    const resumeKinds = ['school','major','degree','employment','project','intention'].filter((kind) => kinds.has(kind));
    return (kinds.size >= 3 && resumeKinds.length >= 2) || (kinds.has('name') && (kinds.has('phone') || kinds.has('email')) && applicationContext(scope));
  }
  // 排除插件自身、隐藏控件、搜索、认证及协议，检测结果只包含类型和数量。
  function inspect() {
    const roots = [document]; const fields = []; const scopes = new Map(); const seen = new Map(); let authentication = 0;
    for (let index = 0; index < roots.length && index < 8; index++) {
      for (const element of roots[index].querySelectorAll('*')) if (element.shadowRoot && !element.id.startsWith('wsa-') && roots.length < 8) roots.push(element.shadowRoot);
      for (const element of roots[index].querySelectorAll('input,textarea,select,[role=combobox],[role=textbox],[contenteditable=true]')) {
        if (fields.length >= 300 || element.closest('[id^=wsa-],[hidden],[inert],[aria-hidden=true],[role=listbox],[role=option],fieldset[disabled]') || !element.getClientRects().length || element.disabled || element.getAttribute('aria-disabled') === 'true' || ['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) continue;
        const type = (element.getAttribute('type') || '').toLowerCase();
        const metadata = [element.getAttribute('name'),element.id,element.getAttribute('autocomplete'),element.getAttribute('aria-label'),element.getAttribute('placeholder'),...labelsFor(element)].join(' ');
        if (type === 'password' || /captcha|验证码|one-time-code|短信验证/i.test(metadata)) { authentication++; continue; }
        if (['hidden','submit','button','reset','search'].includes(type) || /搜索|search|同意|协议|隐私|consent|agreement/i.test(metadata)) continue;
        // ARIA 外壳和内部 input 只计一个控件；匿名外壳可补充内部明确标签，不增加字段数量。
        const control = element.closest('[role=combobox],[role=textbox]') || element;
        const kind = fieldKind(metadata.slice(0, 300), type);
        if (seen.has(control)) { const field = seen.get(control); if (!field.kind) field.kind = kind; continue; }
        const field = { kind }; const scope = fieldScope(element); seen.set(control, field);
        fields.push(field); if (!scopes.has(scope)) scopes.set(scope, []); scopes.get(scope).push(field);
      }
    }
    const kind = authentication > 0 && fields.length <= 3 ? 'login' : Array.from(scopes).some(([scope, items]) => isApplication(items, scope)) ? 'application' : 'other';
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
  setInterval(() => { if (lastUrl !== location.href) { lastUrl = location.href; lastSignature = ''; schedule(); global.WangshenFloatbar?.onNavigation(); } }, 1000);
  global.LocalApplyPagePresence = { inspect, get: () => current }; schedule();
})(globalThis);
