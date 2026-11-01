// 飞书配置的纯解析与受控语义表；只处理公共元数据，不接触个人值或持久化库。
(function (global) {
  'use strict';
  const LIMIT = 2 * 1024 * 1024;
  const kinds = { education_list: 'education', career_list: 'employment', internship_list: 'internship', project_list: 'project', award_list: 'award' };
  const mappings = {
    basic_info: { name: 'name', mobile: 'phone', email: 'email', gender: 'gender', nationality: 'nationality', current_city: 'currentCity', birthday: 'birthDate', marital_status: 'maritalStatus', current_home_address: 'homeAddress' },
    education_list: { school: 'school', degree: 'degree', field_of_study: 'major', start_end_time: ['educationStartDate', 'graduationDate'] },
    career_list: { company: 'employmentCompany', title: 'employmentPosition', start_end_time: ['employmentStartDate', 'employmentEndDate'], desc: 'employmentDescription' },
    internship_list: { company: 'internshipCompany', title: 'internshipPosition', start_end_time: ['internshipStartDate', 'internshipEndDate'], desc: 'internshipDescription' },
    project_list: { name: 'projectName', role: 'projectRole', start_end_time: ['projectStartDate', 'projectEndDate'], link: 'projectLink', desc: 'projectDescription' },
    award_list: { name: 'awardName', date: 'awardDate', desc: 'awardDescription' },
    self_evaluation: { self_evaluation: 'selfIntroduction' }
  };
  const states = ['linked', 'custom', 'hidden', 'ambiguous', 'control_conflict', 'unsupported'];

  // 精确限定飞书企业申请路由；不把职位详情、相似后缀或任意 iframe 当作申请页。
  function pageScope(input) {
    try {
      const url = new URL(input); const route = /^\/(?:([a-z][a-z0-9_-]{0,40})\/)?resume\/\d+\/apply\/?$/.exec(url.pathname);
      return url.protocol === 'https:' && !url.port && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jobs\.feishu\.cn$/.test(url.hostname) && route
        ? { origin: url.origin, pathname: url.pathname, path: route[1] || 'index' } : null;
    } catch { return null; }
  }

  // 双种子散列仅作本页失效标记，不能充当可信来源、持久化规则或填写授权。
  function fingerprint(text) {
    let a = 2166136261; let b = 3339675911;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }

  // 固定错误码不附带配置正文、企业名称或任意异常消息。
  function check(ok, code = 'invalid_structure') { if (!ok) { const error = new Error(code); error.code = code; throw error; } }

  // 只保留有界配置文本；拒绝控制字符、HTML 和非字符串，不执行页面内容。
  function text(value, empty = false, max = 200) {
    check(typeof value === 'string' && (empty || value.trim()) && value.length <= max && !/[\u0000-\u001f<>]/.test(value)); return value.trim();
  }

  // ID 只用于企业/配置作用域，不用于构造 DOM 选择器。
  function identifier(value) { check(typeof value === 'string' && /^[\w-]{1,128}$/.test(value)); return value; }

  // 缺失代码允许保留为企业自定义候选，不能推导出公共语义。
  function code(value) { check(value === undefined || typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value)); return value || ''; }

  // 防止超深或过大 JSON；遍历计数包含无关属性，但不把它们留在投影中。
  function bounded(root) {
    const queue = [[root, 0]]; let count = 0;
    while (queue.length) {
      const [value, depth] = queue.pop(); check(++count <= 60000 && depth <= 24, 'size_limit');
      if (value && typeof value === 'object') for (const key of Object.keys(value)) { check(!['__proto__', 'constructor', 'prototype'].includes(key)); queue.push([value[key], depth + 1]); }
    }
  }

  // 提取显示/必填等元数据，active_status 原样保留，绝不猜测其启用语义。
  function attributes(raw) {
    check(raw && typeof raw === 'object' && !Array.isArray(raw));
    const name = {};
    for (const locale of ['zh_cn', 'en_us']) if (raw.name?.[locale] !== undefined) name[locale] = text(raw.name[locale], true);
    const out = { label: text(name.zh_cn || name.en_us), name, code: code(raw.field_type?.name), type: text(raw.field_type?.type, false, 40) };
    for (const key of ['visible', 'required', 'repeatable', 'is_predefined', 'is_customized']) { check(raw[key] === undefined || typeof raw[key] === 'boolean'); out[key] = raw[key] ?? false; }
    for (const key of ['active_status', 'order']) { check(raw[key] === undefined || Number.isSafeInteger(raw[key])); out[key] = raw[key] ?? null; }
    return out;
  }

  // v2/v5 共用层级解析；只返回白名单投影，详细和简化配置的必填冲突仅作诊断。
  function normalizeFeishuSchema(raw, page) {
    bounded(raw); const website = raw?.website_info; const schema = website?.resume_form_schema;
    check(raw?.tenant_info && /^[a-f0-9]{32}$/i.test(raw.tenant_info.tenant_id_md5));
    const tenantId = raw.tenant_info.tenant_id_md5.toLowerCase(); const websiteId = identifier(website?.id); const path = text(website?.path, true, 64);
    check(/^[a-z0-9_-]*$/.test(path)); check(!page || path === page.path, 'scope_mismatch');
    check(schema && [2, 5].includes(schema.version), 'unsupported_version'); const schemaId = identifier(schema.id);
    check(Array.isArray(schema.scenario_list) && schema.scenario_list.length <= 30 && schema.scenario_list.every(Number.isSafeInteger));
    check(Array.isArray(schema.object_list) && schema.object_list.length <= 100);
    const groups = []; const fields = []; const ids = new Set();
    // 递归只接收显式 group→children 关系，父级不可见会传递到所有后代。
    function visit(nodes, parent = null, ancestorsVisible = true, depth = 0) {
      check(depth <= 8 && Array.isArray(nodes));
      for (const node of nodes) {
        check(node && typeof node === 'object'); const id = identifier(node.id); check(!ids.has(id)); ids.add(id);
        const meta = attributes(node.attributes); const effectiveVisible = ancestorsVisible && meta.visible;
        if (meta.type === 'group') {
          check(!parent || node.attributes.parent === parent.id);
          check(groups.length < 100); const group = { id, ...meta, parent: parent?.id || null, effectiveVisible };
          groups.push(group); check(Array.isArray(node.children)); visit(node.children, group, effectiveVisible, depth + 1);
        } else {
          check(parent && fields.length < 1000 && node.attributes.parent === parent.id && (node.children === undefined || Array.isArray(node.children) && node.children.length === 0));
          const settings = node.attributes.field_type.settings || {}; check(typeof settings === 'object' && !Array.isArray(settings));
          const options = settings.options || []; check(Array.isArray(options) && options.length <= 200);
          const normalizedOptions = options.map((option) => {
            check(option && (typeof option.value === 'string' || Number.isFinite(option.value)) && String(option.value).length <= 200);
            check(option.active_status === undefined || Number.isSafeInteger(option.active_status));
            return { label: text(option.name?.zh_cn || option.name?.en_us), value: option.value, active_status: option.active_status ?? null };
          });
          check(settings.date_precision === undefined || Number.isSafeInteger(settings.date_precision));
          fields.push({ id, parent: parent.id, groupCode: parent.code, ...meta, effectiveVisible, options: normalizedOptions, datePrecision: settings.date_precision ?? null });
        }
      }
    }
    visit(schema.object_list);
    const config = website.resume_form_config || []; check(Array.isArray(config) && config.length <= 100);
    const configAliases = { education: 'education_list', career: 'career_list', internship: 'internship_list', project: 'project_list', award: 'award_list', basic: 'basic_info', attachment_resume: 'attachment_resume_list', works: 'works_list', language: 'language_list', sns: 'sns_list' };
    const fieldAliases = { major: 'field_of_study', time_period: 'start_end_time' };
    const requiredConflicts = [];
    for (const entry of config) {
      check(entry && typeof entry.name === 'string' && Array.isArray(entry.fields) && entry.fields.length <= 200);
      const groupCode = configAliases[entry.name] || entry.name;
      for (const child of entry.fields) {
        check(child && typeof child.name === 'string' && typeof child.required === 'boolean');
        const fieldCode = fieldAliases[child.name] || child.name;
        const field = fields.find((row) => row.groupCode === groupCode && row.code === fieldCode);
        const key = groupCode + '.' + fieldCode;
        if (field && field.required !== child.required && !requiredConflicts.includes(key)) requiredConflicts.push(key);
      }
    }
    return { tenantId, websiteId, path, schemaId, version: schema.version, scenarios: [...schema.scenario_list], groups, fields, requiredConflicts };
  }

  // 只解析有界 JSON；调用方仅获得固定失败码，不回显原文或异常正文。
  function parse(textContent, page) {
    if (typeof textContent !== 'string' || !textContent.trim()) return { status: 'empty_schema', schema: null };
    if (textContent.length > LIMIT) return { status: 'size_limit', schema: null };
    let raw; try { raw = JSON.parse(textContent); } catch { return { status: 'invalid_json', schema: null }; }
    try { return { status: 'ready', schema: normalizeFeishuSchema(raw, page) }; }
    catch (error) { return { status: ['invalid_structure', 'unsupported_version', 'scope_mismatch', 'size_limit'].includes(error.code) ? error.code : 'invalid_structure', schema: null }; }
  }

  // 代码只能选取受控已有定义；日期范围必须由真实 DOM 明确提供端点角色。
  function target(groupCode, fieldCode, part = 'value') {
    const value = Object.hasOwn(mappings, groupCode) && Object.hasOwn(mappings[groupCode], fieldCode) ? mappings[groupCode][fieldCode] : null;
    const key = Array.isArray(value) ? part === 'start' ? value[0] : part === 'end' ? value[1] : null : part === 'value' ? value : null;
    return key ? 'builtin.' + key : null;
  }

  // 扫描边界只容许匿名作用域与短代码，不接收配置正文、DOM 句柄或任意目标 fieldId。
  function validateEvidence(evidence) {
    check(evidence && Object.keys(evidence).sort().join() === 'fieldCode,groupCode,key,part,scope,state,version');
    check(evidence.version === 1 && /^fs\.[a-f0-9]{16}$/.test(evidence.scope) && /^fs\.[a-f0-9]{16}$/.test(evidence.key));
    code(evidence.groupCode || undefined); code(evidence.fieldCode || undefined);
    check(typeof evidence.groupCode === 'string' && typeof evidence.fieldCode === 'string' && states.includes(evidence.state) && ['value', 'start', 'end'].includes(evidence.part));
    return evidence;
  }

  // 诊断只投影固定状态与数量；配置 ID、标签、选项和个人值都不能进入日志。
  function diagnostic(value) {
    const statuses = ['ready', 'missing_schema', 'empty_schema', 'invalid_script', 'invalid_json', 'size_limit', 'invalid_structure', 'unsupported_version', 'scope_mismatch'];
    if (!value || !statuses.includes(value.status)) return null;
    const out = { status: value.status };
    for (const key of ['version', 'groups', 'fields', 'visible', 'requiredConflicts', 'associated', 'custom', 'hidden', 'ambiguous', 'unsupported', 'control_conflict', 'unassociated']) {
      if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 1000) return null;
      out[key] = value[key];
    }
    return out;
  }

  global.LocalApplyFeishuSchema = { LIMIT, kinds, pageScope, fingerprint, normalizeFeishuSchema, parse, target, validateEvidence, diagnostic };
})(globalThis);
