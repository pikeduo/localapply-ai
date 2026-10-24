// 设置页仅显示密钥是否存在，不读回保险库中的明文。
'use strict';
let pendingCredentials = Promise.resolve();
// 网络动作等待失焦触发的 Key 保存，避免请求仍携带旧凭据。
async function flushCredentials() { await pendingCredentials; await flushSaves(); }
// 根据当前会话显示迁移、解锁或已加密状态；刷新后口令框始终为空。
function renderVault() {
  const vault = state.settings.vault || {};
  const saved = !!state.settings.keyStatus?.[state.settings.provider];
  $('#apiKey').value = '';
  $('#apiKey').disabled = !vault.enabled || !vault.unlocked;
  $('#apiKey').placeholder = saved ? '已加密保存；输入新 Key 可替换' : '先设置口令并解锁，再输入 Key';
  $('#vaultSetup').hidden = !!vault.enabled;
  $('#vaultConfirm').hidden = !!vault.enabled;
  $('#vaultUnlock').hidden = !vault.enabled;
  $('#vaultLock').hidden = !vault.enabled;
  $('#deleteKey').disabled = !vault.unlocked || !saved;
  $('#vaultStatus').textContent = !vault.enabled ? '尚未加密：请设置至少 8 位口令。已有明文 Key 会在加密验证成功后迁移。'
    : vault.unlocked ? '已加密并解锁。关闭文件页或扩展后台回收后需要重新输入口令。' : '已加密、已锁定。本地资料仍可正常编辑，使用已保存 Key 时需解锁。';
}
// 密钥操作单独串行，失败保留用户输入，口令用后立即从 DOM 清除。
function changeVault(action, payload = {}) {
  const task = pendingCredentials.catch(() => {}).then(async () => {
    await flushSaves();
    const current = await getState();
    const response = await dataRequest('localapply:vault', { action, payload: { ...payload, revision: current.settings.vault.revision } });
    state = await getState();
    renderVault(); resetModelCatalog();
    $('#vaultStatus').textContent = action === 'setKey' ? '密钥已加密保存。' : $('#vaultStatus').textContent;
    toastMsg(action === 'unlock' ? '密钥已解锁' : action === 'lock' ? '密钥已锁定' : action === 'setup' ? '口令已设置，密钥已加密' : '密钥已加密保存', 'ok');
    return response;
  });
  pendingCredentials = task;
  task.catch((error) => { $('#vaultStatus').textContent = error.message; toastMsg(error.message, 'err'); });
  return task;
}
// 挂载口令与 Key 操作，不把明文 Key 混入兼容状态保存队列。
function initCredentials() {
  renderVault();
  $('#apiKey').addEventListener('change', () => {
    const key = $('#apiKey').value.trim();
    if (key) changeVault('setKey', { providerId: state.settings.provider, key });
  });
  $('#deleteKey').addEventListener('click', () => changeVault('setKey', { providerId: state.settings.provider, key: '' }));
  // 口令操作不记录口令/密文到日志，失败也清除输入。
  const submit = (action) => {
    const password = $('#vaultPassword').value;
    if (action === 'setup' && password !== $('#vaultConfirm').value) { $('#vaultStatus').textContent = '两次口令不一致'; return; }
    $('#vaultPassword').value = $('#vaultConfirm').value = '';
    changeVault(action, { password });
  };
  $('#vaultSetup').addEventListener('click', () => submit('setup'));
  $('#vaultUnlock').addEventListener('click', () => submit('unlock'));
  $('#vaultLock').addEventListener('click', () => changeVault('lock'));
}
