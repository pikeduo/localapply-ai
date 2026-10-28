// Service Worker：复用资料/AI 服务，编排右上角悬浮卡片及本地脱敏诊断。
'use strict';

importScripts('data/templates.js', 'data/providers.js', 'data/key-vault.js', 'data/resume.js', 'data/resume-catalog.js', 'data/field-matching.js', 'data/fill-contract.js', 'data/field-suggestions.js', 'data/applications.js', 'data/local-store.js', 'data/model-capabilities.js', 'data/responses.js', 'data/ai-client.js', 'data/field-learning.js', 'data/diagnostics.js', 'data/floating-panel.js', 'data/job-tracking.js'); // 填写契约、岗位与字段学习复用唯一仓库，不读回密钥。

const ROOT_KEY = 'wangshenAutofill';
const repository = LocalApplyStore.createRepository(chrome.storage.local, { cache: true, changes: chrome.storage.onChanged });
const diagnostics = LocalApplyDiagnostics.create(chrome.storage.local);
const jobTracking = LocalApplyJobTracking.create(repository, chrome);
const floatingPanel = LocalApplyFloatingPanel.create(chrome, diagnostics, (tabId) => fieldLearning.invalidate(tabId)); // 关闭卡片也中止本页 AI 和未确认候选。
const presenceTimes = new Map();

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
const aiClient = LocalApplyAI.createClient(() => repository.readAiSettings(), async (profileId) => LocalApplyResumeCatalog.catalog(await repository.read(), profileId)); // 只向解析器提供目标档案的字段元数据。
const fieldLearning = FieldLearning.create(repository, aiClient, chrome);
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

