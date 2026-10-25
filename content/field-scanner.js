// 阶段三扫描器：仅在可信扩展页面授权后运行，值读取与结构扫描严格分开。
(function (global) {
  'use strict';
  if (global.LocalApplyPageScanner) return;
  const M = global.FieldMatchingEngine;
  const documentId = crypto.randomUUID();
  const nodeIds = new WeakMap();
  const registry = new Map();
  let granted = false; let currentUrl = ''; let lastSignature = ''; let timer;

  // 过滤认证、搜索和协议控件，不读取它们的值；节点不可见或脱离文档时也不能填写。
  function allowed(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const hint = [type, el.getAttribute('autocomplete'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label')].join(' ');
    return el.isConnected && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
      && !['hidden', 'password', 'file', 'submit', 'reset', 'image', 'search'].includes(type) && (type !== 'button' || el.getAttribute('role') === 'combobox')
      && !/password|captcha|one-time-code|验证码|密码|验证口令|csrf|token/i.test(hint)
      && !el.closest('[id^="wsa-"], [data-localapply-ui]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  // DOM/无障碍标签优先；不回退到整个容器的正文或 HTML。
  function label(el) {
    const root = el.getRootNode();
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => root.getElementById?.(id)?.textContent || '').join(' ');
    const explicit = el.id ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent : '';
    const wrap = el.closest('label')?.textContent;
    const nearby = el.closest('.form-item,.form-group,.field,.el-form-item,.ant-form-item')?.querySelector('label,.label,.el-form-item__label,.ant-form-item-label')?.textContent;
    return M.redact(explicit || el.getAttribute('aria-label') || labelled.trim() || nearby || wrap || el.getAttribute('placeholder') || el.getAttribute('name'));
  }

  // 只读取分组标题，不读取经历内容；识别学历、经历种类及重复区块序号。
  function context(el) {
    const selectors = 'fieldset,[data-experience],[role="group"],.experience,.education-item,.work-item,.project-item,.form-section';
    const containers = []; let parent = el.parentElement;
    while (parent && parent !== document.body) { if (parent.matches(selectors)) containers.push(parent); parent = parent.parentElement; }
    const headings = containers.map((container) => container.querySelector(':scope > legend,:scope > h2,:scope > h3,:scope > h4,:scope > [role="heading"],:scope > .section-title')?.textContent || container.getAttribute('aria-label') || '');
    const text = M.redact(headings.join(' · '));
    const probe = label(el) + ' ' + text;
    const kind = /教育|学历|本科|硕士|博士|毕业院校/.test(probe) ? 'education' : /实习/.test(text) ? 'internship'
      : /工作经历|任职|工作经验/.test(text) ? 'employment' : /项目/.test(text) ? 'project' : '';
    const degree = /第一学历/.test(probe) ? 'first' : /最高学历/.test(probe) ? 'highest' : /本科/.test(probe) ? 'undergrad'
      : /硕士/.test(probe) ? 'master' : /博士/.test(probe) ? 'doctor' : '';
    const nearest = containers[0];
    const peers = nearest?.parentElement ? [...nearest.parentElement.children].filter((node) => node.matches(selectors)) : [];
    return { group: text, kind, degree, index: Math.max(0, peers.indexOf(nearest)) };
  }

  // 稳定节点引用不写入网页 dataset；语义 ID 另由脱敏结构计算并跨重绘保持一致。
  function id(el) { if (!nodeIds.has(el)) nodeIds.set(el, 'scan.' + crypto.randomUUID()); return nodeIds.get(el); }

  // 从 light DOM 与 open shadow root 收集控件，最多八层，禁止访问跨域 iframe。
  function controls(root = document, depth = 0) {
    if (depth > 8) return [];
    const out = [...root.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]')];
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) out.push(...controls(node.shadowRoot, depth + 1));
    return [...new Set(out)];
  }

  // 下拉仅收集已有选项，不为扫描点击网页；候选值同样脱敏且有数量上限。
  function options(el, members, type) {
    let rows = [];
    if (el.tagName === 'SELECT') rows = [...el.options].map((option) => ({ value: option.value, text: option.textContent }));
    else if (['radio', 'checkbox'].includes(type)) rows = members.map((option) => ({ value: option.value, text: option.closest('label')?.textContent || option.getAttribute('aria-label') || option.value }));
    else if (type === 'combobox') {
      const menu = el.getRootNode().getElementById?.(el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
      rows = [...(menu?.querySelectorAll('[role="option"]') || [])].map((option) => ({ value: option.getAttribute('data-value') || option.textContent, text: option.textContent }));
    }
    return rows.slice(0, 100).map((option) => ({ value: M.redact(option.value), text: M.redact(option.text) }));
  }

  // 获得授权后仅输出结构元数据，调用期间不触碰任何 input.value/checked。
  function scan(authorize = false) {
    if (authorize) { granted = true; currentUrl = location.href; }
    if (!granted || location.href !== currentUrl) { granted = false; throw new Error('请先主动授权扫描当前招聘页面'); }
    const found = controls().filter(allowed).slice(0, 500); const used = new Set(); const fields = [];
    registry.clear();
    for (const el of found) {
      if (used.has(el)) continue;
      const rawType = (el.getAttribute('type') || 'text').toLowerCase();
      const members = ['radio', 'checkbox'].includes(rawType) && el.name ? found.filter((node) => node.name === el.name && node.getAttribute('type') === rawType && node.closest('form,fieldset,[role="group"]') === el.closest('form,fieldset,[role="group"]')) : [el];
      members.forEach((member) => used.add(member));
      const type = el.getAttribute('role') === 'combobox' ? 'combobox' : el.isContentEditable ? 'contenteditable'
        : el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : ['email','tel','number','url','date','month','radio','checkbox'].includes(rawType) ? rawType : 'text';
      let text = label(el);
      if (members.length > 1) text = M.redact(el.closest('fieldset,[role="group"],.form-item,.form-group')?.querySelector('legend,:scope > label,.label')?.textContent || text);
      const field = { scanId: id(el), label: text, name: M.redact(el.getAttribute('name')), type,
        placeholder: M.redact(el.getAttribute('placeholder')), options: options(el, members, type), ...context(el) };
      if (!field.label || M.restricted(field) || /搜索|站内检索|订阅邮件/.test(field.label)) continue;
      field.semanticId = M.semanticId(field);
      fields.push(field); registry.set(field.scanId, { el, members, field });
    }
    // 指纹相同但有多份相同控件时不能任意合并成一条高置信规则。
    const counts = new Map();
    fields.forEach((field) => { const count = counts.get(field.semanticId) || 0; counts.set(field.semanticId, count + 1); if (count) field.index += count; field.semanticId = M.semanticId(field); });
    const login = !!document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[id*="captcha" i],input[name*="captcha" i],input[placeholder*="验证码"]') && fields.length <= 3 && !fields.some((field) => field.kind);
    if (login) { fields.length = 0; registry.clear(); }
    return { documentId, origin: location.origin, fields, authorized: true, notice: login ? '登录/验证页面不执行智能填表，请进入招聘申请页' : '' };
  }

  // 每次值操作前重新核对授权、语义和节点引用，动态替换控件必须重新扫描确认。
  function record(scanId, expectedDocument, expectedSemantic) {
    if (!granted || currentUrl !== location.href || expectedDocument !== documentId) throw new Error('页面已变化，请重新授权扫描');
    const previous = registry.get(scanId);
    if (!previous || !allowed(previous.el)) throw new Error('控件已失效，请重新扫描');
    const current = scan().fields.find((field) => field.scanId === scanId);
    if (!current || current.semanticId !== expectedSemantic) throw new Error('字段结构已变化，请重新扫描');
    return registry.get(scanId);
  }

  // 只有用户主动保存或核对填写时才读取该控件；不批量收集网页个人值。
  function readValue(item) {
    if (item.field.type === 'radio') return item.members.find((el) => el.checked)?.value || '';
    if (item.field.type === 'checkbox') return item.members.length === 1 ? item.el.checked : item.members.filter((el) => el.checked).map((el) => el.value);
    if (item.field.type === 'combobox' && !('value' in item.el)) return item.el.textContent.trim();
    return item.el.isContentEditable ? item.el.textContent : item.el.value;
  }

  // 只通知结构变化，不向后台发送值；导航会撤销当前文档授权。
  const observer = new MutationObserver(() => {
    if (!granted) return;
    clearTimeout(timer); timer = setTimeout(() => {
      try {
        const snapshot = scan(); const signature = JSON.stringify(snapshot.fields);
        if (signature !== lastSignature) { lastSignature = signature; chrome.runtime.sendMessage({ type: 'learning:changed', documentId }).catch(() => {}); }
      } catch { granted = false; }
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-labelledby', 'aria-controls', 'disabled', 'type'] });

  // 撤销只清理本页内存，不删除用户资料或已确认规则。
  function revoke() { granted = false; registry.clear(); lastSignature = ''; }
  global.LocalApplyPageScanner = { scan, record, readValue, revoke, documentId };
})(globalThis);
