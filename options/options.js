// 设置页：模型能力与密钥、简历文件/页面图识别、人工校对和本地资料管理。
'use strict';

let state = null;
let availableModels = null; // 当前端点近期获取的完整列表；临时标签页缓存不进入数据库或备份。
let modelsRequestId = 0; // 使切换服务商/Key 后迟到的响应失效。
let providerPicker = null; // 全量服务商选择器保留输入地址创建入口。

const $ = (s) => document.querySelector(s);

// ============ 初始化 ============

// 读取本地资料并挂载设置事件，服务商元数据交由共享解析器处理。
async function init() {
  const standalone = globalThis.LocalApplyStandalone?.enabled;
  $('#standaloneNotice').hidden = !standalone;
  state = await getState();
  pdfjsLib.GlobalWorkerOptions.workerSrc = standalone
    ? new URL('../libs/pdfjs/pdf.worker.min.js', location.href).href
    : chrome.runtime.getURL('libs/pdfjs/pdf.worker.min.js');

  // —— AI 服务商区（可选功能） ——
  state.settings.customProviders ||= {};
  state.settings.providerModels ||= {};
  providerPicker = createProviderPicker(applyProviderInput);
  refreshProviderUI();
  $('#customBase').addEventListener('change', () => applyProviderInput($('#customBase').value));
  $('#apiProtocol').addEventListener('change', changeApiProtocol);
  initCredentials();
  initCapabilities();
  $('#btnFetchModels').addEventListener('click', fetchAvailableModels);
  $('#manualModel').addEventListener('change', () => {
    renderModelChoices();
  });
  $('#modelSelect').addEventListener('change', () => {
    state.settings.model = $('#modelSelect').value;
    $('#model').value = state.settings.model;
    $('#manualModel').checked = false;
    renderModelChoices();
    rememberProviderModels();
    resetCapabilities();
    save();
  });
  $('#model').value = state.settings.model || '';
  $('#model').addEventListener('change', () => {
    state.settings.model = $('#model').value.trim();
    renderModelChoices();
    rememberProviderModels();
    resetCapabilities();
    save();
  });
  $('#visionModel').value = state.settings.visionModel || '';
  $('#manualVisionModel').addEventListener('change', renderModelChoices);
  $('#visionModelSelect').addEventListener('change', () => {
    state.settings.visionModel = $('#visionModelSelect').value;
    $('#visionModel').value = state.settings.visionModel;
    $('#manualVisionModel').checked = false;
    renderModelChoices(); rememberProviderModels(); resetCapabilities(); save();
  });
  $('#visionModel').addEventListener('change', () => {
    state.settings.visionModel = $('#visionModel').value.trim();
    renderModelChoices();
    rememberProviderModels();
    resetCapabilities();
    save();
  });

  $('#autoThreshold').value = state.settings.autoThreshold;
  $('#thresholdVal').textContent = Number(state.settings.autoThreshold).toFixed(2);
  $('#privacyMask').checked = state.settings.privacyMask !== false;
  $('#autoFloatbar').checked = state.settings.autoFloatbar !== false;

  $('#btnRevealKey').addEventListener('click', () => {
    const k = $('#apiKey');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    $('#btnRevealKey').textContent = show ? '隐藏' : '显示';
  });
  $('#btnTestKey').addEventListener('click', testConnection);
  $('#autoThreshold').addEventListener('input', () => {
    state.settings.autoThreshold = Number($('#autoThreshold').value);
    $('#thresholdVal').textContent = Number($('#autoThreshold').value).toFixed(2);
    save();
  });
  $('#privacyMask').addEventListener('change', () => {
    state.settings.privacyMask = $('#privacyMask').checked;
    save();
  });
  $('#autoFloatbar').addEventListener('change', () => {
    state.settings.autoFloatbar = $('#autoFloatbar').checked;
    save();
  });

  initResume();
  $('#btnBackup').addEventListener('click', doBackup);
  $('#btnRestore').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', doRestore);

  renderTemplates();
  renderTargetProfiles();
}

