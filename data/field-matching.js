// 阶段三纯函数：脱敏元数据、稳定语义指纹、本地字段及重复经历匹配。
(function (global) {
  'use strict';
  const kinds = Object.keys(global.WangshenTemplates.RECORD_GROUPS);
  const types = ['text', 'textarea', 'number', 'email', 'tel', 'url', 'date', 'month', 'datetime-local', 'select', 'radio', 'checkbox', 'combobox', 'contenteditable'];
  const layouts = ['date:year-month', 'date:year-month-day', 'phone:country-number', 'address:province-city-district'];

  // 只处理短元数据，不接受 HTML、地址、Key、邮箱、手机号或长数字作为模型上下文。
  function redact(value, max = 80) {
    return String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ')
      .replace(/(?:https?:\/\/|data:|javascript:|blob:)\S+/gi, '[已脱敏]')
      .replace(/(?:Bearer\s+\S+|sk-[\w-]+)/gi, '[已脱敏]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[已脱敏]')
      .replace(/\+?\d[\d\s()-]{7,}\d/g, '[已脱敏]').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // 指纹不包含输入值、DOM id、URL 查询或简历文本，重绘后仍可按语义比较。
  function features(field) {
    return { label: redact(field.label), type: types.includes(field.type) ? field.type : 'text', group: redact(field.group),
      kind: kinds.includes(field.kind) ? field.kind : '', degree: ['first', 'undergrad', 'master', 'doctor', 'highest'].includes(field.degree) ? field.degree : '',
      index: Number.isInteger(field.index) && field.index >= 0 ? Math.min(field.index, 100) : 0, ...(field.layout ? { layout: field.layout } : {}) };
  }

  // 双种子散列只用作索引；命中后仍逐属性比较，不能只相信散列相同。
  function semanticId(field) {
    const text = JSON.stringify(features(field)); let a = 2166136261; let b = 3339675911;
    for (const char of text) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b ^ char.charCodeAt(0), 2246822519); }
    return 'semantic.' + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }

  // 仅允许经过白名单和脱敏的扫描元数据跨消息边界，绝不接受 value/html 属性。
  function validateField(field) {
    const allowed = ['scanId', 'semanticId', 'label', 'name', 'type', 'placeholder', 'options', 'group', 'kind', 'degree', 'index', 'layout'];
    if (!field || Object.keys(field).some((key) => !allowed.includes(key)) || typeof field.scanId !== 'string'
      || !/^scan\.[\w.-]{1,100}$/.test(field.scanId) || !types.includes(field.type)) throw new Error('扫描字段格式错误');
    for (const key of ['label', 'name', 'placeholder', 'group']) {
      if (typeof field[key] !== 'string' || field[key] !== redact(field[key])) throw new Error('扫描元数据未脱敏或超限');
    }
    if (field.layout !== undefined && !layouts.includes(field.layout)) throw new Error('扫描复合结构格式错误');
    if (field.semanticId !== semanticId(field) || JSON.stringify(features(field)) !== JSON.stringify({ label: field.label, type: field.type, group: field.group, kind: field.kind, degree: field.degree, index: field.index, ...(field.layout ? { layout: field.layout } : {}) })) throw new Error('扫描语义指纹错误');
    if (!Array.isArray(field.options) || field.options.length > 100 || field.options.some((option) => !option || Object.keys(option).sort().join() !== 'text,value'
      || typeof option.text !== 'string' || typeof option.value !== 'string' || option.text !== redact(option.text) || option.value !== redact(option.value))) throw new Error('扫描选项格式错误');
    return field;
  }

  // 家庭、联系人、同意条款及认证字段不使用申请人资料自动匹配。
  function restricted(field) { return /密码|验证码|captcha|password|otp|同意|协议|授权|隐私政策/i.test(field.label + ' ' + field.group); }

  // 已有来源记录即用户档案资料；空值与 false/0 必须明确区分。
  function hasValue(value) { return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0); }

  // 读取指定字段的本地来源，不在匹配时更改资料或模型置信度。
  function valueOf(db, profileId, target) {
    return db.fieldValues.find((row) => row.profileId === profileId && row.fieldId === target.fieldId && row.entryId === (target.entryId || null));
  }

  // 匹配同站、同档案、同语义规则；禁用记录完全不参与，未验证编辑只能成为待确认建议。
  function memory(db, profileId, origin, field) {
    const expected = JSON.stringify(features(field));
    const rules = db.mappingRules.filter((rule) => rule.enabled !== false && rule.origin === origin && rule.profileId === profileId
      && rule.semanticId === field.semanticId && JSON.stringify(features(rule.features || {})) === expected);
    if (!rules.length) return null;
    const targets = new Set(rules.map((rule) => JSON.stringify([rule.fieldId, rule.entryId])));
    if (targets.size !== 1) return { target: null, reason: '历史规则冲突，请手动选择', confirmed: false };
    const rule = rules.find((item) => item.confirmed && item.lastVerifiedAt) || rules[0];
    return { target: { fieldId: rule.fieldId, entryId: rule.entryId }, confirmed: !!(rule.confirmed && rule.lastVerifiedAt), reason: rule.confirmed ? '用户确认且已验证的网站记忆' : '规则已编辑，需要重新确认及验证' };
  }

  // 仅从当前档案的学历枚举判断层级；目录首段使用平面值，不读取其他档案或从院校名猜测。
  function degreeOf(db, entry) {
    const row = db.fieldValues.find((value) => value.profileId === entry.profileId && value.entryId === entry.entryId && /\.(degree|education|educationLevel)$/.test(value.fieldId));
    const text = String(row?.value || '');
    return /博士/.test(text) ? 4 : /硕士|研究生/.test(text) ? 3 : /本科|学士/.test(text) ? 2 : /大专|专科/.test(text) ? 1 : 0;
  }

  // 根据明确学历/经历语义缩小来源；只有唯一来源才可匹配，不默认拿最高学历覆盖第一学历。
  function targetsFor(db, profileId, field, fieldId) {
    let entries = db.entries.filter((entry) => entry.profileId === profileId && (!field.kind || entry.kind === field.kind));
    const definedGroup = db.fieldDefinitions.find((definition) => definition.fieldId === fieldId)?.group;
    const definedKind = global.WangshenTemplates.recordKind(definedGroup);
    const repeated = field.kind || (field.degree ? 'education' : '') || definedKind || '';
    if (!repeated) return [{ fieldId, entryId: null }];
    entries = entries.filter((entry) => entry.kind === repeated);
    // 目录首段保存在模块基础字段，与附加记录一起参与语义筛选；多个来源不确定时仍交用户选择。
    const primary = db.fieldValues.find((row) => row.profileId === profileId && row.fieldId === fieldId && row.entryId === null);
    // 仅有空白模板时返回明确的缺资料项；有独立经历时不凭空插入一条空白来源制造歧义。
    const bound = db.bindings.some((row) => row.profileId === profileId && row.fieldId === fieldId);
    if (definedKind === repeated && (hasValue(primary?.value) || !entries.length && bound)) entries.push({ profileId, entryId: null, kind: repeated });
    if (['first', 'undergrad'].includes(field.degree)) entries = entries.filter((entry) => degreeOf(db, entry) === 2);
    if (field.degree === 'master') entries = entries.filter((entry) => degreeOf(db, entry) === 3);
    if (field.degree === 'doctor') entries = entries.filter((entry) => degreeOf(db, entry) === 4);
    if (field.degree === 'highest') { const rank = Math.max(0, ...entries.map((entry) => degreeOf(db, entry))); entries = rank ? entries.filter((entry) => degreeOf(db, entry) === rank) : []; }
    return entries.map((entry) => ({ fieldId, entryId: entry.entryId }));
  }

  // 词典精确命中优先，上下文仅做有界显式规则；相似度不够时留给 AI 或人工。
  function definitionFor(db, field) {
    const normalize = global.WangshenTemplates.normalizeLabel;
    const norm = normalize(field.label);
    const exact = db.fieldDefinitions.filter((def) => [def.label, ...def.aliases].some((alias) => normalize(alias) === norm));
    const group = global.WangshenTemplates.RECORD_GROUPS[field.kind];
    const contextual = group ? exact.filter((definition) => global.WangshenTemplates.recordKind(definition.group) === field.kind) : [];
    if (contextual.length === 1) return { definition: contextual[0], reason: '字段及经历模块精确匹配' };
    if (exact.length === 1) return { definition: exact[0], reason: '标准字段或别名精确匹配' };
    // 只映射页面中含义明确的同义标题；薪资周期、最近公司等含义不明项不猜。
    const aliases = { education: { '学校名称': 'school', '专业名称': 'major' }, employment: { '工作职责': 'employmentResponsibilities' }, internship: { '工作职责': 'internshipDescription' }, project: { '职责': 'projectRole', '项目描述': 'projectDescription' } };
    const language = /英语能力|语言能力/.test(field.group) ? ({ '掌握程度': 'englishProficiency', '听说': 'englishListening', '读写': 'englishReading' })[norm] : '';
    const alias = aliases[field.kind]?.[field.label] || language || ({ '出生日期年龄': 'birthDate', '自我描述': 'selfIntroduction', '所在地': 'currentCity' })[norm];
    if (alias) { const definition = db.fieldDefinitions.find((def) => def.fieldId === 'builtin.' + alias); if (definition) return { definition, reason: '明确字段别名与模块匹配' }; }
    let key = '';
    if (/院校|学校/.test(field.label) && (field.kind === 'education' || field.degree)) key = 'school';
    else if (/专业/.test(field.label) && field.kind === 'education') key = 'major';
    else if (/学历|学位/.test(field.label) && field.kind === 'education') key = 'degree';
    else if (/公司|单位/.test(field.label) && ['internship', 'employment'].includes(field.kind)) key = 'company';
    else if (/项目名称/.test(field.label) && field.kind === 'project') key = 'title';
    else { const match = global.WangshenTemplates.matchLabel(field.label); if (match?.score >= 0.95) key = match.key; }
    const definition = db.fieldDefinitions.find((def) => def.fieldId === 'builtin.' + key) || db.fieldDefinitions.find((def) => def.fieldId === 'resume.' + key);
    return definition && key ? { definition, reason: '标准词典与明确上下文匹配' } : null;
  }

  // 生成完整状态列表；匹配仅计算建议，任何网页写入仍需要后续用户确认。
  function match(db, profileId, origin, fields) {
    return fields.map((field) => {
      validateField(field);
      const base = { field, target: null, candidates: [], status: 'needs_confirmation', reason: '未知字段，请手动选择或主动使用 AI', source: 'unknown' };
      if (restricted(field)) return { ...base, status: 'unsupported', reason: '认证或同意条款不自动处理' };
      if (/家庭|紧急|联系人|家属/.test(field.group + field.label)) return { ...base, reason: '联系人与申请人语义不同，请人工选择' };
      const saved = memory(db, profileId, origin, field);
      if (saved) return { ...base, ...saved, status: saved.target && saved.confirmed ? hasValue(valueOf(db, profileId, saved.target)?.value) ? 'matched' : 'missing_value' : 'needs_confirmation', source: 'memory' };
      const found = definitionFor(db, field);
      if (!found) return base;
      const candidates = targetsFor(db, profileId, field, found.definition.fieldId);
      if (candidates.length !== 1) return { ...base, candidates, reason: candidates.length ? '存在多段经历，请明确选择来源' : '缺少符合该学历或经历语义的资料', source: 'context' };
      const target = candidates[0];
      const privateSuggestion = !db.publicFieldIds.includes(found.definition.fieldId);
      const languageChoice = /语言能力/.test(field.group) && !/英语/.test(field.label);
      return { ...base, target, candidates, source: privateSuggestion || languageChoice ? 'definition-suggestion' : 'local',
        reason: languageChoice ? '网页语种未明确，请先选择对应语种的本地来源；不将英语水平套用到其他语言' : privateSuggestion ? '私有字段的通用语义建议，请确认当前网站含义' : found.reason,
        status: hasValue(valueOf(db, profileId, target)?.value) ? privateSuggestion || languageChoice ? 'needs_confirmation' : 'matched' : 'missing_value' };
    });
  }

  global.FieldMappingMemory = { find: memory };
  global.FieldMatchingEngine = { redact, features, semanticId, validateField, restricted, hasValue, valueOf, match, degreeOf, definitionFor };
})(globalThis);
