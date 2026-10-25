// 阶段三侧栏：扫描/模型/资料/填写/记忆各有独立确认，不把网页或模型文本作为 HTML。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const labels = { matched: '已匹配', needs_confirmation: '需要确认', missing_value: '缺少资料', filling: '正在填写', success: '填写成功', failed: '填写失败', unsupported: '控件暂不支持' };
  let current = null; let aiPreview = null; let fillIds = []; let busy = false; let rulesView = null; let selectionInitialized = false;
  let generation = 0; let polling = false;
  const drafts = new Map(); const selected = new Set();
  // DOM 元素只通过 textContent 显示不可信标签和模型内容。
  function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  // 个人值只在用户核对/编辑时展开，默认预览保持遮挡。
  function display(value) { return value === null || value === undefined ? '（空）' : typeof value === 'string' ? value : JSON.stringify(value); }
  // 统一错误恢复，不输出 Key、响应原文或网页内容到日志。
  async function task(operation) {
    if (busy) return;
    const started = generation;
    busy = true;
    $('tab-smart').setAttribute('aria-busy', 'true');
    $('tab-smart').querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try { await operation(); }
    catch (error) { if (started === generation) { $('smartStatus').textContent = error.message; $('smartStatus').className = 'err'; } }
    finally { busy = false; $('tab-smart').setAttribute('aria-busy', 'false'); $('tab-smart').querySelectorAll('button').forEach((button) => { button.disabled = button.id === 'smartUndo' ? !rulesView?.canUndo : false; }); }
  }
  // 所有阶段三业务均经受信后台；内容脚本不持有完整档案或 API Key。
  async function request(type, payload = {}) {
    const started = generation;
    const result = await sendMessage('learning:' + type, { sessionId: current?.sessionId, ...payload });
    if (started !== generation) throw new Error('页面或档案已切换，请重新授权');
    if (!result.ok) throw new Error(result.error); return result;
  }
  // 获取新视图时只自动勾选本地确定匹配的字段，AI 原始建议不进入执行列表。
  function update(view) {
    current = view;
    $('tab-smart').dataset.sessionId = view.sessionId;
    if (!selectionInitialized) { view.rows.filter((row) => row.status === 'matched').forEach((row) => selected.add(row.field.scanId)); selectionInitialized = true; }
    render();
  }
  // 创建按钮并统一走错误屏障，不让失败的异步操作锁住侧栏。
  function button(text, action, className = 'btn ghost') { const result = node('button', text, className); result.type = 'button'; result.disabled = busy; result.addEventListener('click', () => task(action)); return result; }
  // 按档案来源生成选择器，显示教育/工作序号而非假设第一条就是最高学历。
  function sourceSelect(row, change) {
    const select = node('select'); select.className = 'smart-source'; select.append(new Option('手动选择本地字段 / 经历', ''));
    current.sources.forEach((source) => select.append(new Option(source.label + (source.hasValue ? '' : '（缺少值）'), source.ref)));
    select.value = current.sources.find((source) => source.fieldId === row.target?.fieldId && source.entryId === row.target?.entryId)?.ref || '';
    select.addEventListener('change', () => task(async () => { const source = current.sources.find((source) => source.ref === select.value); if (source) await change(source); })); return select;
  }
  // 实际值输入有明确类型转换，空白保持空值，不由 AI 或程序编造资料。
  function typedValue(text, type) {
    if (text === '') return null;
    if (type === 'number') { const value = Number(text); if (!Number.isFinite(value)) throw new Error('请输入有效数字'); return value; }
    if (['boolean', 'multiSelect'].includes(type)) { try { return JSON.parse(text); } catch { throw new Error('布尔值请输入 true/false，多选值请输入 JSON 数组'); } }
    return text;
  }
  // 字段编辑与差异预览；即使模型建议或网页已有值，也只在最终确认按钮后入库。
  function editor(row) {
    const details = node('details'); details.className = 'smart-editor'; details.append(node('summary', '新建字段 / 修改资料 / 保存网页已填内容'));
    const draft = drafts.get(row.field.scanId) || { newField: !row.target, label: row.field.label, type: row.field.type === 'checkbox' ? 'boolean' : 'text', group: row.field.group || '其他', aliases: '', options: row.field.options.map((option) => option.text).join('\n'), value: '', sourceRef: '', source: 'manual' };
    drafts.set(row.field.scanId, draft);
    const createLabel = node('label'); const create = node('input'); create.type = 'checkbox'; create.checked = draft.newField; create.className = 'smart-new'; createLabel.append(create, document.createTextNode(' 创建新的私有字段（不进入公共定义导出）')); details.append(createLabel);
    const name = node('input'); name.value = draft.label; name.className = 'smart-field-label'; name.placeholder = '字段名称'; name.setAttribute('aria-label', '字段名称');
    const type = node('select'); type.className = 'smart-field-type'; ['text','textarea','select','number','boolean','date','multiSelect'].forEach((value) => type.append(new Option(value, value))); type.value = draft.type;
    const group = node('input'); group.value = draft.group; group.className = 'smart-field-group'; group.setAttribute('aria-label', '字段分类');
    const aliases = node('input'); aliases.value = draft.aliases; aliases.placeholder = '别名，用顿号分隔'; aliases.setAttribute('aria-label', '字段别名');
    const options = node('textarea'); options.value = draft.options; options.placeholder = '可选项，每行一个'; options.setAttribute('aria-label', '可选项');
    const value = node('textarea'); value.value = draft.value; value.className = 'smart-field-value'; value.placeholder = '实际值；缺少资料可留空，布尔使用 true/false，多选使用 JSON 数组'; value.setAttribute('aria-label', '字段实际值');
    const source = node('select'); source.append(new Option('手动填写实际值', '')); current.sources.filter((source) => source.hasValue).forEach((item) => source.append(new Option('复制已确认来源：' + item.label, item.ref))); source.value = draft.sourceRef;
    const entry = node('select'); entry.className = 'smart-field-entry'; entry.setAttribute('aria-label', '新字段所属经历'); entry.append(new Option('平面资料（不属于重复经历）', ''));
    current.entries.forEach((item) => entry.append(new Option(({ education: '教育', internship: '实习', employment: '工作', project: '项目' }[item.kind]) + '第' + (item.order + 1) + '条', item.entryId)));
    entry.value = draft.entryId || current.sources.find((source) => source.ref === draft.sourceRef)?.entryId || row.target?.entryId || '';
    const review = node('div'); review.className = 'smart-value-review';
    // 输入变更立即取消本地确认令牌；后台同时校验版本及令牌，不能保存旧预览。
    const changed = () => { Object.assign(draft, { newField: create.checked, label: name.value, type: type.value, group: group.value, aliases: aliases.value, options: options.value, value: value.value, entryId: entry.value }); review.replaceChildren(); };
    [create, name, type, group, aliases, options, value, entry].forEach((input) => input.addEventListener('input', () => { draft.sourceRef = ''; source.value = ''; draft.source = 'manual'; changed(); }));
    source.addEventListener('change', () => { draft.sourceRef = source.value; const selected = current.sources.find((item) => item.ref === source.value); value.value = selected ? display(selected.value) : ''; if (draft.newField) entry.value = selected?.entryId || ''; changed(); });
    const read = button('读取此网页字段（不自动保存）', async () => { const result = await request('readField', { scanId: row.field.scanId }); value.value = result.value == null ? '' : display(result.value); draft.source = 'web-confirmed'; draft.sourceRef = ''; source.value = ''; changed(); }); read.classList.add('smart-read');
    const preview = button('预览资料差异', async () => {
      changed(); const selectedType = draft.newField ? draft.type : current.definitions.find((def) => def.fieldId === row.target?.fieldId)?.type;
      const definition = draft.newField ? { label: draft.label, type: draft.type, group: draft.group, aliases: draft.aliases.split('、').map((value) => value.trim()).filter(Boolean), options: draft.options.split('\n').map((value) => value.trim()).filter(Boolean) } : null;
      const result = await request('previewValue', { scanId: row.field.scanId, definition, fieldId: row.target?.fieldId, entryId: draft.newField ? draft.entryId || null : row.target?.entryId,
        value: typedValue(draft.value, selectedType), sourceRef: draft.sourceRef || null, source: draft.source });
      review.replaceChildren(node('pre', JSON.stringify(result.diff, null, 2)));
      const consentLabel = node('label'); const consent = node('input'); consent.type = 'checkbox'; consent.className = 'smart-value-consent'; consentLabel.append(consent, document.createTextNode(' 我已核对新旧值及来源，确认写入个人档案'));
      const save = button('确认保存字段与值', async () => { if (!consent.checked) throw new Error('请先核对差异并勾选确认'); const view = await request('commitValue', { scanId: row.field.scanId, token: result.token, confirmed: true }); drafts.delete(row.field.scanId); if (view.rows.find((item) => item.field.scanId === row.field.scanId)?.status === 'matched') selected.add(row.field.scanId); update(view); }); save.classList.add('smart-value-commit');
      review.append(consentLabel, save);
    }); preview.classList.add('smart-value-preview');
    details.append(name, type, group, aliases, options, source, entry, value, read, preview, review); return details;
  }
  // 只展开填写预览，此时不向网页写入任何值。
  function prepareFill(ids) {
    fillIds = ids.filter((id) => current.rows.some((row) => row.field.scanId === id && row.target && row.value !== null && row.value !== ''));
    if (!fillIds.length) throw new Error('没有可填写的已选字段，请先选择来源或补充资料');
    $('smartFillPayload').textContent = JSON.stringify(current.rows.filter((row) => fillIds.includes(row.field.scanId)).map((row) => ({ 网页字段: row.field.label, 分组: row.field.group, 来源: current.sources.find((source) => source.fieldId === row.target.fieldId && source.entryId === row.target.entryId)?.label, 实际值: row.value })), null, 2);
    $('smartFillConsent').checked = false; $('smartRememberAfter').checked = false; $('smartFillReview').hidden = false;
  }
  // 渲染每个状态及确认入口，任何模型建议都不会直接生成点击网页的行为。
  function render() {
    $('smartMatched').replaceChildren(); $('smartUnknown').replaceChildren();
    if (!current) return;
    $('smartStatus').textContent = `${current.origin} · 扫描 ${current.rows.length} 个字段；资料版本 ${current.revision} ${current.notice || ''}`; $('smartStatus').className = 'muted';
    for (const row of current.rows) {
      const card = node('article', '', 'card smart-row'); card.dataset.scanId = row.field.scanId; card.dataset.status = row.status;
      const title = node('h4', row.field.label + ' · ' + labels[row.status]); const check = node('input'); check.type = 'checkbox'; check.className = 'smart-check'; check.checked = selected.has(row.field.scanId); check.disabled = !row.target || ['unsupported','missing_value'].includes(row.status);
      check.addEventListener('change', () => check.checked ? selected.add(row.field.scanId) : selected.delete(row.field.scanId)); title.prepend(check); card.append(title, node('p', [row.field.group, row.field.type, row.reason].filter(Boolean).join(' · '), 'muted'));
      card.append(sourceSelect(row, async (source) => { selected.add(row.field.scanId); update(await request('select', { scanId: row.field.scanId, fieldId: source.fieldId, entryId: source.entryId })); }));
      if (row.target) {
        const preview = node('p', row.value == null ? '本地暂无资料' : '本地值：••••'); card.append(preview);
        card.append(button('核对本地值', async () => { preview.textContent = display(row.value); }), button('单项填写预览', async () => prepareFill([row.field.scanId])));
      }
      if (row.suggestion) {
        card.append(node('pre', JSON.stringify(row.suggestion, null, 2)));
        const apply = button('采用此建议并核对', async () => {
          const suggestion = row.suggestion;
          const source = current.sources.find((source) => source.ref === suggestion.sourceRef);
          if (suggestion.definition) { drafts.set(row.field.scanId, { newField: true, ...suggestion.definition, aliases: suggestion.definition.aliases.join('、'), options: suggestion.definition.options.join('\n'), value: source ? display(source.value) : '', sourceRef: source?.ref || '', source: source ? 'local-confirmed' : 'manual' }); render(); const entry = [...document.querySelectorAll('.smart-row')].find((item) => item.dataset.scanId === row.field.scanId); entry.querySelector('details').open = true; }
          else { const choices = current.sources.filter((source) => source.fieldId === suggestion.existingFieldId); const chosen = source || (choices.length === 1 ? choices[0] : null); if (!chosen) throw new Error('存在多段经历，请在来源列表中明确选择'); selected.add(row.field.scanId); update(await request('select', { scanId: row.field.scanId, fieldId: chosen.fieldId, entryId: chosen.entryId })); }
        }); apply.classList.add('smart-apply-suggestion'); card.append(apply);
      }
      if (row.status === 'success') card.append(button('确认记住此网站映射', async () => { if (confirm(`确认记住 ${current.origin} 的“${row.field.label}”映射？`)) update(await request('remember', { scanId: row.field.scanId, confirmed: true })); }));
      if (row.status !== 'unsupported') card.append(editor(row));
      (row.source === 'unknown' || (!row.target && row.suggestion) ? $('smartUnknown') : $('smartMatched')).append(card);
    }
  }
  // 规则管理只在明确保存时写入，目标变化将清除验证状态。
  async function showRules() {
    rulesView = await request('rules'); $('smartRulesPanel').hidden = false; $('smartRuleList').replaceChildren(); $('smartUndo').disabled = !rulesView.canUndo;
    if (!rulesView.rules.length) $('smartRuleList').append(node('p', '尚无历史映射'));
    for (const rule of rulesView.rules) {
      const card = node('article', '', 'smart-rule'); card.dataset.mappingId = rule.mappingId;
      card.append(node('p', rule.origin + ' · ' + rule.label + ' · ' + (rule.enabled === false ? '已禁用' : rule.confirmed ? '已验证' : '待重新确认')));
      const target = node('select'); target.className = 'smart-rule-target';
      for (const def of rulesView.definitions) {
        target.append(new Option(def.label + ' · 平面资料', JSON.stringify([def.fieldId, null])));
        for (const entry of rulesView.entries.filter((entry) => entry.profileId === rule.profileId)) target.append(new Option(def.label + ' · ' + entry.kind + '第' + (entry.order + 1) + '条', JSON.stringify([def.fieldId, entry.entryId])));
      }
      target.value = JSON.stringify([rule.fieldId, rule.entryId]);
      const enabledLabel = node('label'); const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false; enabled.className = 'smart-rule-enabled'; enabledLabel.append(enabled, document.createTextNode(' 启用'));
      card.append(target, enabledLabel, button('确认修改规则', async () => { if (!confirm('确认修改该规则？目标变化后需要重新验证，不能直接自动填写。')) return; const [fieldId, entryId] = JSON.parse(target.value); await request('editRule', { mappingId: rule.mappingId, fieldId, entryId, enabled: enabled.checked, revision: rulesView.revision, confirmed: true }); await showRules(); }),
        button('删除规则', async () => { if (!confirm('确认删除该规则？可撤销本会话最近一次操作。')) return; await request('deleteRule', { mappingId: rule.mappingId, revision: rulesView.revision, confirmed: true }); await showRules(); })); $('smartRuleList').append(card);
    }
  }

  // 绑定用户主动操作，打开侧栏本身不会扫描或调用模型。
  $('smartScan').addEventListener('click', () => task(async () => {
    if (!$('smartPageConsent').checked) throw new Error('请先勾选授权扫描当前招聘页');
    await flushSaves(); const state = await getState();
    // 悬浮卡片固定绑定打开时的顶层标签，不能跟随另一个活动标签操作资料。
    const tab = globalThis.LocalApplyPanelContext || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    current = null; selectionInitialized = false; selected.clear(); drafts.clear(); $('smartAIReview').hidden = $('smartFillReview').hidden = true; render(); $('smartStatus').textContent = '正在扫描已授权页面…';
    update(await request('scanPage', { tabId: tab?.id, profileId: state.activeProfileId, confirmed: true }));
  }));
  $('smartRefresh').addEventListener('click', () => task(async () => update(await request('session'))));
  $('smartRevoke').addEventListener('click', () => task(async () => { await request('revoke'); current = null; $('smartPageConsent').checked = false; render(); $('smartStatus').textContent = '已撤销本页授权'; }));
  $('smartAI').addEventListener('click', () => task(async () => { aiPreview = await request('prepareAI'); $('smartRecipient').textContent = `${aiPreview.recipient.name} · ${aiPreview.recipient.baseUrl} · ${aiPreview.recipient.model} · ${aiPreview.recipient.protocol}`; $('smartAIPayload').textContent = JSON.stringify(aiPreview.payload, null, 2); $('smartAIConsent').checked = false; $('smartAIReview').dataset.token = aiPreview.token; $('smartAIReview').hidden = false; }));
  $('smartAICancel').addEventListener('click', () => { aiPreview = null; $('smartAIReview').hidden = true; });
  $('smartAISend').addEventListener('click', () => task(async () => { if (!$('smartAIConsent').checked || !aiPreview) throw new Error('请先核对模型接收方及发送内容并勾选确认'); const preview = aiPreview; aiPreview = null; const result = await request('recognize', { token: preview.token, confirmed: true }); update(result); $('smartAIReview').hidden = true; $('smartStatus').textContent = `AI 返回 ${result.suggestionCount} 条待确认建议；没有修改个人资料`; }));
  $('smartFillAll').addEventListener('click', () => task(async () => { if (!current) throw new Error('请先扫描页面'); prepareFill([...selected]); }));
  $('smartFillCancel').addEventListener('click', () => { fillIds = []; $('smartFillReview').hidden = true; });
  $('smartFillConfirm').addEventListener('click', () => task(async () => {
    if (!$('smartFillConsent').checked) throw new Error('请先核对填写预览并勾选确认');
    const remember = $('smartRememberAfter').checked; const ids = [...fillIds]; let success = 0; let failed = 0;
    $('smartFillReview').hidden = true;
    for (const scanId of ids) {
      const card = [...document.querySelectorAll('.smart-row')].find((node) => node.dataset.scanId === scanId); if (card) { card.dataset.status = 'filling'; card.querySelector('h4').append(document.createTextNode(' · 正在填写')); }
      update(await request('fill', { scanId, confirmed: true }));
      if (current.rows.find((row) => row.field.scanId === scanId)?.status === 'success') { success++; if (remember) update(await request('remember', { scanId, confirmed: true })); } else failed++;
    }
    $('smartStatus').textContent = `填写完成：成功 ${success}，失败/不支持 ${failed}。未提交申请。`;
  }));
  $('smartRules').addEventListener('click', () => task(showRules));
  $('smartUndo').addEventListener('click', () => task(async () => { if (confirm('确认撤销最近一次规则操作？')) { await request('undoRule', { revision: rulesView.revision, confirmed: true }); await showRules(); } }));
  $('smartExportV3').addEventListener('click', () => task(async () => { const result = await request('exportV3'); const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' })); const link = node('a'); link.href = url; link.download = 'localapply-compatible-v3.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  // 档案/标签变化立即清除 UI 确认，用户必须重新授权当前页；不偷偷延续另一个页面的许可。
  function clear() { generation++; current = null; selectionInitialized = false; selected.clear(); drafts.clear(); $('smartPageConsent').checked = false; $('smartAIReview').hidden = $('smartFillReview').hidden = true; render(); $('smartStatus').textContent = '请选择当前招聘页并主动授权扫描'; }
  $('profileSel').addEventListener('change', clear); chrome.tabs.onActivated.addListener(clear);
  // 后台观察不抢占按钮，也不覆盖最近一次错误/成功提示；仅结构或资料版本变化时重绘。
  setInterval(async () => {
    if (!current || busy || polling || $('tab-smart').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    const id = current.sessionId; polling = true;
    try {
      const view = await request('session');
      if (current?.sessionId === id && !busy && (view.revision !== current.revision || JSON.stringify(view.rows.map((row) => row.field)) !== JSON.stringify(current.rows.map((row) => row.field)))) update(view);
    } catch (error) { if (current?.sessionId === id && !busy) { $('smartStatus').textContent = error.message; $('smartStatus').className = 'err'; } }
    finally { polling = false; }
  }, 2000);
})();
