// 申请追踪领域模型：仅处理结构化岗位记录，不读网页、不联网、不访问密钥。
(function (global) {
  'use strict';
  const STATUSES = { saved: '准备投递', draft: '正在填写', applied: '已投递', screening: '筛选中', assessment: '测评 / 笔试', interview: '面试中', offer: '收到 Offer', rejected: '未通过', closed: '结束 / 撤回' };
  const JOB_KEYS = ['companyName', 'jobTitle', 'jobUrl', 'jobId', 'jobSource', 'location', 'employmentType', 'summary'];
  const EDIT_KEYS = [...JOB_KEYS, 'status', 'appliedAt', 'notes', 'tags', 'todos', 'archived'];
  const RECORD_KEYS = ['applicationId', ...EDIT_KEYS, 'round', 'createdAt', 'updatedAt', 'history'];
  // 抛出固定校验错误，不把岗位正文或私人备注放入日志。
  function check(ok, message) { if (!ok) throw new Error(message); }
  // 拷贝仅含 JSON 的领域数据，避免界面草稿修改已保存记录。
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  // 严格属性白名单阻止备份通过额外字段夹带文件或凭据。
  function keys(value, allowed, name) { check(value && Object.getPrototypeOf(value) !== null && Object.prototype.toString.call(value) === '[object Object]' && Object.keys(value).every((key) => allowed.includes(key)), name + ' 包含无效属性'); }
  // 限制文本大小；正文和备注不得承载二进制或 data URL。
  function text(value, max = 500, empty = true) { check(typeof value === 'string' && value.length <= max && (empty || value.trim()) && !/^(?:data:|blob:)/i.test(value), '岗位文本格式错误'); return value; }
  // 日期统一使用完整 ISO 时间，避免无效日期被运行时自动纠正。
  function timestamp(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
  // URL 仅保留岗位标识参数，去除跟踪参数、片段和潜在令牌；不允许凭据或可执行协议。
  function cleanUrl(value) {
    if (!value) return '';
    const url = new URL(text(value, 4000));
    check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, '职位链接必须是无凭据的 HTTP(S) 地址');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (!/^(?:id|job_?id|position_?id|requisition_?id|recruitment_?id|batch_?id|locale|lang)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort(); return url.href;
  }
  // 用户可使用预设状态或显式输入的自定义状态，不把网页反馈当成状态更新。
  function validStatus(value) { text(value, 90, false); check(Object.hasOwn(STATUSES, value) || /^custom:[^\u0000-\u001f]{1,60}$/.test(value), '申请状态无效'); }
  // 返回中文状态标签，使用普通文本渲染。
  function statusLabel(value) { return Object.hasOwn(STATUSES, value) ? STATUSES[value] : value.replace(/^custom:/, ''); }
  // 岗位 ID 与站点优先；没有 ID 时按规范链接、公司和职位联合去重。
  function identity(record) {
    const url = record.jobUrl ? new URL(cleanUrl(record.jobUrl)) : null;
    const fold = (value) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    return record.jobId && url ? JSON.stringify([url.origin, record.jobId]) : JSON.stringify([url?.href || '', fold(record.companyName), fold(record.jobTitle)]);
  }
  // 校验完整记录与时间线；JSON 导入不能伪造“自动确认”来源。
  function validate(record) {
    keys(record, RECORD_KEYS, '申请记录');
    for (const key of JOB_KEYS) text(record[key], key === 'summary' ? 6000 : key === 'jobUrl' ? 4000 : 500);
    text(record.applicationId, 100, false); text(record.companyName, 500, false); text(record.jobTitle, 500, false);
    check(cleanUrl(record.jobUrl) === record.jobUrl, '职位链接含未规范的参数'); validStatus(record.status);
    check(record.appliedAt === null || timestamp(record.appliedAt), '投递日期无效');
    check(record.status !== 'applied' || record.appliedAt !== null, '已投递必须有日期');
    check(timestamp(record.createdAt) && timestamp(record.updatedAt) && record.updatedAt >= record.createdAt, '申请时间无效');
    check(Number.isInteger(record.round) && record.round >= 1 && record.round <= 1000 && typeof record.archived === 'boolean', '申请轮次或归档状态无效');
    text(record.notes, 10000);
    check(Array.isArray(record.tags) && record.tags.length <= 30 && new Set(record.tags).size === record.tags.length, '申请标签无效'); record.tags.forEach((tag) => text(tag, 80, false));
    check(Array.isArray(record.todos) && record.todos.length <= 100, '待办数量无效'); const todoIds = new Set();
    for (const todo of record.todos) { keys(todo, ['id', 'text', 'done'], '待办'); text(todo.id, 100, false); text(todo.text, 500, false); check(typeof todo.done === 'boolean' && !todoIds.has(todo.id), '待办状态或 ID 无效'); todoIds.add(todo.id); }
    check(Array.isArray(record.history) && record.history.length > 0 && record.history.length <= 500, '申请历史无效'); const eventIds = new Set(); let previous = record.createdAt;
    for (const event of record.history) { keys(event, ['eventId', 'status', 'at', 'source', 'note'], '申请事件'); text(event.eventId, 100, false); validStatus(event.status); text(event.note, 1000); check(timestamp(event.at) && event.at >= previous && event.at <= record.updatedAt && ['user', 'import'].includes(event.source) && !eventIds.has(event.eventId), '申请事件来源或时间无效'); previous = event.at; eventIds.add(event.eventId); }
    check(record.history.at(-1).status === record.status, '申请状态与最后事件不一致'); return record;
  }
  // 全表校验 ID 与轮次去重，不能覆盖另一条申请或静默吞掉导入冲突。
  function validateAll(records) {
    check(Array.isArray(records) && records.length <= 5000, '申请记录数量无效'); const ids = new Set(); const identities = new Set();
    for (const record of records) { validate(record); const key = identity(record) + ':' + record.round; check(!ids.has(record.applicationId) && !identities.has(key), '申请记录 ID 或同轮岗位重复'); ids.add(record.applicationId); identities.add(key); } return records;
  }
  // 建立候选只处理岗位元数据，缺少公司或职位时留给用户补全。
  function candidate(input) {
    keys(input, JOB_KEYS, '岗位候选'); const result = Object.fromEntries(JOB_KEYS.map((key) => [key, text(input[key] || '', key === 'summary' ? 6000 : key === 'jobUrl' ? 4000 : 500).trim()]));
    result.jobUrl = cleanUrl(result.jobUrl); return result;
  }
  // 保存必须来自明确确认；重复创建只补空白资料，不擅自覆盖现有状态或备注。
  function save(records, input, at = new Date().toISOString()) {
    keys(input, ['record', 'applicationId', 'newRound', 'confirmed'], '保存申请'); check(input.confirmed === true && typeof input.newRound === 'boolean', '保存申请需要确认'); keys(input.record, EDIT_KEYS, '申请输入');
    const job = candidate(Object.fromEntries(JOB_KEYS.map((key) => [key, input.record[key] || '']))); const fields = { ...job, status: input.record.status || 'saved', appliedAt: input.record.appliedAt || null, notes: input.record.notes || '', tags: clone(input.record.tags || []), todos: clone(input.record.todos || []), archived: input.record.archived ?? false };
    let existing = input.applicationId ? records.find((record) => record.applicationId === input.applicationId) : null;
    check(!input.applicationId || existing, '申请记录不存在'); const same = records.filter((record) => identity(record) === identity(job));
    let duplicate = false;
    if (!existing && !input.newRound && same.length) {
      existing = [...same].sort((a, b) => b.round - a.round)[0]; duplicate = true;
      for (const key of EDIT_KEYS) fields[key] = !existing[key] && typeof fields[key] === 'string' ? fields[key] : clone(existing[key]);
    }
    if (fields.status === 'applied' && !fields.appliedAt) fields.appliedAt = at;
    const record = { ...(existing ? clone(existing) : { applicationId: 'application.' + global.crypto.randomUUID(), createdAt: at, round: same.length ? Math.max(...same.map((row) => row.round)) + 1 : 1, history: [] }), ...fields, updatedAt: at };
    const changed = !existing || EDIT_KEYS.some((key) => JSON.stringify(existing[key]) !== JSON.stringify(record[key]));
    if (!changed) return { applicationId: record.applicationId, duplicate, changed: false };
    record.history.push({ eventId: 'event.' + global.crypto.randomUUID(), status: record.status, at, source: 'user', note: !existing ? '创建申请记录' : duplicate ? '补全岗位空白信息' : record.status !== existing.status ? '更新申请状态' : '更新申请资料' }); validate(record);
    const next = records.filter((row) => row.applicationId !== record.applicationId); next.push(record); validateAll(next); records.splice(0, records.length, ...next);
    return { applicationId: record.applicationId, duplicate, changed: true };
  }
  // 全部筛选共用于列表、看板和导出预览；日期以投递日优先，未投递用创建日。
  function filter(records, query = {}) {
    const search = (query.search || '').trim().toLocaleLowerCase();
    return records.filter((row) => {
      const date = (row.appliedAt || row.createdAt).slice(0, 10);
      return (!query.status || row.status === query.status) && (!query.source || row.jobSource === query.source) && (!query.city || row.location === query.city) && (!query.type || row.employmentType === query.type)
        && (query.archived === 'all' || row.archived === (query.archived === 'archived')) && (!query.from || date >= query.from) && (!query.to || date <= query.to)
        && (!search || [row.companyName, row.jobTitle, row.location, row.notes, row.tags.join(' ')].some((value) => value.toLocaleLowerCase().includes(search)));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  // 结构化导出包含完整时间线；不可能访问个人简历或 API 配置。
  function exportPackage(records) { validateAll(records); return { kind: 'localapply-applications', schemaVersion: 1, exportedAt: new Date().toISOString(), applications: clone(records) }; }
  // 严格检查独立 JSON 包，不接受额外属性、未知版本或过大输入。
  function parsePackage(input) {
    const raw = typeof input === 'string' ? input : JSON.stringify(input); check(raw.length <= 8 * 1024 * 1024, '申请备份超过 8 MiB'); const data = JSON.parse(raw);
    keys(data, ['kind', 'schemaVersion', 'exportedAt', 'applications'], '申请备份'); check(data.kind === 'localapply-applications' && data.schemaVersion === 1 && timestamp(data.exportedAt), '申请备份版本或格式无效'); validateAll(data.applications); return data.applications;
  }
  // 合并按稳定 ID 或同岗位轮次去重，所有冲突保留本机版本并在确认前报告。
  function importPlan(current, incoming) {
    validateAll(current); validateAll(incoming); const records = clone(current); let added = 0; let conflicts = 0; let duplicates = 0;
    for (const record of incoming) {
      const existing = records.find((row) => row.applicationId === record.applicationId || identity(row) === identity(record) && row.round === record.round);
      if (existing) { if (JSON.stringify(existing) !== JSON.stringify(record)) conflicts++; else duplicates++; }
      else { records.push(clone(record)); added++; }
    }
    validateAll(records); return { records, added, conflicts, duplicates };
  }
  // 防止 Excel 将岗位名、备注等文本当公式执行；BOM 与 CRLF 保证中文兼容。
  function csv(records) {
    validateAll(records);
    const cell = (value) => '"' + (/^[\s\u0000-\u001f]*[=+@-]/.test(String(value ?? '')) ? "'" : '') + String(value ?? '').replace(/"/g, '""') + '"';
    const rows = [['公司', '岗位', '地点', '平台', '职位类型', '网址', '状态', '申请日期', '最近更新', '轮次', '标签', '备注'], ...records.map((row) => [row.companyName, row.jobTitle, row.location, row.jobSource, row.employmentType, row.jobUrl, statusLabel(row.status), row.appliedAt || '', row.updatedAt, row.round, row.tags.join('、'), row.notes])];
    return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
  }
  global.LocalApplyApplications = { STATUSES, JOB_KEYS, EDIT_KEYS, validate, validateAll, cleanUrl, identity, candidate, save, filter, exportPackage, parsePackage, importPlan, csv, statusLabel };
})(globalThis);