// 对关键业务只记录结果摘要；轮询读取不刷日志，失败记录不包含原始响应或个人值。
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const started = Date.now();
  const operation = String(msg?.type || '').replace(':', '.');
  const quiet = ['wsa:ping','wsa:getState','wsa:contentSettings','localapply:read','learning:session','learning:changed','learning:rules','panel:context','panel:layout','diagnostics:read','diagnostics:clear','diagnostics:presence','diagnostics:uiError'].includes(msg?.type);
  // 关键结果先等待脱敏日志落盘再响应；日志故障仅提示，不改变已经完成的填表结果。
  async function sendResponse(response, logError) {
    const count = response?.rows?.length ?? response?.data?.items?.length;
    // 岗位缺失和控件拒绝虽可正常返回，仍需警告日志，便于区分业务失败与通信成功。
    const outcome = msg?.type === 'learning:fill' ? response?.rows?.find((row) => row.field.scanId === msg.scanId) : null;
    const incomplete = response?.ok && (msg?.type === 'jobs:scan' && !response.recognized || outcome && outcome.status !== 'success');
    if (!quiet) try { await diagnostics.append(operation, { level: response?.ok ? incomplete ? 'WARNING' : 'INFO' : 'ERROR', durationMs: Date.now() - started, count,
      ...(response?.rows ? { success: response.rows.filter((row) => row.status === 'success').length, failed: response.rows.filter((row) => row.status === 'failed').length,
        unsupported: response.rows.filter((row) => row.status === 'unsupported').length, needsConfirmation: response.rows.filter((row) => row.status === 'needs_confirmation').length } : {}),
      ...(outcome?.diagnostic ? { fill: outcome.diagnostic } : {}),
      ...(incomplete ? { error: new Error(msg.type === 'jobs:scan' ? '缺少岗位元数据' : outcome.status === 'unsupported' ? '控件格式暂不支持' : outcome.status === 'needs_confirmation' ? '网页内容需要确认' : '网页填写校验失败') } : {}),
      ...(!response?.ok ? { error: logError || response?.error } : {}) }); }
    catch { response = { ...response, diagnosticsSaved: false }; }
    // 调用页可能已关闭；响应通道失效不能产生新的未处理异常。
    try { respond(response); } catch {}
  }
  (async () => {
    try {
      // 内容脚本只能报告用户提交及状态枚举，实际申请数据仍需可信界面明确确认。
      if (['jobs:submitted', 'jobs:feedback'].includes(msg?.type)) { sendResponse({ ok: true, ...await jobTracking.observe(sender, msg) }); return; }
      // 自动检测只接受当前顶层内容脚本的有限枚举与数量，不授予私有数据库权限。
      if (msg?.type === 'diagnostics:presence' && sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0) {
        const now = Date.now();
        if (['application','login','other'].includes(msg.kind) && Number.isInteger(msg.count) && msg.count >= 0 && msg.count <= 300 && now - (presenceTimes.get(sender.tab.id) || 0) > 1000) {
          presenceTimes.set(sender.tab.id, now); await diagnostics.append('page.presence', { kind: msg.kind, count: msg.count });
          await chrome.action?.setBadgeText({ tabId: sender.tab.id, text: msg.kind === 'application' ? '表单' : '' });
          await chrome.action?.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2563eb' });
        }
        sendResponse({ ok: true }); return;
      }
      // 页面错误只登记固定事件，拒绝内容脚本提交任意异常正文或资料。
      if (msg?.type === 'diagnostics:pageError' && sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0) {
        await diagnostics.append('page.error', { level: 'ERROR', error: new Error('页面检测失败') }); sendResponse({ ok: true }); return;
      }
      // 网页只能报告本页结构变化，不能借学习消息调用模型或读取个人资料。
      if (msg?.type === 'learning:changed' && sender.id === chrome.runtime.id && sender.tab) {
        fieldLearning.changed(sender, msg); sendResponse({ ok: true }); return;
      }
      const panelSession = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('panel/panel.html') ? await floatingPanel.authorize(sender, msg) : null;
      if (!['wsa:ping', 'wsa:openPanel', 'wsa:contentSettings'].includes(msg && msg.type) && !trustedPage(sender) && !panelSession) {
        throw new Error('此消息仅允许扩展管理页调用');
      }
      // 悬浮请求绑定自身标签，不能借显式 tabId 授权另一个页面。
      if (panelSession && msg.type === 'learning:scanPage' && msg.tabId !== panelSession.tabId) throw new Error('不能扫描其他标签页');
      if (msg?.type === 'panel:context') {
        if (!panelSession) throw new Error('悬浮会话无效');
        const probe = await chrome.tabs.sendMessage(panelSession.tabId, { type: 'wsa:floatingProbe' }, { frameId: 0 });
        sendResponse({ ok: true, tabId: panelSession.tabId, presence: probe.presence }); return;
      }
      if (msg?.type === 'panel:close') { if (!panelSession) throw new Error('悬浮会话无效'); await sendResponse({ ok: true }); await floatingPanel.close(panelSession.tabId); return; }
      // 布局命令仅由已授权的扩展卡片发送，不能让网页伪造拖动或取得资料。
      if (msg?.type === 'panel:layout') {
        if (!panelSession || typeof msg.collapsed !== 'boolean' && !(Number.isFinite(msg.dx) && Number.isFinite(msg.dy) && Math.abs(msg.dx) <= 2000 && Math.abs(msg.dy) <= 2000)) throw new Error('悬浮布局参数无效');
        await chrome.tabs.sendMessage(panelSession.tabId, { type: 'wsa:floatingLayout', collapsed: msg.collapsed, dx: msg.dx, dy: msg.dy }, { frameId: 0 });
        sendResponse({ ok: true }); return;
      }
      // 编辑入口只构造固定的内部页面，档案和分组通过参数定位，禁止任意导航 URL。
      if (msg?.type === 'panel:edit') {
        if (!panelSession) throw new Error('悬浮会话无效');
        const db = await repository.read(); const profileId = db.profiles.some((item) => item.profileId === msg.profileId) ? msg.profileId : db.activeProfileId;
        const params = new URLSearchParams({ profile: profileId, section: typeof msg.section === 'string' ? msg.section.slice(0, 500) : '' });
        const destination = ['pdfCard', 'privacySettings', 'fieldLibrary', 'aiSettings', 'applications'].includes(msg.destination) ? msg.destination : 'resumeCenter';
        await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + '?' + params + '#' + destination });
        sendResponse({ ok: true }); return;
      }
      if (msg?.type === 'diagnostics:read') { sendResponse({ ok: true, ...await diagnostics.read(), databaseStorage: await repository.storageStatus() }); return; }
      // 岗位扫描始终绑定卡片所在标签，不接受调用方指定的其他页面。
      if (msg?.type === 'jobs:scan') { if (!panelSession) throw new Error('请从当前网页的悬浮卡片识别岗位'); sendResponse({ ok: true, ...await jobTracking.scan(panelSession.tabId) }); return; }
      // 保存成功后的确认提示只清理当前卡片所属标签，不改变已写入的申请。
      if (msg?.type === 'jobs:acknowledge') { if (!panelSession) throw new Error('悬浮会话无效'); await jobTracking.close(panelSession.tabId); await chrome.tabs.sendMessage(panelSession.tabId, { type: 'jobs:notice' }, { frameId: 0 }); sendResponse({ ok: true }); return; }
      if (msg?.type === 'diagnostics:clear') { if (msg.confirmed !== true) throw new Error('清理日志需要确认'); await diagnostics.clear(); sendResponse({ ok: true }); return; }
      if (msg?.type === 'diagnostics:uiError') { await diagnostics.append('ui.error', { level: 'ERROR', error: { message: msg.error, stack: msg.stack } }); sendResponse({ ok: true }); return; }
      if (msg?.type?.startsWith('learning:')) { sendResponse({ ok: true, ...await fieldLearning.handle(msg) }); return; }
      switch (msg && msg.type) {
        case 'wsa:ping':
          sendResponse({ ok: true, pong: true });
          return;
        case 'wsa:openPanel': {
          const tabId = sender.tab && sender.tab.id;
          try {
            if (sender.id !== chrome.runtime.id || tabId == null || sender.frameId !== 0) throw new Error('请点击浏览器工具栏打开插件');
            await floatingPanel.open(tabId);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || '无法打开悬浮卡片，请刷新网页后重试。' });
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
          sendResponse({ ok: true, backup: await repository.exportBackup(msg.version) }); return;
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
        case 'wsa:probeCapabilities':
          sendResponse({ ok: true, ...await aiClient.probeCapabilities(msg.payload || {}) }); return;
        case 'wsa:resumeRoute':
          sendResponse({ ok: true, route: await aiClient.resumeRoute(msg.format) }); return;
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
      sendResponse({ ok: false, error: e.message || String(e), detail: e.detail }, e);
    }
  })();
  return true; // 所有分支都异步回复
});

