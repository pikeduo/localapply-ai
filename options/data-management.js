// 设置页的渐进式数据管理：备份预览、公共定义和重复经历，不接触原文件。
'use strict';
let pendingRestore = null;
let pendingPublicPackage = null;
let publicPreviewGeneration = 0;
let publicPackageBusy = false;

// 规则包阻断原因仅显示固定中文，不读取或展示被引用的个人值。
const ruleConflictLabels = { private_id: '与私有字段ID冲突', semantic_change: '不支持重命名、改分类或改类型', field_version: '字段版本未递增',
  metadata_changed: '安装后定义已变化', has_values: '已有个人资料，不可删除', has_mappings: '存在网页映射引用', bindings_changed: '安装后绑定已变化', other_package: '其他规则包仍引用此字段' };

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
  document.getElementById('restorePreview').textContent = `校验通过：新增档案 ${preview.profilesAdded}，字段 ${preview.fieldsAdded}，值 ${preview.valuesAdded}，申请 ${preview.applicationsAdded}，冲突 ${preview.conflicts}，移除档案 ${preview.profilesRemoved}、申请 ${preview.applicationsRemoved}。${mode === 'merge' ? '冲突保留当前内容。' : '确认后覆盖资料并保存恢复点。'}`;
  document.getElementById('btnApplyRestore').hidden = false;
}

// 使用明确命令保存，版本变化由后台拒绝。
async function dataCommand(action, payload, expectedRevision) {
  return dataRequest('localapply:command', { request: { action, payload, expectedRevision } });
}

// 安装和回滚都先展示逐字段定义差异；文本仅用textContent，不解释公共包中的HTML。
function showPublicPackagePreview(plan, payload, action) {
  pendingPublicPackage = { plan, payload, action };
  const box = document.getElementById('publicPackagePreview'); const rows = document.getElementById('publicPackageChanges'); rows.replaceChildren();
  const rollback = action === 'rollbackRulePackage'; const conflicts = plan.conflicts || [];
  document.getElementById('publicPackageSummary').textContent = `${rollback ? '回滚' : '导入'}预览：${plan.changes.length} 项定义变化，${conflicts.length} 项冲突。` +
    (plan.source ? ` ${plan.packageId} · 发布 ${plan.release} · 来源 ${plan.source.name}${plan.source.reference ? '（' + plan.source.reference + '）' : ''}。摘要 ${plan.sha256} 仅校验一致性，请独立审核来源。` : '旧格式不含包级回执；合并前建议导出备份。');
  for (const change of plan.changes) {
    const before = rollback ? change.after : change.before; const after = rollback ? change.before : change.after;
    const item = document.createElement('details'); const title = document.createElement('summary'); const body = document.createElement('pre');
    title.textContent = `${after?.label || before?.label || change.fieldId}（${change.fieldId}）· ${!before ? '新增' : !after ? '删除空定义' : '更新元数据'}`;
    body.textContent = JSON.stringify({ 原定义: before, 确认后定义: after }, null, 2); item.append(title, body); rows.append(item);
  }
  for (const conflict of conflicts) { const row = document.createElement('p'); row.textContent = `${conflict.fieldId}：${ruleConflictLabels[conflict.reason] || '需要人工检查'}`; rows.append(row); }
  const consent = document.getElementById('publicPackageConsent'); consent.checked = false;
  const button = document.getElementById('btnApplyPublicPackage'); button.disabled = true; button.textContent = rollback ? '确认按差异回滚' : '确认按差异导入';
  if (plan.alreadyInstalled) document.getElementById('publicPackageSummary').textContent += ' 已安装同一版本，无需重复导入。';
  else if (!plan.changes.length && action !== 'mergePublicFields') document.getElementById('publicPackageSummary').textContent += ' 本次只变更本机安装回执，不改变字段定义。';
  box.hidden = false;
}

// 同一预览版本必须由用户再次确认，资料变化或失败后不能静默换revision重试。
function updatePublicPackageConsent() {
  const current = pendingPublicPackage;
  document.getElementById('btnApplyPublicPackage').disabled = !current || !document.getElementById('publicPackageConsent').checked
    || !!current.plan.conflicts?.length || !!current.plan.alreadyInstalled || current.action === 'mergePublicFields' && !current.plan.changes.length;
}

