// 工作台只使用既有后台命令管理字段与档案，不增加数据库版本或 API 请求。
let workspaceDatabase = null;
let workspaceEditing = null;
let workspaceInitialized = false;
let workspaceResumeSections = [];
let workspaceResumeFrame = 0;
// 路由只接受固定模块，概览旧链接兼容到我的简历，不接收任意页面地址。
const workspacePages = {
  pdfCard: ['导入简历', '选择或拖入 PDF / DOCX，预览后由你决定何时解析。'],
  aiSettings: ['AI 与模型', '配置服务商、密钥和模型，仅在你主动操作时调用。'],
  resumeCenter: ['我的简历', '查看资料概览，在对应分类内编辑全部简历内容。'],
  fieldLibrary: ['字段库', '管理字段定义、分类和别名，个人内容独立保存。'],
  privacySettings: ['数据与备份', '导出、恢复和迁移本地资料，导入前先预览差异。'],
  diagnosticsPanel: ['诊断与关于', '查看本地运行与报错记录，导出脱敏日志协助排查。'],
};
// 兼容旧概览锚点及卡片编辑链接；未指定模块时默认进入导航第一项。
function workspaceRoute() {
  const hash = location.hash.slice(1); if (hash === 'workspaceOverview') return 'resumeCenter';
  if (Object.hasOwn(workspacePages, hash)) return hash;
  return !hash && new URLSearchParams(location.search).has('profile') ? 'resumeCenter' : 'pdfCard';
}
// 切换只隐藏其他模块，不重建表单、不清理文件预览或未保存的字段草稿。
function showWorkspacePage(target, focus = false) {
  const key = Object.hasOwn(workspacePages, target) ? target : 'pdfCard';
  document.querySelectorAll('.workspace-page[data-workspace-page]').forEach((page) => { page.hidden = page.dataset.workspacePage !== key; });
  document.querySelectorAll('.workspace-sidebar nav a').forEach((link) => { if (link.hash === '#' + key) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  document.getElementById('workspaceTitle').textContent = workspacePages[key][0]; document.getElementById('workspaceDescription').textContent = workspacePages[key][1];
  document.querySelector('.skip-link').hash = key; document.body.dataset.workspaceActivePage = key;
  if (focus) { window.scrollTo(0, 0); document.getElementById('workspaceContent').focus({ preventScroll: true }); }
  scheduleResumePosition();
}
// DOM 构造始终用文本，字段名、经历标题不得拼接到 HTML。
function workspaceNode(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
// 目录只取当前基础字段分类，不显示旧经历条目或字段实际值。
function renderResumeToc() {
  const root = document.getElementById('resumeToc');
  const selected = root.querySelector('[aria-current="location"]')?.dataset.tocKey;
  const items = [
    { key: 'overview', label: '资料概览', target: document.getElementById('workspaceOverview') },
    { key: 'center', label: '档案与资料', target: document.getElementById('resumeProfileControls') },
  ];
  // 分类与正文顺序一致，滚动时持续高亮完整分类。
  document.querySelectorAll('#basicFields .resume-group').forEach((target) => {
    items.push({ key: 'group:' + target.dataset.group, label: target.querySelector('h3').textContent, target });
  });
  workspaceResumeSections = items;
  root.replaceChildren(...items.map(({ key, label }) => {
    const button = workspaceNode('button', label); button.type = 'button'; button.dataset.tocKey = key; button.title = label;
    if (selected === key) button.setAttribute('aria-current', 'location');
    return button;
  }));
  scheduleResumePosition();
}
// 活动状态覆盖完整卡片；只滚动目录自身，避免把正文拉回或抢走输入焦点。
function markResumeSection(key) {
  const root = document.getElementById('resumeToc');
  workspaceResumeSections.forEach((section) => section.target.classList.toggle('is-target', section.key === key));
  let active;
  root.querySelectorAll('button').forEach((button) => {
    if (button.dataset.tocKey === key) { active = button; if (!button.hasAttribute('aria-current')) button.setAttribute('aria-current', 'location'); }
    else if (button.hasAttribute('aria-current')) button.removeAttribute('aria-current');
  });
  const container = root.closest('.resume-toc');
  if (!active || getComputedStyle(container).position !== 'sticky') return;
  const box = container.getBoundingClientRect(); const item = active.getBoundingClientRect();
  if (item.top < box.top + 48) container.scrollTop -= box.top + 48 - item.top;
  else if (item.bottom > box.bottom - 12) container.scrollTop += item.bottom - box.bottom + 12;
}
// 以视口中线判断正在阅读的完整区块；折叠和搜索隐藏项不参与判断。
function updateResumePosition() {
  workspaceResumeFrame = 0;
  if (document.body.dataset.workspaceActivePage !== 'resumeCenter') return;
  const visible = workspaceResumeSections.filter((section) => section.target.getClientRects().length);
  if (!visible.length) return;
  const readingLine = innerHeight / 2; let current = visible[0];
  if (scrollY > 1) for (const section of visible) { if (section.target.getBoundingClientRect().top <= readingLine) current = section; else break; }
  // 底部留白不能使最后一个短区块永远无法选中。
  if (scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 2) current = visible[visible.length - 1];
  markResumeSection(current.key);
}
// 滚轮、尺寸变化与重新渲染合并到每帧最多一次检测，不写数据库或读取字段实际值。
function scheduleResumePosition() {
  if (!workspaceResumeFrame) workspaceResumeFrame = requestAnimationFrame(updateResumePosition);
}
// 短区块居中、长区块顶对齐；仅展开外层容器，更多字段保持用户选择的显隐状态。
function locateResumeSection(key) {
  const target = workspaceResumeSections.find((section) => section.key === key)?.target;
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) { if (parent.tagName === 'DETAILS') parent.open = true; }
  target.tabIndex = -1; target.focus({ preventScroll: true });
  const bounds = target.getBoundingClientRect(); const inset = bounds.height <= innerHeight - 48 ? (innerHeight - bounds.height) / 2 : 24;
  window.scrollTo({ top: Math.max(0, bounds.top + scrollY - inset), behavior: 'instant' });
  markResumeSection(key); scheduleResumePosition();
}
// 日期编辑复用中文弹出日历及三种精度，旧非标准文本须显式修改，渲染时不改值。
function workspaceDateControl(def, value) {
  const box = workspaceNode('div', '', 'workspace-date'); box.setAttribute('role', 'group');
  const precision = document.createElement('select'); precision.setAttribute('aria-label', '日期精度 · ' + def.label);
  for (const [key, label] of [['date', '年月日'], ['month', '年月'], ['year', '年份']]) precision.append(new Option(label, key));
  const raw = value == null ? '' : String(value);
  // 非法旧日期也必须原样显示，不能把 2 月 30 日等历史文本静默清空。
  const validDay = !!LocalApplyDatePicker.parse(raw, 'date');
  const mode = !raw || validDay ? 'date' : /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && Number(raw.slice(0, 4)) > 0 ? 'month' : /^\d{4}$/.test(raw) && Number(raw) > 0 ? 'year' : 'legacy';
  if (mode === 'legacy' || def.type === 'text') precision.append(new Option(mode === 'legacy' ? '原有文本' : '文字说明', 'legacy'));
  precision.value = mode;
  const input = document.createElement('input'); input.dataset.primary = ''; input.type = 'text'; input.autocomplete = 'off';
  const entry = workspaceNode('div', '', 'workspace-date-entry');
  const trigger = workspaceNode('button', '', 'workspace-date-trigger'); trigger.type = 'button'; trigger.setAttribute('aria-label', '打开日历 · ' + def.label);
  // 固定 SVG 图标仅使用本地绘图指令，不拼接字段或用户内容。
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M7 3v4m10-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1ZM8 14h2m4 0h2m-8 3h2'); icon.append(path); trigger.append(icon);
  const status = workspaceNode('small', '', 'workspace-date-message'); status.setAttribute('role', 'alert'); status.hidden = true;
  const picker = LocalApplyDatePicker.attach(input, trigger, { mode: () => precision.value, label: def.label, status });
  // 统一使用可手输文本，格式校验和日历选择共享原有自动保存链路。
  function configure(next, text) {
    input.value = text; picker.refresh();
  }
  configure(mode, raw);
  precision.addEventListener('input', (event) => event.stopPropagation());
  precision.addEventListener('change', (event) => {
    event.stopPropagation(); const previous = input.value; const next = precision.value;
    const length = next === 'year' ? 4 : next === 'month' ? 7 : 10;
    const compatible = /^\d{4}(-\d{2})?(-\d{2})?$/.test(previous) && previous.length >= length;
    configure(next, compatible ? previous.slice(0, length) : next === 'legacy' ? previous : '');
    // 降低精度是用户的显式操作；提高精度必须等待实际选择，不能凭空补月或补日。
    if (compatible && previous !== input.value) box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  Object.defineProperty(box, 'value', { get: () => input.value });
  entry.append(input, trigger); box.append(precision, entry, status); return box;
}
// 开放多选把用户添加的城市仅存为个人值，绝不将这些内容混入公共候选定义。
function workspaceOpenMultiControl(def, value) {
  const box = workspaceNode('div', '', 'workspace-multi'); box.setAttribute('role', 'group');
  let values = Array.isArray(value) ? [...value] : [];
  const tags = workspaceNode('div', '', 'workspace-tags');
  const input = document.createElement('input'); input.placeholder = '输入城市，按回车或点击添加'; input.setAttribute('aria-label', '添加城市 · ' + def.label);
  const add = workspaceNode('button', '添加', 'btn ghost'); add.type = 'button';
  const status = workspaceNode('small'); status.setAttribute('role', 'status');
  // 只由明确的添加/移除动作保存，多选输入尚未确认的文字不视为已添加。
  function render() {
    tags.replaceChildren();
    values.forEach((city) => {
      const remove = workspaceNode('button', city + ' ×', 'btn ghost'); remove.type = 'button'; remove.setAttribute('aria-label', '移除城市 · ' + city);
      remove.addEventListener('click', () => { values = values.filter((item) => item !== city); render(); box.dispatchEvent(new Event('change', { bubbles: true })); }); tags.append(remove);
    });
  }
  // 可一次输入多个城市，限制数量与长度，后台仍会重复校验。
  function append() {
    const additions = input.value.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean);
    const next = [...new Set([...values, ...additions])];
    if (next.length > 200 || next.some((item) => item.length > 500)) { status.textContent = '最多添加 200 项，每项不超过 500 字。'; return; }
    if (!additions.length) return;
    values = next; input.value = ''; status.textContent = ''; render(); box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  input.addEventListener('change', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); append(); } });
  add.addEventListener('click', append); Object.defineProperty(box, 'value', { get: () => [...values] });
  render(); box.append(tags, input, add, status); return box;
}
// 离线地区编辑提供省市区联动候选及自由输入，兼容旧文本、区划更新和海外地址。
function workspaceRegionControl(def, value) {
  const box = workspaceNode('div', '', 'workspace-region'); box.setAttribute('role', 'group');
  const input = document.createElement('input'); input.dataset.primary = ''; input.value = value == null ? '' : String(value);
  input.placeholder = '完整地区，也可使用下方省市区控件';
  const parts = workspaceNode('div', '', 'workspace-region-parts');
  const province = document.createElement('select'); province.setAttribute('aria-label', '省份 · ' + def.label); province.append(new Option('选择省份', ''));
  const provinces = ['北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区', '香港特别行政区', '澳门特别行政区', '台湾省', '海外/其他'];
  provinces.forEach((name) => province.append(new Option(name, name)));
  const city = document.createElement('input'); city.placeholder = '城市'; city.setAttribute('aria-label', '城市 · ' + def.label);
  const district = document.createElement('input'); district.placeholder = '区县（可留空）'; district.setAttribute('aria-label', '区县 · ' + def.label);
  const regions = globalThis.LocalApplyRegions || {};
  const cities = document.createElement('datalist'); cities.id = 'region-cities-' + def.fieldId; city.setAttribute('list', cities.id);
  const districts = document.createElement('datalist'); districts.id = 'region-districts-' + def.fieldId; district.setAttribute('list', districts.id);
  // 城市/区县用可输入的原生候选列表，不能将离线快照中缺失的新地名当作无效个人值。
  function refreshOptions() {
    cities.replaceChildren(...Object.keys(regions[province.value] || {}).map((name) => new Option(name, name)));
    districts.replaceChildren(...(regions[province.value]?.[city.value] || []).map((name) => new Option(name, name)));
  }
  // 只有明确的分隔符才拆分已有值，单个城市名不猜测省份。
  function syncParts() { const chunks = input.value.split(/\s*\/\s*/); province.value = provinces.includes(chunks[0]) ? chunks[0] : ''; city.value = chunks.length > 1 ? chunks[1] : ''; district.value = chunks.length > 2 ? chunks.slice(2).join(' / ') : ''; refreshOptions(); }
  input.addEventListener('change', syncParts); syncParts();
  city.addEventListener('input', refreshOptions);
  for (const part of [province, city, district]) part.addEventListener('change', (event) => {
    event.stopPropagation(); if (part === province) { city.value = ''; district.value = ''; }
    else if (part === city) district.value = '';
    refreshOptions();
    input.value = [province.value, city.value.trim(), district.value.trim()].filter(Boolean).join(' / ');
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  Object.defineProperty(box, 'value', { get: () => input.value }); parts.append(province, city, district);
  box.append(input, parts, cities, districts, workspaceNode('small', '省、市、区县联动候选均在本地；支持手动输入新地区或海外地址。')); return box;
}
// 按定义和参考控件创建编辑器；旧日期文本保持兼容，静态下拉完整显示并保留历史自定义值。
function workspaceControl(def, value) {
  const standard = def.fieldId?.startsWith('builtin.') && WangshenTemplates.FIELD_INDEX[def.fieldId.slice(8)];
  if (def.type === 'date' || (def.type === 'text' && standard?.widget === 'date')) return workspaceDateControl(def, value);
  if (def.type === 'text' && standard?.widget === 'region') return workspaceRegionControl(def, value);
  if (def.type === 'multiSelect' && !def.options.length) return workspaceOpenMultiControl(def, value);
  let input;
  if (['boolean', 'select', 'multiSelect'].includes(def.type)) {
    input = document.createElement('select'); input.multiple = def.type === 'multiSelect';
    if (!input.multiple) input.append(new Option('尚未填写', ''));
    const options = def.type === 'boolean' ? [['是', 'true'], ['否', 'false']] : [...new Set([...(def.options || []), ...(typeof value === 'string' && value ? [value] : [])])].map((item) => [item, item]);
    options.forEach(([label, key]) => input.append(new Option(label, key)));
    if (input.multiple) [...input.options].forEach((option) => { option.selected = Array.isArray(value) && value.includes(option.value); });
    else input.value = value == null ? '' : String(value);
  } else { input = document.createElement(def.type === 'textarea' ? 'textarea' : 'input'); if (input.tagName === 'INPUT') input.type = def.type === 'number' ? 'number' : 'text'; input.value = value == null ? '' : String(value); }
  return input;
}
// 只做显式类型转换，最终由后台契约再次校验，不用字符串真假推断布尔值。
function workspaceValue(input, def) { if (def.type === 'multiSelect') return input.tagName === 'SELECT' ? [...input.selectedOptions].map((option) => option.value) : input.value; if (input.value === '') return null; if (def.type === 'number') { const value = Number(input.value); if (!Number.isFinite(value)) throw new Error('请输入有效数字'); return value; } return def.type === 'boolean' ? input.value === 'true' : input.value; }
// 页面含未保存的字段定义或经历输入时，重新渲染或切换须由用户选择丢弃。
function workspaceDirty() { return !!document.querySelector('[data-dirty="true"]'); }
// 统一处理简历管理及清空内容；保护草稿，破坏性操作绑定确认版本，成功后才刷新编辑器。
async function manageResumeProfile(action) {
  const status = document.getElementById('centerStatus');
  const buttons = ['createResumeProfile', 'renameResumeProfile', 'clearResumeValues', 'deleteResumeProfile'].map((id) => document.getElementById(id));
  const select = document.getElementById('entryProfile');
  // 清空等待期间禁止继续修改字段，防止新输入排到清空命令之后重新写回。
  const editors = action === 'clearProfileValues' ? [...document.querySelectorAll('#basicFields input:enabled, #basicFields textarea:enabled, #basicFields select:enabled, #basicFields button:enabled')] : [];
  editors.forEach((control) => { control.disabled = true; });
  buttons.forEach((button) => { button.disabled = true; }); select.disabled = true;
  try {
    // 按钮引起的失焦保存先完成；仍未保存的冲突草稿继续交给用户决定。
    await resumeSaveQueue;
    if (workspaceDirty() && !confirm('存在未保存编辑，继续管理简历将丢弃这些编辑，是否继续？')) return;
    await flushSaves();
    const { database } = await dataRequest('localapply:read');
    const profile = database.profiles.find((item) => item.profileId === select.value);
    let payload; let message;
    if (action === 'createProfile') {
      const name = document.getElementById('newProfileName').value.trim();
      if (!name) throw new Error('请输入新简历名称');
      payload = { name }; message = '已新建并切换到新简历。';
    } else {
      if (!profile) throw new Error('简历不存在，请重新打开页面');
      if (action === 'renameProfile') {
        const name = prompt('修改简历名称（仅修改名称，保留所有资料）', profile.name);
        if (name === null) return;
        if (!name.trim()) throw new Error('简历名称不能为空');
        if (name.trim() === profile.name) return;
        payload = { profileId: profile.profileId, name: name.trim(), confirmed: true }; message = '简历已重命名。';
      } else if (action === 'clearProfileValues') {
        const values = database.fieldValues.filter((item) => item.profileId === profile.profileId && (LocalApplyProfileView.hasValue(item.value) || item.evidence !== undefined)).length;
        if (!values) { cancelFieldEdit(); await reloadDataState(profile.profileId); status.textContent = '当前简历的全部字段内容已为空。'; return; }
        if (!confirm(`清空简历“${profile.name}”的全部字段内容（${values} 项，包含收起的选填字段、动态字段及旧经历字段值）？\n字段、简历和经历结构、映射规则、其他简历及模型配置保留。清空前会保存恢复点，可在“数据与备份”恢复；该恢复点将替换上一次恢复点。`)) return;
        payload = { profileId: profile.profileId, confirmed: true }; message = `已清空 ${values} 项字段内容，字段结构保留。可在“数据与备份”恢复清空前资料。`;
      } else {
        if (database.profiles.length <= 1) throw new Error('至少保留一份简历，可直接修改现有资料');
        const values = database.fieldValues.filter((item) => item.profileId === profile.profileId).length;
        const entries = database.entries.filter((item) => item.profileId === profile.profileId).length;
        const rules = database.mappingRules.filter((item) => item.profileId === profile.profileId).length;
        if (!confirm(`确认删除简历“${profile.name}”？将删除 ${values} 个资料项（含空值）、${entries} 段经历、${rules} 条专属映射，以及该简历的材料备注和草稿。此操作不可撤销，其他简历和共享字段库保留。`)) return;
        payload = { profileId: profile.profileId, confirmed: true }; message = '简历及其关联资料已删除，已切换至保留的简历。';
      }
    }
    const { result } = await dataCommand(action, payload, database.revision);
    cancelFieldEdit(); await reloadDataState(action === 'clearProfileValues' ? profile.profileId : result);
    if (action === 'createProfile') document.getElementById('newProfileName').value = '';
    status.textContent = message;
  } catch (error) { status.textContent = '未完成：' + error.message; }
  finally {
    editors.forEach((control) => { if (control.isConnected) control.disabled = false; });
    buttons.forEach((button) => { button.disabled = false; }); select.disabled = false;
    document.getElementById('deleteResumeProfile').disabled = select.options.length <= 1;
  }
}
// 概览只统计基础字段及其已填值，与当前编辑内容一致；不读取任何 Key。
async function refreshWorkspace() {
  const { database } = await dataRequest('localapply:read'); workspaceDatabase = database;
  const profileId = document.getElementById('entryProfile').value || database.activeProfileId;
  document.getElementById('overviewProfile').textContent = database.profiles.find((item) => item.profileId === profileId)?.name || '未选择';
  const fields = LocalApplyProfileView.editorSections(database, profileId).flatMap((group) => group.items);
  document.getElementById('overviewValues').textContent = String(fields.filter((item) => LocalApplyProfileView.hasValue(item.row?.value)).length);
  document.getElementById('overviewFields').textContent = String(fields.length);
  document.getElementById('overviewRules').textContent = String(database.mappingRules.filter((item) => item.profileId === profileId).length);
  document.getElementById('managerWelcome').hidden = fields.some((item) => LocalApplyProfileView.hasValue(item.row?.value));
  document.getElementById('deleteResumeProfile').disabled = database.profiles.length <= 1;
  renderFieldLibrary(); renderResumeToc();
}
// 当前档案删除与全局删除明确分开；公共内置定义只能从个人展示中移除。
function renderFieldLibrary() {
  if (!workspaceDatabase) return; const db = workspaceDatabase; const root = document.getElementById('fieldList'); root.replaceChildren(); const query = document.getElementById('fieldSearch').value.trim().toLowerCase(); const profileId = document.getElementById('entryProfile').value;
  for (const def of db.fieldDefinitions.filter((item) => (item.label + item.group + item.aliases.join(' ')).toLowerCase().includes(query))) {
    const box = workspaceNode('article', '', 'library-row'); box.dataset.fieldId = def.fieldId; const info = workspaceNode('div'); info.append(workspaceNode('strong', def.label), workspaceNode('p', `${def.group} · ${def.type} · ${db.publicFieldIds.includes(def.fieldId) ? '公共定义 / 无个人值' : '本地私有'} · v${def.version}`)); box.append(info);
    const actions = workspaceNode('div', '', 'library-actions');
    // 目录动作执行后统一刷新版本，失败保留定义和值并显示可读错误。
    function action(label, work) { const button = workspaceNode('button', label, 'btn ghost'); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await work(); } catch (error) { document.getElementById('fieldStatus').textContent = error.message; } finally { button.disabled = false; } }); actions.append(button); }
    const binding = db.bindings.find((item) => item.profileId === profileId && item.fieldId === def.fieldId);
    if (binding) action('移除当前档案字段', async () => {
      if (!confirm(`仅移除当前档案的“${def.label}”平面字段和值？其他档案与独立经历保留。`)) return;
      const latest = await getState(); const profile = latest.profiles.find((item) => item.id === profileId); profile.fields = profile.fields.filter((item) => item.fid !== binding.fid); await saveState(latest); await reloadDataState(); document.getElementById('fieldStatus').textContent = '已从当前档案移除，其他档案及经历保留。';
    });
    else action('添加到当前档案', async () => {
      if (!confirm(`将“${def.label}”作为空白字段添加到当前档案？不会复制其他档案的值。`)) return;
      await dataCommand('attachField', { fieldId: def.fieldId, profileId }, db.revision); await reloadDataState();
    });
    if (!db.publicFieldIds.includes(def.fieldId)) {
      action('编辑定义', () => beginFieldEdit(def.fieldId));
      action('彻底删除字段', async () => { const values = db.fieldValues.filter((item) => item.fieldId === def.fieldId); const profiles = new Set([...values.map((item) => item.profileId), ...db.bindings.filter((item) => item.fieldId === def.fieldId).map((item) => item.profileId)]); const rules = db.mappingRules.filter((item) => item.fieldId === def.fieldId).length;
        if (!confirm(`彻底删除“${def.label}”？影响 ${profiles.size} 个档案、${values.length} 个值、${rules} 条映射。删除前建议导出备份；确认后移除全部关联数据。`)) return;
        await dataCommand('deleteField', { fieldId: def.fieldId }, db.revision); await reloadDataState(); document.getElementById('fieldStatus').textContent = '字段及全部关联引用已删除。';
      });
    }
    box.append(actions); root.append(box);
  }
  if (!root.children.length) root.append(workspaceNode('p', '没有匹配字段。', 'muted'));
}
// 开始编辑时读取最新版本，加载期间禁用表单，避免异步回填覆盖正在输入的中文。
async function beginFieldEdit(fieldId) {
  if (workspaceDirty() && !confirm('当前有未保存编辑，丢弃后编辑此定义？')) return;
  const form = document.getElementById('fieldForm'); const controls = [...form.elements]; controls.forEach((item) => { item.disabled = true; });
  try {
    await refreshWorkspace(); const latest = workspaceDatabase.fieldDefinitions.find((item) => item.fieldId === fieldId); if (!latest) throw new Error('字段已被删除，请刷新后重试');
    workspaceEditing = { definition: latest, revision: workspaceDatabase.revision }; form.dataset.dirty = '';
    document.getElementById('fieldLabel').value = latest.label; document.getElementById('fieldGroup').value = latest.group; document.getElementById('fieldType').value = latest.type;
    document.getElementById('fieldAliases').value = latest.aliases.join('、'); document.getElementById('fieldOptions').value = latest.options.join('\n'); document.getElementById('fieldSave').textContent = '确认修改定义';
    document.getElementById('fieldCreate').open = true; form.scrollIntoView({ block: 'center' });
  } finally { controls.forEach((item) => { item.disabled = false; }); }
}
// 取消编辑不写数据库，保留旧字段的稳定 ID 和实际值。
function cancelFieldEdit() { workspaceEditing = null; document.getElementById('fieldForm').reset(); document.getElementById('fieldForm').dataset.dirty = ''; document.getElementById('fieldSave').textContent = '确认新增字段'; }
// 旧分类别名定位到统一分类；已移除的经历链接回到资料入口，不再生成经历模块。
async function locateWorkspace() {
  const params = new URLSearchParams(location.search); const profileId = params.get('profile');
  if (profileId && workspaceDatabase.profiles.some((item) => item.profileId === profileId)) { const next = await getState(); next.activeProfileId = profileId; await saveState(next); document.getElementById('entryProfile').value = profileId; await reloadDataState(); }
  let key = params.get('section');
  if (key?.startsWith('group:')) {
    const original = key.slice(6);
    const group = LocalApplyProfileView.editorSections(workspaceDatabase, document.getElementById('entryProfile').value)
      .find((item) => item.group === original || item.items.some(({ definition }) => definition.group === original));
    if (group) key = 'group:' + group.group;
  }
  if (key?.startsWith('entry:')) key = 'center';
  if (workspaceRoute() === 'resumeCenter' && (key === 'center' || key?.startsWith('group:'))) locateResumeSection(key);
}
// 工作台导航、字段定义和简历管理只挂载一次，沿用旧设置页的初始化顺序。
async function initWorkspace() {
  if (workspaceInitialized) return; workspaceInitialized = true;
  document.getElementById('resumeToc').addEventListener('click', (event) => { const button = event.target.closest('button[data-toc-key]'); if (button) locateResumeSection(button.dataset.tocKey); });
  window.addEventListener('scroll', scheduleResumePosition, { passive: true });
  window.addEventListener('resize', scheduleResumePosition);
  document.getElementById('resumeCenter').addEventListener('toggle', scheduleResumePosition, true);
  const resumeResize = new ResizeObserver(scheduleResumePosition); resumeResize.observe(document.querySelector('.resume-main'));
  // 导航和引导链接共用入口；从导入页检测能力时显示 AI 模块，避免结果藏在其他页面。
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]'); const detecting = event.target.closest('#btnDetectImport');
    if ((!link && !detecting) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const key = detecting ? 'aiSettings' : link.hash.slice(1); if (!Object.hasOwn(workspacePages, key)) return;
    event.preventDefault(); if (location.hash !== '#' + key) history.pushState(null, '', '#' + key); showWorkspacePage(key, true);
  });
  window.addEventListener('hashchange', () => showWorkspacePage(workspaceRoute(), true));
  document.getElementById('fieldSearch').addEventListener('input', renderFieldLibrary);
  document.getElementById('fieldForm').addEventListener('input', () => { document.getElementById('fieldForm').dataset.dirty = 'true'; }); document.getElementById('fieldCancel').addEventListener('click', cancelFieldEdit);
  document.getElementById('fieldForm').addEventListener('submit', async (event) => { event.preventDefault(); const button = document.getElementById('fieldSave'); button.disabled = true; try {
    const definition = { label: document.getElementById('fieldLabel').value.trim(), type: document.getElementById('fieldType').value, group: document.getElementById('fieldGroup').value.trim(), aliases: document.getElementById('fieldAliases').value.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean), options: document.getElementById('fieldOptions').value.split('\n').map((item) => item.trim()).filter(Boolean) };
    if (workspaceEditing) { const prior = workspaceEditing.definition; const count = workspaceDatabase.fieldValues.filter((item) => item.fieldId === prior.fieldId).length; if (!confirm(`确认修改“${prior.label}”定义？关联 ${count} 个值，类型不兼容时会拒绝保存。`)) return; await dataCommand('editField', { definition: { ...prior, ...definition, version: prior.version + 1 } }, workspaceEditing.revision); }
    else await dataCommand('createField', { definition, profileId: document.getElementById('entryProfile').value, value: null }, workspaceDatabase.revision);
    cancelFieldEdit(); await reloadDataState(); document.getElementById('fieldStatus').textContent = '字段定义已保存，实际内容请在简历中心填写。';
  } catch (error) { document.getElementById('fieldStatus').textContent = '未保存：' + error.message; } finally { button.disabled = false; } });
  for (const [id, action] of [['createResumeProfile', 'createProfile'], ['renameResumeProfile', 'renameProfile'], ['clearResumeValues', 'clearProfileValues'], ['deleteResumeProfile', 'deleteProfile']]) {
    document.getElementById(id).addEventListener('click', () => manageResumeProfile(action));
  }
  document.getElementById('entryProfile').addEventListener('change', async () => { const profileId = document.getElementById('entryProfile').value; try { if (workspaceDirty() && !confirm('切换档案将丢弃未保存编辑，是否继续？')) { document.getElementById('entryProfile').value = workspaceDatabase.activeProfileId; return; } cancelFieldEdit(); const next = await getState(); next.activeProfileId = profileId; await saveState(next); await reloadDataState(); } catch (error) { document.getElementById('centerStatus').textContent = error.message; } });
  window.addEventListener('beforeunload', (event) => { if (workspaceDirty()) { event.preventDefault(); event.returnValue = ''; } });
  await refreshWorkspace(); showWorkspacePage(workspaceRoute()); await locateWorkspace(); document.body.dataset.workspaceReady = 'true';
}
