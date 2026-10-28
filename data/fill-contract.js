// 填写意图与计划的最小契约：仅处理可信运行时数据，不读取存储、DOM 或模型输出。
(function (global) {
  'use strict';
  const VERSION = 1;
  const ADAPTER_IDS = Object.freeze(['text', 'textarea', 'contenteditable', 'select', 'radio', 'checkbox', 'date', 'phone']);
  const logicalTypes = { text: 'string', textarea: 'string', select: 'enum', number: 'number', boolean: 'boolean', date: 'date', multiSelect: 'string-array' };
  const bindingKeys = ['sessionId', 'tabId', 'documentId', 'scanId', 'semanticId'];
  const sourceKeys = ['profileId', 'fieldId', 'entryId', 'revision'];

  // 固定错误不含实际值、资料标识或外部异常正文。
  function check(ok, message = '填写契约格式错误') { if (!ok) throw new Error(message); }

  // 只接受白名单数据属性，拒绝脚本、额外键、数组及 getter/setter。
  function shape(value, keys) {
    check(value && Object.prototype.toString.call(value) === '[object Object]');
    check(Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
  }

  // 保留旧库可用的字符串 ID，不因新契约擅自重命名历史字段。
  function reference(value) { check(typeof value === 'string' && value.trim().length > 0 && value.length <= 500); }

  // 旧定义仅投影逻辑类型及编辑提示，不改变持久化 type 或枚举原文。
  function projectDefinition(definition) {
    check(definition && Object.hasOwn(logicalTypes, definition.type), '字段逻辑类型不支持');
    return { storageType: definition.type, logicalType: logicalTypes[definition.type], editorHint: definition.type };
  }

  // 仅校验既有资料的 JSON 类型和规模，绝不按控件猜值、补日期或裁剪枚举。
  function validateValue(value, logicalType) {
    if (logicalType === 'number') check(typeof value === 'number' && Number.isFinite(value));
    else if (logicalType === 'boolean') check(typeof value === 'boolean');
    else if (logicalType === 'string-array') check(Array.isArray(value) && value.length > 0 && value.length <= 200
      && value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500));
    else {
      check(typeof value === 'string' && value.trim().length > 0 && value.length <= 100000);
      if (logicalType === 'date') {
        check(/^\d{4}(-\d{2})?(-\d{2})?$/.test(value));
        if (value.length >= 7) check(+value.slice(5, 7) >= 1 && +value.slice(5, 7) <= 12);
        if (value.length === 10) check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
      }
    }
  }

  // 意图绑定后台会话、来源和资料版本；expected 只用于调用方的可信上下文比对，不构成授权。
  function validateIntent(intent, expected = {}) {
    shape(intent, ['version', 'intentId', 'binding', 'source', 'valueType', 'value']);
    check(intent.version === VERSION); reference(intent.intentId); check(/^intent\.[\w.-]+$/.test(intent.intentId));
    shape(intent.binding, bindingKeys); shape(intent.source, sourceKeys);
    for (const key of ['sessionId', 'documentId', 'scanId', 'semanticId']) reference(intent.binding[key]);
    check(Number.isInteger(intent.binding.tabId) && intent.binding.tabId >= 0);
    check(/^scan\.[\w.-]{1,100}$/.test(intent.binding.scanId) && /^semantic\.[a-f0-9]{16}$/.test(intent.binding.semanticId));
    for (const key of ['profileId', 'fieldId']) reference(intent.source[key]);
    if (intent.source.entryId !== null) reference(intent.source.entryId);
    check(Number.isInteger(intent.source.revision) && intent.source.revision >= 0);
    shape(intent.valueType, ['storageType', 'logicalType', 'editorHint']);
    const projected = projectDefinition({ type: intent.valueType.storageType });
    check(Object.keys(projected).every((key) => projected[key] === intent.valueType[key])); validateValue(intent.value, projected.logicalType);
    for (const section of ['binding', 'source']) if (expected[section]) {
      shape(expected[section], section === 'binding' ? bindingKeys : sourceKeys);
      check(Object.keys(expected[section]).every((key) => expected[section][key] === intent[section][key]), '填写来源或文档已变化');
    }
    if (Object.hasOwn(expected, 'value')) check(JSON.stringify(expected.value) === JSON.stringify(intent.value), '填写值与后台意图不一致');
    return intent;
  }

  // 只能从当前规范库中取真实来源；调用方必须先通过会话/URL/revision 检查。
  function createIntent(db, profileId, target, field, binding) {
    global.FieldMatchingEngine.validateField(field); shape(target, ['fieldId', 'entryId']);
    check(db.activeProfileId === profileId && db.profiles.some((row) => row.profileId === profileId), '填写档案已变化');
    const entryId = target.entryId ?? null;
    check(entryId === null || db.entries.some((row) => row.entryId === entryId && row.profileId === profileId), '填写来源不属于当前档案');
    const definition = db.fieldDefinitions.find((row) => row.fieldId === target.fieldId);
    const row = db.fieldValues.find((row) => row.profileId === profileId && row.fieldId === target.fieldId && row.entryId === entryId);
    check(definition && row && global.FieldMatchingEngine.hasValue(row.value), '填写来源缺少实际资料');
    const intent = { version: VERSION, intentId: 'intent.' + crypto.randomUUID(), binding: { ...binding, scanId: field.scanId, semanticId: field.semanticId },
      source: { profileId, fieldId: target.fieldId, entryId, revision: db.revision }, valueType: projectDefinition(definition), value: JSON.parse(JSON.stringify(row.value)) };
    return validateIntent(intent);
  }

  // 计划只有固定操作及验证类型；它不是脚本，执行还必须持有本页私有句柄并重新核对节点。
  function validatePlan(plan, intent) {
    validateIntent(intent); shape(plan, ['version', 'planId', 'intentId', 'binding', 'source', 'controlFingerprint', 'operation', 'verification', 'state', 'targetOption', 'targetOptions', 'checked', 'datePrecision', 'targetPrecision', 'targetParts', 'adapterId']);
    check(plan.version === VERSION && typeof plan.planId === 'string' && /^plan\.[\w.-]+$/.test(plan.planId) && plan.intentId === intent.intentId);
    shape(plan.binding, bindingKeys); shape(plan.source, sourceKeys);
    check(bindingKeys.every((key) => plan.binding[key] === intent.binding[key]) && sourceKeys.every((key) => plan.source[key] === intent.source[key]), '填写来源或文档已变化');
    check(typeof plan.controlFingerprint === 'string' && /^control\.v1\.[a-f0-9]{16}$/.test(plan.controlFingerprint));
    const pairs = { 'write-value': 'value', 'select-option': 'selected-option', 'select-options': 'selected-options', 'set-checked': 'checked-state', 'fill-date': 'date-parts', 'fill-phone': 'phone-parts', 'verify-existing': 'legacy-delayed', 'legacy-interaction': 'legacy-delayed' };
    check(Object.hasOwn(pairs, plan.operation) && plan.verification === pairs[plan.operation]);
    check(plan.state === (['legacy-interaction', 'fill-date', 'fill-phone'].includes(plan.operation) ? 'delegated' : 'ready'));
    // 每种注册能力只能使用其固定操作，选择控件不能冒用文本或旧委托路径。
    if (Object.hasOwn(plan, 'adapterId')) {
      const operations = { text: ['write-value'], textarea: ['write-value'], contenteditable: ['write-value'], select: ['select-option', 'select-options'], radio: ['select-option'], checkbox: ['set-checked', 'select-options'], date: ['fill-date'], phone: ['fill-phone'] };
      check(ADAPTER_IDS.includes(plan.adapterId) && [...operations[plan.adapterId], 'verify-existing'].includes(plan.operation));
    } else check(!['select-options', 'set-checked', 'fill-date', 'fill-phone'].includes(plan.operation));
    // 单项和多项选项共享严格形状，句柄/编码不允许夹带可执行属性。
    function validateOption(option) {
      shape(option, ['handle', 'label', 'value']); reference(option.handle);
      check(/^option\.[\w.-]+$/.test(option.handle));
      for (const key of ['label', 'value']) check(typeof option[key] === 'string' && option[key].length <= 100000);
    }
    if (plan.operation === 'select-option') {
      validateOption(plan.targetOption);
    } else check(!Object.hasOwn(plan, 'targetOption'));
    if (plan.operation === 'select-options') {
      check(Array.isArray(intent.value) && Array.isArray(plan.targetOptions) && plan.targetOptions.length > 0 && plan.targetOptions.length <= 200);
      plan.targetOptions.forEach(validateOption);
      check(new Set(plan.targetOptions.map((option) => option.handle)).size === plan.targetOptions.length
        && new Set(plan.targetOptions.map((option) => option.value)).size === plan.targetOptions.length);
    } else check(!Object.hasOwn(plan, 'targetOptions'));
    if (plan.operation === 'set-checked') check(typeof plan.checked === 'boolean' && plan.checked === intent.value && intent.valueType.logicalType === 'boolean');
    else check(!Object.hasOwn(plan, 'checked'));
    if (Object.hasOwn(plan, 'datePrecision')) check(['year', 'month', 'day'].includes(plan.datePrecision));
    // 子项只接受固定角色和本页随机句柄；来源精度由日期准备器校验，纯契约不依赖 DOM 模块。
    if (['date', 'phone'].includes(plan.adapterId)) {
      check(Array.isArray(plan.targetParts) && plan.targetParts.length > 0 && plan.targetParts.length <= 3);
      for (const part of plan.targetParts) { shape(part, ['key', 'handle']); check(typeof part.handle === 'string' && /^part\.[\w.-]+$/.test(part.handle)); }
      const keys = plan.targetParts.map((part) => part.key).join(',');
      check(new Set(plan.targetParts.map((part) => part.handle)).size === plan.targetParts.length);
      check(typeof intent.value === 'string');
      if (plan.adapterId === 'phone') check(keys === 'country,number' && !Object.hasOwn(plan, 'datePrecision') && !Object.hasOwn(plan, 'targetPrecision'));
      else {
        check(['value', 'year,month', 'year,month,day'].includes(keys));
        check(['year', 'month', 'day'].includes(plan.datePrecision));
        check(['year', 'month', 'day', 'minute', 'unknown'].includes(plan.targetPrecision));
      }
    } else check(!Object.hasOwn(plan, 'targetParts') && !Object.hasOwn(plan, 'targetPrecision'));
    return plan;
  }

  global.LocalApplyFillContract = { VERSION, ADAPTER_IDS, projectDefinition, createIntent, validateIntent, validatePlan };
})(globalThis);
