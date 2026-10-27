// 已投职位工作台复用规范仓库；看板、详情和导出共用本地岗位记录。
(function (global) {
  'use strict';
  const A = global.LocalApplyApplications; const $ = (id) => document.getElementById(id);
  const INPUTS = { companyName: 'appCompany', jobTitle: 'appTitle', jobUrl: 'appUrl', jobId: 'appJobId', jobSource: 'appSource', location: 'appLocation', employmentType: 'appEmploymentType', summary: 'appSummary', notes: 'appNotes' };
  let database; let editing = null; let editingRevision; let editorReturnId = null; let dirty = false; let board = true; let scope = 'all'; let pendingImport = null; let pendingExport = null; let initialized = false; let refreshing = 0;
  const selected = new Set(); const hiddenColumns = new Set();
  const endedStatuses = new Set(['offer', 'rejected', 'closed']); // 已结束仅按明确状态归类，自定义状态保留在进行中。
  // 所有外部文字使用 textContent，不把职位摘要、备注或导入内容拼成 HTML。
  function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  // 正文和抽屉同步反馈结果，避免错误被模态背景遮挡；日志仍只由后台记录固定操作名。
  function message(value, error = false) { for (const id of ['appStatusMessage', 'appDetailMessage']) { $(id).textContent = value; $(id).className = error ? 'err' : 'muted'; } }
  // 筛选器不包含个人简历值，所有显示方式与导出共用同一规则。
  function query() { return { search: $('appSearch').value, status: $('appStatusFilter').value, source: $('appSourceFilter').value, city: $('appCityFilter').value, type: $('appTypeFilter').value, from: $('appDateFrom').value, to: $('appDateTo').value, archived: $('appArchiveFilter').value }; }
  // 范围标签与现有组合筛选、导出共用结果；日期有误时保留错误提示，不产生导出。
  function rows() {
    const filter = query(); if (filter.from && filter.to && filter.from > filter.to) throw new Error('开始日期不能晚于结束日期');
    return A.filter(database?.applications || [], filter).filter((row) => scope === 'ongoing' ? !row.archived && !endedStatuses.has(row.status) : scope === 'ended' ? !row.archived && endedStatuses.has(row.status) : true);
  }
  // 选择列表始终显示全部当前候选，并保留仍有效的筛选值。
  function options(id, title, values, label = (value) => value) { const previous = $(id).value; $(id).replaceChildren(new Option(title, ''), ...[...new Set(values.filter(Boolean))].map((value) => new Option(label(value), value))); if ([...$(id).options].some((option) => option.value === previous)) $(id).value = previous; }
  // 后台重读不会覆盖详情草稿；旧版本保存由仓库明确拒绝。
  async function refresh() {
    const generation = ++refreshing; const result = await dataRequest('localapply:read'); if (generation !== refreshing) return;
    database = result.database; const records = database.applications;
    options('appStatusFilter', '全部状态', [...Object.keys(A.STATUSES), ...records.map((row) => row.status)], A.statusLabel);
    options('appSourceFilter', '全部平台', records.map((row) => row.jobSource)); options('appCityFilter', '全部城市', records.map((row) => row.location)); options('appTypeFilter', '全部类型', records.map((row) => row.employmentType)); render();
  }
  // 批量导出只使用当前筛选结果中显式勾选的项；未选择时导出当前筛选结果。
  function exportRows() { const visible = rows(); return selected.size ? visible.filter((row) => selected.has(row.applicationId)) : visible; }
  // 卡片优先展示职位、公司和日期，企业标记仅用本地首字，不请求外部标志或图片。
  function card(record) {
    const box = node('article', '', 'application-record'); box.dataset.applicationId = record.applicationId;
    const check = node('input', '', 'application-export-check'); check.type = 'checkbox'; check.checked = selected.has(record.applicationId); check.setAttribute('aria-label', '选择导出 · ' + record.companyName + ' · ' + record.jobTitle); check.title = '选择此职位用于导出';
    check.addEventListener('change', () => { if (check.checked) selected.add(record.applicationId); else selected.delete(record.applicationId); invalidateExport(); });
    const open = node('button', '', 'application-open'); open.type = 'button'; open.append(node('strong', record.jobTitle), node('span', record.companyName)); open.addEventListener('click', () => openEditor(record.applicationId).catch((error) => message(error.message, true)));
    const mark = node('span', Array.from(record.companyName.trim())[0] || '企', 'application-company-mark'); mark.setAttribute('aria-hidden', 'true');
    const top = node('div', '', 'application-card-main'); top.append(mark, open, check);
    const footer = node('div', '', 'application-card-footer'); footer.append(node('span', (record.appliedAt ? '投递于 ' : '保存于 ') + new Date(record.appliedAt || record.createdAt).toLocaleDateString('zh-CN')), node('span', '第 ' + record.round + ' 轮'));
    box.append(top, node('span', A.statusLabel(record.status), 'application-status'), node('p', [record.location || '地点待补充', record.jobSource, record.employmentType].filter(Boolean).join(' · '), 'application-card-meta'), footer);
    if (record.tags.length) box.append(node('p', record.tags.join(' · '), 'application-tags')); return box;
  }
  // 列表和看板使用同一记录集合；隐藏列只影响显示，不修改申请数据。
  function render() {
    if (!database) return; let visible;
    try { visible = rows(); } catch (error) { message(error.message, true); return; }
    const root = $('appRecords'); root.replaceChildren(); root.className = board ? 'application-records application-board' : 'application-records';
    $('appCount').textContent = `当前 ${visible.length} 条 / 全部 ${database.applications.length} 条`; $('appColumns').hidden = !board;
    $('appTotal').textContent = String(database.applications.length);
    $('appScopes').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.appScope === scope)));
    $('appListView').setAttribute('aria-pressed', String(!board)); $('appBoardView').setAttribute('aria-pressed', String(board));
    if (!board) root.append(...visible.map(card));
    else {
      const statuses = [...new Set([...Object.keys(A.STATUSES), ...database.applications.map((row) => row.status)])].filter((status) => scope === 'ongoing' ? !endedStatuses.has(status) : scope === 'ended' ? endedStatuses.has(status) : true); $('appColumnOptions').replaceChildren();
      for (const status of statuses) {
        const label = node('label', '', 'application-check'); const check = node('input'); check.type = 'checkbox'; check.checked = !hiddenColumns.has(status); check.addEventListener('change', () => { if (check.checked) hiddenColumns.delete(status); else hiddenColumns.add(status); render(); }); label.append(check, document.createTextNode(A.statusLabel(status))); $('appColumnOptions').append(label);
        if (hiddenColumns.has(status)) continue;
        const items = visible.filter((row) => row.status === status); const column = node('section', '', 'application-column'); column.dataset.status = status;
        const title = node('h3', A.statusLabel(status)); title.append(node('span', String(items.length)));
        const body = node('div', '', 'application-column-body'); body.append(...items.map(card)); if (!items.length) body.append(node('p', '暂无职位', 'application-column-empty')); column.append(title, body); root.append(column);
      }
      root.style.setProperty('--application-columns', String(Math.max(1, root.childElementCount)));
      $('appColumns').querySelector('summary').textContent = '显示阶段（' + root.childElementCount + '）';
    }
    if (!visible.length || (board && !root.childElementCount)) {
      const empty = node('div', '', 'application-empty'); empty.append(node('strong', !database.applications.length ? '从第一个职位开始' : '暂无符合条件的职位'), node('span', !database.applications.length ? '点击右上角“添加职位”，或从招聘页面保存岗位。' : board && visible.length ? '可在“显示阶段”中重新勾选状态列。' : '试试切换职位范围，或调整搜索与筛选条件。'));
      root.className = 'application-records'; root.replaceChildren(empty);
    }
  }
  // 显式关闭或切换详情前保护未保存草稿，切工作台模块不会清空表单。
  function canDiscard() { return !dirty || confirm('申请详情有未保存的修改，确认放弃这些修改？'); }
  // 看板刷新会替换原按钮，关闭抽屉后按记录 ID 找回焦点；删除后的缺失目标回到新增入口。
  function hideEditor() {
    dirty = false; $('appDetail').close(); $('appDetail').hidden = true;
    const target = editorReturnId && [...$('appRecords').querySelectorAll('.application-record')].find((box) => box.dataset.applicationId === editorReturnId)?.querySelector('.application-open');
    (target || $('appNew')).focus({ preventScroll: true });
  }
  // 按钮、Esc 及背景点击都经过同一草稿保护，取消时保留完整表单。
  function closeEditor() { if (canDiscard()) hideEditor(); }
  // 详情始终绑定打开时的 revision，防止另一页面覆盖当前编辑。
  async function openEditor(applicationId = null) {
    if (!canDiscard()) return; if (!$('appDetail').open) editorReturnId = applicationId; await refresh(); editing = applicationId ? database.applications.find((row) => row.applicationId === applicationId) : null;
    if (applicationId && !editing) throw new Error('记录已删除，请刷新'); editingRevision = database.revision;
    $('appDetailMessage').textContent = '';
    for (const [key, id] of Object.entries(INPUTS)) $(id).value = editing?.[key] || '';
    $('appEditStatus').replaceChildren(...Object.keys(A.STATUSES).map((status) => new Option(A.statusLabel(status), status)), new Option('自定义状态…', 'custom'));
    $('appEditStatus').value = editing?.status.startsWith('custom:') ? 'custom' : editing?.status || 'saved'; $('appCustomStatus').value = editing?.status.startsWith('custom:') ? A.statusLabel(editing.status) : ''; updateCustomStatus();
    $('appAppliedDate').value = editing?.appliedAt?.slice(0, 10) || ''; $('appTags').value = editing?.tags.join('、') || ''; $('appTodos').value = (editing?.todos || []).map((todo) => (todo.done ? '[x] ' : '') + todo.text).join('\n');
    $('appArchived').checked = editing?.archived || false; $('appNewRound').checked = false; $('appNewRoundLabel').hidden = false; $('appDelete').hidden = !editing;
    $('appDetailTitle').textContent = editing ? '职位详情 · 第 ' + editing.round + ' 轮' : '添加职位'; $('appDetail').hidden = false; if (!$('appDetail').open) $('appDetail').showModal(); $('appTimeline').replaceChildren(...(editing?.history || []).map((event) => node('li', new Date(event.at).toLocaleString('zh-CN') + ' · ' + A.statusLabel(event.status) + ' · ' + event.note)));
    renderTodos(); dirty = false; $('appCompany').focus();
  }
  // 自定义状态只在用户选择后启用，不把自由输入当作网页自动推断结果。
  function updateCustomStatus() { $('appCustomStatusLabel').hidden = $('appEditStatus').value !== 'custom'; }
  // 任务勾选只更新当前草稿，仍需点击确认保存。
  function renderTodos() {
    $('appTodoList').replaceChildren();
    $('appTodos').value.split('\n').filter((line) => line.trim()).forEach((line, index) => {
      const label = node('label', '', 'application-check'); const check = node('input'); check.type = 'checkbox'; check.checked = /^\[x\]\s*/i.test(line.trim()); label.append(check, document.createTextNode(line.trim().replace(/^\[x\]\s*/i, '')));
      check.addEventListener('change', () => { const lines = $('appTodos').value.split('\n').filter((item) => item.trim()); lines[index] = (check.checked ? '[x] ' : '') + lines[index].trim().replace(/^\[x\]\s*/i, ''); $('appTodos').value = lines.join('\n'); dirty = true; }); $('appTodoList').append(label);
    });
  }
  // 只组装可编辑属性，历史、轮次及 ID 由领域层维护。
  function draft() {
    const record = Object.fromEntries(Object.entries(INPUTS).map(([key, id]) => [key, $(id).value.trim()]));
    record.status = $('appEditStatus').value === 'custom' ? 'custom:' + $('appCustomStatus').value.trim() : $('appEditStatus').value;
    record.appliedAt = $('appAppliedDate').value ? $('appAppliedDate').value + 'T00:00:00.000Z' : null; record.archived = $('appArchived').checked;
    record.tags = [...new Set($('appTags').value.split(/[、,，\n]/).map((value) => value.trim()).filter(Boolean))];
    record.todos = $('appTodos').value.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => ({ id: editing?.todos[index]?.id || 'todo.' + crypto.randomUUID(), text: line.replace(/^\[x\]\s*/i, ''), done: /^\[x\]\s*/i.test(line) })); return record;
  }
  // 保存前展示实际变化，取消时保留完整输入；失败时同样保留草稿供重试。
  async function save(event) {
    event.preventDefault(); const record = draft(); const newRound = $('appNewRound').checked;
    const labels = { companyName: '公司', jobTitle: '岗位', jobUrl: '链接', jobId: '职位 ID', jobSource: '平台', location: '地点', employmentType: '类型', summary: '摘要', status: '状态', appliedAt: '投递日期', notes: '备注', tags: '标签', todos: '待办', archived: '归档' };
    const differences = A.EDIT_KEYS.filter((key) => !editing || JSON.stringify(record[key]) !== JSON.stringify(editing[key])).map((key) => labels[key] + '：' + (key === 'status' ? A.statusLabel(record[key]) : typeof record[key] === 'object' ? JSON.stringify(record[key]).slice(0, 100) : String(record[key] ?? '').slice(0, 100)));
    if (!confirm((newRound ? '创建新一轮申请' : editing ? '确认修改申请' : '确认新增申请') + '\n' + differences.join('\n') + '\n仅保存本地记录，不提交网页申请。')) return;
    $('appSave').disabled = true;
    try { const response = await dataCommand('saveApplication', { applicationId: !newRound ? editing?.applicationId : undefined, newRound, record, confirmed: true }, editingRevision); dirty = false; await refresh(); await openEditor(response.result.applicationId); message(response.result.duplicate ? '已复用同岗位记录，仅补全空白信息；现有状态和备注保留。' : '申请记录已保存。'); }
    catch (error) { message('未保存：' + error.message + '；输入已保留。', true); } finally { $('appSave').disabled = false; }
  }
  // 筛选或选中项变化使旧导出预览失效，避免保存另一批数据。
  function invalidateExport() { pendingExport = null; $('appExportPanel').hidden = true; }
  // 导出只在明确按钮点击后创建临时 URL，随后及时释放。
  function download(content, type, name) { const url = URL.createObjectURL(new Blob([content], { type })); const link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  // 所有事件仅挂载一次；范围、菜单和原生抽屉只管理显示，独立文件模式复用同一仓库。
  async function init() {
    if (initialized) return; initialized = true;
    $('appNew').addEventListener('click', () => openEditor().catch((error) => message(error.message, true))); $('appRefresh').addEventListener('click', () => refresh().then(() => message('记录已刷新，详情草稿保留。')).catch((error) => message(error.message, true)));
    $('appForm').addEventListener('submit', save); $('appForm').addEventListener('input', () => { dirty = true; }); $('appEditStatus').addEventListener('change', updateCustomStatus); $('appTodos').addEventListener('input', renderTodos);
    $('appNewRound').addEventListener('change', () => { if ($('appNewRound').checked) { $('appEditStatus').value = 'saved'; $('appAppliedDate').value = ''; updateCustomStatus(); dirty = true; } });
    $('appClose').addEventListener('click', closeEditor); $('appDetailDismiss').addEventListener('click', closeEditor);
    $('appDetail').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
    $('appDetail').addEventListener('click', (event) => { const rect = $('appDetail').getBoundingClientRect(); if (event.target === $('appDetail') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeEditor(); });
    $('appDelete').addEventListener('click', async () => { if (!editing || !confirm('确认删除这条申请及其时间线？其他轮次和简历资料保留。')) return; try { await dataCommand('deleteApplication', { applicationId: editing.applicationId, confirmed: true }, editingRevision); editorReturnId = null; hideEditor(); await refresh(); message('申请记录已删除。'); } catch (error) { message(error.message, true); } });
    for (const id of ['appSearch', 'appStatusFilter', 'appSourceFilter', 'appCityFilter', 'appTypeFilter', 'appDateFrom', 'appDateTo', 'appArchiveFilter']) $(id).addEventListener('input', () => { if (id === 'appArchiveFilter') scope = $('appArchiveFilter').value === 'archived' ? 'archived' : 'all'; selected.clear(); invalidateExport(); message(''); render(); });
    $('appScopes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-app-scope]'); if (!button) return;
      scope = button.dataset.appScope; $('appArchiveFilter').value = scope === 'archived' ? 'archived' : scope === 'all' ? 'all' : ''; $('appStatusFilter').value = '';
      selected.clear(); invalidateExport(); message(''); render();
    });
    $('appResetFilters').addEventListener('click', () => { for (const id of ['appSearch', 'appStatusFilter', 'appSourceFilter', 'appCityFilter', 'appTypeFilter', 'appDateFrom', 'appDateTo']) $(id).value = ''; $('appArchiveFilter').value = 'all'; scope = 'all'; selected.clear(); invalidateExport(); message(''); render(); });
    document.addEventListener('click', (event) => { for (const id of ['appDataTools', 'appColumns']) if (!$(id).contains(event.target)) $(id).open = false; });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('appDataTools').open = false; $('appColumns').open = false; } });
    $('appListView').addEventListener('click', () => { board = false; render(); }); $('appBoardView').addEventListener('click', () => { board = true; render(); });
    $('appExportPreview').addEventListener('click', () => { $('appDataTools').open = false; try { pendingExport = A.exportPackage(exportRows()); $('appExportSummary').textContent = `将导出 ${pendingExport.applications.length} 条申请，含备注和标签。`; $('appExportPanel').hidden = false; } catch (error) { message(error.message, true); } });
    $('appExportCancel').addEventListener('click', invalidateExport);
    $('appExportJson').addEventListener('click', () => { if (pendingExport) download(JSON.stringify(pendingExport, null, 2), 'application/json', 'localapply-applications.json'); });
    $('appExportCsv').addEventListener('click', () => { if (pendingExport) download(A.csv(pendingExport.applications), 'text/csv;charset=utf-8', 'localapply-applications.csv'); });
    $('appImport').addEventListener('click', () => { $('appDataTools').open = false; $('appImportFile').click(); }); $('appImportCancel').addEventListener('click', () => { pendingImport = null; $('appImportPreview').hidden = true; });
    $('appImportFile').addEventListener('change', async (event) => {
      const file = event.target.files[0]; event.target.value = ''; pendingImport = null; $('appImportPreview').hidden = true; if (!file) return;
      try { if (file.size > 8 * 1024 * 1024) throw new Error('申请备份超过 8 MiB'); const text = await file.text(); const incoming = A.parsePackage(text); await refresh(); const plan = A.importPlan(database.applications, incoming); pendingImport = { text, revision: database.revision }; $('appImportSummary').textContent = `校验通过：新增 ${plan.added} 条，重复 ${plan.duplicates} 条，冲突 ${plan.conflicts} 条。冲突保留本机记录；确认前不会写入。`; $('appImportPreview').hidden = false; } catch (error) { message('导入未执行：' + error.message, true); }
    });
    $('appImportConfirm').addEventListener('click', async () => { if (!pendingImport) return; const preview = pendingImport; try { const response = await dataCommand('importApplications', { backup: preview.text, confirmed: true }, preview.revision); pendingImport = null; $('appImportPreview').hidden = true; await refresh(); message(`导入完成：新增 ${response.result.added} 条，冲突 ${response.result.conflicts} 条。`); } catch (error) { message('导入失败：' + error.message, true); } });
    document.addEventListener('workspace:page', (event) => { if (event.detail === 'applications') refresh().catch((error) => message(error.message, true)); });
    window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
    await refresh();
  }
  global.initApplications = init;
})(globalThis);
