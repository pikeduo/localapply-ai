// 复合控件适配只依赖本地 DOM；节点引用和网页值始终留在已授权页面内。
(function (global) {
  'use strict';
  const containers = '.form-item,.form-group,.field,.el-form-item,.ant-form-item,[role="group"],.date-control,.phone-control,[class^="apply-field-"],[class*=" apply-field-"]';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const selections = new WeakMap();
  const popups = new WeakMap();
  const traces = new WeakMap();

  // 单次填写轨迹只含控件状态和数量；复合控件优先返回失败子项，节点和候选内容不离开本页。
  function diagnostic(item, reset = false) {
    const parts = Object.entries(item.compound?.parts || { control: item.el }); let last = null;
    for (const [part, el] of parts) { const trace = traces.get(el); if (reset) traces.delete(el); else if (trace) { const current = { ...trace, ...(part !== 'control' ? { part } : {}) }; if (trace.reasonCode !== 'option_selected') return current; last = current; } }
    return last;
  }

  // 只枚举明确的列表/日历弹层；用于将一次主动打开中新出现的唯一弹层绑定回输入框。
  function popupRoots() { return [...document.querySelectorAll('[role="listbox"],[role="dialog"],[class*="sd-Dropdown-popup-"],[class*="sd-Dropdown-overlay-"],[class*="sd-picker-panel-"],.rc-picker-dropdown,.ant-picker-dropdown')].filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'); }

  // portal 没有 aria-controls 时也须有本次打开的证据；多个新弹层或焦点已离开时拒绝猜归属。
  function popupFor(el, before) {
    const linked = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (linked) return el.getRootNode().getElementById?.(linked) || null;
    const cached = popups.get(el); if (cached?.isConnected && cached.getClientRects().length) return cached;
    if (!before || !(document.activeElement === el || dropdown(el)?.contains(document.activeElement))) return null;
    const opened = popupRoots().filter((node) => !before.has(node));
    const roots = opened.filter((node) => !opened.some((other) => other !== node && other.contains(node)));
    if (roots.length === 1) { popups.set(el, roots[0]); return roots[0]; }
    return null;
  }

  // 只识别上传页面使用的 Moka 下拉容器，不将普通带装饰的文本框升级为下拉。
  function dropdown(el) { return el.matches?.('input') ? el.closest('[class^="sd-Select-container-"],[class*=" sd-Select-container-"]') : null; }

  // Moka 有时将已选文本放在独立显示节点，搜索输入为空不能据此判定未选择。
  function dropdownText(el) { return dropdown(el)?.querySelector('[class^="sd-Input-display-value-"]')?.textContent.trim() || el.value || ''; }

  // 候选必须属于该输入的显式弹层或同一个下拉容器，禁止到全页任意点击相似文字。
  function dropdownOptions(el) {
    const owner = dropdown(el); if (!owner) return [];
    const root = popupFor(el) || owner.closest('[class^="sd-Dropdown-container-"],[class*=" sd-Dropdown-container-"]');
    return [...(root?.querySelectorAll('[role="option"],[class*="option-" i],[class*="menu-item-" i]') || [])].filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
      && node.getAttribute('aria-disabled') !== 'true' && !node.matches('button,input,a,[role="button"]') && !node.closest('button,a') && !node.querySelector('button,input,a,[role="button"],[role="option"],[class*="option-" i]'));
  }

  // 精确点选才登记本次选择证据；仅输入文字即使暂时显示相同也不能算填写成功。
  async function fillDropdown(el, value, unit = '') {
    const started = Date.now(); const desired = String(value); const before = new Set(popupRoots()); const searchable = !el.readOnly && !dropdown(el).classList.contains('select');
    const trace = { adapter: 'moka-dropdown', phase: 'open', candidateCount: 0, matchCount: 0, searchable, popupRelation: 'none', associatedPopup: false };
    selections.delete(el); popups.delete(el); el.focus(); el.click();
    if (searchable) {
      // 搜索时保持弹层焦点，不能复用会立即 blur 的普通文本填写路径。
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, desired);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(60);
      const popup = popupFor(el, before); const visible = popupRoots(); const candidates = dropdownOptions(el);
      const found = candidates.filter((node) => node.textContent.trim() === desired || node.getAttribute('data-value') === desired || unit && new RegExp('^\\d+' + unit + '?$').test(node.textContent.trim()) && Number(node.textContent.trim().replace(unit, '')) === Number(desired));
      Object.assign(trace, { phase: 'options', popupRelation: popup ? el.getAttribute('aria-controls') || el.getAttribute('aria-owns') ? 'aria' : 'portal' : candidates.length ? 'local' : 'none', associatedPopup: !!popup || candidates.length > 0, candidateCount: candidates.length, matchCount: found.length, popupCount: visible.length, newPopupCount: visible.filter((node) => !before.has(node)).length, focused: document.activeElement === el || dropdown(el).contains(document.activeElement), elapsedMs: Date.now() - started });
      if (found.length > 1) break;
      if (found.length === 1) {
        const text = found[0].textContent.trim(); found[0].click(); el.blur();
        traces.set(el, { ...trace, phase: 'select', reasonCode: 'option_selected' });
        selections.set(el, { expected: desired, text }); return { ok: true };
      }
    }
    const reasonCode = trace.matchCount > 1 ? 'ambiguous_option' : !trace.focused && !trace.associatedPopup ? 'focus_lost' : !trace.associatedPopup ? 'popup_not_found' : !trace.candidateCount ? 'options_not_found' : 'no_exact_option';
    traces.set(el, { ...trace, phase: trace.associatedPopup ? 'options' : 'open', reasonCode });
    el.blur(); return { ok: false, status: 'unsupported', reason: '下拉未出现属于此字段的唯一精确选项，请在网页选择' };
  }

  // 回读必须同时命中显示值和精确选择证据，受控组件清空或回退不会计为成功。
  function dropdownAccepted(el, value) {
    const selected = selections.get(el); const desired = String(value);
    return !!selected && selected.expected === desired && [desired, selected.text].includes(dropdownText(el));
  }

  // 单个子控件的显式提示优先于父字段标签，避免把“月”或国码当成独立语义。
  function slot(el) {
    const text = (el.getAttribute('data-part') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
    if (/^(年|年份|yyyy|year)$/i.test(text)) return 'year';
    if (/^(月|月份|mm|month)$/i.test(text)) return 'month';
    if (/^(日|日期中的日|dd|day)$/i.test(text)) return 'day';
    if (/^(省|省份|province)$/i.test(text)) return 'province';
    if (/^(市|city)$/i.test(text)) return 'city';
    if (/^(区|县|区县|district)$/i.test(text)) return 'district';
    const name = el.getAttribute('name') || '';
    return /(?:^|[_.\[-])(year|month|day)(?:\]|$)/i.exec(name)?.[1]?.toLowerCase() || '';
  }

  // 国家区号只能由明确标签或全部为国码的选项识别，不能把普通国家/地区字段混入电话。
  function country(el) {
    const hint = [el.getAttribute('aria-label'), el.getAttribute('name')].join(' ');
    if (/区号|country.?code|dial.?code|^\s*\+\d{1,4}\s*$/i.test(hint)) return true;
    if (dropdown(el) && el.closest('[class^="code-"]') && el.closest('[class^="apply-field-"]')) return true;
    const rows = el.tagName === 'SELECT' ? [...el.options].filter((option) => option.getAttribute('value') !== '') : [];
    return rows.length > 0 && rows.every((option) => /\+\d{1,4}/.test(option.textContent) && !/手机|电话/.test(option.textContent));
  }

  // 网站操作、安全及导航只返回固定原因，不读取账号、密码、验证码或控件实际值。
  function exclusion(el, label) {
    // new_password 是该站普通文本框的防补全提示，不等同标准密码控件。
    const autocomplete = el.getAttribute('autocomplete');
    const hint = [el.getAttribute('type'), autocomplete === 'new_password' ? '' : autocomplete, el.getAttribute('name'), el.getAttribute('id'), label].join(' ');
    if (/password|captcha|one-time-code|验证码|密码|csrf|token|cc-number|cc-csc|信用卡|支付卡|登录账号|登录帐号/i.test(hint)) return { category: 'security_control', reason: '安全或登录控件，禁止采集和填写' };
    const popup = el.closest('[role="dialog"],.calendar,.ant-picker-panel,.el-picker-panel');
    const owner = popup?.id ? el.getRootNode().querySelector('[aria-controls="' + CSS.escape(popup.id) + '"][aria-haspopup="dialog"]') : null;
    if (owner && (owner.readOnly || ['date','month'].includes(owner.type))) return { category: 'compound_part', reason: '绑定弹层的内部候选控件，不单独创建资料字段' };
    if (/同步.*(?:在线)?简历|更新在线简历|我已阅读|同意|协议|隐私政策|确认已阅读|复制简历内容/.test(label)) return { category: 'site_action', reason: '网站行为或协议选项，由用户自行操作' };
    if (label === '至今' && el.closest('.month-range-select')) return { category: 'compound_part', reason: '日期范围的至今开关，请在网页手动选择' };
    if (el.matches('button,input[type="button"],input[type="submit"],input[type="reset"]') && el.getAttribute('role') !== 'combobox') return { category: 'navigation_control', reason: '导航或提交按钮，不作为资料字段' };
    if (/搜索|站内检索|订阅邮件/.test(label) || el.getAttribute('type') === 'search') return { category: 'site_action', reason: '搜索或订阅控件，不属于本次申请资料' };
    return null;
  }

  // 只在局部同一语义容器中合并；不跨整个表单或多段经历拼接日期/电话。
  function groups(nodes, labelOf) {
    const result = new Map(); const handled = new Set();
    // 已知年月范围按页面明确的“年/月、年/月”顺序拆为两项，绝不混合不同记录。
    const ranges = new Set(nodes.map((el) => el.closest('.month-range-select')).filter(Boolean));
    for (const container of ranges) {
      const peers = nodes.filter((node) => container.contains(node) && slot(node));
      const sequence = peers.map(slot).join(',');
      if (!['year,month', 'year,month,year,month'].includes(sequence)) continue;
      for (let index = 0; index < peers.length; index += 2) {
        const parts = { year: peers[index], month: peers[index + 1] };
        const group = { kind: 'date', parts, anchor: parts.year, label: peers.length === 2 ? labelOf(parts.year) : index === 0 ? '开始日期' : '结束日期', type: 'month', layout: 'date:year-month' };
        Object.values(parts).forEach((node) => { result.set(node, group); handled.add(node); });
      }
    }
    for (const el of nodes) {
      if (handled.has(el) || (!slot(el) && !country(el))) continue;
      const container = el.closest(containers) || el.parentElement;
      if (!container || container.matches('form,body,html')) continue;
      const peers = nodes.filter((node) => container.contains(node) && (node.closest(containers) || node.parentElement) === container);
      if (peers.length > 8) continue;
      const heading = global.FieldMatchingEngine.redact(container.querySelector(':scope > label,:scope > .label,:scope > legend,:scope > .el-form-item__label,:scope > .ant-form-item-label,:scope > [class^="title-"]')?.textContent || container.getAttribute('aria-label') || '');
      const parts = {};
      for (const node of peers) { const key = slot(node); if (key) { if (parts[key]) parts.ambiguous = true; parts[key] = node; } }
      let group = null;
      if (!parts.ambiguous && parts.year && parts.month && /日期|时间|年月|出生|生日|入学|毕业|起始|开始|结束/.test(heading)) {
        group = { kind: 'date', parts: { year: parts.year, month: parts.month, ...(parts.day ? { day: parts.day } : {}) }, label: heading, type: parts.day ? 'date' : 'month' };
      } else if (!parts.ambiguous && parts.province && parts.city && parts.district && /地址|所在地|居住|地区/.test(heading)) {
        group = { kind: 'address', parts: { province: parts.province, city: parts.city, district: parts.district }, label: heading, type: 'text' };
      } else if (country(el)) {
        const phones = peers.filter((node) => node !== el && node.matches('input') && !slot(node) && !country(node) && /手机|电话|phone|mobile|tel/i.test([labelOf(node), node.type, node.name].join(' ')));
        if (phones.length === 1 && peers.filter(country).length === 1) group = { kind: 'phone', parts: { country: el, number: phones[0] }, label: labelOf(phones[0]) || heading, type: 'tel' };
      }
      if (group) {
        group.anchor = group.parts.number || group.parts.year || group.parts.province;
        group.layout = group.kind + ':' + Object.keys(group.parts).join('-');
        Object.values(group.parts).forEach((node) => { result.set(node, group); handled.add(node); });
      }
    }
    return result;
  }

  // 严格解析精度、闰年与时间；绝不自动补日、补当前年月或猜测美国日期顺序。
  function dateValue(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})(?:[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?月?)?(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
    if (!match) return null;
    const [, y, m, d, h, minute] = match; const year = +y; const month = m ? +m : null; const day = d ? +d : null;
    if (year < 1900 || year > 2200 || (month !== null && (month < 1 || month > 12)) || (day !== null && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())) || (h && (!day || +h > 23 || +minute > 59))) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return { year, month, day, time: h ? h + ':' + minute : null, precision: day ? 'day' : month ? 'month' : 'year', iso: y + (month ? '-' + pad(month) : '') + (day ? '-' + pad(day) : '') };
  }

  // 精确选项比较同时允许数字标签（02 / 2月），不使用子串匹配任意候选。
  function optionFor(el, value, unit = '') {
    const desired = String(value);
    const rows = [...(el.options || [])].filter((option) => !option.disabled && (option.value === desired || option.textContent.trim() === desired || (unit && Number(option.textContent.trim().replace(new RegExp(unit + '$'), '')) === Number(value) && option.value !== '')));
    return rows.length === 1 ? rows[0] : null;
  }

  // 拆分国际号码时必须命中国码候选；无国码只接受明确的国内 11 位号码，不猜国际区号。
  function phoneValue(group, value) {
    const text = String(value).replace(/[\s()-]/g, '').replace(/^00/, '+');
    const codes = [...group.parts.country.options || []].map((option) => /\+\d{1,4}/.exec(option.textContent)?.[0] || (/^\+\d{1,4}$/.test(option.value) ? option.value : '')).filter(Boolean);
    // 自定义国码只复用网页已明确选择的区号，未知或不同区号交用户选择，禁止猜测。
    if (dropdown(group.parts.country)) { const current = dropdownText(group.parts.country); if (/^\+\d{1,4}$/.test(current)) codes.push(current); }
    let code = ''; let number = text;
    if (text.startsWith('+')) { code = [...new Set(codes)].sort((a, b) => b.length - a.length).find((item) => text.startsWith(item)) || ''; number = text.slice(code.length); }
    else if (/^1[3-9]\d{9}$/.test(text) && codes.includes('+86')) code = '+86';
    if (!code || !/^\d{5,15}$/.test(number) || (code === '+86' && !/^1[3-9]\d{9}$/.test(number))) return null;
    if (dropdown(group.parts.country)) return code === dropdownText(group.parts.country) ? { country: code, number } : null;
    const candidates = [...group.parts.country.options || []].filter((option) => !option.disabled && (option.value === code || /\+\d{1,4}/.exec(option.textContent)?.[0] === code));
    return candidates.length === 1 ? { country: candidates[0].value, number } : null;
  }

  // 生成写入计划，保留每个子控件的期望值；错误计划没有任何写入副作用。
  function plan(item, value) {
    const { el, compound } = item;
    const error = (reason, status = 'needs_confirmation') => ({ error: { ok: false, status, reason } });
    if (compound?.kind === 'phone') { const phone = phoneValue(compound, value); return phone ? { parts: phone } : error('号码缺少明确国码、格式不符或页面没有该区号，请手动确认'); }
    if (compound?.kind === 'address') { const parts = typeof value === 'string' ? value.split(/\s*[/／>]\s*/) : []; return parts.length === 3 && parts.every(Boolean) ? { parts: Object.fromEntries(Object.keys(compound.parts).map((key, index) => [key, parts[index]])) } : error('分级地址需要明确的“省 / 市 / 区”，不能从自由文本猜测'); }
    const date = dateValue(value);
    if (!date) return error('日期无效或格式不明确，请核对年月日');
    if (compound?.kind === 'date') {
      if (!date.month || (compound.parts.day && !date.day)) return error('日期精度不足，不能无依据补充月或日');
      return { parts: { year: String(date.year), month: String(date.month), ...(compound.parts.day ? { day: String(date.day) } : {}) } };
    }
    const type = el.getAttribute('type'); let desired = date.iso;
    if (type === 'date' && !date.day || type === 'month' && !date.month || type === 'datetime-local' && (!date.day || !date.time)) return error('日期精度不足，不能自动补日或时间');
    if (type === 'month') desired = desired.slice(0, 7);
    if (type === 'datetime-local') desired += 'T' + date.time;
    if (el.min && desired < el.min || el.max && desired > el.max) return error('日期超出网页允许范围，请核对', 'failed');
    if (!['date','month','datetime-local'].includes(type)) {
      const hint = el.getAttribute('placeholder') || '';
      if (/DD/i.test(hint) && !date.day) return error('日期精度不足，网页需要具体日');
      if (/YYYY[-/.]MM/i.test(hint) && !/DD/i.test(hint)) { if (!date.month) return error('年月精度不足，请补充月份'); desired = desired.slice(0, 7); }
      if (/YYYY\/MM/i.test(hint)) desired = desired.replaceAll('-', '/');
      else if (/YYYY\.MM/i.test(hint)) desired = desired.replaceAll('-', '.');
    }
    return { value: desired, date };
  }

  // 判断日期语义只用控件类型/格式提示；普通描述中的日期字样不触发自动改写。
  function handles(item) { return !!item.compound || ['date','month','datetime-local'].includes(item.el.type) || /YYYY[-/.]MM/i.test(item.el.getAttribute('placeholder') || '') || (item.el.readOnly && (item.el.getAttribute('aria-haspopup') === 'dialog' || item.el.closest('[class*="day_info-"]')) && /日期|时间|出生|生日/.test(item.field.label)); }

  // 比较复合控件中已填写的每个子项；只补空白，已有不同年月/号码必须走单项差异确认。
  function hasConflict(item, value) {
    const next = plan(item, value); if (next.error || !item.compound) return false;
    // 电话只有默认国码且号码为空时仍是空字段；保留原有国际号码填写能力。
    if (item.compound.kind === 'phone' && !item.compound.parts.number.value) return false;
    return Object.entries(item.compound.parts).some(([key, el]) => {
      const current = dropdown(el) ? dropdownText(el) : el.value;
      if (!current) return false;
      if (item.compound.kind === 'date') return Number(String(current).replace(/[年月日]$/, '')) !== Number(next.parts[key]);
      return String(current) !== next.parts[key];
    });
  }

  // 读取复合字段时仅访问当前授权项的成员，不把默认国码单独当成用户填写内容。
  function read(item) {
    if (!item.compound) return item.el.isContentEditable ? item.el.textContent : item.el.value;
    const parts = item.compound.parts; const values = Object.fromEntries(Object.entries(parts).map(([key, el]) => {
      const raw = dropdown(el) ? dropdownText(el) : el.value;
      const selected = el.selectedOptions?.[0]?.textContent.trim(); const numeric = /^(\d+)[年月日]?$/.exec(selected || raw || '');
      return [key, !raw ? '' : item.compound.kind === 'address' ? selected || raw : item.compound.kind === 'date' && numeric ? numeric[1] : raw];
    }));
    if (item.compound.kind === 'phone') return values.number ? (parts.country.selectedOptions?.[0]?.textContent.match(/\+\d{1,4}/)?.[0] || values.country) + values.number : '';
    if (!Object.values(values).some(Boolean)) return '';
    return item.compound.kind === 'date' ? [values.year, values.month?.padStart(2, '0'), ...(parts.day ? [values.day?.padStart(2, '0')] : [])].join('-') : Object.values(values).join(' / ');
  }

  // 复读所有成员及网页原生校验状态，框架回退任一部分都不能记成功。
  function accepted(item, value) {
    const next = plan(item, value); if (next.error) return false;
    if (!item.compound) return item.el.value === next.value;
    return Object.entries(item.compound.parts).every(([key, el]) => el.isConnected && el.getAttribute('aria-invalid') !== 'true' && el.validity?.valid !== false && (el.tagName === 'SELECT' ? optionFor(el, next.parts[key], { year: '年', month: '月', day: '日' }[key])?.value === el.value : dropdown(el) ? dropdownAccepted(el, next.parts[key]) || dropdownText(el) === next.parts[key] : el.value === next.parts[key]));
  }

  // 子控件通过原生 setter 和事件进入框架；先校验全部静态选项，避免半填日期。
  async function setPart(el, value, key) {
    if (dropdown(el)) {
      if (dropdownText(el) === String(value)) return true;
      return (await fillDropdown(el, value, { year: '年', month: '月', day: '日' }[key] || '')).ok;
    }
    if (el.tagName === 'SELECT') {
      const option = optionFor(el, value, { year: '年', month: '月', day: '日' }[key]);
      if (!option) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new FocusEvent('blur', { bubbles: true })); return true;
    }
    if (el.readOnly) return false;
    // 复合子项只走原 setter/事件，不触发普通文本的全局自动补全选项探测。
    global.WangshenFiller.setValue(el, String(value)); return el.value === String(value);
  }

  // 日历仅点击绑定弹层内有完整日期的唯一候选；不猜“上一月/下一月”或任意网页按钮。
  async function calendar(item, next) {
    const el = item.el;
    if (!next.date.day) return { ok: false, status: 'needs_confirmation', reason: '网页日历需要完整日期，本地只有年或年月；请补充日期，不自动补日' };
    const before = new Set(popupRoots()); popups.delete(el); el.focus(); el.click();
    let popup; for (let attempt = 0; attempt < 15 && !popup; attempt++) { await sleep(60); popup = popupFor(el, before); }
    if (!popup || !popup.matches('[role="dialog"],.calendar,.ant-picker-panel,.el-picker-panel,[class*="sd-picker-panel-"],.rc-picker-dropdown,.ant-picker-dropdown')) return { ok: false, status: 'unsupported', reason: '日历未出现唯一关联弹层，请在网页手选' };
    // 有明确年/月选择器时按目标值选择，避免跨年依赖次数猜测或无限翻月。
    for (const [key, value] of [['year', next.date.year], ['month', next.date.month]]) {
      const selectors = [...popup.querySelectorAll('select')].filter((node) => slot(node) === key);
      if (selectors.length === 1 && !await setPart(selectors[0], String(value), key)) return { ok: false, status: 'unsupported', reason: '日历年/月选择器没有目标选项，请手动选择' };
      if (selectors.length) await sleep(50);
    }
    const candidates = [...popup.querySelectorAll('[data-date],[aria-label],[title]')].filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length && [node.getAttribute('data-date'), node.getAttribute('aria-label'), node.getAttribute('title')].some((text) => dateValue(text)?.iso === next.date.iso));
    if (candidates.length !== 1 || !candidates[0].matches('button,[role="gridcell"],[role="option"],td') || candidates[0].matches('button') && candidates[0].type !== 'button' || candidates[0].closest('a')) return { ok: false, status: 'unsupported', reason: '日历中没有唯一可选的目标日期，未尝试猜测跨月按钮' };
    candidates[0].click(); return { ok: true };
  }

  // 复合写入与原有填写器共用事件路径；级联地址逐级等待候选加载，等待有界。
  async function fill(item, value) {
    const next = plan(item, value); if (next.error) return next.error;
    if (!item.compound) return item.el.readOnly ? calendar(item, next) : global.WangshenFiller.fillElement(item.el, next.value, { inputType: item.el.type });
    const entries = Object.entries(item.compound.parts);
    if (item.compound.kind !== 'address' && entries.some(([key, el]) => el.tagName === 'SELECT' && !optionFor(el, next.parts[key], { year: '年', month: '月', day: '日' }[key]))) return { ok: false, status: 'failed', reason: '复合控件缺少精确选项，未填写任何子控件' };
    for (const [key, el] of entries) {
      if (item.compound.kind === 'address') { for (let attempt = 0; attempt < 10 && !optionFor(el, next.parts[key]); attempt++) await sleep(50); }
      if (!await setPart(el, next.parts[key], key)) return { ok: false, status: 'unsupported', reason: '复合控件选项未加载、只读或需要手动选择' };
    }
    return { ok: true };
  }
  global.LocalApplyFieldAdapters = { slot, country, exclusion, groups, dateValue, handles, plan, read, accepted, fill, hasConflict, dropdown, dropdownText, dropdownOptions, fillDropdown, dropdownAccepted, diagnostic };
})(globalThis);