// 列表只读本机回执；按钮先生成回滚预览，禁止一键恢复整份私人数据库。
async function renderRulePackages() {
  const box = document.getElementById('installedRulePackages'); box.replaceChildren();
  try {
    const { result } = await dataCommand('listRulePackages', {});
    if (!result.length) { box.textContent = '尚未安装版本化离线规则包。'; return; }
    for (const item of result) {
      const row = document.createElement('div'); row.className = 'row'; const label = document.createElement('span'); const button = document.createElement('button');
      label.textContent = `${item.packageId} · 发布 ${item.release} · ${item.source.name}${item.canRollback ? '' : ' · 回滚受保护'}`;
      button.type = 'button'; button.className = 'btn ghost'; button.textContent = '查看回滚差异';
      // 回滚差异没有个人值；仍经后台重新检查当前版本和所有引用。
      button.addEventListener('click', async () => {
        try { await flushSaves(); const response = await dataCommand('previewRuleRollback', { packageId: item.packageId }); showPublicPackagePreview(response.result, { packageId: item.packageId }, 'rollbackRulePackage'); }
        catch (error) { backupMsg(escapeHtml(error.message)); }
      });
      row.append(label, button); box.append(row);
    }
  } catch (error) { box.textContent = '规则包列表读取失败：' + error.message; }
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
  // 兼容包明确说明申请表缺失，避免回滚时误以为已备份全部资料。
  for (const version of [3, 4]) document.getElementById('btnExportV' + version).addEventListener('click', async () => {
    try { await flushSaves(); const response = await dataRequest('localapply:exportBackup', { version }); downloadJson(response.backup, `localapply-v${version}-backup.json`); backupMsg(`已导出兼容 v${version} 备份；${version === 3 ? '附加记录转为私有平面字段；' : ''}不含已投职位。请另存普通完整备份和已投职位 JSON 后再回滚。`); }
    catch (error) { backupMsg(escapeHtml('兼容导出失败：' + error.message)); }
  });
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
    try { await dataCommand('restoreRecovery', {}); await reloadDataState(); backupMsg('已恢复上次导入或清理前的资料，API 配置保持原样。'); }
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
    if (publicPackageBusy) return;
    const generation = ++publicPreviewGeneration;
    pendingPublicPackage = null; document.getElementById('publicPackagePreview').hidden = true;
    try {
      if (file.size > 1024 * 1024) throw new Error('公共字段包超过 1 MiB');
      const payload = JSON.parse(await file.text());
      // 后台先完整校验，再显示差异；选择文件和预览均不写入资料或安装回执。
      await flushSaves(); const versioned = payload.kind === 'localapply-rule-package';
      const response = await dataCommand(versioned ? 'previewRulePackage' : 'previewPublicFields', versioned ? { package: payload } : payload);
      if (generation !== publicPreviewGeneration) return;
      showPublicPackagePreview(response.result, payload, versioned ? 'installRulePackage' : 'mergePublicFields');
    } catch (error) { backupMsg(escapeHtml(error.message)); }
  });
  document.getElementById('publicPackageConsent').addEventListener('change', updatePublicPackageConsent);
  document.getElementById('btnCancelPublicPackage').addEventListener('click', () => { publicPreviewGeneration++; pendingPublicPackage = null; document.getElementById('publicPackagePreview').hidden = true; });
  // 明确点击后才调用唯一repository命令；失败保留差异供检查，不自动重复安装。
  document.getElementById('btnApplyPublicPackage').addEventListener('click', async () => {
    const current = pendingPublicPackage; if (!current || !document.getElementById('publicPackageConsent').checked || current.plan.conflicts?.length || current.plan.alreadyInstalled) return;
    if (publicPackageBusy) return; publicPackageBusy = true;
    document.getElementById('btnPublicImport').disabled = true; document.getElementById('btnCancelPublicPackage').disabled = true;
    document.getElementById('btnApplyPublicPackage').disabled = true;
    try {
      await flushSaves();
      const payload = current.action === 'installRulePackage' ? { package: current.payload, confirmed: true }
        : current.action === 'rollbackRulePackage' ? { packageId: current.payload.packageId, confirmed: true } : current.payload;
      await dataCommand(current.action, payload, current.plan.revision); pendingPublicPackage = null; document.getElementById('publicPackagePreview').hidden = true;
      await reloadDataState(); await renderRulePackages(); backupMsg('公共元数据已按确认差异保存，个人值和API配置保持原样。');
    } catch (error) { backupMsg(escapeHtml(error.message)); }
    finally { publicPackageBusy = false; document.getElementById('btnPublicImport').disabled = false; document.getElementById('btnCancelPublicPackage').disabled = false; updatePublicPackageConsent(); }
  });
  await renderEntries();
  await renderRulePackages();
}
