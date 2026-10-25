// 个人档案的界面投影：保持经历 ID、类型和值，不修改存储，也不处理原始简历。
(function (global) {
  'use strict';
  const kinds = { education: '教育背景', internship: '实习经历', employment: '工作经历', project: '项目经历' };
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
  global.LocalApplyProfileView = { hasValue, text, sensitive, sections };
})(globalThis);