// ============ 生命周期 ============

chrome.runtime.onInstalled.addListener(async () => {
  await getState(); // 首次安装写入默认数据
  try {
    await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    // 老版本不支持时退化：由 floatbar 的消息触发 open
  }
});

// 工具栏直接控制网页卡片，不再打开浏览器侧栏；受限页面仅显示可读提示。
chrome.action?.onClicked?.addListener(async (tab) => {
  try { await floatingPanel.open(tab.id); }
  catch (error) { await diagnostics.append('panel.open', { level: 'ERROR', error }); await chrome.action.setTitle({ tabId: tab.id, title: error.message }); }
});
// 标签页导航及关闭立即丢弃卡片授权和限流状态。
// 导航与关闭也清理字段学习的待确认值及进行中的模型任务。
chrome.tabs?.onUpdated?.addListener((tabId, info) => { if (info.url || info.status === 'loading') { fieldLearning.invalidate(tabId); floatingPanel.invalidate(tabId).catch(() => {}); } });
// 只释放已关闭标签的会话，不删除已确认的资料或映射。
chrome.tabs?.onRemoved?.addListener((tabId) => { presenceTimes.delete(tabId); fieldLearning.invalidate(tabId); floatingPanel.invalidate(tabId).catch(() => {}); jobTracking.close(tabId).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => {});
