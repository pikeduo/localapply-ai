// 岗位元数据自动本地识别；收藏和成功确认仍由用户主动触发。
(function (global) {
  'use strict';
  const $ = (id) => document.getElementById(id); const A = global.LocalApplyApplications; let snapshot = null; let revision; let busy = false; let edited = false; let attempts = 0;
  // 只展示固定错误提示和当前操作结果，所有网页文字进入文本节点。
  function status(text) { $('jobStatus').textContent = text; }
  // 确认前读取候选，不写个人库；已记录信息仅在当前卡片内展示。
  async function scan(automatic = false) {
    if (busy || automatic && (edited || snapshot?.recognized)) return;
    busy = true; $('jobScan').disabled = true;
    try {
      const response = await sendMessage('jobs:scan'); if (!response.ok) throw new Error(response.error); snapshot = response;
      const local = await sendMessage('localapply:read'); if (!local.ok) throw new Error(local.error); revision = local.database.revision;
      // 自动请求返回前用户也可能开始编辑，迟到结果不得覆盖已输入的内容。
      if (automatic && edited) return;
      const candidate = snapshot.candidate; $('jobCompany').value = candidate.companyName; $('jobTitle').value = candidate.jobTitle; $('jobLocation').value = candidate.location;
      $('jobMeta').textContent = [candidate.jobSource, candidate.employmentType, candidate.jobUrl].filter(Boolean).join(' · ');
      $('jobNewRound').checked = false; $('jobSaveStatus').value = snapshot.existing?.status === 'draft' ? 'draft' : 'saved'; $('jobSuccess').hidden = !snapshot.successSuggested; $('jobForm').hidden = false;
      edited = false;
      status(snapshot.successSuggested ? '检测到用户提交后的成功反馈，请核对岗位并确认记录。' : snapshot.feedback === 'failed' ? '网页反馈投递失败，申请不会标记为已投递。' : snapshot.existing ? `已有第 ${snapshot.existing.round} 轮记录：${A.statusLabel(snapshot.existing.status)}，最近更新 ${new Date(snapshot.existing.updatedAt).toLocaleDateString('zh-CN')}。重复保存只补空白信息。` : snapshot.recognized ? '已自动识别当前岗位，可确认保存；缺少的信息可手动补全。' : '岗位信息不完整，正在等待页面加载；也可手动补全公司和职位后确认保存。');
    } catch (error) { status(error.message); } finally { busy = false; $('jobScan').disabled = false; }
  }
  // 只有独立确认才能标记已投递，不会点击网页提交或使用模型推断状态。
  async function save(applied = false) {
    if (!snapshot || busy || !$('jobForm').reportValidity()) return;
    const record = { ...snapshot.candidate, companyName: $('jobCompany').value.trim(), jobTitle: $('jobTitle').value.trim(), location: $('jobLocation').value.trim(), status: applied ? 'applied' : $('jobSaveStatus').value };
    if (!confirm(`确认保存申请记录？\n公司：${record.companyName}\n岗位：${record.jobTitle}\n地点：${record.location}\n平台：${record.jobSource}\n链接：${record.jobUrl}\n状态：${A.statusLabel(record.status)}\n只更新本地记录，不提交网页申请。`)) return;
    busy = true; $('jobSave').disabled = true; $('jobConfirmApplied').disabled = true;
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
    finally { busy = false; $('jobSave').disabled = false; $('jobConfirmApplied').disabled = false; }
  }
  $('jobScan').addEventListener('click', () => scan()); $('jobForm').addEventListener('submit', (event) => { event.preventDefault(); save(); }); $('jobConfirmApplied').addEventListener('click', () => save(true));
  // 异步职位标题可自动补齐；一旦用户开始编辑即停止自动刷新，保留输入。
  $('jobForm').addEventListener('input', () => { edited = true; });
  $('jobManage').addEventListener('click', async () => { const response = await sendMessage('panel:edit', { destination: 'applications' }); if (!response.ok) status(response.error); });
  // 打开卡片即在本地识别元数据，零资料写入；后续成功反馈只提示，避免覆盖用户的编辑。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes['localapply.jobSessions']) return;
    const pending = changes['localapply.jobSessions'].newValue?.find((item) => item.tabId === global.LocalApplyPanelContext?.id);
    if (pending?.feedback === 'success') status('检测到投递成功，是否记录？点击“重新识别”核对并确认。');
    else if (pending?.feedback === 'failed') status('检测到投递失败，申请状态保持原样。');
  });
  const timer = setInterval(() => { if (++attempts >= 10 || edited || snapshot?.recognized) clearInterval(timer); else scan(true); }, 1500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true }); scan(true);
})(globalThis);
