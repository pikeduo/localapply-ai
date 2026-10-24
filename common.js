// 侧边栏 / 设置页共用的工具（依赖先加载的 data/templates.js）
'use strict';

const ROOT_KEY = 'wangshenAutofill';
const DATABASE_KEY = 'localapply.database';
const stateBases = new WeakMap();
let pendingSave = Promise.resolve();
let savingCount = 0;
let lastSaveError = null;

// 页面只读取后台兼容投影，不再自行初始化、升级或写入整份存储。
async function getState() {
  const response = await sendMessage('wsa:getState');
  if (!response.ok) throw new Error(response.error);
  const state = response.state;
  stateBases.set(state, JSON.parse(JSON.stringify(state)));
  return state;
}

// 只提交相对读取快照的变更，后台三方合并；同字段冲突时提示刷新而非覆盖。
function saveState(state, source = 'manual') {
  const base = stateBases.get(state);
  if (!base) return Promise.reject(new Error('请先读取档案再保存'));
  const next = JSON.parse(JSON.stringify(state));
  stateBases.set(state, next);
  savingCount++;
  const task = pendingSave.then(async () => {
    const response = await sendMessage('localapply:saveLegacy', { base, state: next, source });
    if (!response.ok) { stateBases.delete(state); throw new Error(response.error); }
    lastSaveError = null;
    state.revision = response.state.revision;
    return response.state;
  });
  pendingSave = task.catch((error) => { lastSaveError = error; }).finally(() => { savingCount--; });
  return task;
}

// 等待页面已提交的操作落盘，备份/导入和测试均复用此屏障。
async function flushSaves() { await pendingSave; if (lastSaveError) throw lastSaveError; }

// 在刚读取的投影上修改；所有实际写入仍经过后台队列。
async function mutateState(mutator) {
  const state = await getState();
  const out = mutator(state);
  await saveState(out === undefined ? state : out);
  return state;
}

function getActiveProfile(state) {
  return state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
}

// 旧输入框统一显示类型化值，false/0 和多选数组不会被当作空值。
function fieldText(value) {
  return value === null || value === undefined ? '' : Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function makeId(prefix) {
  return WangshenTemplates.makeId(prefix);
}

// 隐私遮挡：sensitive 且开启隐私模式 → ••••
function maskValue(value, sensitive, privacyMask, revealed) {
  if (!sensitive || !privacyMask || revealed) return value == null ? '' : String(value);
  return '••••';
}

// 先确认扩展运行环境；普通网页预览无法访问扩展存储和后台。
function sendMessage(type, payload) {
  return new Promise((resolve) => {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtime || !runtime.id || typeof runtime.sendMessage !== 'function') {
      resolve({ ok: false, error: '当前页面不在有效的浏览器扩展环境中。请先在浏览器扩展管理页加载本项目，再从插件的「设置」或「扩展选项」进入；直接打开 HTML 或通过本地服务器预览无法使用。扩展刚重载时，请关闭此页后重新打开。' });
      return;
    }
    try {
      runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
        if (runtime.lastError) {
          resolve({ ok: false, error: runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false, error: '扩展后台无响应，请在扩展管理页重新加载插件后再打开设置。' });
      });
    } catch (error) {
      // 扩展重载会使旧页面的消息接口失效，提示重新打开，不掩盖其他错误。
      resolve({ ok: false, error: /context invalidated/i.test(error.message || '')
        ? '扩展已重载，当前页面已失效。请关闭此页，再从插件的「设置」重新打开。'
        : error.message || String(error) });
    }
  });
}

function sendToTab(tabId, type, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type, ...(payload || {}) }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: '无响应' });
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTs(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 按模板分组顺序输出 {group: fields[]}；自定义字段组排在最后
function groupProfileFields(profile) {
  const ordered = [];
  const map = new Map();
  for (const f of profile.fields) {
    if (!map.has(f.group)) {
      map.set(f.group, []);
      ordered.push(f.group);
    }
    map.get(f.group).push(f);
  }
  return { groups: ordered, map };
}

const PLATFORM_NAMES = { moka: 'Moka', iguopin: '国聘', generic: '通用' };

function toastMsg(text, kind) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show ' + (kind || 'info');
  clearTimeout(toastMsg._t);
  toastMsg._t = setTimeout(() => {
    el.className = 'toast';
  }, 2600);
}
