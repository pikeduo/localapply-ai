// Service Worker：AI 请求代理（OpenAI 兼容，多服务商预设）、CSV 导出、初始数据、侧边栏开关。
'use strict';

importScripts('data/templates.js', 'data/providers.js', 'data/key-vault.js', 'data/resume.js', 'data/local-store.js', 'data/ai-client.js'); // 凭据仅在后台按需解密。

const ROOT_KEY = 'wangshenAutofill';
const repository = LocalApplyStore.createRepository(chrome.storage.local);

// ============ 初始数据（工厂在 data/templates.js） ============

function defaultState() {
  return WangshenTemplates.defaultState();
}

// 兼容旧 AI 调用结构；底层资料与 API 设置始终分别存储。
async function getState() {
  return repository.readLegacy();
}

// 只有本扩展管理页和侧栏可以访问个人数据/模型；网页内容脚本不能提升权限。
function trustedPage(sender) {
  return sender.id === chrome.runtime.id && ['options/options.html', 'sidepanel/sidepanel.html']
    .some((page) => sender.url && sender.url.split(/[?#]/)[0] === chrome.runtime.getURL(page));
}

// 广播的设置投影只有阈值/界面开关，不把存储事件中的敏感对象发到网页。
async function notifySettings() {
  const settings = await repository.readContentSettings();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'wsa:settingsChanged', settings }).catch(() => {})));
}

// 扩展和文件管理页共享 AI 管线，后台只注入本扩展的配置读取器。
const aiClient = LocalApplyAI.createClient(() => repository.readAiSettings());
// 解析视觉模型，保留原后台接口供消息路由和回归测试使用。
function resolveVisionModel() { return aiClient.resolveVisionModel(); }
// 生成兼容的 AI 错误。
function aiError(message, detail) { return aiClient.aiError(message, detail); }
// 调用当前服务商模型。
function callGLM(request) { return aiClient.callGLM(request); }
// 获取当前服务商的模型列表。
function listAvailableModels(providerId) { return aiClient.listAvailableModels(providerId); }
// 从模型响应中提取 JSON。
function extractJson(text) { return aiClient.extractJson(text); }
// 合并多页视觉识别结果。
function visionExtract(pages, model) { return aiClient.visionExtract(pages, model); }
// 保留原合并函数接口。
function mergeResumePart(target, part) { return aiClient.mergeResumePart(target, part); }

// ============ CSV 导出（UTF-8 BOM，Excel 打开不乱码） ============

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function buildCsv(rows) {
  const header = ['时间', '公司', '系统', '链接', '自动填', '点选填'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows || []) {
    lines.push(
      [
        formatTs(r.ts),
        r.company || '',
        r.system || '',
        r.url || '',
        r.autoCount != null ? r.autoCount : 0,
        r.manualCount != null ? r.manualCount : 0,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return '\uFEFF' + lines.join('\r\n');
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatTs(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ============ 消息路由 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!['wsa:ping', 'wsa:openPanel', 'wsa:contentSettings'].includes(msg && msg.type) && !trustedPage(sender)) {
        throw new Error('此消息仅允许扩展管理页调用');
      }
      switch (msg && msg.type) {
        case 'wsa:ping':
          sendResponse({ ok: true, pong: true });
          return;
        case 'wsa:openPanel': {
          const tabId = sender.tab && sender.tab.id;
          try {
            if (tabId != null) {
              await chrome.sidePanel.open({ tabId });
            } else {
              const win = await chrome.windows.getLastFocused();
              await chrome.sidePanel.open({ windowId: win.id });
            }
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: '无法自动打开侧边栏，请点击浏览器工具栏上的插件图标。' });
          }
          return;
        }
        case 'wsa:getState': {
          sendResponse({ ok: true, state: await getState() });
          return;
        }
        case 'wsa:contentSettings': {
          sendResponse({ ok: true, settings: await repository.readContentSettings() });
          return;
        }
        case 'localapply:saveLegacy': {
          const state = await repository.saveLegacy(msg.base, msg.state, msg.source);
          sendResponse({ ok: true, state });
          notifySettings().catch(() => {});
          return;
        }
        case 'localapply:read':
          sendResponse({ ok: true, database: await repository.read() }); return;
        case 'localapply:vault':
          sendResponse({ ok: true, settings: await repository.vaultCommand(msg.action, msg.payload) }); return;
        case 'localapply:command':
          sendResponse({ ok: true, ...await repository.command(msg.request || {}) }); return;
        case 'localapply:exportBackup':
          sendResponse({ ok: true, backup: await repository.exportBackup() }); return;
        case 'localapply:previewImport':
          sendResponse({ ok: true, preview: await repository.previewImport(msg.backup, msg.mode) }); return;
        case 'localapply:exportPublicFields':
          sendResponse({ ok: true, fields: await repository.exportPublicFields() }); return;
        case 'wsa:aiChat': {
          const out = await callGLM(msg.payload || {});
          sendResponse({ ok: true, ...out });
          return;
        }
        case 'wsa:listModels': {
          sendResponse({ ok: true, ...await listAvailableModels(msg.providerId) });
          return;
        }
        case 'wsa:cancelResume':
          aiClient.cancel(msg.requestId); sendResponse({ ok: true }); return;
        case 'wsa:aiExtractResume':
          sendResponse({ ok: true, data: await aiClient.extractResume(msg.payload || {}) }); return;
        case 'wsa:exportCsv': {
          const csv = buildCsv(msg.rows || []);
          const d = new Date();
          const name = `网申台账-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.csv`;
          const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
          chrome.downloads.download({ url, filename: name, saveAs: false }, (dlId) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ ok: true, id: dlId, filename: name });
            }
          });
          return true; // 异步 sendResponse
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e), detail: e.detail });
    }
  })();
  return true; // 所有分支都异步回复
});

// ============ 生命周期 ============

chrome.runtime.onInstalled.addListener(async () => {
  await getState(); // 首次安装写入默认数据
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    // 老版本不支持时退化：由 floatbar 的消息触发 open
  }
});

chrome.runtime.onStartup.addListener(() => {});
