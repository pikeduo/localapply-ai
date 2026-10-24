// 设置页：API 设置 / 填充设置 / 简历 PDF 导入（文本→视觉双路 + 人工校对）/ 模板管理
'use strict';

let state = null;
let pdfInfo = null; // {text, numPages, pages, mode}
let extracted = null; // AI 提取结果（待校对）
let reviewItems = []; // {section,label,value,checked,multi,map}

const $ = (s) => document.querySelector(s);

// ============ 初始化 ============

// 读取本地资料并挂载设置事件，服务商元数据交由共享解析器处理。
async function init() {
  state = await getState();
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdfjs/pdf.worker.min.js');

  // —— AI 服务商区（可选功能） ——
  state.settings.customProviders ||= {};
  state.settings.providerModels ||= {};
  refreshProviderUI();
  $('#provider').addEventListener('change', () => applyProviderInput($('#provider').value));
  $('#provider').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('#provider').blur(); }
  });
  $('#customBase').addEventListener('change', () => applyProviderInput($('#customBase').value));
  $('#apiKey').value = (state.settings.apiKeys || {})[state.settings.provider] || '';
  $('#apiKey').addEventListener('change', () => {
    state.settings.apiKeys = state.settings.apiKeys || {};
    state.settings.apiKeys[state.settings.provider] = $('#apiKey').value.trim();
    save();
  });
  $('#model').value = state.settings.model || '';
  $('#model').addEventListener('change', () => {
    state.settings.model = $('#model').value.trim();
    rememberProviderModels();
    save();
  });
  $('#visionModel').value = state.settings.visionModel || '';
  $('#visionModel').addEventListener('change', () => {
    state.settings.visionModel = $('#visionModel').value.trim();
    rememberProviderModels();
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

  $('#btnExtract').addEventListener('click', () => {
    const file = $('#pdfFile').files[0];
    if (!file) return toastMsg('请先选择 PDF 文件', 'err');
    runExtract(file);
  });
  $('#btnImport').addEventListener('click', doImport);
  $('#btnBackup').addEventListener('click', doBackup);
  $('#btnRestore').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', doRestore);

  renderTemplates();
  renderTargetProfiles();
}

// 切换时还原对应的 Key/模型；列表同时包含内置预设和已保存的自定义地址。
function refreshProviderUI() {
  const p = LocalApplyProviders.resolve(state.settings);
  const providerId = p.providerId;
  $('#provider').value = p.name;
  $('#providerList').replaceChildren(...LocalApplyProviders.entries(state.settings).map((provider) => new Option(provider.name, provider.name)));
  $('#apiKey').value = (state.settings.apiKeys || {})[providerId] || '';
  $('#apiKey').type = 'password'; $('#btnRevealKey').textContent = '显示';
  $('#apiKey').placeholder = p.requiresKey ? '在所选服务商官网创建' : '按服务端要求填写，本地服务通常可留空';
  const modelInput = $('#model');
  modelInput.value = state.settings.model || '';
  modelInput.placeholder = p.models[0] || '服务商模型 ID';
  const vmInput = $('#visionModel');
  vmInput.value = state.settings.visionModel || '';
  vmInput.placeholder = p.visionModels[0] ? '如 ' + p.visionModels[0] + '（留空=用主模型）' : '留空 = 用主模型';
  const ml = $('#modelList');
  ml.innerHTML = '';
  (p.models || []).forEach((m) => ml.appendChild(new Option(m, m)));
  const vl = $('#visionList');
  vl.innerHTML = '';
  (p.visionModels || []).forEach((m) => vl.appendChild(new Option(m, m)));
  $('#providerNote').textContent = p.note || '';
  $('#customBaseRow').style.display = '';
  $('#customBase').readOnly = !p.custom && providerId !== 'ollama';
  $('#customBase').value = p.baseUrl;
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
    state.settings.model = models ? models.model : provider.models[0] || '';
    state.settings.visionModel = models ? models.visionModel : '';
    refreshProviderUI();
    if (provider.baseUrl) requestCustomPermission(provider.baseUrl);
    if (await save() === false) { state = await getState(); refreshProviderUI(); return; }
    if (created) toastMsg('已创建并保存自定义服务商，请填写模型 ID。', 'ok');
  } catch (error) {
    refreshProviderUI();
    $('#providerNote').textContent = error.message;
    toastMsg(error.message, 'err');
  }
}

