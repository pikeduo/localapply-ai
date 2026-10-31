// 岗位元数据优先本地识别，AI 须预览确认；回填卡片与保存记录保持独立。
(function (global) {
  'use strict';
  const $ = (id) => document.getElementById(id); const A = global.LocalApplyApplications; let snapshot = null; let revision; let busy = false; let edited = false; let attempts = 0;
  let aiPreview = null; let aiVersion = 0; let editVersion = 0;
  // 只展示固定错误提示和当前操作结果，所有网页文字进入文本节点。
  function status(text) { $('jobStatus').textContent = text; }
  // 各入口共用忙状态，取消按钮始终可用，识别期间手动编辑仍会受到版本保护。
  function setBusy(value) {
    busy = value;
    for (const id of ['jobScan', 'jobAI', 'jobSave', 'jobConfirmApplied']) $(id).disabled = value;
    $('jobScan').disabled = value || !!aiPreview;
    $('jobAISend').disabled = value || !aiPreview;
    $('jobAIReview').setAttribute('aria-busy', String(value));
  }
  // 公司/岗位/地点和当前链接统一回填可信卡片，不修改招聘网页上的任何控件。
  function renderCandidate(candidate) {
    $('jobCompany').value = candidate.companyName; $('jobTitle').value = candidate.jobTitle; $('jobLocation').value = candidate.location; $('jobUrl').value = candidate.jobUrl;
    $('jobMeta').textContent = [candidate.jobSource, candidate.employmentType].filter(Boolean).join(' · '); $('jobForm').hidden = false;
  }
  // 确认前读取候选，不写个人库；已记录信息仅在当前卡片内展示。
  async function scan(automatic = false) {
    if (busy || aiPreview || automatic && (edited || snapshot?.recognized)) return;
    setBusy(true);
    try {
      const response = await sendMessage('jobs:scan'); if (!response.ok) throw new Error(response.error); snapshot = response;
      const local = await sendMessage('localapply:read'); if (!local.ok) throw new Error(local.error); revision = local.database.revision;
      // 自动请求返回前用户也可能开始编辑，迟到结果不得覆盖已输入的内容。
      if (automatic && edited) return;
      renderCandidate(snapshot.candidate);
      $('jobNewRound').checked = false; $('jobSaveStatus').value = snapshot.existing?.status === 'draft' ? 'draft' : 'saved'; $('jobSuccess').hidden = !snapshot.successSuggested; $('jobForm').hidden = false;
      edited = false;
      status(snapshot.successSuggested ? '检测到用户提交后的成功反馈，请核对岗位并确认记录。' : snapshot.feedback === 'failed' ? '网页反馈投递失败，申请不会标记为已投递。' : snapshot.existing ? `已有第 ${snapshot.existing.round} 轮记录：${A.statusLabel(snapshot.existing.status)}，最近更新 ${new Date(snapshot.existing.updatedAt).toLocaleDateString('zh-CN')}。重复保存只补空白信息。` : snapshot.recognized ? '已自动识别当前岗位，可确认保存；缺少的信息可手动补全。' : '岗位信息不完整，正在等待页面加载；也可手动补全公司和职位后确认保存。');
    } catch (error) { status(error.message); } finally { setBusy(false); }
  }
  // 主动预览接收方和脱敏岗位文本，不联网；凭据和个人简历不会进入预览。
  async function prepareAI() {
    if (busy) return; const version = ++aiVersion; aiPreview = null; $('jobAIReview').hidden = true; $('jobAIPayload').textContent = ''; setBusy(true);
    try {
      const result = await sendMessage('jobs:prepareAI'); if (!result.ok) throw new Error(result.error);
      if (version !== aiVersion) return; aiPreview = result;
      $('jobAIRecipient').textContent = `接收方：${result.recipient.name} · ${result.recipient.baseUrl} · ${result.recipient.model}（${result.recipient.protocol}）`;
      $('jobAIPayload').textContent = JSON.stringify(result.payload, null, 2); $('jobAIConsent').checked = false; $('jobAIReview').hidden = false;
      $('jobAIReview').scrollIntoView({ block: 'nearest' }); status('请核对接收方和发送内容，确认后使用 AI 识别当前岗位。');
    } catch (error) { if (version === aiVersion) status(error.message); }
    finally { if (version === aiVersion) setBusy(false); }
  }
  // 明确发送后将有原文依据的建议自动填入卡片；迟到结果不得覆盖期间的手动编辑。
  async function recognizeAI() {
    if (busy || !aiPreview) return;
    if (!$('jobAIConsent').checked) { status('请先勾选确认发送上述岗位文本。'); return; }
    const version = ++aiVersion; const edit = editVersion; const token = aiPreview.token; setBusy(true); status('AI 正在识别岗位信息…');
    try {
      const result = await sendMessage('jobs:recognizeAI', { token, confirmed: true }); if (!result.ok) throw new Error(result.error);
      if (version !== aiVersion) return;
      if (edit !== editVersion) { status('识别期间岗位内容已被修改，AI 结果未覆盖你的输入，请重新识别。'); return; }
      const local = await sendMessage('localapply:read'); if (!local.ok) throw new Error(local.error);
      if (version !== aiVersion) return;
      if (edit !== editVersion) { status('识别期间岗位内容已被修改，AI 结果未覆盖你的输入，请重新识别。'); return; }
      revision = local.database.revision;
      const candidate = A.candidate({ ...snapshot?.candidate, companyName: $('jobCompany').value.trim(), jobTitle: $('jobTitle').value.trim(), location: $('jobLocation').value.trim(), ...result.suggestion });
      // AI 不能推断投递成功；原有用户提交反馈保持原状态，仅重新查找同岗位本地记录。
      snapshot = { ...snapshot, candidate, documentId: result.documentId, recognized: !!(candidate.companyName && candidate.jobTitle), existing: local.database.applications.filter((row) => A.identity(row) === A.identity(candidate)).sort((a, b) => b.round - a.round)[0] || null };
      renderCandidate(candidate); edited = true;
      const missing = [['公司', candidate.companyName], ['岗位', candidate.jobTitle], ['地点', candidate.location]].filter((item) => !item[1]).map((item) => item[0]);
      status('AI 识别结果已填入岗位卡片，请核对后确认保存。' + (missing.length ? ` ${missing.join('、')}缺少依据，请手动补全。` : '') + ' 未自动保存或投递。');
    } catch (error) { if (version === aiVersion) status('AI 识别未完成：' + error.message + '。已有内容已保留，可重试或手动补全。'); }
    finally { if (version === aiVersion) { aiPreview = null; $('jobAIReview').hidden = true; $('jobAIPayload').textContent = ''; setBusy(false); } }
  }
  // 取消立即丢弃界面预览并撤销后台请求；旧响应不能回填。
  async function cancelAI() {
    ++aiVersion; aiPreview = null; $('jobAIReview').hidden = true; $('jobAIPayload').textContent = ''; setBusy(true);
    try { await sendMessage('jobs:cancelAI'); status('已取消 AI 岗位识别，已有内容已保留。'); }
    finally { setBusy(false); }
  }
  // 只有独立确认才能标记已投递，不会点击网页提交或使用模型推断状态。
  async function save(applied = false) {
    if (!snapshot || busy || !$('jobForm').reportValidity()) return;
    const record = { ...snapshot.candidate, companyName: $('jobCompany').value.trim(), jobTitle: $('jobTitle').value.trim(), location: $('jobLocation').value.trim(), jobUrl: $('jobUrl').value.trim(), status: applied ? 'applied' : $('jobSaveStatus').value };
    if (!confirm(`确认保存申请记录？\n公司：${record.companyName}\n岗位：${record.jobTitle}\n地点：${record.location}\n平台：${record.jobSource}\n链接：${record.jobUrl}\n状态：${A.statusLabel(record.status)}\n只更新本地记录，不提交网页申请。`)) return;
    setBusy(true);
    try {
      // 成功确认更新已有轮次；普通重复保存继续走只补空白的去重流程。
      const existing = applied && !$('jobNewRound').checked ? snapshot.existing : null;
      const fields = existing ? { ...Object.fromEntries(A.EDIT_KEYS.map((key) => [key, existing[key]])), status: 'applied', appliedAt: existing.appliedAt || new Date().toISOString() } : record;
      const result = await sendMessage('localapply:command', { request: { action: 'saveApplication', expectedRevision: revision, payload: { record: fields, applicationId: existing?.applicationId, newRound: $('jobNewRound').checked, confirmed: true } } });
      if (!result.ok) throw new Error(result.error); revision = result.revision;
      const local = await sendMessage('localapply:read'); snapshot.existing = local.database.applications.find((row) => row.applicationId === result.result.applicationId);
      if (applied) await sendMessage('jobs:acknowledge'); // 清除本页已确认的临时提示，刷新不重复提示同一次成功。
      $('jobSuccess').hidden = true; status(result.result.duplicate ? '已复用已有申请，原有状态与备注保留。' : applied ? '已确认记录为已投递。' : '岗位已保存到本地申请追踪。');
    } catch (error) { status('未保存：' + error.message + '。输入已保留，可重新识别或到申请追踪管理。'); }
    finally { setBusy(false); }
  }
  $('jobScan').addEventListener('click', () => scan()); $('jobForm').addEventListener('submit', (event) => { event.preventDefault(); save(); }); $('jobConfirmApplied').addEventListener('click', () => save(true));
  $('jobAI').addEventListener('click', prepareAI); $('jobAISend').addEventListener('click', recognizeAI); $('jobAICancel').addEventListener('click', () => cancelAI().catch(() => status('取消请求未连接，请关闭卡片重试。')));
  // 异步职位标题可自动补齐；一旦用户开始编辑即停止自动刷新，保留输入。
  $('jobForm').addEventListener('input', () => { edited = true; editVersion++; });
  $('jobManage').addEventListener('click', async () => { const response = await sendMessage('panel:edit', { destination: 'applications' }); if (!response.ok) status(response.error); });
  // 打开卡片即在本地识别元数据，零资料写入；后续成功反馈只提示，避免覆盖用户的编辑。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes['localapply.jobSessions']) return;
    const pending = changes['localapply.jobSessions'].newValue?.find((item) => item.tabId === global.LocalApplyPanelContext?.id);
    if (pending?.feedback === 'success') status('检测到投递成功，是否记录？点击“重新识别”核对并确认。');
    else if (pending?.feedback === 'failed') status('检测到投递失败，申请状态保持原样。');
  });
  const timer = setInterval(() => { if (++attempts >= 10 || edited || snapshot?.recognized) clearInterval(timer); else scan(true); }, 1500);
  window.addEventListener('pagehide', () => { clearInterval(timer); ++aiVersion; aiPreview = null; sendMessage('jobs:cancelAI').catch(() => {}); }, { once: true }); scan(true);
})(globalThis);
