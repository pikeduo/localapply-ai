// 工作台只使用既有后台命令管理字段与档案，不增加数据库版本或 API 请求。
let workspaceDatabase = null;
let workspaceEditing = null;
let workspaceInitialized = false;
// DOM 构造始终用文本，字段名、经历标题不得拼接到 HTML。
function workspaceNode(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
// 按字段类型创建编辑器；日期保留年/月精度，不能使用 date 输入框静默补日。
function workspaceControl(def, value) {
  let input;
  if (['boolean', 'select', 'multiSelect'].includes(def.type)) {
    input = document.createElement('select'); input.multiple = def.type === 'multiSelect';
    if (!input.multiple) input.append(new Option('尚未填写', ''));
    const options = def.type === 'boolean' ? [['是', 'true'], ['否', 'false']] : [...new Set([...(def.options || []), ...(typeof value === 'string' && value ? [value] : [])])].map((item) => [item, item]);
    options.forEach(([label, key]) => input.append(new Option(label, key)));
    if (input.multiple) [...input.options].forEach((option) => { option.selected = Array.isArray(value) && value.includes(option.value); });
    else input.value = value == null ? '' : String(value);
  } else { input = document.createElement(def.type === 'textarea' ? 'textarea' : 'input'); if (input.tagName === 'INPUT') input.type = def.type === 'number' ? 'number' : 'text'; input.value = value == null ? '' : String(value); }
  if (def.type === 'date') input.placeholder = 'YYYY / YYYY-MM / YYYY-MM-DD';
  return input;
}
// 只做显式类型转换，最终由后台契约再次校验，不用字符串真假推断布尔值。
function workspaceValue(input, def) { if (def.type === 'multiSelect') return [...input.selectedOptions].map((option) => option.value); if (input.value === '') return null; if (def.type === 'number') { const value = Number(input.value); if (!Number.isFinite(value)) throw new Error('请输入有效数字'); return value; } return def.type === 'boolean' ? input.value === 'true' : input.value; }
// 页面含未保存的字段定义或经历输入时，刷新/切换须由用户选择丢弃。
function workspaceDirty() { return !!document.querySelector('[data-dirty="true"]'); }
// 从后台读取最新规范数据，刷新概览和字段目录，不读取任何 Key。
async function refreshWorkspace() {
  const { database } = await dataRequest('localapply:read'); workspaceDatabase = database;
  const profileId = document.getElementById('entryProfile').value || database.activeProfileId;
  document.getElementById('overviewProfile').textContent = database.profiles.find((item) => item.profileId === profileId)?.name || '未选择';
  document.getElementById('overviewValues').textContent = String(database.fieldValues.filter((item) => item.profileId === profileId && LocalApplyProfileView.hasValue(item.value)).length);
  document.getElementById('overviewEntries').textContent = String(database.entries.filter((item) => item.profileId === profileId).length);
  document.getElementById('overviewRules').textContent = String(database.mappingRules.filter((item) => item.profileId === profileId).length);
  document.getElementById('managerWelcome').hidden = database.fieldValues.some((item) => item.profileId === profileId && LocalApplyProfileView.hasValue(item.value));
  const settings = (await getState()).settings; const provider = LocalApplyProviders.resolve(settings);
  const vault = settings.vault || {}; const saved = !!settings.keyStatus?.[settings.provider]; const locked = vault.enabled && !vault.unlocked && !vault.localProviders?.includes(settings.provider);
  document.getElementById('workspaceMode').textContent = !navigator.onLine ? '当前离线 · 本地资料仍可用' : !settings.model || provider.requiresKey !== false && !saved ? '仅本地使用 · AI 配置可跳过' : 'AI 可选 · ' + provider.name + ' · ' + (locked ? '密钥已锁定' : '按需调用');
  renderFieldLibrary();
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
// 深链接只接受本地已有档案和真实分组，不把 URL 参数当 HTML 或执行命令。
async function locateWorkspace() {
  const params = new URLSearchParams(location.search); const profileId = params.get('profile');
  if (profileId && workspaceDatabase.profiles.some((item) => item.profileId === profileId)) { const next = await getState(); next.activeProfileId = profileId; await saveState(next); document.getElementById('entryProfile').value = profileId; await reloadDataState(); }
  const key = params.get('section'); if (key?.startsWith('group:')) { document.getElementById('centerGroup').value = key.slice(6); document.getElementById('centerGroup').dispatchEvent(new Event('change')); }
  else if (key?.startsWith('entry:')) { const entry = [...document.querySelectorAll('[data-entry-id]')].find((item) => item.dataset.entryId === key.slice(6)); if (entry) { entry.classList.add('is-target'); entry.scrollIntoView({ block: 'center' }); } }
  if (!key && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
}
// 工作台导航、字段定义和刷新入口只挂载一次，沿用旧设置页的初始化顺序。
async function initWorkspace() {
  if (workspaceInitialized) return; workspaceInitialized = true;
  document.querySelector('.wrap').insertBefore(document.getElementById('fieldLibrary'), document.getElementById('pdfCard'));
  document.querySelectorAll('.workspace-sidebar nav a').forEach((link) => link.addEventListener('click', () => { document.querySelectorAll('.workspace-sidebar nav a').forEach((item) => item.removeAttribute('aria-current')); link.setAttribute('aria-current', 'location'); if (link.hash === '#diagnosticsPanel') document.getElementById('diagnosticsPanel').open = true; }));
  document.getElementById('fieldSearch').addEventListener('input', renderFieldLibrary);
  document.getElementById('fieldForm').addEventListener('input', () => { document.getElementById('fieldForm').dataset.dirty = 'true'; }); document.getElementById('fieldCancel').addEventListener('click', cancelFieldEdit);
  document.getElementById('fieldForm').addEventListener('submit', async (event) => { event.preventDefault(); const button = document.getElementById('fieldSave'); button.disabled = true; try {
    const definition = { label: document.getElementById('fieldLabel').value.trim(), type: document.getElementById('fieldType').value, group: document.getElementById('fieldGroup').value.trim(), aliases: document.getElementById('fieldAliases').value.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean), options: document.getElementById('fieldOptions').value.split('\n').map((item) => item.trim()).filter(Boolean) };
    if (workspaceEditing) { const prior = workspaceEditing.definition; const count = workspaceDatabase.fieldValues.filter((item) => item.fieldId === prior.fieldId).length; if (!confirm(`确认修改“${prior.label}”定义？关联 ${count} 个值，类型不兼容时会拒绝保存。`)) return; await dataCommand('editField', { definition: { ...prior, ...definition, version: prior.version + 1 } }, workspaceEditing.revision); }
    else await dataCommand('createField', { definition, profileId: document.getElementById('entryProfile').value, value: null }, workspaceDatabase.revision);
    cancelFieldEdit(); await reloadDataState(); document.getElementById('fieldStatus').textContent = '字段定义已保存，实际内容请在简历中心填写。';
  } catch (error) { document.getElementById('fieldStatus').textContent = '未保存：' + error.message; } finally { button.disabled = false; } });
  document.getElementById('centerSearch').addEventListener('input', () => { const query = document.getElementById('centerSearch').value.trim().toLowerCase(); document.querySelectorAll('#basicFields .center-field').forEach((item) => { item.hidden = !item.textContent.toLowerCase().includes(query); }); });
  document.getElementById('centerGroup').addEventListener('change', () => { const group = document.getElementById('centerGroup').value; const heading = [...document.querySelectorAll('.center-group-heading')].find((item) => item.dataset.group === group); if (heading) { heading.scrollIntoView({ block: 'center' }); heading.classList.add('is-target'); } });
  document.getElementById('centerRefresh').addEventListener('click', async () => { try { if (workspaceDirty() && !confirm('存在未保存编辑，确认丢弃并刷新本地资料？')) return; cancelFieldEdit(); await flushSaves(); await reloadDataState(); document.getElementById('centerStatus').textContent = '已刷新本地资料。'; } catch (error) { document.getElementById('centerStatus').textContent = error.message; } });
  document.getElementById('entryProfile').addEventListener('change', async () => { const profileId = document.getElementById('entryProfile').value; try { if (workspaceDirty() && !confirm('切换档案将丢弃未保存编辑，是否继续？')) { document.getElementById('entryProfile').value = workspaceDatabase.activeProfileId; return; } cancelFieldEdit(); const next = await getState(); next.activeProfileId = profileId; await saveState(next); await reloadDataState(); } catch (error) { document.getElementById('centerStatus').textContent = error.message; } });
  window.addEventListener('offline', () => refreshWorkspace()); window.addEventListener('online', () => refreshWorkspace());
  window.addEventListener('beforeunload', (event) => { if (workspaceDirty()) { event.preventDefault(); event.returnValue = ''; } });
  await refreshWorkspace(); await locateWorkspace();
}
