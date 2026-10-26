// 能力检测由用户主动触发，只发送合成样例；切换配置使旧界面结果失效。
'use strict';
let capabilityGeneration = 0;
let capabilityJob = null;
// 清理可选诊断及其显示，不将旧结果套到新配置，也不阻止直接解析。
function resetCapabilities() {
  capabilityGeneration++;
  if (capabilityJob) sendMessage('wsa:cancelResume', { requestId: capabilityJob });
  capabilityJob = null;
  $('#capabilityStatus').textContent = '无需预先检测，可直接解析简历。以下检测仅用于排查识别问题。';
  $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = false;
}
// 分格式显示端点的实际检测结果，鉴权、网络和识别失败均不会伪装成支持。
async function detectCapabilities() {
  // 先完成 Key 保存引起的刷新，再建立检测代次，避免点击后被旧保存任务误取消。
  const clickedModels = JSON.stringify([state.settings.provider, state.settings.model, state.settings.visionModel]);
  $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = true;
  try { await flushCredentials(); }
  catch (error) {
    $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = false;
    $('#capabilityStatus').textContent = '检测未完成：' + error.message; return;
  }
  if (clickedModels !== JSON.stringify([state.settings.provider, state.settings.model, state.settings.visionModel])) {
    $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = false; return;
  }
  resetCapabilities(); const generation = capabilityGeneration;
  const requestId = crypto.randomUUID(); capabilityJob = requestId;
  $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = true;
  $('#capabilityStatus').textContent = '检测中：每个所选模型最多 3 次请求，仅发送随机数字图片及图片型 PDF/DOCX，不发送简历。';
  try {
    if (generation !== capabilityGeneration) return;
    const { results } = await dataRequest('wsa:probeCapabilities', { payload: { requestId, probe: LocalApplyProbes.createProbe() } });
    if (generation !== capabilityGeneration) return;
    const names = { supported: '识别通过', unsupported: '接口不接受', unverified: '识别未通过', unknown: '检测失败/未知' };
    $('#capabilityStatus').textContent = results.map((r) => `${r.model}：图片 ${names[r.image]}；图片型 PDF ${names[r.pdf]}；图片型 DOCX ${names[r.docx]}。` +
      Object.entries(r.reasons).map(([type, reason]) => `${type}：${reason}`).join(' ')).join('\n');
    if (resumeSource) $('#pdfStatus').textContent = '可选检测完成，可直接发送简历解析；检测结果不会阻止发送，模型不支持时显示实际调用错误。';
  } catch (error) { if (generation === capabilityGeneration) $('#capabilityStatus').textContent = '检测未完成：' + error.message; }
  finally { if (generation === capabilityGeneration) { capabilityJob = null; $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = false; } }
}
// 取消后可立即重新测试，迟到的检测结果不得覆盖新配置。
function initCapabilities() {
  $('#btnDetectCapabilities').addEventListener('click', detectCapabilities);
  $('#btnDetectImport').addEventListener('click', detectCapabilities);
  $('#cancelCapabilities').addEventListener('click', resetCapabilities);
  window.addEventListener('pagehide', resetCapabilities);
}
