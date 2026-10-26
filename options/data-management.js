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

// 刷新最新投影；简历管理可指定新的选中 ID，避免继续展示已删除或旧的简历。
async function reloadDataState(profileId) {
  state = await getState();
  renderTargetProfiles();
  await renderEntries(profileId);
  await renderResumeCenter();
  if (typeof workspaceInitialized !== 'undefined' && workspaceInitialized) await refreshWorkspace();
}

// 刷新当前简历选择器；所有资料和经历统一交给简历分类编辑器渲染。
async function renderEntries(profileId) {
  const { database } = await dataRequest('localapply:read');
  const select = document.getElementById('entryProfile');
  const selected = profileId || select.value || database.activeProfileId;
  select.replaceChildren(...database.profiles.map((profile) => new Option(profile.name, profile.profileId)));
  select.value = database.profiles.some((profile) => profile.profileId === selected) ? selected : database.activeProfileId;
}

// 挂载备份确认、恢复点和公共包入口，并初始化简历选择。
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
  await renderEntries();
}
