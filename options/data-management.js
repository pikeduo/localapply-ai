// 设置页的渐进式数据管理：备份预览、公共定义和重复经历，不接触原文件。
'use strict';
let pendingRestore = null;

// 调用可信页面 RPC 并统一处理错误。
async function dataRequest(type, payload = {}) {
  const response = await sendMessage(type, payload);
  if (!response.ok) throw new Error(response.error);
  return response;
}

// 只在用户触发导出时创建临时对象 URL，用后释放。
function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 每次预览都绑定数据库 revision；之后数据有变化则要求重新预览。
async function prepareRestore(text) {
  pendingRestore = null;
  document.getElementById('btnApplyRestore').hidden = true;
  await flushSaves();
  const mode = document.getElementById('restoreMode').value;
  const { preview } = await dataRequest('localapply:previewImport', { backup: text, mode });
  pendingRestore = { text, mode, revision: preview.revision };
  document.getElementById('restorePreview').textContent = `校验通过：新增档案 ${preview.profilesAdded}，字段 ${preview.fieldsAdded}，值 ${preview.valuesAdded}，冲突 ${preview.conflicts}，移除档案 ${preview.profilesRemoved}。${mode === 'merge' ? '冲突保留当前内容。' : '确认后覆盖资料并保存恢复点。'}`;
  document.getElementById('btnApplyRestore').hidden = false;
}

// 使用明确命令保存，版本变化由后台拒绝。
async function dataCommand(action, payload, expectedRevision) {
  return dataRequest('localapply:command', { request: { action, payload, expectedRevision } });
}

// 刷新可信页面的最新投影，导入后旧快照不得再覆盖新数据。
async function reloadDataState() {
  state = await getState();
  renderTargetProfiles();
  await renderEntries();
  await renderResumeCenter();
}

// 渲染重复经历编辑器；所有标题和值用 textContent/value，避免注入 HTML。
async function renderEntries() {
  const { database } = await dataRequest('localapply:read');
  const select = document.getElementById('entryProfile');
  const selected = select.value || database.activeProfileId;
  select.replaceChildren(...database.profiles.map((profile) => new Option(profile.name, profile.profileId)));
  select.value = database.profiles.some((profile) => profile.profileId === selected) ? selected : database.activeProfileId;
  const root = document.getElementById('entriesList'); root.replaceChildren();
  for (const entry of database.entries.filter((row) => row.profileId === select.value)) {
    const box = document.createElement('div'); box.className = 'card';
    const title = document.createElement('h3'); title.textContent = `${LocalApplyResume.kinds[entry.kind]} · ${entry.title || '未命名经历'}`;
    box.appendChild(title);
    const field = document.createElement('select'); field.setAttribute('aria-label', '经历字段');
    database.fieldDefinitions.forEach((def) => field.appendChild(new Option(`${def.group} · ${def.label}`, def.fieldId)));
    field.value = database.fieldValues.find((row) => row.entryId === entry.entryId)?.fieldId || database.fieldDefinitions[0].fieldId;
    const input = document.createElement('input'); input.type = 'text'; input.setAttribute('aria-label', '经历字段值');
    const hint = document.createElement('div'); hint.className = 'muted';
    // 选择字段时显示已有值，类型化字段在保存时转换并由后台再次校验。
    const update = () => {
      const row = database.fieldValues.find((value) => value.entryId === entry.entryId && value.fieldId === field.value);
      input.value = row?.value === undefined || row.value === null ? '' : Array.isArray(row.value) ? JSON.stringify(row.value) : String(row.value);
      const def = database.fieldDefinitions.find((def) => def.fieldId === field.value);
      hint.textContent = def.type === 'boolean' ? '填写 true 或 false。' : def.type === 'multiSelect' ? '多选内容填写 JSON 数组。'
        : row?.evidence ? `来源${row.evidence.page ? '（页/块 ' + row.evidence.page + '）' : ''}：${row.evidence.excerpt || '人工校对'}；编辑保存后改为手动资料。` : '修改后点击保存字段。';
    };
    field.addEventListener('change', update); update();
    const save = document.createElement('button'); save.className = 'btn'; save.textContent = '保存字段';
    save.addEventListener('click', () => entryAction(async () => {
      const def = database.fieldDefinitions.find((def) => def.fieldId === field.value);
      const value = input.value === '' ? null : def.type === 'number' ? Number(input.value)
        : ['boolean', 'multiSelect'].includes(def.type) ? JSON.parse(input.value) : input.value;
      await dataCommand('setValue', { profileId: entry.profileId, entryId: entry.entryId, fieldId: field.value, value }, database.revision);
    }));
    const remove = document.createElement('button'); remove.className = 'btn ghost'; remove.textContent = '删除经历';
    remove.addEventListener('click', () => entryAction(() => dataCommand('deleteEntry', { entryId: entry.entryId }, database.revision)));
    box.append(field, input, save, remove, hint);
    const values = document.createElement('p'); values.className = 'muted';
    values.textContent = database.fieldValues.filter((row) => row.entryId === entry.entryId).map((row) => `${database.fieldDefinitions.find((def) => def.fieldId === row.fieldId).label}：${fieldText(row.value)}`).join('；');
    box.appendChild(values); root.appendChild(box);
  }
}

