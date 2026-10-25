// 悬浮卡片协调档案与简历预览；按钮直接填入本地匹配，仍复用阶段三的回读验证。
(function (global) {
  'use strict';
  const $ = (id) => document.getElementById(id); let database; let shown = false;
  // 所有不可信字段名称和值只作为文本节点渲染。
  function node(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  // 界面错误先展示可读提示，再交由后台分类记录，避免吞掉维护线索。
  async function report(error) { $('panelStatus').textContent = error.message || '界面操作失败'; await sendMessage('diagnostics:uiError', { error: error.message, stack: error.stack }); }
  // 读取当前文档授权和档案列表；失败时清空预览，不沿用过期数据。
  async function refresh() {
    const context = await sendMessage('panel:context'); if (!context.ok) throw new Error(context.error);
    global.LocalApplyPanelContext = { id: context.tabId };
    $('panelStatus').textContent = context.presence?.kind === 'application' ? '已检测到网申表单，点击即可自动填写。' : '当前页面暂未识别为网申表单，可点击自动填写或仅扫描字段。';
    const result = await sendMessage('localapply:read'); if (!result.ok) throw new Error(result.error); database = result.database;
    $('profileSel').replaceChildren(...database.profiles.map((profile) => new Option(profile.name, profile.profileId))); $('profileSel').value = database.activeProfileId;
    if (shown) renderResume();
  }
  // 按分组与独立经历展示当前档案的确认值，不读取或缓存原始简历文件。
  function renderResume() {
    const root = $('resumeContent'); root.replaceChildren(); const profileId = database.activeProfileId;
    const profile = database.profiles.find((item) => item.profileId === profileId); root.append(node('h1', profile.name, 'resume-title'));
    const rows = database.fieldValues.filter((item) => item.profileId === profileId && item.value !== null && item.value !== '');
    const definitions = new Map(database.fieldDefinitions.map((item) => [item.fieldId,item]));
    const sections = new Map();
    for (const row of rows) {
      const definition = definitions.get(row.fieldId); const entry = database.entries.find((item) => item.entryId === row.entryId);
      const group = entry ? ({education:'教育经历',internship:'实习经历',employment:'工作经历',project:'项目经历'}[entry.kind] + ' · ' + (entry.title || '第' + (entry.order + 1) + '条')) : definition.group;
      if (!sections.has(group)) sections.set(group, []); sections.get(group).push({ row, definition });
    }
    for (const [group, items] of sections) {
      const section = node('section', '', 'resume-section'); section.append(node('h2', group)); const list = node('dl', '');
      for (const { row, definition } of items) {
        const binding = database.bindings.find((item) => item.profileId === profileId && item.fieldId === row.fieldId);
        const sensitive = binding?.sensitive || /电话|手机|邮箱|地址|身份证|生日|薪资|家庭/.test(definition.label);
        const value = sensitive && !$('previewReveal').checked ? '••••' : Array.isArray(row.value) ? row.value.join('、') : String(row.value);
        const pair = node('div', '', 'resume-item'); pair.append(node('dt', definition.label), node('dd', value)); list.append(pair);
      }
      section.append(list); root.append(section);
    }
    if (!rows.length) root.append(node('p','当前档案还没有资料，请点击“编辑资料”录入或导入。','resume-empty'));
  }
  // 切换只改变卡片内容，简历预览是用户显式打开后才渲染。
  async function tab(preview) { shown = preview; $('autoView').hidden = preview; $('resumeView').hidden = !preview; $('autoTab').classList.toggle('active', !preview); $('resumeTab').classList.toggle('active', preview); if (preview) await refresh(); }
  $('autoTab').addEventListener('click', () => tab(false).catch(report)); $('resumeTab').addEventListener('click', () => tab(true).catch(report));
  $('previewReveal').addEventListener('change', renderResume); $('previewRefresh').addEventListener('click', () => refresh().catch(report));
  $('profileSel').addEventListener('change', async () => { try { const state = await getState(); state.activeProfileId = $('profileSel').value; await saveState(state); await refresh(); } catch (error) { await report(error); } });
  $('panelClose').addEventListener('click', () => sendMessage('panel:close'));
  for (const id of ['panelSettings','previewEdit']) $(id).addEventListener('click', () => chrome.runtime.openOptionsPage());
  window.addEventListener('error', (event) => report(event.error || new Error('界面脚本错误')));
  window.addEventListener('unhandledrejection', (event) => report(event.reason instanceof Error ? event.reason : new Error('异步界面错误')));
  refresh().catch(report);
})(globalThis);
