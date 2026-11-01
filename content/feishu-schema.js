// 飞书 Schema 的只读 DOM 桥接：不读取表单值，不点击控件，不访问页面私有状态。
(function (global) {
  'use strict';
  if (global.LocalApplyFeishuSchemaBridge) return;
  const S = global.LocalApplyFeishuSchema;
  let cache = null; let epoch = 0;
  const roots = new WeakMap(); let rootSequence = 0;

  // 结构身份仅驻留本页，用于区分重复经历与相同标签；绝不写回页面属性。
  function identity(node) { if (!roots.has(node)) roots.set(node, ++rootSequence); return roots.get(node); }

  // 仅比较元数据标签，去掉可见必填星号，不从说明或表单值提取语义。
  function label(value) { return global.WangshenTemplates.normalizeLabel(String(value || '').replace(/[*＊]\s*$/, '').trim()); }

  // 中英文标签来自同一字段定义，不能用翻译、模糊相似或别组名称扩展关联范围。
  function sameLabel(meta, value) { return [meta.label, ...Object.values(meta.name || {})].some((name) => name && label(name) === label(value)); }

  // 配置读取只发生在主动扫描中；缓存只有白名单投影及散列，没有整份原始 JSON。
  function readCurrentPageSchema() {
    const page = S.pageScope(location.href);
    if (!page || global.top !== global.self) { cache = null; return { stamp: 'not_applicable', status: 'not_applicable', schema: null }; }
    const nodes = [...document.querySelectorAll('script#js-websiteInfo')]; const node = nodes.length === 1 ? nodes[0] : null;
    const raw = node?.getAttribute('type') === 'text/json' ? node.textContent : '';
    const signature = JSON.stringify([page.origin, page.pathname, node ? identity(node) : null, nodes.length, node?.getAttribute('type'), raw.length <= S.LIMIT ? S.fingerprint(raw) : 'oversize']);
    if (cache?.signature === signature) return cache.result;
    let parsed;
    if (!nodes.length) parsed = { status: 'missing_schema', schema: null };
    else if (!node || node.getAttribute('type') !== 'text/json') parsed = { status: 'invalid_script', schema: null };
    else parsed = S.parse(raw, page);
    const stamp = 'fs.' + S.fingerprint(signature + ':' + ++epoch);
    const schema = parsed.schema;
    const scope = schema ? 'fs.' + S.fingerprint(JSON.stringify([page.origin, page.pathname, schema.tenantId, schema.websiteId, schema.path, schema.schemaId, schema.version, stamp])) : null;
    const result = { ...parsed, stamp, scope };
    cache = { signature, result }; return result;
  }

  // 只接受明确模块标题和记录外壳；缺少结构时回退旧扫描，不按字段顺序猜关联。
  function owner(el) {
    const atsx = global.LocalApplyATSX?.section(el);
    if (atsx) return { block: atsx, group: atsx.querySelector(':scope > .createFormSection-left .createFormSection-text')?.textContent,
      record: el.closest('.resumeEditForm-item') };
    const block = el.closest('fieldset,.form-section');
    if (!block) return null;
    return { block, group: block.querySelector(':scope > legend,:scope > h2,:scope > h3,:scope > [role="heading"]')?.textContent || block.getAttribute('aria-label'),
      record: el.closest('[data-experience],.education-item,.work-item,.project-item') };
  }

  // 日期端点只能来自已识别的 ATSX 双端点或明确无障碍标签，不能从遍历次序推断。
  function datePart(item) {
    const range = global.LocalApplyATSX?.range(item.el);
    if (range) return range.index === 0 ? 'start' : 'end';
    const role = label(item.el.getAttribute('aria-label'));
    return /^(开始日期|开始时间|起始日期|起始时间)$/.test(role) ? 'start' : /^(结束日期|结束时间|截止日期|截止时间)$/.test(role) ? 'end' : 'value';
  }

  // Schema 类型只校验兼容性；实际适配器完全由当前 DOM 决定，选项仅取 DOM 的唯一可用候选。
  function compatible(meta, item, part) {
    const type = item.field.type;
    if (meta.type === 'date_range') return part !== 'value' && ['date', 'month', 'text', 'combobox'].includes(type);
    if (meta.type === 'date_select') return ['date', 'month', 'text', 'combobox'].includes(type);
    if (meta.type === 'select') return ['select', 'radio', 'combobox'].includes(type);
    if (meta.type === 'multi_select') return type === 'checkbox' || type === 'select' && item.el.multiple;
    if (meta.type === 'number') return ['number', 'text'].includes(type);
    if (meta.type === 'long_text') return ['textarea', 'contenteditable', 'text'].includes(type);
    return ['text', 'link'].includes(meta.type) && ['text', 'email', 'tel', 'url', 'textarea', 'contenteditable', 'combobox', 'select'].includes(type);
  }

  // 关联必须在同模块、同一条真实记录和唯一字段标签内成立，重复同名控件一律待确认。
  function associate(current, items) {
    const schema = current.schema; const counts = { associated: 0, custom: 0, hidden: 0, ambiguous: 0, unsupported: 0, control_conflict: 0, unassociated: items.length };
    if (!schema) return { status: current.status, version: 0, groups: 0, fields: 0, visible: 0, requiredConflicts: 0, ...counts };
    const pending = [];
    for (const item of items) {
      const info = owner(item.el); if (!info?.group) continue;
      const groups = schema.groups.filter((group) => sameLabel(group, info.group));
      if (!groups.length) continue;
      const rawLabel = global.LocalApplyATSX?.label(item.el) || item.field.label;
      const candidates = schema.fields.filter((field) => groups.some((group) => group.id === field.parent) && sameLabel(field, rawLabel));
      if (!candidates.length) continue;
      const meta = candidates[0]; const group = groups.find((row) => row.id === meta.parent); const part = meta.type === 'date_range' ? datePart(item) : 'value';
      let state = groups.length !== 1 || candidates.length !== 1 ? 'ambiguous' : !meta.effectiveVisible ? 'hidden'
        : !meta.is_predefined || !group.is_predefined || !meta.code || !group.code ? 'custom'
        : !compatible(meta, item, part) ? 'control_conflict' : !S.target(group.code, meta.code, part) ? 'unsupported' : 'linked';
      if (group.repeatable && (!info.record || !info.block.contains(info.record))) state = 'ambiguous';
      const unique = [identity(info.block), identity(info.record || info.block), meta.id, part].join(':');
      pending.push({ item, unique, evidence: { version: 1, scope: current.scope, key: 'fs.' + S.fingerprint(current.scope + ':' + group.id + ':' + meta.id),
        groupCode: group.code, fieldCode: meta.code, part, state } });
    }
    for (const row of pending) {
      if (pending.filter((other) => other.unique === row.unique).length !== 1) row.evidence.state = 'ambiguous';
      row.item.field.feishu = row.evidence;
      counts[row.evidence.state === 'linked' ? 'associated' : row.evidence.state]++;
    }
    counts.unassociated = items.length - pending.length;
    return { status: current.status, version: schema.version, groups: schema.groups.length, fields: schema.fields.length,
      visible: schema.fields.filter((field) => field.effectiveVisible).length, requiredConflicts: schema.requiredConflicts.length, ...counts };
  }

  // Schema 只能收紧已有添加入口：隐藏/非重复/歧义模块不自动新增，缺配置沿用旧能力。
  function canAdd(block, kind, current) {
    if (!current?.schema) return true;
    const info = owner(block); if (!info?.group) return true;
    const groups = current.schema.groups.filter((group) => sameLabel(group, info.group));
    if (!groups.length) return true;
    return groups.length === 1 && groups[0].effectiveVisible && groups[0].repeatable && groups[0].is_predefined && S.kinds[groups[0].code] === kind;
  }

  // 移除/替换/修改 script 使旧证据失效；监听器不扫描、不读取输入、不发起联网或填写。
  const observer = new MutationObserver((changes) => {
    if (!cache) return;
    if (changes.some((change) => change.target.nodeType === 3 && change.target.parentElement?.id === 'js-websiteInfo'
      || change.target.id === 'js-websiteInfo'
      || [...change.addedNodes, ...change.removedNodes].some((node) => node.nodeType === 1 && (node.id === 'js-websiteInfo' || node.querySelector?.('script#js-websiteInfo'))))) cache = null;
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['type', 'id'] });
  global.LocalApplyFeishuSchemaBridge = { readCurrentPageSchema, associate, canAdd };
})(globalThis);