// 切换时还原 Key/模型/协议，并展示实际请求地址，根路径不再被隐式改写。
function refreshProviderUI() {
  const p = LocalApplyProviders.resolve(state.settings);
  const providerId = p.providerId;
  providerPicker.update(LocalApplyProviders.entries(state.settings), providerId);
  $('#modelsEndpoint').textContent = p.baseUrl ? p.baseUrl.replace(/\/+$/, '') + '/models' : '请先填写接口地址';
  renderVault();
  $('#apiKey').type = 'password'; $('#btnRevealKey').textContent = '显示';
  const modelInput = $('#model');
  modelInput.value = state.settings.model || '';
  modelInput.placeholder = p.models[0] || '服务商模型 ID';
  const vmInput = $('#visionModel');
  vmInput.value = state.settings.visionModel || '';
  vmInput.placeholder = p.visionModels[0] ? '如 ' + p.visionModels[0] + '（留空=用主模型）' : '留空 = 用主模型';
  $('#providerNote').textContent = p.note || '';
  $('#customBaseRow').style.display = '';
  $('#customBase').readOnly = !p.custom && providerId !== 'ollama';
  $('#customBase').value = p.baseUrl;
  $('#apiProtocolRow').hidden = !state.settings.customProviders[providerId];
  $('#apiProtocol').value = p.protocol;
  $('#chatEndpoint').textContent = (p.baseUrl || '').replace(/\/+$/, '') + (p.protocol === 'responses' ? '/responses' : '/chat/completions');
  resetModelCatalog();
}

// 用户显式选择协议，不自动试发请求；协议切换使旧能力和草稿路由失效。
async function changeApiProtocol() {
  const provider = state.settings.customProviders[state.settings.provider];
  if (!provider) return;
  provider.protocol = $('#apiProtocol').value;
  refreshProviderUI();
  if (await save() === false) { state = await getState(); refreshProviderUI(); }
}

// 临时缓存按端点、协议及密钥版本隔离，不缓存 Key 本身。
function modelCatalogKey() {
  const p = LocalApplyProviders.resolve(state.settings);
  const vault = state.settings.vault || {};
  return 'localapply.models:' + JSON.stringify([new URL('.', location.href).href, p.providerId, p.baseUrl, p.protocol, vault.revision || 0, vault.localRevision || 0]);
}
// 缓存只活在当前标签页会话中，读取异常或过期时回到主动获取入口。
function readModelCatalog() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(modelCatalogKey()));
    if (!cached || !Number.isFinite(cached.savedAt) || Date.now() - cached.savedAt > 1800000 || cached.savedAt > Date.now()
      || !Array.isArray(cached.models) || cached.models.length > 10000 || cached.models.some((id) => typeof id !== 'string' || !id || id.length > 2000)) return null;
    return cached.models;
  } catch { return null; }
}
// 写入失败不影响当页下拉，禁止缓存失败导致配置页面不可用。
function saveModelCatalog(models) {
  try { sessionStorage.setItem(modelCatalogKey(), JSON.stringify({ models, savedAt: Date.now() })); } catch { /* 使用内存列表即可。 */ }
}
// 服务商/Key 变化后按新作用域读取列表，已保存的 ID 仍保留并清楚标注。
function resetModelCatalog({ clearCache = false } = {}) {
  resetCapabilities();
  modelsRequestId++;
  if (clearCache) { try { sessionStorage.removeItem(modelCatalogKey()); } catch { /* 不依赖浏览器必须允许会话存储。 */ } }
  availableModels = clearCache ? null : readModelCatalog();
  renderModelChoices();
  $('#modelsStatus').textContent = availableModels
    ? `已恢复本标签页近期的 ${availableModels.length} 个模型；展开可选全部型号，也可重新获取。`
    : '填写接口和所需 Key 后，先获取模型列表，再选择主模型。';
  $('#modelsStatus').className = 'muted';
  $('#btnFetchModels').disabled = false;
  $('#btnFetchModels').textContent = '获取可用模型';
  $('#testResult').textContent = '';
}

// 两个原生下拉始终放入完整列表，已选值和手动输入不会成为过滤条件。
function renderModelChoices() {
  const current = state.settings.model || '';
  const select = $('#modelSelect');
  const options = [new Option(availableModels ? '请选择模型' : '请先获取模型列表', '')];
  (availableModels || []).forEach((model) => options.push(new Option(model, model)));
  if (current && !availableModels?.includes(current)) options.push(new Option('已保存：' + current + '（尚未在本次列表确认）', current));
  select.replaceChildren(...options);
  select.value = current;
  select.disabled = !availableModels?.length;
  $('#model').hidden = !$('#manualModel').checked;
  const vision = state.settings.visionModel || '';
  const visionOptions = [new Option('使用主模型', ''), ...(availableModels || []).map((model) => new Option(model, model))];
  if (vision && !availableModels?.includes(vision)) visionOptions.push(new Option('已保存：' + vision + '（尚未在本次列表确认）', vision));
  $('#visionModelSelect').replaceChildren(...visionOptions); $('#visionModelSelect').value = vision;
  $('#visionModel').hidden = !$('#manualVisionModel').checked;
}

