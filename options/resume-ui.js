// 简历中心与导入：本地预览→用户发起解析→默认自动覆盖非空候选，保留可选手动校对。
'use strict';
let resumeJob = null;
let resumeSource = null;
let resumeRows = [];
let resumeDatabase = null;
let resumeCatalog = null;
let resumeCatalogMode = false;
let lastResumeReport = null; // 仅当前页保留模型结构化结果，不放入日志、URL 或公共字段库。
let resumeCommitBusy = false; // 原子写入期间不接收新文件，避免把已提交操作误当作可取消任务。
let selectedResumeFile = null; // 仅留在当前页面内存，取消或识别完成后释放。
// 清理旧任务及其草稿，迟到响应不能重建已取消的审核结果。
function clearResume(message = '', keepFile = false, keepReport = false) {
  if (resumeJob) {
    resumeJob.controller.abort();
    sendMessage('wsa:cancelResume', { requestId: resumeJob.id });
  }
  resumeJob = resumeSource = resumeDatabase = null; resumeRows = [];
  resumeCatalog = null; resumeCatalogMode = false;
  if (!keepReport) { lastResumeReport = null; $('#resumeReport').hidden = true; $('#resumeReport').open = false; $('#resumeReportItems').replaceChildren(); $('#resumeReportRaw').textContent = ''; }
  selectedResumeFile = null;
  if (!keepFile) $('#pdfFile').value = '';
  $('#sourcePreview').textContent = ''; $('#pdfReview').replaceChildren();
  $('#resumePreview').open = false; $('#resumeFileInfo').textContent = '尚未选择文件';
  $('#importRow').style.display = 'none'; $('#sendResume').hidden = true;
  $('#retryResumeImport').hidden = true;
  $('#sendResume').disabled = false;
  $('#pdfStatus').textContent = message; $('#btnExtract').disabled = false;
}
// 本地仅生成页面预览，包含所有可渲染文字和图片；不做字段抽取和文字识别。
async function prepareResume(file = selectedResumeFile || $('#pdfFile').files[0]) {
  if (resumeCommitBusy) { $('#pdfStatus').textContent = '正在保存导入资料，请稍候再更换文件。'; return; }
  if (!file) { $('#pdfStatus').textContent = '请先选择 PDF 或 DOCX'; return; }
  clearResume();
  selectedResumeFile = file;
  $('#resumeFileInfo').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KiB`;
  const job = { id: crypto.randomUUID(), controller: new AbortController() }; resumeJob = job;
  $('#btnExtract').disabled = true; $('#pdfStatus').textContent = '正在本地读取与检查文件…';
  try {
    const source = await LocalApplyFiles.read(file, job.controller.signal);
    source.pages = await LocalApplyFiles.render(source, job.controller.signal);
    if (resumeJob !== job) return;
    resumeSource = source;
    for (const [index, page] of source.pages.entries()) {
      const image = document.createElement('img'); image.src = page.dataUrl; image.alt = '简历第 ' + (index + 1) + ' 页/图';
      $('#sourcePreview').append(image);
    }
    $('#resumePreview').open = true;
    $('#pdfStatus').textContent = `已生成 ${source.pages.length} 张页面预览，尚未发送。可直接点击“${$('#sendResume').textContent}”，无需预先检测。`;
    $('#sendResume').hidden = false;
  } catch (error) { if (resumeJob === job) clearResume('读取失败：' + error.message); }
  finally { if (resumeJob === job) $('#btnExtract').disabled = false; }
}
// 用户点击后才发送文件；结果默认自动导入，失败或取消不清空原有资料。
async function analyzeResume() {
  const job = resumeJob; const source = resumeSource;
  if (!job || !source || resumeCommitBusy) return;
  const automatic = $('#autoImportResume').checked; const profileId = $('#targetProfile').value;
  $('#targetProfile').disabled = $('#autoImportResume').disabled = true;
  $('#sendResume').disabled = true; $('#btnExtract').disabled = true;
  $('#pdfStatus').textContent = '正在调用当前模型解析，最长每次请求 2 分钟，可随时取消…';
  try {
    await flushCredentials();
    if (resumeJob !== job) return;
    const { database } = await dataRequest('localapply:read');
    if (resumeJob !== job) return;
    resumeCatalog = LocalApplyResumeCatalog.catalog(database, profileId);
    const { route } = await dataRequest('wsa:resumeRoute', { format: source.type });
    if (resumeJob !== job) return;
    const file = route.mode === 'file' ? { filename: 'resume.' + source.type,
      file_data: LocalApplyProbes.dataUrl(source.bytes, source.type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') } : undefined;
    source.mode = route.mode;
    $('#pdfStatus').textContent = `正在由 ${route.model} 识别${file ? '原文件（包括图片内容）' : source.pages.length + ' 张完整页面图片'}，可取消…`;
    const response = await dataRequest('wsa:aiExtractResume', { payload: { requestId: job.id, profileId, catalog: resumeCatalog, type: source.type, routeToken: route.token,
      mode: route.mode, file, pages: file ? undefined : source.pages } });
    if (resumeJob !== job) return;
    lastResumeReport = { createdAt: new Date().toISOString(), profileId, raw: response.data, items: [] };
    const analysis = LocalApplyResumeCatalog.analyze(response.data, source, resumeCatalog); lastResumeReport.items = analysis.items;
    // 旧手动校对返回继续兼容历史契约；默认自动导入及新目录结果均使用完整字段映射。
    let legacyRows;
    if (!Object.hasOwn(response.data, 'fields') && !automatic) {
      try { legacyRows = LocalApplyResume.normalize(response.data, source); } catch (error) { if (!analysis.rows.length) throw error; }
    }
    resumeCatalogMode = Object.hasOwn(response.data, 'fields') || automatic || !legacyRows || analysis.rows.length > legacyRows.length;
    resumeRows = resumeCatalogMode ? analysis.rows.map((row) => ({ ...row, original: structuredClone(row.value), checked: false, label: resumeCatalog.find((field) => field.fieldId === row.fieldId).label })) : legacyRows;
    renderResumeReport();
    if (!resumeRows.length) throw new Error('没有可自动写入的字段，请展开解析报告查看原因');
    // 文件识别结束释放原字节，页面预览仅留在本次内存供人工核对。
    source.bytes = source.renderBytes = selectedResumeFile = null;
    $('#sendResume').hidden = true;
    if (automatic) await autoImportResume(job, profileId);
    else {
      $('#targetProfile').value = profileId;
      $('#pdfStatus').textContent = '解析完成，当前为手动校对模式。请核对并勾选需要导入的字段。';
      $('#importRow').style.display = ''; await renderResumeReview();
    }
  } catch (error) {
    if (resumeJob === job) { $('#pdfStatus').textContent = '解析失败：' + error.message; $('#sendResume').hidden = false; }
  } finally {
    // 旧任务取消后可能立即开始新解析，旧回调不得解除新任务的目标锁定。
    if (!resumeJob || resumeJob === job) $('#targetProfile').disabled = $('#autoImportResume').disabled = false;
    if (resumeJob === job) { $('#sendResume').disabled = false; $('#btnExtract').disabled = false; }
  }
}
// 将完整的非空解析结果一次写入点击时指定的档案；失败保留结果，重试不再调用模型。
async function autoImportResume(job = resumeJob, profileId = $('#targetProfile').value) {
  const source = resumeSource; if (!job || !source || !resumeRows.length || resumeCommitBusy) return;
  let writing = false;
  $('#retryResumeImport').hidden = true;
  try {
    await resumeSaveQueue;
    if (resumeJob !== job || job.controller.signal.aborted) return;
    if (workspaceDirty()) throw new Error('存在未保存的资料编辑，请先保存或处理草稿，再重试自动导入');
    const { database } = await dataRequest('localapply:read');
    if (resumeJob !== job || job.controller.signal.aborted) return;
    const profile = database.profiles.find((item) => item.profileId === profileId); if (!profile) throw new Error('目标简历已被删除，请重新选择目标简历');
    writing = resumeCommitBusy = true; $('#cancelResume').disabled = $('#pdfFile').disabled = $('#targetProfile').disabled = $('#autoImportResume').disabled = true;
    $('#pdfStatus').textContent = '解析完成，正在自动导入并保存恢复点…';
    const rows = resumeImportRows(resumeRows);
    const { result } = await dataCommand('autoImportResume', { profileId, fingerprint: source.fingerprint, rows, overwrite: true, ...(resumeCatalogMode ? { catalog: resumeCatalog } : {}) }, database.revision);
    if (resumeJob !== job) return;
    markResumeReport(result);
    clearResume(`解析完成，已自动导入到“${profile.name}”：${result.saved} 项（覆盖 ${result.overwritten} 项）。未识别字段保留；可展开解析报告查看详情，在“数据与备份”恢复。`, false, true);
    await reloadDataState();
  } catch (error) {
    if (resumeJob === job) { $('#pdfStatus').textContent = '解析成功，自动导入未完成：' + error.message + '。解析结果已保留，可重试导入，无需再次调用模型。'; $('#retryResumeImport').hidden = false; }
  } finally {
    if (writing) resumeCommitBusy = false;
    if (!resumeJob || resumeJob === job) $('#cancelResume').disabled = $('#pdfFile').disabled = $('#targetProfile').disabled = $('#autoImportResume').disabled = false;
  }
}
// 按当前契约构造保存行，用户修改过的值标记人工来源，不能继续冒充模型引用。
function resumeImportRows(rows) {
  return rows.map((row) => ({ kind: row.kind, index: row.index, ...(resumeCatalogMode ? { fieldId: row.fieldId } : { key: row.key }), value: row.value,
    evidence: JSON.stringify(row.value) === JSON.stringify(row.original) ? row.evidence : { kind: 'manual', excerpt: '', page: 0, verified: false } }));
}
// 只按后台实际提交结果标记写入状态；未匹配和错误候选始终保留原始原因。
function markResumeReport(result) {
  if (!lastResumeReport) return;
  lastResumeReport.result = result;
  for (const item of lastResumeReport.items) {
    const detail = result.details?.find((row) => row.fieldId === item.fieldId && row.index === item.index);
    if (detail && item.status === 'ready') { item.status = detail.status; item.reason = detail.status === 'kept' ? '保留已有内容' : detail.status === 'overwritten' ? '已按简历内容覆盖' : '已写入本地资料'; }
    else if (result.details && item.status === 'ready') { item.status = 'skipped'; item.reason = '手动模式未勾选此字段，保留原值'; }
    else if (!result.details && item.status === 'ready') {
      // 旧手动契约没有逐行返回状态，按本次勾选和校对版本展示，不将未勾选项冒充已写入。
      const selected = resumeRows.find((row) => row.checked && ('builtin.' + row.key === item.fieldId) && row.index === item.index);
      const prior = selected && resumeExisting(selected, resumeDatabase, $('#targetProfile').value);
      item.status = !selected ? 'skipped' : prior?.value && !$('#overwriteResume').checked ? 'kept' : 'saved';
      item.reason = !selected ? '手动模式未勾选此字段' : item.status === 'kept' ? '保留已有内容' : '已通过兼容导入保存';
    }
  }
  renderResumeReport();
}
// 报告只使用 textContent 渲染模型值，恶意 HTML/脚本只能作为可见文本，不能执行。
function renderResumeReport() {
  if (!lastResumeReport) return;
  const report = $('#resumeReport'); report.hidden = false;
  const labels = { ready: '待写入', saved: '已写入', overwritten: '已覆盖', kept: '已保留', skipped: '未选择', absent: '未返回', unmatched: '未匹配', invalid: '格式不符', missing: '缺少内容', conflict: '结果冲突', duplicate: '重复合并' };
  const items = lastResumeReport.items;
  $('#resumeReportSummary').textContent = `查看解析报告（返回 ${items.filter((item) => item.status !== 'absent').length} 项${lastResumeReport.result ? ' · 已保存 ' + lastResumeReport.result.saved + ' 项' : ''} · 未返回 ${items.filter((item) => item.status === 'absent').length} 项）`;
  $('#resumeReportRaw').textContent = JSON.stringify(lastResumeReport.raw, null, 2);
  const root = $('#resumeReportItems'); root.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'resume-report-item'; row.dataset.reportStatus = item.status;
    const title = document.createElement('strong'); title.textContent = `${labels[item.status]} · ${item.group ? item.group + ' / ' : ''}${item.label}${item.index > 0 ? ' · 第 ' + (item.index + 1) + ' 条' : ''}`;
    const value = document.createElement('pre'); value.textContent = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
    const reason = document.createElement('p'); reason.className = 'muted'; reason.textContent = item.reason; row.append(title, value, reason); root.append(row);
  }
}
// 自动导入默认开启；切换只改变待执行方式，不因勾选开关直接写入资料。
function updateResumeImportMode() {
  const automatic = $('#autoImportResume').checked; $('#sendResume').textContent = automatic ? '解析并自动导入' : '解析并校对';
  if (!resumeRows.length) return;
  $('#importRow').style.display = automatic ? 'none' : ''; $('#retryResumeImport').hidden = !automatic;
  if (!automatic) renderResumeReview().catch((error) => { $('#pdfStatus').textContent = '读取校对结果失败：' + error.message; });
}
// 文件选择和拖放使用同一入口；一次只接收一份简历，预览不会调用模型。
function acceptResumeFiles(files) {
  if (resumeCommitBusy) { $('#pdfStatus').textContent = '正在保存导入资料，请稍候再更换文件。'; return; }
  if (files.length !== 1) { clearResume('请每次选择或拖入一份 PDF/DOCX 简历'); return; }
  return prepareResume(files[0]);
}
// 支持鼠标、键盘与系统文件拖放，始终阻止拖放文件导致页面跳转。
function initResumeDrop() {
  const zone = $('#resumeDropZone'); let dragDepth = 0;
  zone.addEventListener('click', () => $('#pdfFile').click());
  zone.addEventListener('keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('#pdfFile').click(); }
  });
  zone.addEventListener('dragenter', (event) => {
    event.preventDefault(); dragDepth++; zone.classList.add('drag-active');
  });
  zone.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) zone.classList.remove('drag-active'); });
  zone.addEventListener('drop', (event) => {
    event.preventDefault(); event.stopPropagation(); dragDepth = 0; zone.classList.remove('drag-active');
    acceptResumeFiles(event.dataTransfer?.files || []);
  });
  document.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) {
      event.preventDefault(); $('#pdfStatus').textContent = '请将文件拖入“选择简历文件”区域';
    }
  });
}
// 计算规范字段与稳定经历 ID，和数据库入口采用相同去重规则。
function resumeExisting(row, database, profileId) {
  if (resumeCatalogMode) {
    const entryId = LocalApplyStore.catalogTarget(database, profileId, resumeSource.fingerprint, row.kind, row.index);
    return database.fieldValues.find((item) => item.profileId === profileId && item.fieldId === row.fieldId && item.entryId === entryId);
  }
  const fieldId = database.fieldDefinitions.some((d) => d.fieldId === 'builtin.' + row.key) ? 'builtin.' + row.key : 'resume.' + row.key;
  // 重复经历按当前文件指纹查找已导入的来源行，基本信息直接按字段查询。
  return database.fieldValues.find((v) => v.profileId === profileId && v.fieldId === fieldId && (row.kind === 'basic' ? v.entryId === null
    : database.entries.some((e) => e.entryId === v.entryId && e.entryId === LocalApplyStore.resumeEntryId(profileId, resumeSource.fingerprint, row.kind, row.index))));
}
// 切换目标或刷新差异时重新绑定数据库版本，防止校对期间外部修改被覆盖。
async function renderResumeReview() {
  if (!resumeRows.length) return;
  const profileId = $('#targetProfile').value;
  const { database } = await dataRequest('localapply:read');
  if (profileId !== $('#targetProfile').value || !resumeRows.length) return;
  resumeDatabase = database;
  const root = $('#pdfReview'); root.replaceChildren();
  for (const row of resumeRows) {
    const box = document.createElement('div'); box.className = 'review-cell';
    const label = document.createElement('label'); label.className = 'review-label';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = row.checked;
    check.addEventListener('change', () => { row.checked = check.checked; });
    label.append(check, document.createTextNode(`${row.kind === 'basic' ? '基本信息' : (LocalApplyResumeCatalog.groups[row.kind] || LocalApplyResume.kinds[row.kind]) + ' ' + (row.index + 1)} · ${row.label}`));
    const definition = resumeCatalogMode && resumeCatalog.find((field) => field.fieldId === row.fieldId);
    const input = definition ? workspaceControl(definition, row.value) : document.createElement(row.key === 'description' ? 'textarea' : 'input'); if (!definition) input.value = row.value;
    (input.querySelector('[data-primary]') || input).setAttribute('aria-label', label.textContent);
    input.addEventListener(definition ? 'change' : 'input', () => { try { row.value = definition ? workspaceValue(input, definition) : input.value; evidence.textContent = '已编辑：将按人工校对保存'; } catch (error) { evidence.textContent = error.message; } });
    const evidence = document.createElement('p'); evidence.className = row.evidence.verified ? 'muted' : 'warn';
    evidence.textContent = `${row.evidence.verified ? '历史文本已核对' : '模型引用，待人工核对'} · ${row.evidence.page ? '页/图 ' + row.evidence.page : '未标页码'}：${row.evidence.excerpt || '模型没有提供来源'}`;
    const prior = document.createElement('p'); prior.className = 'muted';
    const previous = resumeExisting(row, database, profileId);
    prior.textContent = previous?.value ? `当前值：${fieldText(previous.value)}。${$('#overwriteResume').checked ? '确认后覆盖勾选项。' : '保留已有值，仅补空白。'}` : '当前为空，确认后写入。';
    box.append(label, input, evidence, prior); root.append(box);
  }
}
// 只提交勾选项；默认保留已有值，相同文件在同一档案不重复创建经历。
async function confirmResume() {
  if (!resumeDatabase || !resumeSource) return;
  $('#btnImport').disabled = true;
  $('#cancelResume').disabled = true;
  try {
    const rows = resumeImportRows(resumeRows.filter((row) => row.checked));
    const { result } = await dataCommand('importResume', { profileId: $('#targetProfile').value, fingerprint: resumeSource.fingerprint,
      rows, overwrite: $('#overwriteResume').checked, ...(resumeCatalogMode ? { catalog: resumeCatalog } : {}) }, resumeDatabase.revision);
    markResumeReport(result);
    clearResume(`已确认保存 ${result.saved} 项，保留已有值 ${result.kept} 项；可展开解析报告查看详情，原文件和全文未保存。`, false, true);
    await reloadDataState();
  } catch (error) { $('#pdfStatus').textContent = '未导入：' + error.message + '。数据变化时请点击「刷新差异」后重新核对。'; }
  finally { $('#btnImport').disabled = false; $('#cancelResume').disabled = false; }
}
// 串行保存同一页面的字段；读取最新版本后只写当前行，避免多个自动保存互相覆盖。
let resumeSaveQueue = Promise.resolve();
// 展开状态只驻留当前设置页，按档案隔离；切换导航或重绘不影响未保存的字段草稿。
const resumeExpandedGroups = new Map();
const resumeRecordExpansion = new Map(); // 每条记录独立收起/展开，仅影响本页显示，不改字段值。
// 大模块沿用参考页常用字段的分界；其他模块先展示少量字段，剩余内容由用户展开。
const resumePrimaryFieldCounts = { '基本信息': 18, '求职意向': 8, '教育背景': 7, '实习经历': 7, '工作经历': 9, '项目经历': 7, '家庭成员': 4, '获奖经历': 4, '英语能力': 3, '证书信息': 4, '论文期刊': 4 };
// 所有记录共用保存链路，普通字段默认隐藏提示；accessibleLabel 区分家庭姓名与本人姓名。
function resumeFieldEditor(profileId, entryId, definition, row, displayLabel = definition.label, accessibleLabel = displayLabel) {
  const multiline = definition.type === 'text' && typeof row?.value === 'string' && row.value.includes('\n');
  const input = workspaceControl(multiline ? { ...definition, type: 'textarea' } : definition, row?.value);
  const label = workspaceNode(input.tagName === 'DIV' ? 'div' : 'label', '', 'center-field'); label.dataset.fieldId = definition.fieldId;
  (input.querySelector('[data-primary]') || input).setAttribute('aria-label', (entryId ? '经历字段 · ' : '简历中心 · ') + accessibleLabel);
  const hint = workspaceNode('small', input.classList.contains('workspace-region') ? '选择候选或“使用输入内容”后保存 · 搜索不改动资料' : ''); hint.setAttribute('role', 'status'); hint.hidden = !hint.textContent;
  let saved = row ? structuredClone(row) : null;
  input.addEventListener('input', () => { input.dataset.dirty = 'true'; });
  input.addEventListener('change', () => {
    input.dataset.dirty = 'true'; hint.hidden = false; hint.textContent = '正在保存…';
    let value;
    try { value = workspaceValue(input, definition); }
    catch (error) { hint.textContent = '保存失败：' + error.message; return; }
    // 值在事件发生时捕获；等待期间继续输入时不清除较新的草稿。
    resumeSaveQueue = resumeSaveQueue.then(async () => {
      try {
        const { database: latest } = await dataRequest('localapply:read');
        if (!latest.profiles.some((profile) => profile.profileId === profileId) || (entryId && !latest.entries.some((entry) => entry.profileId === profileId && entry.entryId === entryId))) throw new Error('档案或经历已变化，请刷新');
        const currentDefinition = latest.fieldDefinitions.find((def) => def.fieldId === definition.fieldId);
        if (JSON.stringify(currentDefinition) !== JSON.stringify(definition)) throw new Error('字段定义已修改，请刷新后重新核对');
        const current = latest.fieldValues.find((item) => item.profileId === profileId && item.fieldId === definition.fieldId && item.entryId === entryId);
        if (!!current !== !!saved || JSON.stringify(current?.value) !== JSON.stringify(saved?.value)) throw new Error('该字段已被其他页面修改，请刷新后重新核对');
        await dataCommand('setValue', { profileId, entryId, fieldId: definition.fieldId, value }, latest.revision);
        saved = { value };
        if (JSON.stringify(workspaceValue(input, definition)) === JSON.stringify(value)) input.dataset.dirty = '';
        hint.textContent = '已保存在本地 · 手动资料'; $('#centerStatus').textContent = '已保存在本地';
        if (workspaceInitialized) await refreshWorkspace();
      } catch (error) { hint.textContent = '保存失败：' + error.message; $('#centerStatus').textContent = hint.textContent; }
    });
  });
  label.append(workspaceNode('span', displayLabel), input, hint);
  return label;
}
// 用户明确清空后仅删除旧经历；目录记录和基础字段保留，恢复点由后台保存。
async function clearLegacyResumeEntries() {
  const status = $('#entryStatus');
  const button = $('#clearResumeEntries'); button.disabled = true;
  try {
    await resumeSaveQueue;
    if (workspaceDirty() && !confirm('存在未保存编辑，继续将丢弃这些编辑，是否继续？')) return;
    const { database } = await dataRequest('localapply:read'); const profileId = $('#entryProfile').value;
    const entries = database.entries.filter((entry) => entry.profileId === profileId && !entry.entryId.startsWith('catalog.'));
    if (!entries.length) { await reloadDataState(profileId); status.textContent = '当前简历没有旧经历需要清理。'; return; }
    const entryIds = new Set(entries.map((entry) => entry.entryId));
    const values = database.fieldValues.filter((row) => entryIds.has(row.entryId)).length;
    const mappings = database.mappingRules.filter((row) => entryIds.has(row.entryId)).length;
    if (!confirm(`清空当前简历的 ${entries.length} 条旧经历、${values} 个经历字段值和 ${mappings} 条关联映射？\n基础字段及其值、其他简历和模型配置保留。清理前保存恢复点，可在“数据与备份”恢复；该恢复点会替换上一次恢复点。`)) return;
    const { result } = await dataCommand('clearResumeEntries', { profileId, confirmed: true }, database.revision);
    await reloadDataState(profileId);
    status.textContent = `已清空 ${result.entries} 条旧经历及 ${result.values} 个经历字段值。可在“数据与备份”恢复清理前资料。`;
  } catch (error) { status.textContent = '清理失败：' + error.message; }
  finally { button.disabled = false; }
}
// 共享模块字段模板生成一条记录的全部控件；各记录仅值和展开状态不同，不复制定义。
function resumeRecordFields(profileId, group, items, entryId, index, ordinal) {
  const root = workspaceNode('div', '', 'resume-record-fields'); const key = group.group + ':' + (entryId || 'primary');
  const limit = Object.hasOwn(resumePrimaryFieldCounts, group.group) ? resumePrimaryFieldCounts[group.group] : group.items.length > 4 ? 4 : 2;
  const fields = workspaceNode('div', '', 'basic-grid');
  const extra = workspaceNode('div', '', 'basic-grid resume-more-fields'); extra.id = 'resumeMoreFields' + index + 'Record' + ordinal;
  items.forEach(({ definition, row }, position) => {
    const label = group.group === '家庭成员' ? definition.label.replace(/^家庭成员一[·・]/, '') : definition.label;
    (position < limit ? fields : extra).append(resumeFieldEditor(profileId, entryId, definition, row, label, group.group === '家庭成员' ? '家庭成员 · ' + label : label));
  });
  root.append(fields);
  if (extra.childElementCount) {
    const toggle = workspaceNode('button', '', 'resume-more-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-controls', extra.id);
    const text = workspaceNode('span'); const arrow = workspaceNode('span', '⌄', 'resume-more-arrow'); arrow.setAttribute('aria-hidden', 'true'); toggle.append(text, arrow);
    // 切换只改本页显示状态，数量来自字段节点，不读取或展示个人值。
    function update(expanded) { extra.hidden = !expanded; toggle.setAttribute('aria-expanded', String(expanded)); text.textContent = (expanded ? '收起更多内容' : '展开更多内容') + '（' + extra.childElementCount + ' 项）'; }
    update(resumeExpandedGroups.get(profileId)?.has(key) || false);
    toggle.addEventListener('click', () => {
      if (!resumeExpandedGroups.has(profileId)) resumeExpandedGroups.set(profileId, new Set());
      const expanded = extra.hidden; const groups = resumeExpandedGroups.get(profileId);
      if (expanded) groups.add(key); else groups.delete(key);
      update(expanded); scheduleResumePosition();
    });
    root.append(toggle, extra);
  }
  return root;
}
// 添加空记录或确认删除任一记录；首条使用 null 定位，操作类型由按钮明确区分。
async function manageModuleRecord(profileId, group, entryId, button) {
  button.disabled = true; const deleting = button.dataset.moduleAction === 'delete';
  try {
    await resumeSaveQueue; if (workspaceDirty()) throw new Error('请先处理未保存的字段编辑，再管理记录');
    const { database } = await dataRequest('localapply:read');
    if (deleting && !confirm(`删除当前简历“${group}”中的这条记录及其内容、映射？其他记录及共享字段保留，最后一条删除后保留空白模板。删除前保存恢复点，可在“数据与备份”恢复；本次恢复点会替换上一次恢复点。`)) return;
    const out = await dataCommand(deleting ? 'deleteModuleRecord' : 'addModuleRecord', deleting ? { profileId, group, entryId, confirmed: true } : { profileId, group }, database.revision);
    if (!deleting) { if (!resumeRecordExpansion.has(profileId)) resumeRecordExpansion.set(profileId, new Map()); resumeRecordExpansion.get(profileId).set(group + ':' + out.result, true); }
    await reloadDataState(profileId); $('#centerStatus').textContent = deleting ? '已删除此条记录，共享字段及其他记录保留，最后一条仅留下空白模板；可在数据与备份恢复。' : '已添加空白记录，与同模块其他记录共享字段。';
    if (!deleting) Array.from($('#basicFields').querySelectorAll('[data-entry-id]')).find((node) => node.dataset.entryId === out.result)?.scrollIntoView({ block: 'start' });
  } catch (error) { $('#centerStatus').textContent = '记录未变更：' + error.message; }
  finally { button.disabled = false; }
}
// 八个重复模块内逐条展开/收起，首条兼容原有平面值，其他条目共享相同字段模板。
function resumeGroupEditor(profileId, group, index) {
  const section = workspaceNode('section', '', 'resume-group'); section.dataset.group = group.group;
  const header = workspaceNode('div', '', 'resume-group-header'); const heading = workspaceNode('h3', group.group, 'center-group-heading'); heading.id = 'resumeGroupHeading' + index;
  section.setAttribute('aria-labelledby', heading.id); header.append(heading); section.append(header);
  if (!Object.values(WangshenTemplates.RECORD_GROUPS).includes(group.group)) { section.append(resumeRecordFields(profileId, group, group.items, null, index, 0)); return section; }
  const add = workspaceNode('button', group.group === '教育背景' ? '添加教育经历' : '添加' + (group.group === '证书信息' ? '证书' : group.group), 'btn ghost'); add.type = 'button'; add.dataset.moduleAction = 'add'; add.addEventListener('click', () => manageModuleRecord(profileId, group.group, null, add)); header.append(add);
  const records = [{ entryId: null, items: group.items }, ...(group.records || [])];
  records.forEach((record, ordinal) => {
    const details = workspaceNode('details', '', 'resume-record' + (record.entryId ? '' : ' resume-primary-record')); details.dataset.entryId = record.entryId || 'primary';
    const key = group.group + ':' + (record.entryId || 'primary'); details.open = resumeRecordExpansion.get(profileId)?.get(key) ?? !record.entryId;
    const summary = workspaceNode('summary'); summary.append(workspaceNode('span', `第 ${ordinal + 1} 条${group.group} · 展开 / 收起`));
    const remove = workspaceNode('button', '删除此条记录', 'btn ghost'); remove.type = 'button'; remove.dataset.moduleAction = 'delete'; remove.setAttribute('aria-label', `删除第 ${ordinal + 1} 条${group.group}`);
    // 删除按钮常驻标题，鼠标与键盘激活均不触发 summary 的展开/收起。
    remove.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); manageModuleRecord(profileId, group.group, record.entryId, remove); }); summary.append(remove); details.append(summary);
    details.addEventListener('toggle', () => { if (!details.isConnected) return; if (!resumeRecordExpansion.has(profileId)) resumeRecordExpansion.set(profileId, new Map()); resumeRecordExpansion.get(profileId).set(key, details.open); scheduleResumePosition(); });
    details.append(resumeRecordFields(profileId, group, record.items, record.entryId, index, ordinal)); section.append(details);
  });
  return section;
}
// 渲染基础模块及目录经历；旧契约经历保留清理提示，各模块先显示常用字段。
async function renderResumeCenter() {
  const { database } = await dataRequest('localapply:read'); const profileId = $('#entryProfile').value;
  const root = $('#basicFields');
  // 切档案/重绘前保存旧视图的真实状态，按旧档案隔离，不依赖尚未派发的 toggle 事件。
  if (root.dataset.profileId) { const previousId = root.dataset.profileId; if (!resumeRecordExpansion.has(previousId)) resumeRecordExpansion.set(previousId, new Map()); root.querySelectorAll('.resume-record').forEach((record) => { const group = record.closest('.resume-group').dataset.group; resumeRecordExpansion.get(previousId).set(group + ':' + record.dataset.entryId, record.open); }); }
  root.dataset.profileId = profileId; root.replaceChildren();
  const legacyCount = database.entries.filter((entry) => entry.profileId === profileId && !entry.entryId.startsWith('catalog.')).length;
  $('#legacyEntriesNotice').hidden = legacyCount === 0;
  $('#legacyEntriesHint').textContent = `当前简历保留 ${legacyCount} 条旧经历记录，已停止显示独立经历卡片。可清空后按基础字段重新整理。`;
  if (!database.profiles.some((profile) => profile.profileId === profileId)) { renderResumeToc(); return; }
  for (const [index, group] of LocalApplyProfileView.editorSections(database, profileId).entries()) {
    root.append(resumeGroupEditor(profileId, group, index));
  }
  renderResumeToc();
}
// 独立挂载导入和本地编辑入口，切换文件时取消旧任务。
function initResume() {
  initResumeDrop();
  $('#clearResumeEntries').addEventListener('click', clearLegacyResumeEntries);
  $('#btnExtract').addEventListener('click', () => prepareResume());
  $('#sendResume').addEventListener('click', analyzeResume);
  $('#btnImport').addEventListener('click', confirmResume);
  $('#downloadResumeReport').addEventListener('click', () => { if (lastResumeReport) downloadJson(lastResumeReport, 'localapply-resume-report.json'); });
  $('#retryResumeImport').addEventListener('click', () => autoImportResume());
  $('#autoImportResume').addEventListener('change', updateResumeImportMode); updateResumeImportMode();
  $('#selectAllResume').addEventListener('click', () => {
    resumeRows.forEach((row) => { row.checked = true; });
    document.querySelectorAll('#pdfReview input[type="checkbox"]').forEach((control) => { control.checked = true; });
  });
  $('#cancelResume').addEventListener('click', () => clearResume('已取消，本次草稿已清理，未写入资料。'));
  $('#pdfFile').addEventListener('change', (event) => {
    if (event.target.files.length) acceptResumeFiles(event.target.files);
  });
  $('#targetProfile').addEventListener('change', () => renderResumeReview().catch((e) => { $('#pdfStatus').textContent = e.message; }));
  $('#overwriteResume').addEventListener('change', () => renderResumeReview().catch((e) => { $('#pdfStatus').textContent = e.message; }));
  $('#refreshReview').addEventListener('click', () => renderResumeReview().catch((e) => { $('#pdfStatus').textContent = e.message; }));
  window.addEventListener('pagehide', () => clearResume());
}