// 已有主机权限时无需重复授权；HTTP IP 接口也按实际 origin 检查。
function requestCustomPermission(base) {
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
  try { await flushSaves(); } catch (error) { el.textContent = '✗ ' + error.message; el.className = 'err'; return; }
  const res = await sendMessage('wsa:aiChat', {
    payload: { messages: [{ role: 'user', content: '请只回复两个字：正常' }], maxTokens: 16, temperature: 0.1 },
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

function renderTargetProfiles() {
  const sel = $('#targetProfile');
  sel.innerHTML = '';
  for (const p of state.profiles) sel.appendChild(new Option(p.name, p.id));
  // 默认选中当前活跃档案，减少误导入
  if (state.profiles.some((p) => p.id === state.activeProfileId)) {
    sel.value = state.activeProfileId;
  }
}

// ============ PDF 提取管线 ============

async function runExtract(file) {
  const st = $('#pdfStatus');
  try {
    st.textContent = '读取文件…';
    const buf = await file.arrayBuffer();
    await extractFromBytes(new Uint8Array(buf));
  } catch (e) {
    st.innerHTML = '<span class="err">✗ ' + escapeHtml(e.message) + '</span>';
  }
}

async function extractFromBytes(bytes) {
  const st = $('#pdfStatus');
  const btn = $('#btnExtract');
  btn.disabled = true;
  try {
    st.textContent = 'pdf.js 解析中…';
    pdfInfo = await extractPdfText(bytes);
    const mode = decideMode(pdfInfo);
    pdfInfo.mode = mode;

    if (mode === 'vision') {
      st.innerHTML = `判定为扫描件/文本过少（全文 ${pdfInfo.text.length} 字符），走 <b>视觉模式</b>：共 ${pdfInfo.numPages} 页，将按页调用 ${escapeHtml(state.settings.model)}（每页一次请求，注意费用）。`;
    } else {
      st.innerHTML = `文本模式：全文 ${pdfInfo.text.length} 字符 / ${pdfInfo.numPages} 页，调用 1 次请求。`;
    }
    st.innerHTML += '<br>⏳ AI 提取中…（最长 2 分钟）';

    let raw;
    if (mode === 'vision') {
      const pages = await renderPages(bytes);
      st.innerHTML = st.innerHTML.replace('⏳ AI 提取中…（最长 2 分钟）', `⏳ AI 逐页提取中（0/${pages.length}）…`);
      const res = await sendMessage('wsa:aiExtractResume', { payload: { pages } });
      if (!res.ok) throw new Error(res.error);
      raw = res.data;
    } else {
      const sys = resumeSchemaPrompt();
      const res = await sendMessage('wsa:aiExtractResume', {
        payload: {
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: '以下是一份简历的全文，请提取为 JSON：\n\n' + pdfInfo.text },
          ],
        },
      });
      if (!res.ok) throw new Error(res.error);
      raw = res.data;
    }
    extracted = raw;
    buildReviewItems(extracted);
    renderReview();
    st.innerHTML += ' <span class="ok">✓ 提取完成，请在下方校对。</span>';
    $('#importRow').style.display = '';
    renderTargetProfiles();
  } finally {
    btn.disabled = false;
  }
}

function resumeSchemaPrompt() {
  return (
    '你是简历信息抽取助手。请从简历全文中提取信息，只输出一个 JSON 对象，不要输出任何其他文字。' +
    'JSON 字段：name(姓名), phone(手机号), email(邮箱), school(毕业院校), major(专业), degree(学历), graduation(毕业时间), ' +
    'gpa(绩点或排名), languages(数组,语言/证书), skills(数组,技能), ' +
    'experiences(数组,每项{company,role,start,end,bullets:[字符串数组]}), ' +
    'projects(数组,每项{name,role,start,end,bullets:[字符串数组]}), ' +
    'customs(对象,其他所有能识别到的字段,如政治面貌/籍贯/四六级/获奖等,键用中文标签)。' +
    '没有的字段省略或留空，不要编造。'
  );
}

async function extractPdfText(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  let full = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ').replace(/[ \t]+/g, ' ').trim();
    pages.push(text);
    full += text + '\n';
  }
  return { text: full.trim(), numPages: doc.numPages, pages };
}

