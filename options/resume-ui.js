// 简历中心与导入审核：本地读取→明确发送→逐项校对→一次提交，不保存原文件。
'use strict';
let resumeJob = null;
let resumeSource = null;
let resumeRows = [];
let resumeDatabase = null;
let selectedResumeFile = null; // 仅留在当前页面内存，取消或识别完成后释放。
// 清理旧任务及其草稿，迟到响应不能重建已取消的审核结果。
function clearResume(message = '', keepFile = false) {
  if (resumeJob) {
    resumeJob.controller.abort();
    sendMessage('wsa:cancelResume', { requestId: resumeJob.id });
  }
  resumeJob = resumeSource = resumeDatabase = null; resumeRows = [];
  selectedResumeFile = null;
  if (!keepFile) $('#pdfFile').value = '';
  $('#sourcePreview').textContent = ''; $('#pdfReview').replaceChildren();
  $('#resumePreview').open = false; $('#resumeFileInfo').textContent = '尚未选择文件';
  $('#importRow').style.display = 'none'; $('#sendResume').hidden = true;
  $('#sendResume').disabled = false;
  $('#pdfStatus').textContent = message; $('#btnExtract').disabled = false;
}
// 本地仅生成页面预览，包含所有可渲染文字和图片；不做字段抽取和文字识别。
async function prepareResume(file = selectedResumeFile || $('#pdfFile').files[0]) {
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
    $('#pdfStatus').textContent = `已生成 ${source.pages.length} 张页面预览，文字和嵌入图片均交由模型识别。尚未发送文件，请先检测模型能力。`;
    $('#sendResume').hidden = false;
  } catch (error) { if (resumeJob === job) clearResume('读取失败：' + error.message); }
  finally { if (resumeJob === job) $('#btnExtract').disabled = false; }
}
// 解析失败或取消都不写入数据库，所有结果必须经过人工选择。
async function analyzeResume() {
  const job = resumeJob; const source = resumeSource;
  if (!job || !source) return;
  $('#sendResume').disabled = true; $('#btnExtract').disabled = true;
  $('#pdfStatus').textContent = '正在调用当前模型解析，最长每次请求 2 分钟，可随时取消…';
  try {
    await flushCredentials();
    if (resumeJob !== job) return;
    const { route } = await dataRequest('wsa:resumeRoute', { format: source.type });
    if (resumeJob !== job) return;
    const file = route.mode === 'file' ? { filename: 'resume.' + source.type,
      file_data: LocalApplyProbes.dataUrl(source.bytes, source.type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') } : undefined;
    source.mode = route.mode;
    $('#pdfStatus').textContent = `正在由 ${route.model} 识别${file ? '原文件（包括图片内容）' : source.pages.length + ' 张完整页面图片'}，可取消…`;
    const response = await dataRequest('wsa:aiExtractResume', { payload: { requestId: job.id, type: source.type, routeToken: route.token,
      mode: route.mode, file, pages: file ? undefined : source.pages } });
    if (resumeJob !== job) return;
    resumeRows = LocalApplyResume.normalize(response.data, source);
    // 文件识别结束释放原字节，页面预览仅留在本次内存供人工核对。
    source.bytes = source.renderBytes = selectedResumeFile = null;
    $('#sendResume').hidden = true;
    $('#pdfStatus').textContent = '解析完成。所有字段均由模型识别，默认不勾选；请对照页面图片核对引用、字段值及目标档案后选择导入。';
    $('#importRow').style.display = '';
    await renderResumeReview();
  } catch (error) {
    if (resumeJob === job) { $('#pdfStatus').textContent = '解析失败：' + error.message; $('#sendResume').hidden = false; }
  } finally {
    if (resumeJob === job) { $('#sendResume').disabled = false; $('#btnExtract').disabled = false; }
  }
}
// 文件选择和拖放使用同一入口；一次只接收一份简历，预览不会调用模型。
function acceptResumeFiles(files) {
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
    label.append(check, document.createTextNode(`${row.kind === 'basic' ? '基本信息' : LocalApplyResume.kinds[row.kind] + ' ' + (row.index + 1)} · ${row.label}`));
    const input = document.createElement(row.key === 'description' ? 'textarea' : 'input'); input.value = row.value;
    input.setAttribute('aria-label', label.textContent); input.addEventListener('input', () => { row.value = input.value; evidence.textContent = '已编辑：将按人工校对保存'; });
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
    const rows = resumeRows.filter((row) => row.checked).map((row) => ({ kind: row.kind, index: row.index, key: row.key, value: row.value,
      evidence: row.value === row.original ? row.evidence : { kind: 'manual', excerpt: '', page: 0, verified: false } }));
    const { result } = await dataCommand('importResume', { profileId: $('#targetProfile').value, fingerprint: resumeSource.fingerprint,
      rows, overwrite: $('#overwriteResume').checked }, resumeDatabase.revision);
    clearResume(`已确认保存 ${result.saved} 项，保留已有值 ${result.kept} 项；原文件和全文未保存。`);
    await reloadDataState();
  } catch (error) { $('#pdfStatus').textContent = '未导入：' + error.message + '。数据变化时请点击「刷新差异」后重新核对。'; }
  finally { $('#btnImport').disabled = false; $('#cancelResume').disabled = false; }
}
// 串行保存同一页面的字段；读取最新版本后只写当前行，避免多个自动保存互相覆盖。
let resumeSaveQueue = Promise.resolve();
// 所有基础字段共用保存链路；复合编辑器标注内部输入，失败保留草稿且不重建其他字段。
function resumeFieldEditor(profileId, entryId, definition, row, displayLabel = definition.label) {
  const multiline = definition.type === 'text' && typeof row?.value === 'string' && row.value.includes('\n');
  const input = workspaceControl(multiline ? { ...definition, type: 'textarea' } : definition, row?.value);
  const label = workspaceNode(input.tagName === 'DIV' ? 'div' : 'label', '', 'center-field'); label.dataset.fieldId = definition.fieldId;
  (input.querySelector('[data-primary]') || input).setAttribute('aria-label', (entryId ? '经历字段 · ' : '简历中心 · ') + displayLabel);
  const hint = workspaceNode('small', '修改后离开输入框自动保存 · 保存失败保留输入'); hint.setAttribute('role', 'status');
  let saved = row ? structuredClone(row) : null;
  input.addEventListener('input', () => { input.dataset.dirty = 'true'; });
  input.addEventListener('change', () => {
    input.dataset.dirty = 'true'; hint.textContent = '正在保存…';
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
// 用户明确清空后按预览版本删除旧经历；恢复点由后台保存，不将旧值自动搬到基础字段。
async function clearLegacyResumeEntries() {
  const status = $('#entryStatus');
  const button = $('#clearResumeEntries'); button.disabled = true;
  try {
    await resumeSaveQueue;
    if (workspaceDirty() && !confirm('存在未保存编辑，继续将丢弃这些编辑，是否继续？')) return;
    const { database } = await dataRequest('localapply:read'); const profileId = $('#entryProfile').value;
    const entries = database.entries.filter((entry) => entry.profileId === profileId);
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
// 只渲染现有基础字段分类，旧经历仅提供清理提示，不自动生成新模块或覆盖基础值。
async function renderResumeCenter() {
  const { database } = await dataRequest('localapply:read'); const profileId = $('#entryProfile').value;
  const root = $('#basicFields'); root.replaceChildren();
  const legacyCount = database.entries.filter((entry) => entry.profileId === profileId).length;
  $('#legacyEntriesNotice').hidden = legacyCount === 0;
  $('#legacyEntriesHint').textContent = `当前简历保留 ${legacyCount} 条旧经历记录，已停止显示独立经历卡片。可清空后按基础字段重新整理。`;
  if (!database.profiles.some((profile) => profile.profileId === profileId)) { renderResumeToc(); return; }
  for (const [index, group] of LocalApplyProfileView.editorSections(database, profileId).entries()) {
    const section = workspaceNode('section', '', 'resume-group'); section.dataset.group = group.group;
    const header = workspaceNode('div', '', 'resume-group-header');
    const heading = workspaceNode('h3', group.group, 'center-group-heading'); heading.id = 'resumeGroupHeading' + index;
    section.setAttribute('aria-labelledby', heading.id); header.append(heading);
    section.append(header);
    if (group.items.length) {
      const fields = workspaceNode('div', '', 'basic-grid');
      group.items.forEach(({ definition, row }) => fields.append(resumeFieldEditor(profileId, null, definition, row))); section.append(fields);
    }
    root.append(section);
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
