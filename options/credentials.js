// Key 可直接填写；口令为可选保护，不读回已保存的明文。
'use strict';
let pendingCredentials = Promise.resolve();
// 网络动作等待失焦触发的 Key 保存，避免请求仍携带旧凭据。
async function flushCredentials() { await pendingCredentials; await flushSaves(); }
// 默认不要求口令；旧密钥锁定时也允许直接填写新 Key，旧密文不会丢失。
function renderVault() {
  const vault = state.settings.vault || {};
  const saved = !!state.settings.keyStatus?.[state.settings.provider];
  $('#apiKey').value = '';
  $('#apiKey').disabled = false;
  const local = vault.localProviders?.includes(state.settings.provider);
  $('#apiKey').placeholder = saved ? '已保存，输入新的 API Key 可替换' : '在这里粘贴服务商提供的 API Key，无需安全口令';
  $('#keySavedStatus').textContent = !saved ? '尚未填写 API Key；无需认证的本地服务可以留空。'
    : !vault.enabled || local ? '当前 Key 已在本机保存，可直接使用，无需口令。'
      : vault.unlocked ? '当前 Key 受可选口令保护，已解锁。' : '旧 Key 受口令保护。可直接填写新 Key 使用，或展开下方选项解锁旧 Key。';
  $('#vaultSetup').hidden = !!vault.enabled;
  $('#vaultConfirm').hidden = !!vault.enabled;
  $('#vaultUnlock').hidden = !vault.enabled;
  $('#vaultLock').hidden = !vault.enabled;
  $('#vaultDisable').hidden = !vault.enabled;
  $('#deleteKey').disabled = !saved;
  $('#vaultStatus').textContent = !vault.enabled ? '默认无需口令。本机自动保存模式可直接使用；只有主动开启口令保护后才需要解锁。'
    : vault.unlocked ? '可选口令保护已解锁；点击“取消口令保护”后，下次无需解锁。' : '口令保护已锁定。要保留旧 Key 并取消保护，需输入原口令；忘记口令可直接在上方重填新 Key，旧密文保留。';
}
// 密钥操作单独串行，失败保留用户输入，口令用后立即从 DOM 清除。
function changeVault(action, payload = {}) {
  const task = pendingCredentials.catch(() => {}).then(async () => {
    await flushSaves();
    const current = await getState();
    const response = await dataRequest('localapply:vault', { action, payload: { ...payload, revision: current.settings.vault.revision,
      localRevision: current.settings.vault.localRevision } });
    state = await getState();
    renderVault(); resetModelCatalog();
    toastMsg(action === 'unlock' ? '旧密钥已解锁' : action === 'lock' ? '口令保护已锁定' : action === 'setup' ? '已开启可选口令保护'
      : action === 'disable' ? '已取消口令保护，下次可直接使用' : payload.key ? 'API Key 已保存到本机' : '当前 Key 已删除', 'ok');
    return response;
  });
  pendingCredentials = task;
  task.catch((error) => { $('#vaultStatus').textContent = error.message; toastMsg(error.message, 'err'); });
  return task;
}
// 明确保存按钮和失焦自动保存共用一个入口，空输入不会误删已保存的 Key。
function saveEnteredKey() {
  const key = $('#apiKey').value.trim();
  if (!key) return;
  return changeVault('setKey', { providerId: state.settings.provider, key });
}
// 挂载口令与 Key 操作，不把明文 Key 混入兼容状态保存队列。
function initCredentials() {
  renderVault();
  $('#apiKey').addEventListener('change', saveEnteredKey);
  $('#saveKey').addEventListener('click', saveEnteredKey);
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
  $('#vaultDisable').addEventListener('click', () => submit('disable'));
}