function garbleRatio(text) {
  const chars = [...String(text || '')].filter((c) => !/\s/.test(c));
  if (!chars.length) return 1;
  const okChars = chars.filter(
    (c) => /[\u4e00-\u9fa5\u3000-\u303fA-Za-z0-9]/.test(c) || '.,:;!?()[]{}<>/@#$%&*+=_-|\'"、。，；：！？（）《》“”‘’·…—％／'.includes(c)
  );
  return 1 - okChars.length / chars.length;
}

function decideMode(info) {
  if (info.text.length < 200) return 'vision';
  if (garbleRatio(info.text) > 0.3) return 'vision';
  return 'text';
}

async function renderPages(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / vp0.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    out.push({ dataUrl: canvas.toDataURL('image/png'), hint: i });
  }
  return out;
}

// ============ 校对界面 ============

const SCALAR_LABELS = {
  name: '姓名', phone: '手机号', email: '邮箱', school: '毕业院校',
  major: '专业', degree: '学历', graduation: '毕业时间', gpa: 'GPA/排名',
};

function buildReviewItems(data) {
  reviewItems = [];
  for (const key of Object.keys(SCALAR_LABELS)) {
    if (data[key]) {
      reviewItems.push({
        section: '基本信息',
        label: SCALAR_LABELS[key],
        value: String(data[key]),
        checked: true,
        multi: false,
        map: { kind: 'field', key: key === 'graduation' ? 'graduationDate' : key }, // 对齐原填充词库。
      });
    }
  }
  const joinArr = (v) => (Array.isArray(v) ? v.join('、') : String(v || ''));
  if (data.skills && (Array.isArray(data.skills) ? data.skills.length : String(data.skills).trim())) {
    reviewItems.push({ section: '技能与语言', label: '技能特长', value: joinArr(data.skills), checked: true, multi: false, map: { kind: 'field', key: 'skills' } });
  }
  if (data.languages && (Array.isArray(data.languages) ? data.languages.length : String(data.languages).trim())) {
    reviewItems.push({ section: '技能与语言', label: '语言/证书', value: joinArr(data.languages), checked: true, multi: false, map: { kind: 'customField', label: '语言证书', group: '教育背景', inputType: 'text' } });
  }
  for (const [i, e] of (data.experiences || []).entries()) {
    const val = expToText(e);
    if (!val.trim()) continue;
    reviewItems.push({
      section: '经历',
      label: `经历${i + 1}·${e.company || e.role || ''}`,
      value: val,
      checked: true,
      multi: true,
      map: { kind: 'exp', label: `经历${i + 1}：${e.company || ''}${e.role ? '·' + e.role : ''}`, group: '经历描述' },
    });
  }
  for (const [i, p] of (data.projects || []).entries()) {
    const val = expToText(p);
    if (!val.trim()) continue;
    reviewItems.push({
      section: '项目',
      label: `项目${i + 1}·${p.name || p.role || ''}`,
      value: val,
      checked: true,
      multi: true,
      map: { kind: 'exp', label: `项目${i + 1}：${p.name || ''}${p.role ? '·' + p.role : ''}`, group: '项目描述' },
    });
  }
  for (const [k, v] of Object.entries(data.customs || {})) {
    if (v == null || String(v).trim() === '') continue;
    reviewItems.push({
      section: '其他',
      label: k,
      value: typeof v === 'object' ? JSON.stringify(v) : String(v),
      checked: true,
      multi: String(v).length > 40,
      map: { kind: 'customField', label: k, group: '其他', inputType: String(v).length > 40 ? 'textarea' : 'text' },
    });
  }
}

function expToText(e) {
  const period = [e.start, e.end].filter(Boolean).join(' ~ ');
  const bullets = (e.bullets || []).map((b) => '· ' + b);
  return [period, bullets.join('\n')].filter(Boolean).join('\n');
}

