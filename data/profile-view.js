// 个人档案的界面投影：保持经历 ID、类型和值，不修改存储，也不处理原始简历。
(function (global) {
  'use strict';
  const kinds = global.WangshenTemplates.RECORD_GROUPS;
  // 保留 false/0；只有空字符串、null 和空数组视为没有资料。
  function hasValue(value) { return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0); }
  // 布尔和多选在预览中使用可读中文，存储仍保持原类型。
  function text(value) { return value === true ? '是' : value === false ? '否' : Array.isArray(value) ? value.join('、') : value == null ? '' : String(value); }
  // 未绑定的经历字段也按标签判断敏感性，默认遮挡联系方式与私人资料。
  function sensitive(definition, binding) { return !!binding?.sensitive || /电话|手机|邮箱|地址|证件|身份证|出生|生日|薪资|薪酬|家庭|紧急联系/.test(definition.label); }
  // 按稳定经历 ID 分区，同名项目不会被合并；导航键不包含个人值。
  function sections(database, profileId, includeEmpty = false) {
    const definitions = new Map(database.fieldDefinitions.map((item) => [item.fieldId, item])); const groups = new Map();
    const rows = database.fieldValues.filter((item) => item.profileId === profileId && (includeEmpty || hasValue(item.value)));
    for (const row of rows) {
      const definition = definitions.get(row.fieldId); if (!definition) continue;
      const entry = database.entries.find((item) => item.profileId === profileId && item.entryId === row.entryId);
      const key = entry ? 'entry:' + entry.entryId : 'group:' + definition.group;
      if (!groups.has(key)) groups.set(key, { key, group: entry ? kinds[entry.kind] : definition.group, title: entry ? entry.title || '未命名经历' : definition.group, entryId: entry?.entryId || null, order: entry?.order ?? -1, items: [] });
      groups.get(key).items.push({ row, definition, sensitive: sensitive(definition, database.bindings.find((item) => item.profileId === profileId && item.fieldId === row.fieldId)) });
    }
    if (includeEmpty) for (const entry of database.entries.filter((item) => item.profileId === profileId)) {
      const key = 'entry:' + entry.entryId; if (!groups.has(key)) groups.set(key, { key, group: kinds[entry.kind], title: entry.title || '未命名经历', entryId: entry.entryId, order: entry.order, items: [] });
    }
    return [...groups.values()].sort((a, b) => Number(!!a.entryId) - Number(!!b.entryId) || a.group.localeCompare(b.group, 'zh-CN') || a.order - b.order);
  }
  // 只归一已知分类别名，不根据个人值猜测语义；自定义分类原样保留。
  function editorGroup(group) {
    const aliases = { '教育经历': '教育背景', '教育': '教育背景', '基本资料': '基本信息', '个人信息': '基本信息', '工作经验': '工作经历', '实习经验': '实习经历', '项目经验': '项目经历' };
    return Object.hasOwn(aliases, group) ? aliases[group] : group;
  }
  // 编辑视图按现有模块组织基础字段；新目录经历放在模块内部，旧契约经历保持兼容且不猜测平面值。
  function editorSections(database, profileId) {
    const definitions = new Map(database.fieldDefinitions.map((item) => [item.fieldId, item]));
    const groups = new Map(); const seen = new Set();
    // 仅缺少目标分类时创建界面容器，不新增或改写数据库字段定义。
    function group(name) {
      const label = editorGroup(name);
      if (!groups.has(label)) groups.set(label, { group: label, items: [] });
      return groups.get(label);
    }
    // 基本资料按定义分类，旧资料仅复用同名标准分类，不再额外生成已删除的语言证书模块。
    function add(row, definition) {
      if (!definition || seen.has(definition.fieldId)) return;
      seen.add(definition.fieldId);
      const standard = definition.group === '简历资料' && database.fieldDefinitions.find((item) => item.fieldId.startsWith('builtin.') && item.label === definition.label);
      const name = standard?.group || definition.group;
      group(name).items.push({ row, definition });
    }
    for (const binding of database.bindings.filter((item) => item.profileId === profileId)) {
      const row = database.fieldValues.find((item) => item.profileId === profileId && item.fieldId === binding.fieldId && item.entryId === null);
      add(row || null, definitions.get(binding.fieldId));
    }
    for (const row of database.fieldValues.filter((item) => item.profileId === profileId && item.entryId === null)) add(row, definitions.get(row.fieldId));
    // 每条模块记录从同一绑定模板生成全部编辑器；空记录/自定义字段也保留，旧契约记录不冒充新模块。
    for (const entry of database.entries.filter((item) => item.profileId === profileId && item.entryId.startsWith('catalog.')).sort((a, b) => a.order - b.order)) {
      const section = groups.get(kinds[entry.kind]); if (!section || !section.items.length) continue;
      const items = section.items.map(({ definition }) => ({ definition, row: database.fieldValues.find((row) => row.profileId === profileId && row.entryId === entry.entryId && row.fieldId === definition.fieldId) || null }));
      if (!section.records) section.records = [];
      section.records.push({ entryId: entry.entryId, order: entry.order, items });
    }
    const catalog = global.WangshenTemplates?.PROFILE_TEMPLATE || [];
    const fieldOrder = new Map(catalog.map((field, index) => ['builtin.' + field.key, index]));
    const groupOrder = [...new Set(catalog.map((field) => editorGroup(field.group)))];
    // 旧档案新增字段后仍按完整模块排序；用户自定义模块及其中的字段保留相对顺序。
    const result = [...groups.values()];
    result.forEach((section) => { const compare = (a, b) => (fieldOrder.get(a.definition.fieldId) ?? Infinity) - (fieldOrder.get(b.definition.fieldId) ?? Infinity); section.items.sort(compare); (section.records || []).forEach((record) => record.items.sort(compare)); });
    return result.sort((a, b) => (groupOrder.includes(a.group) ? groupOrder.indexOf(a.group) : Infinity) - (groupOrder.includes(b.group) ? groupOrder.indexOf(b.group) : Infinity));
  }
  global.LocalApplyProfileView = { hasValue, text, sensitive, sections, editorSections };
})(globalThis);