// 用户主动获取模型列表；失败时展开对应接口的跨域、鉴权和协议排查说明。
async function fetchAvailableModels() {
  // 先完成密钥保存/解锁引起的界面刷新，再建立本次请求编号，避免刷新取消新请求。
  const clickedProvider = state.settings.provider;
  $('#btnFetchModels').disabled = true;
  try { await flushCredentials(); }
  catch (error) { $('#btnFetchModels').disabled = false; $('#modelsStatus').textContent = '获取失败：' + error.message; return; }
  if (clickedProvider !== state.settings.provider) { $('#btnFetchModels').disabled = false; return; }
  resetModelCatalog({ clearCache: true });
  const requestId = modelsRequestId;
  const providerId = state.settings.provider;
  const status = $('#modelsStatus');
  $('#btnFetchModels').disabled = true;
  $('#btnFetchModels').textContent = '获取中…';
  status.textContent = '正在从当前服务商获取模型列表…';
  try {
    if (requestId !== modelsRequestId) return;
    const response = await sendMessage('wsa:listModels', { providerId });
    if (requestId !== modelsRequestId || providerId !== state.settings.provider) return;
    if (!response.ok) throw new Error(response.error);
    if (response.providerId !== providerId) throw new Error('服务商已变化，请重新获取模型列表。');
    availableModels = response.models;
    saveModelCatalog(availableModels);
    if (availableModels.length) $('#manualModel').checked = false;
    renderModelChoices();
    const missing = state.settings.model && !availableModels.includes(state.settings.model);
    status.textContent = availableModels.length
      ? `已获取 ${availableModels.length} 个模型，请选择主模型。${missing ? '当前保存的模型未出现在列表中，请核对后重新选择。' : ''}`
      : '服务商返回了空模型列表，可确认模型部署后重试，或手动填写模型 ID。';
    status.className = availableModels.length ? 'ok' : 'warn';
    if (!availableModels.length) { $('#manualModel').checked = true; renderModelChoices(); }
  } catch (error) {
    if (requestId !== modelsRequestId) return;
    status.textContent = '获取失败：' + error.message;
    status.className = 'err';
    $('#modelApiHelp').open = true;
    $('#manualModel').checked = true;
    renderModelChoices();
  } finally {
    if (requestId === modelsRequestId) {
      $('#btnFetchModels').disabled = false;
      $('#btnFetchModels').textContent = '重新获取模型';
    }
  }
}

// 在切换前保存当前服务商的模型，防止沿用上一家的模型 ID。
function rememberProviderModels() {
  state.settings.providerModels ||= {};
  state.settings.providerModels[state.settings.provider] = { model: state.settings.model || '', visionModel: state.settings.visionModel || '' };
}

// 输入服务商名称或地址后自动选择/创建；规范化去重，不继承其他端点的 Key。
async function applyProviderInput(raw) {
  try {
    let providerId = LocalApplyProviders.find(state.settings, raw);
    let created = false;
    if (!providerId) {
      const baseUrl = LocalApplyProviders.normalizeBase(raw);
      providerId = 'custom.' + crypto.randomUUID();
      state.settings.customProviders[providerId] = { name: baseUrl, baseUrl };
      created = true;
    }
    if (providerId === state.settings.provider) { refreshProviderUI(); return; }
    rememberProviderModels();
    state.settings.provider = providerId;
    const provider = LocalApplyProviders.resolve(state.settings);
    const models = state.settings.providerModels[providerId];
    state.settings.model = models ? models.model : '';
    state.settings.visionModel = models ? models.visionModel : '';
    refreshProviderUI();
    if (provider.baseUrl) requestCustomPermission(provider.baseUrl);
    if (await save() === false) { state = await getState(); refreshProviderUI(); return; }
    if (created) toastMsg('已保存自定义服务商，请获取模型列表后选择模型。', 'ok');
  } catch (error) {
    refreshProviderUI();
    $('#providerNote').textContent = error.message;
    toastMsg(error.message, 'err');
  }
}

