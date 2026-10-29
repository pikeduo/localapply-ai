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

  // 过滤认证及未激活步骤，不读取它们的值；ARIA 隐藏、inert 与禁用分组同样禁止扫描。
  function allowed(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Moka 在普通资料框使用非标准 new_password 禁用补全；真实密码类型/名称仍须排除。
    const autocomplete = el.getAttribute('autocomplete');
    const hint = [type, autocomplete === 'new_password' ? '' : autocomplete, el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label')].join(' ');
    return el.isConnected && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
      && !['hidden', 'password', 'file', 'submit', 'reset', 'image', 'search'].includes(type) && (type !== 'button' || el.getAttribute('role') === 'combobox')
      && !/password|captcha|one-time-code|验证码|密码|验证口令|csrf|token/i.test(hint)
      && !el.closest('[id^="wsa-"],[data-localapply-ui],[hidden],[inert],[aria-hidden="true"],fieldset[disabled],.atsx-select-disabled,.atsx-date-picker-disabled') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  // DOM/无障碍标签优先；不回退到整个容器的正文或 HTML。
  function label(el) {
    const atsx = global.LocalApplyATSX?.label(el);
    if (atsx) return M.redact(atsx).replace(/\s*[*＊]+\s*$/, '');
    const root = el.getRootNode();
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => root.getElementById?.(id)?.textContent || '').join(' ');
    const explicit = el.id ? root.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent : '';
    const wrap = el.closest('label')?.textContent;
    const nearby = el.closest('.form-item,.form-group,.field,.el-form-item,.ant-form-item,[class^="apply-field-"],[class*=" apply-field-"]')?.querySelector(':scope > [class^="title-"],label,.label,.el-form-item__label,.ant-form-item-label')?.textContent;
    return M.redact(explicit || labelled.trim() || nearby || el.getAttribute('aria-label') || wrap || el.getAttribute('name') || el.getAttribute('placeholder')).replace(/\s*[*＊]+\s*$/, '');
  }

  // 只读取分组标题，不读取经历内容；识别学历、经历种类及重复区块序号。
  function context(el) {
    const atsx = global.LocalApplyATSX?.context(el);
    if (atsx) return { ...atsx, group: M.redact(atsx.group) };
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

  // 收集当前根控件；明确指向同一列表的嵌套 combobox 只保留内部输入，避免生成两个字段。
  function controls(root = document, depth = 0) {
    if (depth > 8) return [];
    const out = [...root.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]'), ...(global.LocalApplyATSX?.controls(root) || [])];
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) out.push(...controls(node.shadowRoot, depth + 1));
    return [...new Set(out)].filter((el) => {
      if (el.getAttribute('role') !== 'combobox' || el.matches('input,select,textarea,button')) return true;
      const link = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (!link || /\s/.test(link.trim())) return true;
      const inputs = [...el.querySelectorAll('input[role="combobox"]')];
      return inputs.length !== 1 || (inputs[0].getAttribute('aria-controls') || inputs[0].getAttribute('aria-owns')) !== link;
    });
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

  // 授权后输出旧版结构封套；分离语义/控件仅放本页注册表，不读取 input.value/checked。
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
      // ATSX 对侧端点仅用于保护，仍需独立扫描成自己的起止日期字段。
      if (compound) Object.values(compound.parts).filter((part) => !compound.atsx || part === el).forEach((part) => { used.add(part); if (part !== el) excluded.push({ category: 'compound_part', label: A.slot(part) || '国家区号', reason: '已归入“' + compound.label + '”复合字段' }); });
      else if (A.country(el) || A.slot(el)) { excluded.push({ category: 'compound_part', label: A.slot(el) || '国家区号', reason: '未找到明确主字段，请在网页手动操作；不创建独立简历字段' }); continue; }
      const rawType = (el.getAttribute('type') || 'text').toLowerCase();
      const members = ['radio', 'checkbox'].includes(rawType) && el.name ? found.filter((node) => node.name === el.name && node.getAttribute('type') === rawType && node.closest('form,fieldset,[role="group"]') === el.closest('form,fieldset,[role="group"]')) : [el];
      members.forEach((member) => used.add(member));
      const type = compound?.type || (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea'
        : el.getAttribute('role') === 'combobox' || A.dropdown(el) ? 'combobox' : el.isContentEditable ? 'contenteditable'
        : ['email','tel','number','url','date','month','datetime-local','radio','checkbox'].includes(rawType) ? rawType : 'text');
      let text = compound?.label || label(el);
      if (members.length > 1) text = M.redact(el.closest('fieldset,[role="group"],.form-item,.form-group')?.querySelector('legend,:scope > label,.label')?.textContent || text);
      const field = { scanId: id(el), label: text, name: M.redact(el.getAttribute('name')), type,
        placeholder: compound ? '' : M.redact(el.getAttribute('placeholder')), options: compound ? [] : options(el, members, type), ...context(el), ...(compound ? { layout: compound.layout } : {}) };
      if (!field.label || M.restricted(field) || /搜索|站内检索|订阅邮件/.test(field.label)) continue;
      field.semanticId = M.semanticId(field);
      fields.push(field); registry.set(field.scanId, { el, members, field, compound, semantic: M.semanticDescriptor(field), control: M.controlDescriptor(field) });
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

  // 主动读取单项按控件描述分派；编辑器保留块级换行，实际值不进入结构扫描封套。
  function readValue(item) {
    const control = item.control || M.controlDescriptor(item.field);
    if (item.compound) return A.read(item);
    if (global.LocalApplyATSX?.select(item.el)) return global.LocalApplyATSX.selectValue(item.el);
    if (A.dropdown(item.el)) return A.dropdownText(item.el);
    if (control.type === 'radio') return item.members.find((el) => el.checked)?.value || '';
    if (control.type === 'checkbox') return item.members.length === 1 ? item.el.checked : item.members.filter((el) => el.checked).map((el) => el.value);
    if (control.type === 'select' && item.el.multiple) return [...item.el.selectedOptions].map((option) => option.value);
    if (control.type === 'combobox' && !('value' in item.el)) return item.el.textContent.trim();
    return item.el.isContentEditable ? (global.WangshenFiller?.readText?.(item.el) ?? item.el.textContent) : item.el.value;
  }

  // 分别返回是否完成与是否占用：未确认的搜索文本仍占用记录，不能据此自动混入另一条经历。
  function completion() {
    if (!granted || currentUrl !== location.href) throw new Error('请先主动授权扫描当前招聘页面');
    return [...registry.values()].map((item) => {
      const value = readValue(item);
      let present = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== false && String(value).trim() !== '' && !/^(请选择|请选择一项|Select|Please select)$/i.test(String(value).trim());
      const occupied = present;
      if (item.compound?.kind === 'date') present = present && !A.plan(item, value).error;
      if (item.compound?.kind === 'address') present = present && A.accepted(item, value); // 半填地址不能隐藏为已完成。
      if (A.dropdown(item.el) && !item.compound) present = present && (!!A.dropdown(item.el).querySelector('[class*="sd-Input-display-value-"]')?.textContent.trim() || A.dropdownAccepted(item.el, value));
      // ARIA 搜索框的临时查询值不能令卡片隐藏待填项，必须有真正选中的结构证据。
      else if (item.control.type === 'combobox' && global.LocalApplyDropdownControls) present = present && global.LocalApplyDropdownControls.accepted(item.el, value);
      return { scanId: item.field.scanId, occupied, present: present && item.el.getAttribute('aria-invalid') !== 'true' && item.el.validity?.valid !== false };
    });
  }

  // 模块节点仅驻留本页；Moka 沿用原结构，语义分组只接受直接记录子项和明确的添加按钮。
  function recordStructures() {
    const blocks = [...document.querySelectorAll('[class^="apply-block-"],[class*=" apply-block-"],fieldset,[role="group"],.createFormSection-container > div')];
    return blocks.flatMap((block) => {
      if (!block.isConnected || !block.getClientRects().length || block.closest('[hidden],[inert],[aria-hidden="true"],fieldset[disabled],[id^="wsa-"]')) return [];
      const atsx = global.LocalApplyATSX?.records(block);
      if (atsx) return atsx.records.some((node) => !node.getClientRects().length || node.closest('[hidden],[inert],[aria-hidden="true"]') || getComputedStyle(node).visibility === 'hidden' || node.querySelector('.resumeEditForm-item')) ? [] : [atsx];
      const moka = block.matches('[class^="apply-block-"],[class*=" apply-block-"]');
      const heading = block.querySelector(moka ? ':scope > [class^="blockTitle-"]' : ':scope > legend,:scope > h2,:scope > h3,:scope > [role="heading"]');
      const title = (moka ? heading?.querySelector('[class^="text-"]')?.textContent : heading?.textContent || block.getAttribute('aria-label'))?.trim();
      const kind = global.WangshenTemplates.recordKind(title); if (!kind || kind === 'family') return [];
      // 通用上下文尚不能确定获奖/证书/论文的记录角色，保留单项扫描，不生成不一致的模块封套。
      if (!moka && !['education', 'internship', 'employment', 'project'].includes(kind)) return [];
      const records = [...block.children].filter((node) => node.matches(moka ? '[class^="apply-fields-"],[class*=" apply-fields-"]' : '[data-experience],.education-item,.work-item,.project-item'));
      // 隐藏记录可能已有资料；不能把它当成空槽，也不能因看不到它而继续自动添加。
      if (records.some((node) => !node.getClientRects().length || node.closest('[hidden],[inert],[aria-hidden="true"]') || getComputedStyle(node).visibility === 'hidden')) return [];
      const buttons = moka ? heading?.querySelectorAll('button[type="button"]') || [] : block.querySelectorAll(':scope > button[type="button"]');
      const names = new Set(['添加', '添加经历', '添加记录', '添加' + title]);
      const add = [...buttons].filter((node) => names.has(node.textContent.trim().replace(/^\+\s*/, '')) && !node.disabled && !node.closest('a,[role="link"]') && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      if (!records.length && !add.length || records.some((node) => node.querySelector('[data-experience],.education-item,.work-item,.project-item'))) return [];
      return [{ block, kind, records, add }];
    });
  }

  // 重复模块只投影已扫描的字段引用，不输出节点、按钮或个人字段值。
  function recordBlocks() {
    if (!granted || currentUrl !== location.href) throw new Error('请先主动扫描当前招聘页面');
    return recordStructures().flatMap(({ block, kind, records, add }) => {
      // 已有超多记录仍可扫描单项，只停止自动增补，不能让整页扫描报错。
      if (records.length > 20) return [];
      return [{ blockId: id(block), kind, canAdd: add.length === 1, records: records.map((node) => ({ recordId: id(node), scanIds: [...registry.values()].filter((item) => node.contains(item.el)).map((item) => item.field.scanId) })) }];
    });
  }

  // 只点唯一明确添加按钮，并验证原记录身份保留且恰好新增一条；不代点下一步或提交。
  async function addRecord(blockId, expectedDocument, { signal } = {}) {
    if(signal?.aborted)throw new Error('已取消添加记录');
    if (!granted || currentUrl !== location.href || documentId !== expectedDocument) throw new Error('页面已变化，请重新扫描');
    const structure = recordStructures().find(({ block }) => nodeIds.get(block) === blockId); const block = structure?.block;
    const group = recordBlocks().find((item) => item.blockId === blockId);
    if (!block || !group?.canAdd || group.records.length >= 20) throw new Error('该模块不能安全添加记录或已达到上限');
    const button = structure.add.length === 1 ? structure.add[0] : null;
    if (!button) throw new Error('添加按钮已变化，请重新扫描');
    button.click();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if(signal?.aborted)throw new Error('已取消添加记录');
      if (!granted || documentId!==expectedDocument || !block.isConnected || currentUrl !== location.href) throw new Error('添加时页面结构已变化，请重新扫描');
      const latest = recordStructures().find((item) => item.block === block); const count = latest?.records.length;
      if (!latest || structure.records.some((record) => !latest.records.includes(record))) break;
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
