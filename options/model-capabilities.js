// 能力检测由用户主动触发，只发送合成样例；切换配置使旧界面结果失效。
'use strict';
let capabilityGeneration = 0;
let capabilityJob = null;
// 清理显示与正在运行的探测；不把一次通过的能力套用到新服务商或新型号。
function resetCapabilities() {
  capabilityGeneration++;
  if (capabilityJob) sendMessage('wsa:cancelResume', { requestId: capabilityJob });
  capabilityJob = null;
  $('#capabilityStatus').textContent = '尚未检测文件/图片识别能力。模型列表与连接成功不代表支持识别。';
  $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = false;
}
// 分格式显示端点的实际检测结果，鉴权、网络和识别失败均不会伪装成支持。
async function detectCapabilities() {
  resetCapabilities(); const generation = capabilityGeneration;
  const requestId = crypto.randomUUID(); capabilityJob = requestId;
  $('#btnDetectCapabilities').disabled = $('#btnDetectImport').disabled = true;
  $('#capabilityStatus').textContent = '检测中：每个所选模型最多 3 次请求，仅发送随机数字图片及图片型 PDF/DOCX，不发送简历。';
  try {
    await flushCredentials();
    if (generation !== capabilityGeneration) return;
    const { results } = await dataRequest('wsa:probeCapabilities', { payload: { requestId, probe: LocalApplyProbes.createProbe() } });
    if (generation !== capabilityGeneration) return;
    const names = { supported: '识别通过', unsupported: '接口不接受', unverified: '识别未通过', unknown: '检测失败/未知' };
    $('#capabilityStatus').textContent = results.map((r) => `${r.model}：图片 ${names[r.image]}；图片型 PDF ${names[r.pdf]}；图片型 DOCX ${names[r.docx]}。` +
      Object.entries(r.reasons).map(([type, reason]) => `${type}：${reason}`).join(' ')).join('\n');
    if (resumeSource) $('#pdfStatus').textContent = '检测完成，请核对页面预览后发送；系统会选择通过检测的文件或图片路径。';
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
