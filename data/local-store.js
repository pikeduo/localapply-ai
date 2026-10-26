// 本地数据层：公共元数据与个人值隔离；仅后台实例可写，旧 UI 使用兼容投影。
(function (global) {
  'use strict';
  const DB_KEY = 'localapply.database';
  const API_KEY = 'localapply.apiSettings';
  const RECOVERY_KEY = 'localapply.recovery';
  const LEGACY_KEY = 'wangshenAutofill';
  const VAULT_KEY = 'localapply.keyVault';
  const DEVICE_KEY = 'localapply.deviceKeys';
  const CATALOG_KEY = 'localapply.fieldCatalog'; // 独立升级标记，用户删掉字段后不再自动补回。
  const SCHEMA_VERSION = 3;
  const TYPES = ['text', 'textarea', 'select', 'number', 'boolean', 'date', 'multiSelect'];
  const KINDS = ['education', 'internship', 'employment', 'project'];
  const API_FIELDS = ['provider', 'model', 'visionModel', 'customBase', 'apiKeys', 'customProviders', 'providerModels'];
  const DEF_KEYS = ['fieldId', 'label', 'type', 'group', 'aliases', 'options', 'description', 'version'];
  const TABLES = ['fieldDefinitions', 'profiles', 'fieldValues', 'entries', 'bindings', 'mappingRules'];

  // 深拷贝仅接受 JSON 数据；拒绝文件对象、原型污染及未经声明的属性。
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  // 比较 JSON 数据，undefined 仅用于差异计算中的缺失值。
  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
    if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
    return false;
  }
  // 创建不包含档案标识的全局 ID。
  function id(prefix) { return prefix + '.' + global.crypto.randomUUID(); }
  // 旧备份需稳定 ID 才能重复合并；此散列仅作标识，不用于加密或安全认证。
  function legacyFieldId(profileId, fid) {
    const input = JSON.stringify([profileId, fid]);
    const parts = [2166136261, 2246822519, 3266489917, 668265263].map((seed) => {
      let hash = seed;
      for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
      return (hash >>> 0).toString(16).padStart(8, '0');
    });
    return 'legacy.' + parts.join('');
  }
  // 文件指纹、档案和经历序号共同决定 ID，重复导入不会跨档案串数据。
  function resumeEntryId(profileId, fingerprint, kind, index) { return legacyFieldId(profileId, fingerprint + ':' + kind + ':' + index); }
  // 统一生成 UTC 时间。
  function now() { return new Date().toISOString(); }
  // 对不符合 Schema 的输入抛出可读错误，不输出原始个人数据。
  function check(ok, message) { if (!ok) throw new Error(message); }
  // 校验普通 JSON 对象，避免 Blob/File 等隐式序列化。
  function object(value) { return !!value && Object.prototype.toString.call(value) === '[object Object]'; }
  // 只允许显式键名，阻止备份夹带简历原文件或秘密属性。
  function keys(value, allowed, name) {
    check(object(value), name + ' 必须是对象');
    check(Object.keys(value).every((key) => allowed.includes(key)), name + ' 包含未声明属性');
  }
  // 限制字符串大小；元数据不承担任意二进制或原文存储职责。
  function string(value, name, max = 500, empty = false) {
    check(typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= max, name + ' 格式错误');
    check(!/^(data:|blob:)/i.test(value), name + ' 不允许文件数据 URL');
  }
  // 校验数组和规模，防止异常导入耗尽内存。
  function list(value, name, max = 10000) { check(Array.isArray(value) && value.length <= max, name + ' 数量或格式错误'); }
  // 校验字段定义白名单，不允许携带 value/profileId/source 等个人属性。
  function definition(value) {
    keys(value, DEF_KEYS, '字段定义');
    for (const key of ['fieldId', 'label', 'group']) string(value[key], key);
    check(TYPES.includes(value.type), '未知字段类型');
    check(Number.isInteger(value.version) && value.version > 0, '字段版本错误');
    string(value.description, 'description', 2000, true);
    for (const key of ['aliases', 'options']) {
      list(value[key], key, key === 'options' ? 500 : 200); // 专业分类包含 238 个真实静态选项，不截断。
      value[key].forEach((item) => string(item, key));
    }
    return clone(value);
  }
  // 构造字段定义，默认属性只来自元数据，不复制用户值。
  function makeDefinition(input) {
    keys(input, DEF_KEYS, '字段定义输入');
    return definition({ fieldId: input.fieldId || id('custom'), label: input.label, type: input.type || 'text',
      group: input.group || '其他', aliases: input.aliases || [], options: input.options || [],
      description: input.description || '', version: input.version || 1 });
  }
  // 根据类型校验个人值，保留 false/0；无预置选项的多选允许手动添加，封闭多选仍严格限制候选。
  function validValue(value, def) {
    if (value === null || value === '') return;
    if (def.type === 'number') check(typeof value === 'number' && Number.isFinite(value), '字段需要数字');
    else if (def.type === 'boolean') check(typeof value === 'boolean', '字段需要布尔值');
    else if (def.type === 'multiSelect') {
      list(value, '多选值', 200);
      value.forEach((item) => { string(item, '多选值'); check(!def.options.length || def.options.includes(item), '多选值不在选项内'); });
    } else {
      string(value, '字段值', 100000, true);
      if (def.type === 'date') {
        check(/^\d{4}(-\d{2})?(-\d{2})?$/.test(value), '日期格式错误');
        if (value.length >= 7) check(Number(value.slice(5, 7)) >= 1 && Number(value.slice(5, 7)) <= 12, '月份错误');
        if (value.length === 10) check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, '日期不存在');
      }
      // 原项目允许 select 保存自定义文字，保留这一兼容行为。
    }
  }
  // 从指定模板取得公共元数据，默认包含参考页结构，不复制个人值或界面专用属性。
  function builtins(template = global.WangshenTemplates.PROFILE_TEMPLATE) {
    return template.map((field) => makeDefinition({
      fieldId: 'builtin.' + field.key, label: field.label, type: field.inputType, group: field.group,
      aliases: (field.patterns || []).filter((alias) => !alias.startsWith('re:')), options: field.options || [],
    }));
  }
  // 一次性补齐参考目录：仅升级未改动的旧标准定义，新增空白绑定，保留旧值及用户已删的旧字段。
  function upgradeFieldCatalog(db) {
    const old = new Map(builtins(global.WangshenTemplates.SOE_LONG_TEMPLATE).map((def) => [def.fieldId, def]));
    for (const field of global.WangshenTemplates.PROFILE_TEMPLATE) {
      const next = builtins([field])[0];
      const index = db.fieldDefinitions.findIndex((def) => def.fieldId === next.fieldId);
      if (index < 0) { db.fieldDefinitions.push(next); db.publicFieldIds.push(next.fieldId); }
      else if (equal(db.fieldDefinitions[index], old.get(next.fieldId)) && !equal(next, db.fieldDefinitions[index])) {
        db.fieldDefinitions[index] = { ...next, version: db.fieldDefinitions[index].version + 1 };
      }
      // 原有 51 字段若被手动移除则继续尊重；只将本次新目录字段添加到已有简历。
      if (old.has(next.fieldId) || !db.publicFieldIds.includes(next.fieldId)) continue;
      for (const profile of db.profiles) {
        if (!db.bindings.some((binding) => binding.profileId === profile.profileId && binding.fieldId === next.fieldId)) {
          db.bindings.push({ profileId: profile.profileId, fieldId: next.fieldId, fid: id('field'), key: field.key,
            sensitive: !!field.sensitive, autoFill: false, material: false, custom: false });
        }
        if (!db.fieldValues.some((row) => row.profileId === profile.profileId && row.fieldId === next.fieldId && row.entryId === null)) {
          db.fieldValues.push({ profileId: profile.profileId, fieldId: next.fieldId, entryId: null, value: null, updatedAt: now(), source: 'catalog' });
        }
      }
    }
    return validate(db);
  }
  // 建立空数据库，API 设置不进入此对象。
  function emptyDatabase() {
    const defs = builtins();
    return { schemaVersion: SCHEMA_VERSION, revision: 0, fieldDefinitions: defs, publicFieldIds: defs.map((d) => d.fieldId),
      profiles: [], fieldValues: [], entries: [], bindings: [], mappingRules: [], activeProfileId: '',
      settings: { autoThreshold: 0.85, privacyMask: true, autoFloatbar: true }, ledger: [], drafts: {}, onboardingDone: false };
  }
  // 校验非敏感设置，不能夹带 API Key。
  function settings(value) {
    keys(value, ['autoThreshold', 'privacyMask', 'autoFloatbar'], '填充设置');
    check(typeof value.autoThreshold === 'number' && value.autoThreshold >= 0.5 && value.autoThreshold <= 1, '阈值错误');
    check(typeof value.privacyMask === 'boolean' && typeof value.autoFloatbar === 'boolean', '设置格式错误');
  }
  // API 配置独立保存；自定义协议为可选字段，兼容旧配置且不进入个人资料备份。
  function apiSettings(value) {
    keys(value, API_FIELDS, 'API 设置');
    for (const key of ['provider', 'model', 'visionModel', 'customBase']) string(value[key] || '', key, 2000, true);
    check(object(value.apiKeys), 'apiKeys 格式错误');
    for (const [provider, key] of Object.entries(value.apiKeys)) { string(provider, '服务商'); string(key, 'API Key', 4096, true); }
    for (const key of ['customProviders', 'providerModels']) check(object(value[key] || {}), key + ' 格式错误');
    for (const [providerId, provider] of Object.entries(value.customProviders || {})) {
      check(/^custom\.[a-z\d-]+$/i.test(providerId), '自定义服务商 ID 错误');
      keys(provider, ['name', 'baseUrl', 'protocol'], '自定义服务商'); string(provider.name, '服务商名称'); string(provider.baseUrl, '接口地址', 2000);
      check(provider.protocol === undefined || ['chat-completions', 'responses'].includes(provider.protocol), '接口协议无效');
      const url = new URL(provider.baseUrl);
      check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, '接口地址无效');
    }
    for (const models of Object.values(value.providerModels || {})) {
      keys(models, ['model', 'visionModel'], '服务商模型');
      string(models.model, '模型 ID', 2000, true); string(models.visionModel, '视觉模型 ID', 2000, true);
    }
    return clone(value);
  }
  // 校验数据库完整性和所有引用；输入错误时不进行任何写入。
  function validate(db) {
    keys(db, ['schemaVersion', 'revision', ...TABLES, 'publicFieldIds', 'activeProfileId', 'settings', 'ledger', 'drafts', 'onboardingDone'], '数据库');
    check(db.schemaVersion === SCHEMA_VERSION, '不支持的数据库版本');
    check(Number.isInteger(db.revision) && db.revision >= 0, '数据库 revision 错误');
    for (const table of [...TABLES, 'publicFieldIds', 'ledger']) list(db[table], table);
    const defs = new Map();
    db.fieldDefinitions.forEach((def) => { definition(def); check(!defs.has(def.fieldId), '重复字段 ID'); defs.set(def.fieldId, def); });
    const profiles = new Set();
    db.profiles.forEach((profile) => {
      keys(profile, ['profileId', 'name', 'createdAt', 'materials'], '档案');
      string(profile.profileId, 'profileId'); string(profile.name, '档案名称'); string(profile.createdAt, '创建时间');
      check(Number.isFinite(Date.parse(profile.createdAt)), '创建时间错误');
      check(!profiles.has(profile.profileId), '重复档案 ID'); profiles.add(profile.profileId);
      list(profile.materials, '材料', 500);
      profile.materials.forEach((material) => { keys(material, ['name', 'note'], '材料'); string(material.name, '材料名称', 500, true); string(material.note, '备注', 2000, true); });
    });
    check(profiles.size > 0 && profiles.has(db.activeProfileId), '缺少有效活动档案');
    const entries = new Map();
    db.entries.forEach((entry) => {
      keys(entry, ['entryId', 'profileId', 'kind', 'title', 'order'], '经历');
      string(entry.entryId, 'entryId'); string(entry.title, '经历标题', 500, true);
      check(profiles.has(entry.profileId) && KINDS.includes(entry.kind), '经历引用或类型错误');
      check(Number.isInteger(entry.order) && entry.order >= 0 && !entries.has(entry.entryId), '经历顺序或 ID 错误');
      entries.set(entry.entryId, entry);
    });
    const valueKeys = new Set();
    db.fieldValues.forEach((row) => {
      keys(row, ['profileId', 'fieldId', 'entryId', 'value', 'updatedAt', 'source', 'evidence'], '个人字段值');
      check(profiles.has(row.profileId) && defs.has(row.fieldId), '字段值引用错误');
      check(row.entryId === null || entries.get(row.entryId)?.profileId === row.profileId, '经历不属于当前档案');
      const key = JSON.stringify([row.profileId, row.fieldId, row.entryId]);
      check(!valueKeys.has(key), '重复个人字段值'); valueKeys.add(key);
      string(row.updatedAt, '更新时间'); string(row.source, '数据来源');
      check(Number.isFinite(Date.parse(row.updatedAt)), '更新时间错误');
      validValue(row.value, defs.get(row.fieldId));
      if (row.evidence !== undefined) {
        keys(row.evidence, ['kind', 'excerpt', 'page', 'verified', 'fingerprint'], '简历来源');
        check(['pdf', 'docx', 'vision', 'manual'].includes(row.evidence.kind), '来源类型错误');
        string(row.evidence.excerpt, '来源片段', 500, true);
        check(/^[a-f0-9]{64}$/.test(row.evidence.fingerprint) && Number.isInteger(row.evidence.page)
          && row.evidence.page >= 0 && row.evidence.page <= 30 && typeof row.evidence.verified === 'boolean', '来源证据格式错误');
      }
    });
    const bindingKeys = new Set();
    db.bindings.forEach((binding) => {
      keys(binding, ['profileId', 'fieldId', 'fid', 'key', 'sensitive', 'autoFill', 'material', 'custom'], '字段展示配置');
      check(profiles.has(binding.profileId) && defs.has(binding.fieldId), '字段展示引用错误');
      string(binding.fid, 'fid'); string(binding.key, '字段 key');
      for (const key of ['sensitive', 'autoFill', 'material', 'custom']) check(typeof binding[key] === 'boolean', '展示配置错误');
      const key = JSON.stringify([binding.profileId, binding.fid]);
      check(!bindingKeys.has(key), '重复档案字段'); bindingKeys.add(key);
    });
    // Schema v3 可选学习元数据；旧规则仍可导入，但缺少确认及验证标记时不自动复用。
    const mappings = new Set();
    db.mappingRules.forEach((rule) => {
      keys(rule, ['mappingId', 'origin', 'path', 'label', 'fieldId', 'profileId', 'entryId', 'semanticId', 'features', 'confirmed', 'enabled', 'lastVerifiedAt', 'ruleVersion'], '映射规则');
      string(rule.mappingId, 'mappingId'); string(rule.label, '映射标签'); string(rule.path, '映射路径');
      check(/^https?:\/\/[^/?#]+$/.test(rule.origin) && defs.has(rule.fieldId), '映射 origin 或字段错误');
      check(rule.profileId === null || profiles.has(rule.profileId), '映射档案错误');
      check(rule.entryId === null || entries.get(rule.entryId)?.profileId === rule.profileId, '映射经历错误');
      check(!mappings.has(rule.mappingId), '重复映射 ID'); mappings.add(rule.mappingId);
      if (rule.semanticId !== undefined) {
        // v3 可选复合结构参与指纹，防止普通电话/年月规则被误用于另一种布局。
        keys(rule.features, ['label', 'type', 'group', 'kind', 'degree', 'index', 'layout'], '映射结构');
        global.FieldMatchingEngine.validateField({ scanId: 'scan.validation', semanticId: rule.semanticId, ...rule.features, name: '', placeholder: '', options: [] });
        check(rule.label === rule.features.label && typeof rule.confirmed === 'boolean' && typeof rule.enabled === 'boolean', '映射确认信息错误');
        check(Number.isInteger(rule.ruleVersion) && rule.ruleVersion >= 1, '映射版本错误');
        check(rule.lastVerifiedAt === null || (typeof rule.lastVerifiedAt === 'string' && Number.isFinite(Date.parse(rule.lastVerifiedAt))), '映射验证时间错误');
        check(!rule.confirmed || rule.lastVerifiedAt !== null, '未验证映射不能标记已确认');
      } else check(['features','confirmed','enabled','lastVerifiedAt','ruleVersion'].every((key) => rule[key] === undefined), '学习规则必须有语义标识');
    });
    check(db.publicFieldIds.every((fieldId) => defs.has(fieldId)) && new Set(db.publicFieldIds).size === db.publicFieldIds.length, '公共导出范围错误');
    settings(db.settings);
    check(typeof db.onboardingDone === 'boolean' && object(db.drafts), '草稿/引导格式错误');
    // 对历史辅助信息也限制形状，禁止以宽松 metadata 偷渡原文件。
    db.ledger.forEach((row) => {
      keys(row, ['ts', 'company', 'system', 'url', 'autoCount', 'manualCount'], '填充记录');
      check(Number.isFinite(row.ts), '记录时间错误');
      for (const key of ['company', 'system', 'url']) string(row[key] || '', key, 4000, true);
      for (const key of ['autoCount', 'manualCount']) check(Number.isFinite(row[key]) && row[key] >= 0, '记录数量错误');
    });
    for (const [profileId, questions] of Object.entries(db.drafts)) {
      check(profiles.has(profileId) && object(questions), '草稿档案错误');
      for (const history of Object.values(questions)) {
        list(history, '草稿历史', 3);
        history.forEach((draft) => { keys(draft, ['ts', 'text'], '草稿'); check(Number.isFinite(draft.ts), '草稿时间错误'); string(draft.text, '草稿文本', 10000, true); });
      }
    }
    return db;
  }
  // v2→v3 只增加可选来源证据；旧记录不伪造证据，未知版本拒绝升级。
  function upgradeDatabase(input) {
    check(input && [2, SCHEMA_VERSION].includes(input.schemaVersion), '不支持的数据库版本');
    const db = clone(input);
    if (db.schemaVersion === 2) {
      check(Array.isArray(db.fieldValues) && db.fieldValues.every((row) => row.evidence === undefined), '旧版本不支持来源证据');
      db.schemaVersion = SCHEMA_VERSION;
    }
    return validate(db);
  }
  // 分离旧 API 配置，不改动原始对象。
  function splitApi(legacy) {
    const old = legacy.settings || {};
    return apiSettings({ provider: old.provider || 'zhipu', model: old.model || '', visionModel: old.visionModel || '',
      customBase: old.customBase || '', apiKeys: { ...(old.apiKey ? { zhipu: old.apiKey } : {}), ...(old.apiKeys || {}) },
      customProviders: old.customProviders || {}, providerModels: old.providerModels || {} });
  }
  // 将旧档案按原顺序导入，保留 key/fid/开关；自定义标签不默认对外公开。
  function syncLegacy(db, state, source = 'manual') {
    check(Array.isArray(state.profiles) && state.profiles.length > 0, '旧数据缺少档案');
    const profileIds = state.profiles.map((profile) => profile.id);
    db.entries = db.entries.filter((entry) => profileIds.includes(entry.profileId));
    db.fieldValues = db.fieldValues.filter((row) => profileIds.includes(row.profileId));
    db.mappingRules = db.mappingRules.filter((rule) => !rule.profileId || profileIds.includes(rule.profileId));
    db.drafts = Object.fromEntries(Object.entries(state.drafts || {}).filter(([key]) => profileIds.includes(key)));
    const bindings = [];
    db.profiles = state.profiles.map((profile) => {
      string(profile.id, '旧档案 ID'); string(profile.name, '旧档案名称'); list(profile.fields, '旧字段');
      for (const field of profile.fields) {
        string(field.key, '旧字段 key'); string(field.fid, '旧字段 fid');
        const previous = db.bindings.find((row) => row.profileId === profile.id && row.fid === field.fid);
        const builtin = db.fieldDefinitions.find((def) => def.fieldId === 'builtin.' + field.key);
        const input = { label: field.label, type: field.inputType || 'text', group: field.group || '其他', options: field.options || [] };
        let def = previous && db.fieldDefinitions.find((row) => row.fieldId === previous.fieldId);
        if (!def) {
          const canUseBuiltin = builtin && !bindings.some((row) => row.profileId === profile.id && row.fieldId === builtin.fieldId)
            && builtin.label === input.label && builtin.type === input.type && builtin.group === input.group && equal(builtin.options, input.options);
          def = canUseBuiltin ? builtin : makeDefinition({ ...input, fieldId: source === 'legacy' ? legacyFieldId(profile.id, field.fid) : id('custom') });
          if (!canUseBuiltin) {
            check(!db.fieldDefinitions.some((row) => row.fieldId === def.fieldId), '旧字段 ID 冲突，请检查原数据');
            db.fieldDefinitions.push(def);
          }
        } else if (['label', 'type', 'group', 'options'].some((key) => !equal(def[key], input[key]))) {
          // 旧 UI 修改局部元数据时建立私有定义，避免改变其他档案或公共目录。
          if (!db.publicFieldIds.includes(def.fieldId)) {
            Object.assign(def, input, { version: def.version + 1 });
          } else {
            def = makeDefinition({ ...def, ...input, fieldId: id('custom'), version: 1 });
            db.fieldDefinitions.push(def);
          }
        }
        const binding = { profileId: profile.id, fieldId: def.fieldId, fid: field.fid, key: field.key,
          sensitive: !!field.sensitive, autoFill: !!field.autoFill, material: !!field.material, custom: !!field.custom };
        bindings.push(binding);
        let row = db.fieldValues.find((value) => value.profileId === profile.id && value.fieldId === def.fieldId && value.entryId === null);
        let value = field.value === undefined ? '' : field.value;
        // 旧输入框只产出字符串，按定义转换；错误文字交给校验拒绝而非随意转 true。
        if (value !== '' && value !== null && typeof value === 'string') {
          if (def.type === 'number') value = value.trim() === '' ? null : Number(value);
          if (def.type === 'boolean' && ['true', 'false'].includes(value)) value = value === 'true';
          if (def.type === 'multiSelect') value = JSON.parse(value);
        }
        if (!row) { row = { profileId: profile.id, fieldId: def.fieldId, entryId: null, value,
          updatedAt: source === 'legacy' ? new Date(profile.createdAt || 0).toISOString() : now(), source }; db.fieldValues.push(row); }
        else if (!equal(row.value, value)) { row.value = value; row.updatedAt = now(); row.source = source; delete row.evidence; }
      }
      return { profileId: profile.id, name: profile.name, createdAt: new Date(profile.createdAt || 0).toISOString(),
        materials: (profile.materials || []).map((material) => ({ name: material.name || '', note: material.note || '' })) };
    });
    db.bindings = bindings;
    // 清理已删除的平面字段值，重复经历使用独立 entryId，不受旧 UI 投影影响。
    db.fieldValues = db.fieldValues.filter((row) => row.entryId !== null || bindings.some((b) => b.profileId === row.profileId && b.fieldId === row.fieldId));
    db.fieldDefinitions = db.fieldDefinitions.filter((def) => db.publicFieldIds.includes(def.fieldId)
      || db.bindings.some((row) => row.fieldId === def.fieldId) || db.fieldValues.some((row) => row.fieldId === def.fieldId)
      || db.mappingRules.some((row) => row.fieldId === def.fieldId));
    db.activeProfileId = state.activeProfileId;
    db.settings = Object.fromEntries(['autoThreshold', 'privacyMask', 'autoFloatbar'].map((key) => [key, state.settings?.[key] ?? db.settings[key]]));
    db.ledger = clone(state.ledger || []);
    db.onboardingDone = !!state.onboardingDone;
    return validate(db);
  }
  // 旧 schema=1 显式迁移；未知版本失败而不是重置用户数据。
  function migrate(legacy) {
    check(legacy.schemaVersion === 1 || legacy.schemaVersion === undefined, '不支持的旧数据库版本');
    return { db: syncLegacy(emptyDatabase(), clone(legacy), 'legacy'), api: splitApi(legacy) };
  }
  // 将规范存储投影为旧 UI 需要的 fields，仅投影平面字段，不损失重复经历。
  function legacyState(db, api) {
    return { schemaVersion: SCHEMA_VERSION, revision: db.revision, migratedFullFields: true, onboardingDone: db.onboardingDone,
      settings: { ...clone(db.settings), ...clone(api) }, activeProfileId: db.activeProfileId, ledger: clone(db.ledger), drafts: clone(db.drafts),
      profiles: db.profiles.map((profile) => ({ id: profile.profileId, name: profile.name, createdAt: Date.parse(profile.createdAt), templateId: 'all', __wsaFull: true,
        materials: clone(profile.materials), fields: db.bindings.filter((binding) => binding.profileId === profile.profileId).map((binding) => {
          const def = db.fieldDefinitions.find((field) => field.fieldId === binding.fieldId);
          const row = db.fieldValues.find((value) => value.profileId === profile.profileId && value.fieldId === def.fieldId && value.entryId === null);
          const { profileId, fieldId, ...display } = binding;
          return { ...clone(display), label: def.label, group: def.group, inputType: def.type, options: clone(def.options), value: row?.value ?? '' };
        }) })) };
  }
  // 旧 UI 新增字段不带 options；标准化快照后才比较，避免把展示默认值误判为冲突。
  function normalizeSnapshot(state) {
    const normalized = clone(state);
    for (const profile of normalized.profiles || []) for (const field of profile.fields || []) {
      field.options ||= [];
    }
    return normalized;
  }
  // 三方合并旧 UI 快照：只应用改变的路径，同一字段并发编辑明确冲突。
  function mergeChanged(base, next, current) {
    if (equal(base, next)) return clone(current);
    if (equal(next, current)) return clone(current);
    if (object(base) && object(next) && object(current)) {
      const result = clone(current);
      for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
        if (key === 'revision' || equal(base[key], next[key])) continue;
        if (!(key in next)) { check(equal(current[key], base[key]), '资料已变化，请刷新后重试'); delete result[key]; }
        else result[key] = mergeChanged(base[key], next[key], current[key]);
      }
      return result;
    }
    if (Array.isArray(base) && Array.isArray(next) && Array.isArray(current)) {
      const key = [...base, ...next, ...current].every((row) => object(row) && row.fid) ? 'fid'
        : [...base, ...next, ...current].every((row) => object(row) && row.id) ? 'id' : null;
      if (key) {
        const result = clone(current);
        for (const old of base) if (!next.some((row) => row[key] === old[key])) {
          const index = result.findIndex((row) => row[key] === old[key]);
          if (index >= 0) { check(equal(result[index], old), '删除目标已变化，请刷新后重试'); result.splice(index, 1); }
        }
        for (const item of next) {
          const old = base.find((row) => row[key] === item[key]);
          const index = result.findIndex((row) => row[key] === item[key]);
          if (!old) { check(index < 0 || equal(result[index], item), '新增 ID 冲突'); if (index < 0) result.push(clone(item)); }
          else if (!equal(old, item)) { check(index >= 0, '资料已删除，请刷新后重试'); result[index] = mergeChanged(old, item, result[index]); }
        }
        return result;
      }
    }
    check(equal(base, current), '资料已变化，请刷新后重试');
    return clone(next);
  }
  // 备份只含规范个人库；API 设置及旧恢复源从不进入备份。
  function backup(db) {
    return { kind: 'localapply-ai-backup', formatVersion: 1, schemaVersion: SCHEMA_VERSION, exportedAt: now(), database: clone(validate(db)) };
  }
  // 导入支持旧档案备份和新备份；所有校验在写入前完成。
  function parseBackup(input) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    check(text.length <= 8 * 1024 * 1024, '备份超过 8 MiB 限制');
    const data = JSON.parse(text);
    if (data.kind === 'wangshen-autofill-backup') {
      keys(data, ['kind', 'version', 'exportedAt', 'profiles', 'activeProfileId'], '旧备份');
      check(data.version === 1, '不支持的旧备份版本');
      return migrate({ schemaVersion: 1, profiles: data.profiles, activeProfileId: data.activeProfileId || data.profiles?.[0]?.id }).db;
    }
    keys(data, ['kind', 'formatVersion', 'schemaVersion', 'exportedAt', 'database'], '备份');
    check(data.kind === 'localapply-ai-backup' && data.formatVersion === 1 && [2, SCHEMA_VERSION].includes(data.schemaVersion)
      && data.database?.schemaVersion === data.schemaVersion, '不支持的备份版本');
    return upgradeDatabase(data.database);
  }
  // 合并备份保留现有冲突数据，差异预览会列出冲突数量；覆盖模式需显式选择。
  function importPlan(current, incoming, mode) {
    check(['merge', 'replace'].includes(mode), '未知导入方式');
    const summary = { mode, profilesAdded: 0, fieldsAdded: 0, valuesAdded: 0, conflicts: 0, profilesRemoved: 0 };
    const result = mode === 'replace' ? clone(incoming) : clone(current);
    const identities = { fieldDefinitions: (row) => row.fieldId, profiles: (row) => row.profileId,
      fieldValues: (row) => JSON.stringify([row.profileId, row.fieldId, row.entryId]), entries: (row) => row.entryId,
      bindings: (row) => JSON.stringify([row.profileId, row.fid]), mappingRules: (row) => row.mappingId };
    for (const table of TABLES) {
      for (const row of incoming[table]) {
        const existing = current[table].find((item) => identities[table](item) === identities[table](row));
        if (!existing) {
          if (mode === 'merge') result[table].push(clone(row));
          if (table === 'profiles') summary.profilesAdded++;
          if (table === 'fieldDefinitions') summary.fieldsAdded++;
          if (table === 'fieldValues') summary.valuesAdded++;
        } else if (!equal(existing, row)) summary.conflicts++;
      }
    }
    if (mode === 'replace') summary.profilesRemoved = current.profiles.filter((profile) => !incoming.profiles.some((row) => row.profileId === profile.profileId)).length;
    // 私人备份不能自行提升公开权限；仅保留本机已审核且元数据完全相同的定义。
    result.publicFieldIds = current.publicFieldIds.filter((fieldId) => {
      const known = current.fieldDefinitions.find((def) => def.fieldId === fieldId);
      return result.fieldDefinitions.some((def) => def.fieldId === fieldId && equal(def, known));
    });
    result.revision = current.revision;
    return { database: validate(result), summary };
  }
  // 创建后台仓库；队列同时覆盖读取初始化与写入，避免 UI 并发丢更新。
  function createRepository(storage) {
    let queue = Promise.resolve();
    let sessionKey = null; // 不落盘；后台回收或文件页关闭后须重新解锁。
    let sessionSalt = null; // 另一页面重设口令时，旧会话密钥必须失效。
    // 初始化访问限制和数据；失败不删除/修改旧源，下次启动可重试。
    async function load() {
      await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      const data = await storage.get([DB_KEY, API_KEY, VAULT_KEY, DEVICE_KEY, CATALOG_KEY]);
      if (data[VAULT_KEY]) global.LocalApplyVault.validate(data[VAULT_KEY]);
      if (sessionKey && data[VAULT_KEY]?.salt !== sessionSalt) { sessionKey = sessionSalt = null; }
      if (data[DEVICE_KEY]) global.LocalApplyVault.validateDevice(data[DEVICE_KEY]);
      if (data[DB_KEY]) {
        const db = upgradeDatabase(data[DB_KEY]); const api = apiSettings(data[API_KEY]);
        const catalogUpgrade = data[CATALOG_KEY]?.version !== global.WangshenTemplates.CATALOG_VERSION;
        if (catalogUpgrade) upgradeFieldCatalog(db);
        if (!equal(db, data[DB_KEY])) {
          db.revision++;
          await storage.set({ [DB_KEY]: db, [CATALOG_KEY]: { version: global.WangshenTemplates.CATALOG_VERSION } }); // 数据和升级标记同批提交，失败可重试。
        } else if (catalogUpgrade) {
          await storage.set({ [CATALOG_KEY]: { version: global.WangshenTemplates.CATALOG_VERSION } });
        }
        return { db, api, vault: data[VAULT_KEY] || null, device: data[DEVICE_KEY] || null };
      }
      const legacy = await storage.get(LEGACY_KEY);
      const migrated = migrate(legacy[LEGACY_KEY] || global.WangshenTemplates.defaultState());
      upgradeFieldCatalog(migrated.db);
      // 先持久化独立配置，再以单 DB 键作为迁移生效点；中断时旧源仍可重试。
      await storage.set({ [API_KEY]: migrated.api });
      await storage.set({ [DB_KEY]: migrated.db, [CATALOG_KEY]: { version: global.WangshenTemplates.CATALOG_VERSION } });
      const saved = await storage.get([DB_KEY, API_KEY]);
      check(equal(saved[DB_KEY], migrated.db) && equal(saved[API_KEY], migrated.api), '迁移写入校验失败；旧数据仍保留');
      return { ...migrated, vault: data[VAULT_KEY] || null, device: data[DEVICE_KEY] || null };
    }
    // UI 只获得密钥存在状态；启用保险库后绝不通过兼容投影返回真实 Key。
    function project(previous) {
      const api = clone(previous.api);
      const providers = new Set(previous.vault?.providers || Object.keys(api.apiKeys).filter((id) => api.apiKeys[id]));
      for (const providerId of previous.device?.overrides || []) providers.delete(providerId);
      for (const providerId of previous.device?.providers || []) providers.add(providerId);
      if (previous.vault || previous.device) api.apiKeys = {};
      const state = legacyState(previous.db, api);
      state.settings.keyStatus = Object.fromEntries([...providers].map((id) => [id, true]));
      state.settings.vault = { enabled: !!previous.vault, unlocked: !!sessionKey, revision: previous.vault?.revision || 0,
        pendingMigration: !!previous.vault?.migrationPending, localRevision: previous.device?.revision || 0,
        localProviders: previous.device?.overrides || [] };
      return state;
    }
    // 按序运行操作，单次失败不阻塞后续请求。
    function run(work) {
      const task = queue.then(async () => work(await load()));
      queue = task.catch(() => {});
      return task;
    }
    // 一次数据库写入为提交单位；API 配置独立存储，仅必要时同时更新。
    async function commit(db, api, previous, recovery = false) {
      validate(db); db.revision = previous.db.revision + 1;
      const write = { [DB_KEY]: db };
      if (api && !equal(api, previous.api)) write[API_KEY] = apiSettings(api);
      if (recovery) await storage.set({ [RECOVERY_KEY]: clone(previous.db) });
      await storage.set(write);
      return clone(db);
    }
    // 密文读回并认证成功后才清理旧明文，档案和其他旧源内容保持不变。
    async function finishVaultMigration(previous, record, key) {
      const payload = await global.LocalApplyVault.open(record, key);
      if (previous.device) {
        // 迁移中断后新增的无口令 Key 也要合并，验证新密文后才移除本机自动密钥。
        Object.assign(payload.keys, await global.LocalApplyVault.openDevice(previous.device));
        record = await global.LocalApplyVault.seal(payload, key, global.LocalApplyVault.decode(record.salt), record.revision + 1, true);
        await storage.set({ [VAULT_KEY]: record });
        record = (await storage.get(VAULT_KEY))[VAULT_KEY]; await global.LocalApplyVault.open(record, key);
      }
      const old = await storage.get(LEGACY_KEY);
      const write = { [VAULT_KEY]: { ...record, migrationPending: false }, [DEVICE_KEY]: null, [API_KEY]: { ...previous.api, apiKeys: {} } };
      if (old[LEGACY_KEY]?.settings) {
        const legacy = clone(old[LEGACY_KEY]); delete legacy.settings.apiKey; legacy.settings.apiKeys = {};
        write[LEGACY_KEY] = legacy;
      }
      await storage.set(write);
    }
    // 无口令保存也先验证密文，再清理旧明文；旧的口令密文不会被擅自覆盖。
    async function saveDeviceKeys(previous, keys) {
      const record = await global.LocalApplyVault.sealDevice(keys, (previous.device?.revision || 0) + 1);
      await storage.set({ [DEVICE_KEY]: record });
      await global.LocalApplyVault.openDevice((await storage.get(DEVICE_KEY))[DEVICE_KEY]);
      const old = await storage.get(LEGACY_KEY);
      const write = { [API_KEY]: { ...previous.api, apiKeys: {} } };
      if (old[LEGACY_KEY]?.settings) {
        const legacy = clone(old[LEGACY_KEY]); delete legacy.settings.apiKey; legacy.settings.apiKeys = {}; write[LEGACY_KEY] = legacy;
      }
      await storage.set(write);
    }
    // 设置/解锁/锁定/修改单个 Key，口令与密钥只在调用期间及会话内使用。
    function vaultCommand(action, input = {}) {
      return run(async (previous) => {
        const vault = global.LocalApplyVault;
        if (action === 'setup') {
          check(!previous.vault, '保险库已设置，请解锁');
          const old = (await storage.get(LEGACY_KEY))[LEGACY_KEY];
          const payload = { keys: { ...clone(previous.api.apiKeys), ...(previous.device ? await vault.openDevice(previous.device) : {}) }, legacy: old?.settings
            ? { apiKey: old.settings.apiKey || '', apiKeys: old.settings.apiKeys || {} } : {} };
          const created = await vault.create(input.password, payload);
          await storage.set({ [VAULT_KEY]: created.record });
          const saved = (await storage.get(VAULT_KEY))[VAULT_KEY];
          await finishVaultMigration(previous, saved, created.key);
          sessionKey = created.key;
          sessionSalt = created.record.salt;
        } else if (action === 'unlock') {
          check(previous.vault, '请先设置安全口令');
          const key = await vault.unlock(input.password, previous.vault);
          if (previous.vault.migrationPending) await finishVaultMigration(previous, previous.vault, key);
          sessionKey = key;
          sessionSalt = previous.vault.salt;
        } else if (action === 'lock') {
          sessionKey = sessionSalt = null;
        } else if (action === 'disable') {
          check(previous.vault, '当前没有启用口令保护');
          const key = sessionKey || await vault.unlock(input.password, previous.vault);
          const payload = await vault.open(previous.vault, key);
          const local = previous.device ? await vault.openDevice(previous.device) : {};
          await saveDeviceKeys(previous, { ...payload.keys, ...local });
          await storage.set({ [VAULT_KEY]: null }); sessionKey = sessionSalt = null;
        } else if (action === 'setKey') {
          check(input.revision === (previous.vault?.revision || 0), '密钥已变化，请刷新状态后重试');
          if (input.localRevision !== undefined) check(input.localRevision === (previous.device?.revision || 0), '本机密钥已变化，请刷新后重试');
          check(Object.hasOwn(global.WangshenTemplates.PROVIDERS, input.providerId)
            || Object.hasOwn(previous.api.customProviders || {}, input.providerId), '服务商不存在');
          string(input.key, 'API Key', 4096, true);
          if (!previous.vault || !sessionKey) {
            const local = previous.device ? await vault.openDevice(previous.device) : {};
            await saveDeviceKeys(previous, { ...previous.api.apiKeys, ...local, [input.providerId]: input.key });
            return project(await load()).settings;
          }
          const payload = await vault.open(previous.vault, sessionKey);
          if (input.key) payload.keys[input.providerId] = input.key;
          else {
            delete payload.keys[input.providerId];
            if (payload.legacy?.apiKeys) delete payload.legacy.apiKeys[input.providerId];
            if (input.providerId === 'zhipu' && payload.legacy) delete payload.legacy.apiKey;
          }
          const record = await vault.seal(payload, sessionKey, vault.decode(previous.vault.salt), previous.vault.revision + 1);
          const write = { [VAULT_KEY]: record };
          if (previous.device) {
            const local = await vault.openDevice(previous.device); delete local[input.providerId];
            write[DEVICE_KEY] = await vault.sealDevice(local, previous.device.revision + 1);
          }
          await storage.set(write);
        } else if (action !== 'status') throw new Error('未知保险库操作');
        return project(await load()).settings;
      });
    }
    // 命令校验并操作独立副本，AI 未来也通过同一入口而不是直接写存储。
    function command(request) {
      return run(async (previous) => {
        const db = clone(previous.db);
        const input = request.payload || {};
        if (request.expectedRevision !== undefined) check(request.expectedRevision === db.revision, '数据版本已变化，请重新预览');
        let result = null;
        switch (request.action) {
          case 'confirmField': {
            keys(input, ['profileId', 'fieldId', 'entryId', 'definition', 'value', 'confirmed', 'source'], '确认学习字段');
            check(input.confirmed === true && request.expectedRevision !== undefined, '必须先预览差异并明确确认');
            check(db.profiles.some((profile) => profile.profileId === input.profileId), '档案不存在');
            let fieldId = input.fieldId;
            if (input.definition) {
              keys(input.definition, ['label', 'type', 'group', 'aliases', 'options'], '新学习定义');
              const def = makeDefinition({ ...input.definition, fieldId: id('custom') });
              db.fieldDefinitions.push(def); fieldId = def.fieldId;
              if (!input.entryId) db.bindings.push({ profileId: input.profileId, fieldId, fid: id('field'), key: fieldId, sensitive: true, autoFill: false, material: false, custom: true });
            }
            check(db.fieldDefinitions.some((definition) => definition.fieldId === fieldId), '字段不存在');
            const row = { profileId: input.profileId, fieldId, entryId: input.entryId || null, value: input.value,
              updatedAt: now(), source: ['manual', 'web-confirmed', 'local-confirmed'].includes(input.source) ? input.source : 'manual' };
            const index = db.fieldValues.findIndex((value) => value.profileId === row.profileId && value.fieldId === row.fieldId && value.entryId === row.entryId);
            if (index >= 0) db.fieldValues[index] = row; else db.fieldValues.push(row);
            result = { fieldId, entryId: row.entryId }; break;
          }
          case 'deleteMapping': {
            keys(input, ['mappingId', 'confirmed'], '删除规则');
            check(input.confirmed === true && request.expectedRevision !== undefined, '删除规则需要确认及版本');
            check(db.mappingRules.some((rule) => rule.mappingId === input.mappingId), '规则不存在');
            db.mappingRules = db.mappingRules.filter((rule) => rule.mappingId !== input.mappingId); break;
          }
          case 'restoreMappings': {
            keys(input, ['rules', 'confirmed'], '撤销规则操作');
            check(input.confirmed === true && request.expectedRevision !== undefined, '撤销需要确认及版本');
            list(input.rules, '撤销规则', 10000); db.mappingRules = clone(input.rules); break;
          }
          case 'createField': {
            keys(input, ['definition', 'profileId', 'value', 'source'], '新字段');
            const def = makeDefinition(input.definition);
            check(!db.fieldDefinitions.some((row) => row.fieldId === def.fieldId), '字段 ID 已存在');
            check(db.profiles.some((row) => row.profileId === input.profileId), '档案不存在');
            db.fieldDefinitions.push(def);
            db.bindings.push({ profileId: input.profileId, fieldId: def.fieldId, fid: id('field'), key: def.fieldId,
              sensitive: false, autoFill: false, material: false, custom: true });
            db.fieldValues.push({ profileId: input.profileId, fieldId: def.fieldId, entryId: null, value: input.value ?? null, updatedAt: now(), source: input.source || 'manual' });
            result = def.fieldId; break;
          }
          case 'editField': {
            keys(input, ['definition'], '编辑字段');
            const def = definition(input.definition);
            const index = db.fieldDefinitions.findIndex((row) => row.fieldId === def.fieldId);
            check(index >= 0 && !db.publicFieldIds.includes(def.fieldId), '字段不存在或属于公共目录，请先创建私有字段');
            check(def.version === db.fieldDefinitions[index].version + 1, '字段定义版本冲突');
            db.fieldDefinitions[index] = def; break;
          }
          // 将现有定义绑定到档案，只创建空值，绝不从其他档案复制答案。
          case 'attachField': {
            keys(input, ['fieldId', 'profileId'], '添加已有字段');
            const def = db.fieldDefinitions.find((row) => row.fieldId === input.fieldId);
            check(def && db.profiles.some((row) => row.profileId === input.profileId), '字段或档案不存在');
            if (!db.bindings.some((row) => row.profileId === input.profileId && row.fieldId === def.fieldId)) db.bindings.push({ profileId: input.profileId, fieldId: def.fieldId, fid: id('field'), key: def.fieldId.startsWith('builtin.') ? def.fieldId.slice(8) : def.fieldId, sensitive: false, autoFill: false, material: false, custom: !db.publicFieldIds.includes(def.fieldId) });
            if (!db.fieldValues.some((row) => row.profileId === input.profileId && row.fieldId === def.fieldId && row.entryId === null)) db.fieldValues.push({ profileId: input.profileId, fieldId: def.fieldId, entryId: null, value: null, updatedAt: now(), source: 'manual' });
            break;
          }
          case 'deleteField': {
            keys(input, ['fieldId'], '删除字段');
            check(db.fieldDefinitions.some((row) => row.fieldId === input.fieldId) && !db.publicFieldIds.includes(input.fieldId), '公共字段不可全局删除');
            db.fieldDefinitions = db.fieldDefinitions.filter((row) => row.fieldId !== input.fieldId);
            for (const table of ['fieldValues', 'bindings', 'mappingRules']) db[table] = db[table].filter((row) => row.fieldId !== input.fieldId);
            break;
          }
          case 'createProfile': {
            keys(input, ['name'], '新档案'); string(input.name, '档案名称');
            const profile = global.WangshenTemplates.makeProfile(input.name, 'all');
            const state = legacyState(db, previous.api); state.profiles.push(profile); state.activeProfileId = profile.id;
            syncLegacy(db, state); result = profile.id; break;
          }
          // 重命名只修改名称；必须确认并绑定预览版本，稳定 ID 和关联资料保持不变。
          case 'renameProfile': {
            keys(input, ['profileId', 'name', 'confirmed'], '重命名简历');
            check(input.confirmed === true && request.expectedRevision !== undefined, '重命名简历需要确认及版本');
            string(input.name, '简历名称'); const name = input.name.trim(); string(name, '简历名称');
            const profile = db.profiles.find((row) => row.profileId === input.profileId);
            check(profile, '简历不存在'); profile.name = name; result = profile.profileId; break;
          }
          // 整份删除只级联当前简历的个人数据，保留共享定义、其他简历和独立模型配置。
          case 'deleteProfile': {
            keys(input, ['profileId', 'confirmed'], '删除简历');
            check(input.confirmed === true && request.expectedRevision !== undefined, '删除简历需要确认及版本');
            check(db.profiles.some((row) => row.profileId === input.profileId), '简历不存在');
            check(db.profiles.length > 1, '至少保留一份简历，可直接修改现有资料');
            db.profiles = db.profiles.filter((row) => row.profileId !== input.profileId);
            for (const table of ['fieldValues', 'entries', 'bindings', 'mappingRules']) db[table] = db[table].filter((row) => row.profileId !== input.profileId);
            delete db.drafts[input.profileId];
            if (db.activeProfileId === input.profileId) db.activeProfileId = db.profiles[0].profileId;
            result = db.activeProfileId; break;
          }
          case 'createEntry': {
            keys(input, ['profileId', 'kind', 'title'], '新经历');
            const entry = { entryId: id('entry'), profileId: input.profileId, kind: input.kind, title: input.title || '',
              order: db.entries.filter((row) => row.profileId === input.profileId && row.kind === input.kind).length };
            db.entries.push(entry); result = entry.entryId; break;
          }
          // 只编辑经历标题，稳定 entryId、所属档案和所有映射关系保持一致。
          case 'editEntry': {
            keys(input, ['entryId', 'title'], '编辑经历'); string(input.title, '经历标题', 500, true);
            const entry = db.entries.find((row) => row.entryId === input.entryId); check(entry, '经历不存在'); entry.title = input.title; break;
          }
          case 'importResume': {
            keys(input, ['profileId', 'fingerprint', 'rows', 'overwrite'], '简历导入');
            check(request.expectedRevision !== undefined, '简历导入必须先校对并携带版本');
            check(db.profiles.some((p) => p.profileId === input.profileId), '目标档案不存在');
            check(/^[a-f0-9]{64}$/.test(input.fingerprint) && typeof input.overwrite === 'boolean', '简历导入参数错误');
            global.LocalApplyResume.validateRows(input.rows);
            result = { saved: 0, kept: 0 };
            for (const cell of input.rows) {
              const builtinId = 'builtin.' + cell.key;
              const fieldId = db.fieldDefinitions.some((d) => d.fieldId === builtinId) ? builtinId : 'resume.' + cell.key;
              const label = (cell.kind === 'basic' ? global.LocalApplyResume.basic : global.LocalApplyResume.repeated)[cell.key];
              const expected = makeDefinition({ fieldId, label, type: cell.key === 'description' ? 'textarea' : 'text', group: '简历资料' });
              const existingDef = db.fieldDefinitions.find((d) => d.fieldId === fieldId);
              if (!existingDef) db.fieldDefinitions.push(expected);
              else if (fieldId.startsWith('resume.')) check(equal(existingDef, expected), '简历字段定义冲突');
              let entryId = null;
              if (cell.kind !== 'basic') {
                entryId = resumeEntryId(input.profileId, input.fingerprint, cell.kind, cell.index);
                if (!db.entries.some((e) => e.entryId === entryId)) {
                  const head = input.rows.find((r) => r.kind === cell.kind && r.index === cell.index && ['school', 'company', 'title'].includes(r.key));
                  db.entries.push({ entryId, profileId: input.profileId, kind: cell.kind,
                    title: (head?.value || global.LocalApplyResume.kinds[cell.kind]).slice(0, 500),
                    order: db.entries.filter((e) => e.profileId === input.profileId && e.kind === cell.kind).length });
                }
              } else if (!db.bindings.some((b) => b.profileId === input.profileId && b.fieldId === fieldId)) {
                db.bindings.push({ profileId: input.profileId, fieldId, fid: id('field'), key: cell.key,
                  sensitive: ['phone', 'email'].includes(cell.key), autoFill: false, material: false, custom: true });
              }
              const index = db.fieldValues.findIndex((v) => v.profileId === input.profileId && v.fieldId === fieldId && v.entryId === entryId);
              if (index >= 0 && db.fieldValues[index].value !== '' && db.fieldValues[index].value !== null && !input.overwrite) { result.kept++; continue; }
              const row = { profileId: input.profileId, fieldId, entryId, value: cell.value, updatedAt: now(), source: 'ai-confirmed',
                evidence: { ...clone(cell.evidence), fingerprint: input.fingerprint } };
              if (index >= 0) db.fieldValues[index] = row; else db.fieldValues.push(row);
              result.saved++;
            }
            break;
          }
          case 'deleteEntry': {
            keys(input, ['entryId'], '删除经历');
            check(db.entries.some((row) => row.entryId === input.entryId), '经历不存在');
            db.entries = db.entries.filter((row) => row.entryId !== input.entryId);
            db.fieldValues = db.fieldValues.filter((row) => row.entryId !== input.entryId);
            db.mappingRules = db.mappingRules.filter((row) => row.entryId !== input.entryId); break;
          }
          // 清理当前档案的旧经历，先保存完整个人库恢复点；定义、基础值及其他档案不变。
          case 'clearResumeEntries': {
            keys(input, ['profileId', 'confirmed'], '清空旧经历');
            check(input.confirmed === true && request.expectedRevision !== undefined, '清空旧经历必须确认并携带版本');
            check(db.profiles.some((profile) => profile.profileId === input.profileId), '目标档案不存在');
            const entryIds = new Set(db.entries.filter((entry) => entry.profileId === input.profileId).map((entry) => entry.entryId));
            result = { entries: entryIds.size, values: db.fieldValues.filter((row) => entryIds.has(row.entryId)).length,
              mappings: db.mappingRules.filter((row) => entryIds.has(row.entryId)).length };
            // 空操作不覆盖先前恢复点，也不增加数据库版本。
            if (!entryIds.size) return { result, revision: db.revision };
            db.entries = db.entries.filter((entry) => !entryIds.has(entry.entryId));
            db.fieldValues = db.fieldValues.filter((row) => !entryIds.has(row.entryId));
            db.mappingRules = db.mappingRules.filter((row) => !entryIds.has(row.entryId));
            await commit(db, null, previous, true);
            return { result, revision: db.revision };
          }
          case 'setValue': {
            keys(input, ['profileId', 'fieldId', 'entryId', 'value', 'source'], '保存字段值');
            const row = { profileId: input.profileId, fieldId: input.fieldId, entryId: input.entryId ?? null,
              value: input.value, updatedAt: now(), source: input.source || 'manual' };
            const index = db.fieldValues.findIndex((value) => value.profileId === row.profileId && value.fieldId === row.fieldId && value.entryId === row.entryId);
            if (index >= 0) db.fieldValues[index] = row; else db.fieldValues.push(row);
            break;
          }
          case 'saveMapping': {
            const rule = clone(input); rule.mappingId ||= id('mapping');
            const index = db.mappingRules.findIndex((row) => row.mappingId === rule.mappingId);
            if (index >= 0) db.mappingRules[index] = rule; else db.mappingRules.push(rule);
            result = rule.mappingId; break;
          }
          case 'mergePublicFields': {
            keys(input, ['kind', 'version', 'fields'], '公共字段包');
            check(input.kind === 'localapply-public-fields' && input.version === 1, '公共字段包版本错误');
            list(input.fields, '公共字段', 2000);
            for (const item of input.fields) {
              const def = definition(item);
              const existing = db.fieldDefinitions.find((row) => row.fieldId === def.fieldId);
              if (existing) {
                if (equal(existing, def) || def.version < existing.version) continue;
                check(db.publicFieldIds.includes(def.fieldId) && def.version > existing.version, '公共字段 ID/版本冲突，请人工处理');
                Object.assign(existing, def); continue;
              }
              db.fieldDefinitions.push(def); db.publicFieldIds.push(def.fieldId);
              for (const profile of db.profiles) db.bindings.push({ profileId: profile.profileId, fieldId: def.fieldId, fid: id('field'), key: def.fieldId,
                sensitive: false, autoFill: false, material: false, custom: true });
            }
            break;
          }
          case 'publishDefinition': {
            // 对外共享必须提供独立审核后的元数据，绝不自动复制私有字段标签/经历标题。
            keys(input, ['definition'], '公共定义');
            const def = definition(input.definition);
            check(!db.fieldDefinitions.some((row) => row.fieldId === def.fieldId), '请为审核后的公共定义分配新 ID');
            db.fieldDefinitions.push(def); db.publicFieldIds.push(def.fieldId); break;
          }
          case 'importBackup': {
            keys(input, ['backup', 'mode'], '备份导入');
            check(request.expectedRevision !== undefined, '导入必须先预览并携带版本');
            const plan = importPlan(db, parseBackup(input.backup), input.mode);
            await commit(plan.database, null, previous, true);
            return { result: plan.summary, revision: plan.database.revision };
          }
          case 'restoreRecovery': {
            const data = await storage.get(RECOVERY_KEY);
            const recovered = upgradeDatabase(data[RECOVERY_KEY]);
            await commit(clone(recovered), null, previous);
            return { result: true, revision: db.revision + 1 };
          }
          default: throw new Error('未知本地数据命令');
        }
        await commit(db, null, previous);
        return { result, revision: db.revision };
      });
    }
    return {
      initialize: () => run(({ db }) => clone(db)),
      read: () => run(({ db }) => clone(db)),
      readLegacy: () => run(project),
      // 仅 AI 客户端可用：解密发生在后台/文件运行时，不向 UI 返回明文。
      readAiSettings: () => run(async (previous) => {
        const local = previous.device ? await global.LocalApplyVault.openDevice(previous.device) : {};
        if (!previous.vault) return { ...clone(previous.api), apiKeys: { ...previous.api.apiKeys, ...local } };
        if (!sessionKey) {
          check(!previous.vault.providers.includes(previous.api.provider) || Object.hasOwn(local, previous.api.provider), '旧密钥已锁定，可解锁口令或直接重新填写 API Key');
          return { ...clone(previous.api), apiKeys: { ...previous.api.apiKeys, ...local } };
        }
        const payload = await global.LocalApplyVault.open(previous.vault, sessionKey);
        return { ...clone(previous.api), apiKeys: { ...payload.keys, ...local } };
      }),
      vaultCommand,
      // 内容脚本只能收到明确的非敏感设置，不返回个人库/API。
      readContentSettings: () => run(({ db }) => clone(db.settings)),
      saveLegacy: (base, next, source = 'manual') => run(async (previous) => {
        check(['manual', 'pdf-confirmed', 'docx-confirmed', 'ai-confirmed'].includes(source), '未知数据来源');
        const merged = mergeChanged(normalizeSnapshot(base), normalizeSnapshot(next), project(previous));
        const db = syncLegacy(clone(previous.db), merged, source);
        const api = splitApi(merged);
        if (previous.vault || previous.device) check(!Object.values(api.apiKeys).some(Boolean), '请使用密钥保存入口');
        await commit(db, api, previous);
        return project({ db, api, vault: previous.vault, device: previous.device });
      }),
      exportBackup: () => run(({ db }) => backup(db)),
      previewImport: (input, mode) => run(({ db }) => ({ ...importPlan(db, parseBackup(input), mode).summary, revision: db.revision })),
      exportPublicFields: () => run(({ db }) => ({ kind: 'localapply-public-fields', version: 1,
        fields: db.fieldDefinitions.filter((def) => db.publicFieldIds.includes(def.fieldId)).map(definition) })),
      command,
    };
  }
  global.LocalApplyStore = { DB_KEY, API_KEY, RECOVERY_KEY, LEGACY_KEY, VAULT_KEY, DEVICE_KEY, CATALOG_KEY, SCHEMA_VERSION, createRepository, validate, migrate, legacyState, parseBackup, definition, resumeEntryId };
})(globalThis);