// 已有主机权限时无需重复授权；HTTP IP 接口也按实际 origin 检查。
function requestCustomPermission(base) {
  if (globalThis.LocalApplyStandalone?.enabled) return; // 文件页使用浏览器 CORS，不请求扩展权限。
  const url = new URL(base);
  const origin = url.protocol + '//' + url.hostname + '/*';
  chrome.permissions.contains({ origins: [origin] }, (granted) => {
    if (granted) return;
    chrome.permissions.request({ origins: [origin] }, (allowed) => {
      if (!allowed) toastMsg('接口地址已保存，使用前请在扩展管理页授予该站点访问权限。', 'err');
    });
  });
}

// 提交旧界面快照到后台；错误已向用户显示，避免事件处理产生未捕获 rejection。
function save(source = 'manual') {
  return saveState(state, source).catch((error) => {
    toastMsg('保存失败：' + error.message, 'err');
    return false;
  });
}

// 先保存当前输入再发起连通测试，避免失焦保存尚未完成时读取旧模型/端点。
async function testConnection() {
  const el = $('#testResult');
  el.textContent = '⏳ 测试中…';
  el.className = 'muted';
  try { await flushCredentials(); } catch (error) { el.textContent = '✗ ' + error.message; el.className = 'err'; return; }
  const res = await sendMessage('wsa:aiChat', {
    payload: { messages: [{ role: 'user', content: '请只回复两个字：正常' }], maxTokens: 128, disableThinking: true, temperature: 0.1 },
  });
  if (res.ok) {
    el.textContent = '✓ 连接正常（' + res.model + '）';
    el.className = 'ok';
  } else {
    el.textContent = '✗ ' + res.error;
    el.className = 'err';
  }
}

// ============ 模板管理 ============

// 显示模板概况，不插入任何用户输入。
function renderTemplates() {
  const root = $('#tplList');
  root.innerHTML = '';
  for (const t of WangshenTemplates.TEMPLATES) {
    const groups = new Map();
    for (const f of t.fields) groups.set(f.group, (groups.get(f.group) || 0) + 1);
    const div = document.createElement('div');
    div.className = 'tpl';
    div.innerHTML = `<b>${t.name}</b> <span class="badge">${t.fields.length} 字段</span> <span class="muted">${[...groups.entries()].map(([g, n]) => `${g}×${n}`).join(' · ')}</span>`;
    root.appendChild(div);
  }
}

// 校对目标切换后重新显示该档案已有的字段值。
function renderTargetProfiles() {
  const sel = $('#targetProfile');
  sel.innerHTML = '';
  for (const p of state.profiles) sel.appendChild(new Option(p.name, p.id));
  // 默认选中当前活跃档案，减少误导入
  if (state.profiles.some((p) => p.id === state.activeProfileId)) {
    sel.value = state.activeProfileId;
  }
}

// ============ 档案备份导出 / 恢复（不含 API Key） ============

// 显示已转义的备份结果。
function backupMsg(text) {
  $('#backupMsg').innerHTML = text;
}

// 从已提交的规范数据库导出，包含重复经历与映射，但不包含 API 配置。
async function doBackup() {
  try {
    await flushSaves();
    const response = await dataRequest('localapply:exportBackup');
    downloadJson(response.backup, 'localapply-backup.json');
    backupMsg('✓ 完整资料、动态字段及本地映射已导出，不含 API Key 或原文件。');
  } catch (error) { backupMsg(escapeHtml('导出失败：' + error.message)); }
}

// 导入先校验并展示差异，必须另行点击确认，文件不持久化。
async function doRestore(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('备份超过 8 MiB 限制');
    await prepareRestore(await file.text());
  } catch (e) {
    backupMsg('<span class="err">✗ 恢复失败：' + escapeHtml(e.message) + '</span>');
  }
}

// 初始化失败时展示持续可见的操作指引，禁用无法保存的表单，防止误认为可用。
function showInitializationError(error) {
  const banner = $('#initializationError');
  banner.textContent = '设置页未能初始化：' + error.message;
  banner.hidden = false;
  document.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
}

// 先初始化既有业务，再挂载工作台；文件解析和密钥机制沿用已验收实现。
init().then(async () => {
  // 简历入口在首屏，既有设置与填表行为保留。
  $('.wrap').insertBefore($('#resumeCenter'), $('#aiSettings'));
  $('.wrap').insertBefore($('#pdfCard'), $('#aiSettings'));
  await initDataManagement(); await renderResumeCenter(); await initWorkspace();
}).catch(showInitializationError);
