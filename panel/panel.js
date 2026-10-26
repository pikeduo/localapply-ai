// 卡片仅渲染后台授权的资料；导航、复制和布局不绕过阶段三业务边界。
(function (global) {
  'use strict';
  const $ = (id) => document.getElementById(id); const V = global.LocalApplyProfileView;
  let database; let shown = false; let collapsed = false; let sectionKey = ''; let refreshing = 0; const expanded = new Map();
  // 外部标签和值只进入文本节点，不能形成 HTML 或可执行属性。
  function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  // 仅记录脱敏错误分类，界面保留可读恢复提示。
  async function report(error) { $('panelStatus').textContent = error.message || '界面操作失败'; await sendMessage('diagnostics:uiError', { error: error.message, stack: error.stack }); }
  // 固定打开内部管理页，并将档案/分类定位交给后台校验。
  async function edit(destination = 'resumeCenter') { const result = await sendMessage('panel:edit', { profileId: database?.activeProfileId, section: sectionKey, destination }); if (!result.ok) throw new Error(result.error); }
  // 刷新只读本地状态，不扫描网页、不联网；序号阻止迟到读取覆盖用户刚选择的档案。
  async function refresh() {
    const revision = ++refreshing; await flushSaves();
    const context = await sendMessage('panel:context'); if (!context.ok) throw new Error(context.error);
    global.LocalApplyPanelContext = { id: context.tabId };
    const result = await sendMessage('localapply:read'); if (!result.ok) throw new Error(result.error); if (revision !== refreshing) return;
    database = result.database;
    $('profileSel').replaceChildren(...database.profiles.map((profile) => new Option(profile.name, profile.profileId))); $('profileSel').value = database.activeProfileId;
    const count = database.fieldValues.filter((item) => item.profileId === database.activeProfileId && V.hasValue(item.value)).length;
    $('panelWelcome').hidden = count > 0;
    $('panelStatus').textContent = count ? (context.presence?.kind === 'application' ? '已检测到网申表单 · 本地规则优先，AI 可选' : '当前页暂未检测到网申表单，可主动扫描。') : '当前档案暂无可填资料，请先录入或导入。';
    $('smartFillAll').dataset.emptyProfile = count ? '' : 'true';
    if (shown) renderResume();
  }
  // 用户点击后才复制指定字段；隐藏的敏感值不能绕过显示许可复制。
  async function copy(value, sensitive) {
    if (sensitive && !$('previewReveal').checked) { $('previewStatus').textContent = '请先勾选显示敏感资料，再复制此项。'; return; }
    const content = V.text(value);
    try { await navigator.clipboard.writeText(content); }
    catch { const input = node('textarea'); input.value = content; input.style.position = 'fixed'; document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error('浏览器未允许复制，请手动选择文字。'); }
    $('previewStatus').textContent = '已复制所选字段。';
  }
  // 预览使用稳定经历分区；筛选只检索标签、分类及项目名，不搜索隐藏的个人值。
  function renderResume() {
    const root = $('resumeContent'); root.replaceChildren(); const profileId = database.activeProfileId;
    const profile = database.profiles.find((item) => item.profileId === profileId); root.append(node('h1', profile.name, 'resume-title'));
    const all = V.sections(database, profileId, $('previewEmpty').checked); const search = $('previewSearch').value.trim().toLowerCase();
    $('previewNav').replaceChildren(new Option('导航到分类 / 经历', ''), ...all.map((section) => new Option(section.group + (section.entryId ? ' · ' + section.title : ''), section.key)));
    let visible = 0;
    for (const section of all) {
      const broadMatch = (section.group + section.title).toLowerCase().includes(search);
      const items = section.items.filter(({ definition }) => !search || broadMatch || (definition.label + definition.aliases.join(' ')).toLowerCase().includes(search));
      if (search && !items.length && !broadMatch) continue;
      const box = node(section.entryId ? 'details' : 'section', '', 'resume-section'); box.dataset.sectionKey = section.key; box.tabIndex = -1;
      if (section.entryId) { box.open = search ? true : expanded.get(section.key) !== false; const summary = node('summary'); summary.append(node('h2', section.group + ' · ' + section.title)); box.append(summary); box.addEventListener('toggle', () => expanded.set(section.key, box.open)); }
      else box.append(node('h2', section.group));
      const list = node('dl');
      for (const { row, definition, sensitive } of items) {
        const pair = node('div', '', 'resume-item'); const value = node('button', sensitive && !$('previewReveal').checked ? '••••' : V.hasValue(row.value) ? V.text(row.value) : '尚未填写', 'copy-value');
        value.type = 'button'; value.setAttribute('aria-label', '复制' + definition.label); value.disabled = !V.hasValue(row.value); value.addEventListener('click', () => copy(row.value, sensitive).catch(report));
        const dd = node('dd'); dd.append(value); pair.append(node('dt', definition.label), dd); list.append(pair);
      }
      box.append(list); if (!items.length) box.append(node('p', '这段经历尚无字段值，可点击编辑资料补充。', 'muted')); root.append(box); visible++;
    }
    if (!visible) root.append(node('p', search ? '没有匹配的字段或项目，试试其他关键词。' : '当前档案还没有资料，请点击“编辑资料”录入或导入。', 'resume-empty'));
  }
  // 分类跳转展开对应经历并高亮；键盘焦点随导航进入目标区。
  function navigate() { sectionKey = $('previewNav').value; const section = [...$('resumeContent').querySelectorAll('.resume-section')].find((item) => item.dataset.sectionKey === sectionKey); if (!section) return; if (section.tagName === 'DETAILS') section.open = true; document.querySelectorAll('.resume-section.is-target').forEach((item) => item.classList.remove('is-target')); section.classList.add('is-target'); section.scrollIntoView({ block: 'start', behavior: 'instant' }); section.focus({ preventScroll: true }); }
  // 标签切换保留扫描/选择/错误状态，只有预览打开时读取最新个人资料。
  async function tab(preview) { shown = preview; $('autoView').hidden = preview; $('tab-smart').hidden = preview; $('resumeView').hidden = !preview; for (const [id, active] of [['autoTab', !preview], ['resumeTab', preview]]) { $(id).classList.toggle('active', active); $(id).setAttribute('aria-selected', String(active)); $(id).tabIndex = active ? 0 : -1; } if (preview) await refresh(); }
  // 折叠保留整个 iframe 会话及未确认草稿，恢复后不重新发模型请求。
  async function minimize() { const next = !collapsed; const result = await sendMessage('panel:layout', { collapsed: next }); if (!result.ok) throw new Error(result.error); collapsed = next; document.body.classList.toggle('collapsed', collapsed); $('panelMinimize').textContent = collapsed ? '+' : '−'; $('panelMinimize').setAttribute('aria-label', collapsed ? '展开卡片' : '折叠卡片'); $('panelMinimize').setAttribute('aria-expanded', String(!collapsed)); }
  // 标题拖动使用真实指针和屏幕坐标，布局命令经后台校验；串行合并移动避免消息堆积。
  function initDrag() {
    let pointer; let last; let pending = { dx: 0, dy: 0 }; let sending = false;
    // 后台忙碌期间累计位移，仅发送数字，不传递网页结构或私人值。
    async function drain() { if (sending) return; sending = true; try { while (pending.dx || pending.dy) { const move = { dx: Math.max(-2000, Math.min(2000, pending.dx)), dy: Math.max(-2000, Math.min(2000, pending.dy)) }; pending.dx -= move.dx; pending.dy -= move.dy; const result = await sendMessage('panel:layout', move); if (!result.ok) { pending = { dx: 0, dy: 0 }; throw new Error(result.error); } } } catch (error) { await report(error); } finally { sending = false; } }
    $('panelDrag').addEventListener('pointerdown', (event) => { if (!event.isTrusted || event.button !== 0 || event.target.closest('button')) return; pointer = event.pointerId; last = { x: event.screenX, y: event.screenY }; $('panelDrag').setPointerCapture(pointer); });
    $('panelDrag').addEventListener('pointermove', (event) => { if (pointer !== event.pointerId || !last) return; pending.dx += event.screenX - last.x; pending.dy += event.screenY - last.y; last = { x: event.screenX, y: event.screenY }; drain(); });
    $('panelDrag').addEventListener('pointerup', () => { pointer = last = null; }); $('panelDrag').addEventListener('lostpointercapture', () => { pointer = last = null; });
  }
  $('autoTab').addEventListener('click', () => tab(false).catch(report)); $('resumeTab').addEventListener('click', () => tab(true).catch(report));
  document.querySelector('.panel-tabs').addEventListener('keydown', (event) => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const preview = event.key === 'End' || (event.key !== 'Home' && !shown); tab(preview).catch(report); $(preview ? 'resumeTab' : 'autoTab').focus(); } });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') sendMessage('panel:close'); });
  $('previewReveal').addEventListener('change', renderResume); $('previewEmpty').addEventListener('change', renderResume); $('previewSearch').addEventListener('input', renderResume); $('previewNav').addEventListener('change', navigate);
  $('previewRefresh').addEventListener('click', () => refresh().then(() => { $('previewStatus').textContent = '已从本地刷新当前档案。'; }).catch(report));
  // 切档案期间禁用选择并等待落盘，避免大目录下连续选择使用旧快照而回到前一个档案。
  $('profileSel').addEventListener('change', async () => { const profileId = $('profileSel').value; $('profileSel').disabled = true; ++refreshing; try { await flushSaves(); const state = await getState(); state.activeProfileId = profileId; await saveState(state); $('previewReveal').checked = false; $('previewSearch').value = ''; sectionKey = ''; await refresh(); } catch (error) { await report(error); } finally { $('profileSel').disabled = false; } });
  $('panelClose').addEventListener('click', () => sendMessage('panel:close')); $('panelMinimize').addEventListener('click', () => minimize().catch(report));
  $('panelSettings').addEventListener('click', () => edit('aiSettings').catch(report)); $('previewEdit').addEventListener('click', () => edit().catch(report));
  $('welcomeManual').addEventListener('click', () => edit().catch(report)); $('welcomeImport').addEventListener('click', () => edit('pdfCard').catch(report)); $('welcomeBackup').addEventListener('click', () => edit('privacySettings').catch(report));
  $('welcomeSkipAI').addEventListener('click', () => { $('panelStatus').textContent = '已选择本地使用：无需配置 API，手动建立资料后即可填写。'; edit().catch(report); });
  // 资料变化只通过后台重新读取；忽略事件中的私人内容，预览新增/删除即时同步。
  let reloadTimer;
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['localapply.database']) { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => refresh().catch(report), 150); } });
  window.addEventListener('error', (event) => report(event.error || new Error('界面脚本错误'))); window.addEventListener('unhandledrejection', (event) => report(event.reason instanceof Error ? event.reason : new Error('异步界面错误')));
  initDrag(); refresh().catch(report);
})(globalThis);