// 统一显示保存结果；失败保留原库并刷新可见版本。
async function entryAction(work) {
  const status = document.getElementById('entryStatus');
  try { await work(); status.textContent = '已保存在本地'; await renderEntries(); }
  catch (error) { status.textContent = '操作失败：' + error.message; }
}

// 挂载备份确认、恢复点、公共包和重复经历入口。
async function initDataManagement() {
  document.getElementById('restoreMode').addEventListener('change', () => {
    if (pendingRestore) prepareRestore(pendingRestore.text).catch((error) => backupMsg(escapeHtml(error.message)));
  });
  document.getElementById('btnApplyRestore').addEventListener('click', async () => {
    if (!pendingRestore) return;
    try {
      const request = pendingRestore;
      await dataCommand('importBackup', { backup: request.text, mode: request.mode }, request.revision);
      pendingRestore = null;
      document.getElementById('btnApplyRestore').hidden = true;
      document.getElementById('restorePreview').textContent = '导入完成；API 设置保持原样。';
      await reloadDataState();
    } catch (error) { document.getElementById('restorePreview').textContent = '导入失败：' + error.message; }
  });
  document.getElementById('btnRestoreRecovery').addEventListener('click', async () => {
    try { await dataCommand('restoreRecovery', {}); await reloadDataState(); backupMsg('已恢复导入前的资料，API 配置保持原样。'); }
    catch (error) { backupMsg(escapeHtml('恢复失败：' + error.message)); }
  });
  document.getElementById('btnPublicExport').addEventListener('click', async () => {
    try { const response = await dataRequest('localapply:exportPublicFields'); downloadJson(response.fields, 'localapply-public-fields.json'); }
    catch (error) { backupMsg(escapeHtml(error.message)); }
  });
  const fileInput = document.getElementById('publicFieldsFile');
  document.getElementById('btnPublicImport').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; fileInput.value = ''; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('公共字段包超过 1 MiB');
      const payload = JSON.parse(await file.text());
      // 元数据包不能含个人值，最终仍由后台完整白名单校验。
      if (!confirm(`合并公共字段定义（${payload.fields?.length || 0} 项）？新字段默认空白，不执行上传。`)) return;
      await dataCommand('mergePublicFields', payload); await reloadDataState(); backupMsg('公共定义已合并，未复制任何个人值。');
    } catch (error) { backupMsg(escapeHtml(error.message)); }
  });
  document.getElementById('entryProfile').addEventListener('change', renderEntries);
  document.getElementById('btnAddEntry').addEventListener('click', () => entryAction(() => dataCommand('createEntry', {
    profileId: document.getElementById('entryProfile').value, kind: document.getElementById('entryKind').value,
    title: document.getElementById('entryTitle').value,
  })));
  await renderEntries();
}