function renderReview() {
  const root = $('#pdfReview');
  root.innerHTML = '';
  if (!reviewItems.length) {
    root.innerHTML = '<p class="warn">没有提取到可导入的字段。</p>';
    return;
  }
  const warn = document.createElement('div');
  warn.className = 'banner warn';
  warn.style.cssText = 'background:#fff7e6;border:1px solid #ffe1a6;border-radius:8px;padding:8px 10px;margin-bottom:10px';
  warn.textContent = '校对区：请逐项核对 AI 提取结果，取消勾选即不导入；确认无误后点底部「确认导入」。';
  root.appendChild(warn);

  let lastSec = '';
  for (const [idx, it] of reviewItems.entries()) {
    if (it.section !== lastSec) {
      lastSec = it.section;
      const h = document.createElement('div');
      h.className = 'rv-section';
      h.innerHTML = `<h3>${it.section}</h3>`;
      root.appendChild(h);
    }
    const secBox = root.lastElementChild;
    const row = document.createElement('div');
    row.className = 'rv';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.checked;
    cb.addEventListener('change', () => {
      it.checked = cb.checked;
      input.classList.toggle('unchecked', !cb.checked);
    });
    const lb = document.createElement('span');
    lb.className = 'rl';
    lb.textContent = it.label;
    let input;
    if (it.multi) {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    input.value = it.value;
    input.addEventListener('input', () => (it.value = input.value));
    row.appendChild(cb);
    row.appendChild(lb);
    row.appendChild(input);
    secBox.appendChild(row);
  }
}

// ============ 导入（确认后才写档案） ============

// 人工确认后保存解析结果，等待真实落盘成功再清理校对区域。
async function doImport() {
  const targetId = $('#targetProfile').value;
  const prof = state.profiles.find((p) => p.id === targetId);
  if (!prof) return toastMsg('找不到目标档案', 'err');
  const picked = reviewItems.filter((i) => i.checked);
  if (!picked.length) return toastMsg('没有勾选任何字段', 'err');
  let created = 0;
  for (const it of picked) {
    if (it.map.kind === 'field') {
      let f = prof.fields.find((x) => x.key === it.map.key);
      if (!f) {
        f = newCustomField(prof, it.label, '其他', 'text');
        created++;
      }
      f.value = it.value;
      if (it.map.key === 'phone' || it.map.key === 'idCard') f.sensitive = true;
    } else if (it.map.kind === 'exp' || it.map.kind === 'customField') {
      const label = it.map.label;
      const exist = prof.fields.find((x) => x.custom && x.label === label);
      if (exist) {
        exist.value = it.value;
      } else {
        newCustomField(prof, label, it.map.group, it.map.inputType || 'text', it.value);
        created++;
      }
    }
  }
  if (await save('pdf-confirmed') === false) return;
  toastMsg(`已导入 ${picked.length} 项到「${prof.name}」（新增 ${created} 个自定义字段），可在侧边栏字段库查看`, 'ok');
  $('#pdfReview').innerHTML = '<p class="ok">✓ 已导入。如需重新导入请再次提取。</p>';
  $('#importRow').style.display = 'none';
  extracted = null;
  reviewItems = [];
}

function newCustomField(prof, label, group, inputType, value) {
  const f = {
    fid: makeId('fc'),
    key: 'c_' + makeId(''),
    label,
    value: value || '',
    group,
    inputType: inputType || 'text',
    sensitive: false,
    autoFill: inputType !== 'textarea',
    material: false,
    custom: true,
  };
  prof.fields.push(f);
  return f;
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

// ============ 调试钩子（自动化验收用） ============

window.__wsaOptions = {
  extractPdfText,
  garbleRatio,
  decideMode,
  extractFromBytes,
  dryRunReview: (data) => {
    extracted = data;
    buildReviewItems(data);
    renderReview();
    return reviewItems.length;
  },
  doImport,
  pdfInfo: () => pdfInfo,
  reviewItems: () => reviewItems,
  state: () => state,
};

// 初始化失败时展示持续可见的操作指引，禁用无法保存的表单，防止误认为可用。
function showInitializationError(error) {
  const banner = $('#initializationError');
  banner.textContent = '设置页未能初始化：' + error.message;
  banner.hidden = false;
  document.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
}

// 初始化既有设置后挂载本地数据管理，不重写原有页面。
init().then(initDataManagement).catch(showInitializationError);
