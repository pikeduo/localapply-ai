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
    await reloadDataState(); await renderResumeCenter();
  } catch (error) { $('#pdfStatus').textContent = '未导入：' + error.message + '。数据变化时请点击「刷新差异」后重新核对。'; }
  finally { $('#btnImport').disabled = false; $('#cancelResume').disabled = false; }
}
// 按分类和字段类型编辑；三方合并保留并发保护，手动编辑清除旧 AI 来源。
async function renderResumeCenter() {
  const root = $('#basicFields'); root.replaceChildren();
  const fresh = await getState(); state = fresh;
  const profile = fresh.profiles.find((p) => p.id === $('#entryProfile').value);
  if (!profile) return;
  const groups = [...new Set(profile.fields.filter((field) => !field.material).map((field) => field.group))];
  const selectedGroup = $('#centerGroup').value; $('#centerGroup').replaceChildren(new Option('全部分类', ''), ...groups.map((group) => new Option(group, group))); $('#centerGroup').value = selectedGroup;
  let priorGroup;
  for (const field of profile.fields.filter((f) => !f.material).sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group))) {
    if (priorGroup !== field.group) { const heading = document.createElement('h3'); heading.textContent = field.group; heading.dataset.group = field.group; heading.className = 'center-group-heading'; root.append(heading); priorGroup = field.group; }
    const label = document.createElement('label'); label.className = 'center-field';
    const text = document.createElement('span'); text.textContent = field.label;
    const def = { type: field.inputType, options: field.options || [] }; const input = workspaceControl(def, field.value);
    input.setAttribute('aria-label', '简历中心 · ' + field.label);
    input.addEventListener('input', () => { input.dataset.dirty = 'true'; });
    input.addEventListener('change', async () => {
      try {
        const next = await getState();
        const current = next.profiles.find((p) => p.id === profile.id)?.fields.find((f) => f.fid === field.fid);
        if (!current) throw new Error('档案或字段已变化，请刷新');
        if (JSON.stringify(current.value) !== JSON.stringify(field.value)) throw new Error('该字段已被其他页面修改，请刷新后重新核对');
        current.value = workspaceValue(input, def);
        await saveState(next); state = next;
        field.value = current.value; input.dataset.dirty = ''; if (workspaceInitialized) await refreshWorkspace();
        $('#centerStatus').textContent = '已保存在本地';
      } catch (error) { $('#centerStatus').textContent = '保存失败：' + error.message; }
    });
    const source = document.createElement('small'); source.textContent = '修改后离开输入框自动保存 · 保存失败保留输入';
    label.append(text, input, source); root.append(label);
  }
  // 新建档案或重新导入后立即同步目录，避免继续指向上一份档案。
  renderResumeToc();
}
// 独立挂载导入和本地编辑入口，切换文件时取消旧任务。
function initResume() {
  initResumeDrop();
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
  $('#createResumeProfile').addEventListener('click', async () => {
    try {
      const { result } = await dataCommand('createProfile', { name: $('#newProfileName').value.trim() });
      await reloadDataState(); $('#entryProfile').value = result; $('#targetProfile').value = result;
      await renderEntries(); await renderResumeCenter(); $('#newProfileName').value = '';
    } catch (error) { $('#centerStatus').textContent = error.message; }
  });
  window.addEventListener('pagehide', () => clearResume());
}
