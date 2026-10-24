// 简历中心与导入审核：本地读取→明确发送→逐项校对→一次提交，不保存原文件。
'use strict';
let resumeJob = null;
let resumeSource = null;
let resumeRows = [];
let resumeDatabase = null;
// 清理旧任务及其草稿，迟到响应不能重建已取消的审核结果。
function clearResume(message = '', keepFile = false) {
  if (resumeJob) {
    resumeJob.controller.abort();
    sendMessage('wsa:cancelResume', { requestId: resumeJob.id });
  }
  resumeJob = resumeSource = resumeDatabase = null; resumeRows = [];
  if (!keepFile) $('#pdfFile').value = '';
  $('#sourcePreview').textContent = ''; $('#pdfReview').replaceChildren();
  $('#importRow').style.display = 'none'; $('#sendResume').hidden = true;
  $('#sendResume').disabled = false;
  $('#pdfStatus').textContent = message; $('#btnExtract').disabled = false;
}
// 本地预览不联网，只有点击发送按钮才允许调用用户所选模型。
async function prepareResume() {
  const file = $('#pdfFile').files[0];
  if (!file) { $('#pdfStatus').textContent = '请先选择 PDF 或 DOCX'; return; }
  clearResume();
  const job = { id: crypto.randomUUID(), controller: new AbortController() }; resumeJob = job;
  $('#btnExtract').disabled = true; $('#pdfStatus').textContent = '正在本地读取与检查文件…';
  try {
    const source = await LocalApplyFiles.read(file, job.controller.signal);
    if (resumeJob !== job) return;
    resumeSource = source;
    $('#sourcePreview').textContent = source.text || '未读取到文字，可使用视觉模型逐页识别。';
    $('#pdfStatus').textContent = source.mode === 'vision'
      ? `扫描件，共 ${source.pages.length} 页。点击发送后会把页面图片发送给当前服务商，每页一次调用。请核对视觉模型能力和费用。`
      : `本地读取完成，${source.text.length} 字。尚未联网；发送前可展开核对文本。DOCX 的页码按文本块展示。`;
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
    const pages = source.mode === 'vision' ? await LocalApplyFiles.pdf(source.bytes, job.controller.signal, true) : undefined;
    if (resumeJob !== job) return;
    const response = await dataRequest('wsa:aiExtractResume', { payload: { requestId: job.id, text: source.text, pages } });
    if (resumeJob !== job) return;
    resumeRows = LocalApplyResume.normalize(response.data, source);
    // 渲染完成后立即释放扫描原字节，校对区只保留有限来源片段。
    source.bytes = null;
    $('#sendResume').hidden = true;
    $('#pdfStatus').textContent = '解析完成。请核对来源和目标档案；无可验证来源的字段默认不选中。修改过的值标记为人工校对。';
    $('#importRow').style.display = '';
    await renderResumeReview();
  } catch (error) {
    if (resumeJob === job) { $('#pdfStatus').textContent = '解析失败：' + error.message; $('#sendResume').hidden = false; }
  } finally {
    if (resumeJob === job) { $('#sendResume').disabled = false; $('#btnExtract').disabled = false; }
  }
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
    evidence.textContent = `${row.evidence.verified ? '原文已核对' : '来源待人工核对'} · ${row.evidence.page ? '页/块 ' + row.evidence.page : '未标页码'}：${row.evidence.excerpt || '模型没有提供来源'}`;
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
// 简历中心复用旧字段保存入口，手动编辑会清除此前的 AI 来源标记。
async function renderResumeCenter() {
  const root = $('#basicFields'); root.replaceChildren();
  const fresh = await getState(); state = fresh;
  const profile = fresh.profiles.find((p) => p.id === $('#entryProfile').value);
  if (!profile) return;
  for (const field of profile.fields.filter((f) => !f.material)) {
    const label = document.createElement('label'); label.className = 'center-field';
    const text = document.createElement('span'); text.textContent = field.label;
    const input = document.createElement('input'); input.type = 'text'; input.value = fieldText(field.value);
    input.setAttribute('aria-label', '简历中心 · ' + field.label);
    input.addEventListener('change', async () => {
      try {
        const next = await getState();
        const current = next.profiles.find((p) => p.id === profile.id)?.fields.find((f) => f.fid === field.fid);
        if (!current) throw new Error('档案或字段已变化，请刷新');
        current.value = input.value === '' ? '' : field.inputType === 'number' ? Number(input.value)
          : ['boolean', 'multiSelect'].includes(field.inputType) ? JSON.parse(input.value) : input.value;
        await saveState(next); state = next;
        $('#centerStatus').textContent = '已保存在本地';
      } catch (error) { $('#centerStatus').textContent = '保存失败：' + error.message; }
    });
    label.append(text, input); root.append(label);
  }
}
// 独立挂载导入和本地编辑入口，切换文件时取消旧任务。
function initResume() {
  $('#btnExtract').addEventListener('click', prepareResume);
  $('#sendResume').addEventListener('click', analyzeResume);
  $('#btnImport').addEventListener('click', confirmResume);
  $('#cancelResume').addEventListener('click', () => clearResume('已取消，本次草稿已清理，未写入资料。'));
  $('#pdfFile').addEventListener('change', () => clearResume('', true));
  $('#targetProfile').addEventListener('change', () => renderResumeReview().catch((e) => { $('#pdfStatus').textContent = e.message; }));
  $('#overwriteResume').addEventListener('change', () => renderResumeReview().catch((e) => { $('#pdfStatus').textContent = e.message; }));
  $('#refreshReview').addEventListener('click', () => renderResumeReview().catch((e) => { $('#pdfStatus').textContent = e.message; }));
  $('#entryProfile').addEventListener('change', renderResumeCenter);
  $('#createResumeProfile').addEventListener('click', async () => {
    try {
      const { result } = await dataCommand('createProfile', { name: $('#newProfileName').value.trim() });
      await reloadDataState(); $('#entryProfile').value = result; $('#targetProfile').value = result;
      await renderEntries(); await renderResumeCenter(); $('#newProfileName').value = '';
    } catch (error) { $('#centerStatus').textContent = error.message; }
  });
  window.addEventListener('pagehide', () => clearResume());
}
