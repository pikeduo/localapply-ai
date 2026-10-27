// 阶段三扫描器：仅在可信扩展页面授权后运行，值读取与结构扫描严格分开。
(function (global) {
  'use strict';
  if (global.LocalApplyPageScanner) return;
  const M = global.FieldMatchingEngine;
  const A = global.LocalApplyFieldAdapters;
  const documentId = crypto.randomUUID();
  const nodeIds = new WeakMap();
  const registry = new Map();
  let granted = false; let currentUrl = ''; let lastSignature = ''; let timer;

  // 过滤认证、搜索和协议控件，不读取它们的值；节点不可见或脱离文档时也不能填写。
  function allowed(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Moka 在普通资料框使用非标准 new_password 禁用补全；真实密码类型/名称仍须排除。
    const autocomplete = el.getAttribute('autocomplete');
    const hint = [type, autocomplete === 'new_password' ? '' : autocomplete, el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label')].join(' ');
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
    const nearby = el.closest('.form-item,.form-group,.field,.el-form-item,.ant-form-item,[class^="apply-field-"],[class*=" apply-field-"]')?.querySelector(':scope > [class^="title-"],label,.label,.el-form-item__label,.ant-form-item-label')?.textContent;
    return M.redact(explicit || labelled.trim() || nearby || el.getAttribute('aria-label') || wrap || el.getAttribute('name') || el.getAttribute('placeholder')).replace(/\s*[*＊]+\s*$/, '');
  }

  // 只读取分组标题，不读取经历内容；识别学历、经历种类及重复区块序号。
  function context(el) {
    // Moka 的模块标题和记录容器使用哈希类名，只取模块标题，不读取记录正文。
    const block = el.closest('[class^="apply-block-"],[class*=" apply-block-"]');
    if (block) {
      const group = M.redact(block.querySelector(':scope > [class^="blockTitle-"] [class^="text-"]')?.textContent);
      const record = el.closest('[class^="apply-fields-"],[class*=" apply-fields-"]');
      const records = [...block.children].filter((node) => node.matches('[class^="apply-fields-"],[class*=" apply-fields-"]'));
      const kind = global.WangshenTemplates.recordKind(group) || (/教育|学历/.test(group) ? 'education' : /实习/.test(group) ? 'internship' : /工作经历/.test(group) ? 'employment' : /项目/.test(group) ? 'project' : /获奖/.test(group) ? 'award' : '');
      const probe = label(el); const degree = /第一学历/.test(probe) ? 'first' : /最高学历/.test(probe) ? 'highest' : '';
      return { group, kind, degree, index: Math.max(0, records.indexOf(record)) };
    }
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
    const all = controls().slice(0, 500); const excluded = [];
    const found = all.filter((el) => {
      const reason = A.exclusion(el, label(el));
      if (reason) { excluded.push({ ...reason, label: reason.category === 'security_control' ? '安全控件' : label(el) }); return false; }
      return allowed(el);
    });
    const compounds = A.groups(found, label); const used = new Set(); const fields = [];
    registry.clear();
    for (const el of found) {
      if (used.has(el)) continue;
      const compound = compounds.get(el);
      if (compound && compound.anchor !== el) continue;
      if (compound) Object.values(compound.parts).forEach((part) => { used.add(part); if (part !== el) excluded.push({ category: 'compound_part', label: A.slot(part) || '国家区号', reason: '已归入“' + compound.label + '”复合字段' }); });
      else if (A.country(el) || A.slot(el)) { excluded.push({ category: 'compound_part', label: A.slot(el) || '国家区号', reason: '未找到明确主字段，请在网页手动操作；不创建独立简历字段' }); continue; }
      const rawType = (el.getAttribute('type') || 'text').toLowerCase();
      const members = ['radio', 'checkbox'].includes(rawType) && el.name ? found.filter((node) => node.name === el.name && node.getAttribute('type') === rawType && node.closest('form,fieldset,[role="group"]') === el.closest('form,fieldset,[role="group"]')) : [el];
      members.forEach((member) => used.add(member));
      const type = compound?.type || (el.getAttribute('role') === 'combobox' || A.dropdown(el) ? 'combobox' : el.isContentEditable ? 'contenteditable'
        : el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : ['email','tel','number','url','date','month','datetime-local','radio','checkbox'].includes(rawType) ? rawType : 'text');
      let text = compound?.label || label(el);
      if (members.length > 1) text = M.redact(el.closest('fieldset,[role="group"],.form-item,.form-group')?.querySelector('legend,:scope > label,.label')?.textContent || text);
      const field = { scanId: id(el), label: text, name: M.redact(el.getAttribute('name')), type,
        placeholder: compound ? '' : M.redact(el.getAttribute('placeholder')), options: compound ? [] : options(el, members, type), ...context(el), ...(compound ? { layout: compound.layout } : {}) };
      if (!field.label || M.restricted(field) || /搜索|站内检索|订阅邮件/.test(field.label)) continue;
      field.semanticId = M.semanticId(field);
      fields.push(field); registry.set(field.scanId, { el, members, field, compound });
    }
    // 指纹相同但有多份相同控件时不能任意合并成一条高置信规则。
    const counts = new Map();
    fields.forEach((field) => { const count = counts.get(field.semanticId) || 0; counts.set(field.semanticId, count + 1); if (count) field.index += count; field.semanticId = M.semanticId(field); });
    const login = !!document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[id*="captcha" i],input[name*="captcha" i],input[placeholder*="验证码"]') && fields.length <= 3 && !fields.some((field) => field.kind);
    if (login) { fields.length = 0; registry.clear(); }
    return { documentId, origin: location.origin, fields, excluded, authorized: true, notice: login ? '登录/验证页面不执行智能填表，请进入招聘申请页' : '' };
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

  // 主动保存/核对时读取单项；主动扫描仅在本页调用它判空，不传出实际值。
  function readValue(item) {
    if (item.compound) return A.read(item);
    if (A.dropdown(item.el)) return A.dropdownText(item.el);
    if (item.field.type === 'radio') return item.members.find((el) => el.checked)?.value || '';
    if (item.field.type === 'checkbox') return item.members.length === 1 ? item.el.checked : item.members.filter((el) => el.checked).map((el) => el.value);
    if (item.field.type === 'combobox' && !('value' in item.el)) return item.el.textContent.trim();
    return item.el.isContentEditable ? item.el.textContent : item.el.value;
  }

  // 用户主动扫描后仅读取是否已有内容；兼容显示节点的多类名顺序，仅返回布尔标记。
  function completion() {
    if (!granted || currentUrl !== location.href) throw new Error('请先主动授权扫描当前招聘页面');
    return [...registry.values()].map((item) => {
      const value = readValue(item);
      let present = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== false && String(value).trim() !== '' && !/^(请选择|请选择一项|Select|Please select)$/i.test(String(value).trim());
      if (item.compound?.kind === 'date') present = present && !A.plan(item, value).error;
      if (A.dropdown(item.el) && !item.compound) present = present && (!!A.dropdown(item.el).querySelector('[class*="sd-Input-display-value-"]')?.textContent.trim() || A.dropdownAccepted(item.el, value));
      return { scanId: item.field.scanId, present: present && item.el.getAttribute('aria-invalid') !== 'true' && item.el.validity?.valid !== false };
    });
  }

  // 只描述已识别的 Moka 重复模块；记录/按钮节点不离开本页，字段实际值不进入描述。
  function recordBlocks() {
    if (!granted || currentUrl !== location.href) throw new Error('请先主动扫描当前招聘页面');
    return [...document.querySelectorAll('[class^="apply-block-"],[class*=" apply-block-"]')].flatMap((block) => {
      const heading = block.querySelector(':scope > [class^="blockTitle-"]');
      const kind = global.WangshenTemplates.recordKind(heading?.querySelector('[class^="text-"]')?.textContent.trim());
      if (!kind || ['family'].includes(kind)) return [];
      const add = [...(heading?.querySelectorAll('button[type="button"]') || [])].filter((node) => /^\+?\s*添加(?:经历|记录)?$/.test(node.textContent.trim()) && !node.disabled && node.getClientRects().length);
      const records = [...block.children].filter((node) => node.matches('[class^="apply-fields-"],[class*=" apply-fields-"]'));
      // 已有超多记录仍可扫描单项，只停止自动增补，不能让整页扫描报错。
      if (records.length > 20) return [];
      return [{ blockId: id(block), kind, canAdd: add.length === 1, records: records.map((node) => ({ recordId: id(node), scanIds: [...registry.values()].filter((item) => node.contains(item.el)).map((item) => item.field.scanId) })) }];
    });
  }

  // 一次只点当前模块唯一的“添加”，必须观察到恰好新增一条；不点击删除/提交或无限重试。
  async function addRecord(blockId, expectedDocument) {
    if (!granted || currentUrl !== location.href || documentId !== expectedDocument) throw new Error('页面已变化，请重新扫描');
    const block = [...document.querySelectorAll('[class^="apply-block-"],[class*=" apply-block-"]')].find((node) => nodeIds.get(node) === blockId);
    const group = recordBlocks().find((item) => item.blockId === blockId);
    if (!block || !group?.canAdd || group.records.length >= 20) throw new Error('该模块不能安全添加记录或已达到上限');
    const button = [...block.querySelectorAll(':scope > [class^="blockTitle-"] button[type="button"]')].find((node) => /^\+?\s*添加(?:经历|记录)?$/.test(node.textContent.trim()) && !node.disabled && node.getClientRects().length);
    if (!button) throw new Error('添加按钮已变化，请重新扫描');
    button.click();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!block.isConnected || currentUrl !== location.href) throw new Error('添加时页面结构已变化，请重新扫描');
      const count = [...block.children].filter((node) => node.matches('[class^="apply-fields-"],[class*=" apply-fields-"]')).length;
      if (count === group.records.length + 1) return;
      if (count !== group.records.length) break;
    }
    throw new Error('网页未确认新增一条记录，已停止添加');
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
  global.LocalApplyPageScanner = { scan, record, readValue, completion, recordBlocks, addRecord, revoke, documentId };
})(globalThis);
