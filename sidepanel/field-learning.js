// 复用字段学习界面：悬浮卡片点击即填，旧界面保留预览；模型调用和资料入库仍独立确认。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const directFill = document.body.dataset.fillMode === 'direct';
  const labels = { matched: '已匹配', needs_confirmation: '需要确认', missing_value: '缺少资料', filling: '正在填写', success: '填写成功', failed: '填写失败', unsupported: '控件暂不支持' };
  let current = null; let aiPreview = null; let fillIds = []; let busy = false; let rulesView = null; let selectionInitialized = false;
  let generation = 0; let polling = false; let activity = 0; let pageActive = true;
  let activeFill = null;
  const drafts = new Map(); const selected = new Set(); const aiSelected = new Set();
  // DOM 元素只通过 textContent 显示不可信标签和模型内容。
  function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  // 个人值只在用户核对/编辑时展开，默认预览保持遮挡。
  function display(value) { return value === null || value === undefined ? '（空）' : typeof value === 'string' ? value : JSON.stringify(value); }
  // 卡片只保留未完成项；未知但已手填的内容也不反复要求处理，冲突/失败仍可见。
  function unfinished(row) { return !row.ignored && row.status !== 'success' && (!row.webFilled || row.conflict || ['failed', 'unsupported'].includes(row.status)); }
  // 统一错误恢复，不输出 Key、响应原文或网页内容到日志。
  async function task(operation) {
    if (busy) return;
    activity++; // 新操作使更早的轮询结果失效，避免清空后被旧的“已填”标记覆盖。
    const started = generation;
    busy = true;
    $('tab-smart').setAttribute('aria-busy', 'true');
    $('tab-smart').querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try { return await operation(); }
    catch (error) { if (started === generation) { $('smartStatus').textContent = error.message; $('smartStatus').className = 'err'; } }
    finally { busy = false; $('tab-smart').setAttribute('aria-busy', 'false'); $('tab-smart').querySelectorAll('button').forEach((button) => { button.disabled = button.id === 'smartUndo' ? !rulesView?.canUndo : false; }); }
  }
  // 所有阶段三业务均经受信后台；日志未落盘时单独提示，不掩盖真实填写结果。
  async function request(type, payload = {}) {
    const started = generation;
    const result = await sendMessage('learning:' + type, { sessionId: current?.sessionId, ...payload });
    if (result.diagnosticsSaved === false && $('logsStorageStatus')) { $('logsStorageStatus').textContent = '本次操作的日志保存失败；填写结果仍有效，请打开诊断面板检查存储并重试。'; $('logsStorageStatus').className = 'err'; }
    if (started !== generation) throw new Error(directFill ? '页面或档案已切换，请重新点击填写' : '页面或档案已切换，请重新授权');
    if (!result.ok) throw new Error(result.error); return result;
  }
  // 停止不进入忙碌屏障：先释放暂停等待，再通过原会话停止内容任务，保留已完成字段。
  async function stopFill() {
    const job=activeFill;if(!job)return;job.controller.abort();
    if(job.batchId)await sendMessage('learning:cancelFill',{sessionId:job.sessionId,batchId:job.batchId}).catch(()=>{});
  }
  // 可靠连接租约把 UI 关闭/刷新与后台取消绑定；只发送随机批次标识和已有面板令牌。
  async function leaseFill(job) {
    const port=chrome.runtime.connect({name:'localapply:fill'});job.port=port;
    port.onDisconnect.addListener(()=>job.controller.abort());
    await new Promise((resolve,reject)=>{
      // 确认、断连和超时共用清理，不留下等待监听器。
      const finish=(error)=>{clearTimeout(timer);port.onMessage.removeListener(reply);port.onDisconnect.removeListener(disconnected);error?reject(error):resolve();};
      const reply=(message)=>finish(message.ok?null:new Error('填写连接未授权，请重新扫描'));
      const disconnected=()=>finish(new Error('填写连接已关闭'));
      const timer=setTimeout(()=>finish(new Error('填写连接超时，请重试')),5000);port.onMessage.addListener(reply);port.onDisconnect.addListener(disconnected);
      const panelToken=directFill?new URLSearchParams(location.search).get('token'):null;
      port.postMessage({sessionId:job.sessionId,batchId:job.batchId,...(panelToken?{panelToken}:{})});
    });
  }
  // 两个入口共用后台批次、连接租约和版本检查；批次标识不放入 URL、存储、AI 或日志。
  async function withFill(operation) {
    const job={sessionId:current.sessionId,generation,controller:new AbortController(),batchId:null,port:null};
    activeFill=job;$('smartStopFill').hidden=false;$('smartStopFill').disabled=false;$('smartRevoke').disabled=false;
    try{
      const result=await request('beginFill',{confirmed:true});job.batchId=result.batchId;
      // 局部检查不重新授权或自动重扫，避免取消/换档案后沿用来源。
      job.check=()=>{if(job.controller.signal.aborted||generation!==job.generation||current?.sessionId!==job.sessionId)throw new Error('已停止填写');};
      job.check();await leaseFill(job);job.check();
      // 单项和记录准备共享批次，所有来源仍由后台签发，不接收 UI 值或执行计划。
      job.send=async(type,payload={})=>{job.check();const result=await request(type,{...payload,sessionId:job.sessionId,batchId:job.batchId});job.check();return result;};
      return await operation(job);
    }catch(error){if(job.controller.signal.aborted)return {cancelled:true};throw error;}
    finally{
      if(job.batchId)await sendMessage('learning:endFill',{sessionId:job.sessionId,batchId:job.batchId}).catch(()=>{});
      job.port?.disconnect();if(activeFill===job){activeFill=null;$('smartStopFill').hidden=true;}
    }
  }
  // 首次及动态新增项只勾选本地确定匹配；保留用户对已有项的取消选择，AI 建议不自动执行。
  function update(view) {
    const previousIds = new Set(current?.rows.map((row) => row.field.scanId) || []);
    current = view;
    $('tab-smart').dataset.sessionId = view.sessionId;
    if (!selectionInitialized || directFill) { view.rows.filter((row) => row.status === 'matched' && (!selectionInitialized || !previousIds.has(row.field.scanId))).forEach((row) => selected.add(row.field.scanId)); selectionInitialized = true; }
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
  // 卡片点击即执行；旧界面继续使用预览，不改变模型建议或资料保存流程。
  async function prepareFill(ids, includeDynamic = false) {
    fillIds = ids.filter((id) => current.rows.some((row) => row.field.scanId === id && row.target && row.value !== null && row.value !== '' && (!directFill || unfinished(row))));
    if (!fillIds.length) {
      if (directFill) { $('smartStatus').textContent = `填写完成：本次成功填入 0 个字段，剩余 ${current.rows.filter(unfinished).length} 个未完成；请为待处理项选择来源或补充资料。`; return; }
      throw new Error('没有可填写的已选字段，请先选择来源或补充资料');
    }
    if (directFill) { await fillSelected([...fillIds], $('smartRememberAfter').checked, includeDynamic); return; }
    $('smartFillPayload').textContent = JSON.stringify(current.rows.filter((row) => fillIds.includes(row.field.scanId)).map((row) => ({ 网页字段: row.field.label, 分组: row.field.group, 来源: current.sources.find((source) => source.fieldId === row.target.fieldId && source.entryId === row.target.entryId)?.label, 实际值: row.value })), null, 2);
    $('smartFillConsent').checked = false; $('smartRememberAfter').checked = false; $('smartFillReview').hidden = false;
  }
  // 渲染每个状态及确认入口，任何模型建议都不会直接生成点击网页的行为。
  function render() {
    $('smartMatched').replaceChildren(); $('smartUnknown').replaceChildren();
    let excluded = $('smartExcluded');
    if (!excluded) { excluded = node('details', '', 'card'); excluded.id = 'smartExcluded'; $('smartUnknown').after(excluded); }
    excluded.replaceChildren(); excluded.hidden = !current;
    if (!current) { if ($('smartMetrics')) $('smartMetrics').replaceChildren(); if (directFill) { $('smartMatchedHeading').hidden = true; $('smartUnknownHeading').hidden = true; } return; }
    if ($('smartMetrics')) {
      const metrics = directFill ? [['成功填入', current.rows.filter((row) => row.status === 'success').length], ['网页已有', current.rows.filter((row) => row.webFilled && row.status !== 'success' && !row.conflict).length], ['未完成', current.rows.filter(unfinished).length], ['缺资料', current.rows.filter((row) => unfinished(row) && row.status === 'missing_value').length]] : [['可填写', current.rows.filter((row) => row.status === 'matched').length], ['待处理', current.rows.filter((row) => row.status === 'needs_confirmation').length], ['缺资料', current.rows.filter((row) => row.status === 'missing_value').length], ['已排除', current.excluded?.length || 0]];
      $('smartMetrics').replaceChildren(...metrics.map(([label, count]) => node('span', `${label} ${count}`, 'metric')));
    }
    $('smartMatched').hidden = !!$('smartOnlyUnknown')?.checked;
    excluded.append(node('summary', `已排除控件 ${current.excluded?.length || 0} 项 / 本次忽略 ${current.rows.filter((row) => row.ignored).length} 项`));
    for (const item of current.excluded || []) excluded.append(node('p', `${item.label} · ${item.category} · ${item.reason}`));
    $('smartStatus').textContent = directFill ? `扫描 ${current.rows.length} 个字段，成功填入 ${current.rows.filter((row) => row.status === 'success').length} 个，剩余 ${current.rows.filter(unfinished).length} 个未完成。${current.notice || ''}` : `${current.origin} · 扫描 ${current.rows.length} 个字段；可填写 ${current.rows.filter((row) => row.status === 'matched').length}，待处理 ${current.rows.filter((row) => !row.target && !row.ignored).length}，缺资料 ${current.rows.filter((row) => row.status === 'missing_value').length}；资料版本 ${current.revision} ${current.notice || ''}`; $('smartStatus').className = 'muted';
    if (directFill) {
      $('smartMatchedHeading').hidden = $('smartOnlyUnknown').checked || !current.rows.some((row) => unfinished(row) && row.source !== 'unknown');
      $('smartUnknownHeading').hidden = !current.rows.some((row) => unfinished(row) && row.source === 'unknown');
    }
    for (const row of current.rows) {
      if (directFill && !row.ignored && !unfinished(row)) continue;
      if (row.ignored) { const ignored = node('p', row.field.label + ' · 本次已忽略'); ignored.append(button('恢复此字段', async () => update(await request('ignore', { scanId: row.field.scanId, ignored: false })))); excluded.append(ignored); continue; }
      const card = node('article', '', 'card smart-row'); card.dataset.scanId = row.field.scanId; card.dataset.status = row.status;
      const title = node('h4', row.field.label + ' · ' + (directFill && row.status === 'needs_confirmation' ? '待处理' : labels[row.status])); const check = node('input'); check.type = 'checkbox'; check.className = 'smart-check'; check.setAttribute('aria-label', '选择填写' + row.field.label); check.checked = selected.has(row.field.scanId); check.disabled = !row.target || ['unsupported','missing_value'].includes(row.status);
      check.addEventListener('change', () => check.checked ? selected.add(row.field.scanId) : selected.delete(row.field.scanId)); const heading = node('div', '', 'smart-row-heading'); heading.append(check, title); card.append(heading, node('p', [row.field.group, row.field.type, directFill ? row.reason.replace('填写前仍需确认', '可直接填写') : row.reason].filter(Boolean).join(' · '), 'muted'));
      // 固定原因和扫描序号可与导出日志对照，不显示候选内容或网页实际值。
      if (row.diagnostic?.message && row.status !== 'success') card.append(node('p', `诊断 #${row.diagnostic.fieldNumber}：${row.diagnostic.message}`, 'muted'));
      card.append(sourceSelect(row, async (source) => { selected.add(row.field.scanId); update(await request('select', { scanId: row.field.scanId, fieldId: source.fieldId, entryId: source.entryId })); }));
      if (!row.target && row.status !== 'unsupported') {
        const aiLabel = node('label'); const aiCheck = node('input'); aiCheck.type = 'checkbox'; aiCheck.className = 'smart-ai-check'; aiCheck.checked = aiSelected.has(row.field.scanId);
        aiCheck.addEventListener('change', () => aiCheck.checked ? aiSelected.add(row.field.scanId) : aiSelected.delete(row.field.scanId)); aiLabel.append(aiCheck, document.createTextNode(' 选择此字段使用 AI（可选）'));
        card.append(aiLabel, button('本次忽略', async () => { aiSelected.delete(row.field.scanId); update(await request('ignore', { scanId: row.field.scanId, ignored: true })); }));
      }
      if (row.target) {
        const preview = node('p', row.value == null ? '本地暂无资料' : '本地值：••••'); card.append(preview);
        card.append(button(directFill ? '查看本地值' : '核对本地值', async () => { preview.textContent = display(row.value); }), button(directFill ? '单项填写' : '单项填写预览', async () => prepareFill([row.field.scanId])));
      }
      if (row.conflict) {
        const diff = node('details'); diff.className = 'smart-overwrite'; diff.append(node('summary', '网页已有不同内容：预览并逐项允许覆盖'), node('pre', JSON.stringify({ 网页现有值: row.conflict.before, 本地拟填值: row.conflict.after }, null, 2)));
        const label = node('label'); const consent = node('input'); consent.type = 'checkbox'; consent.className = 'smart-overwrite-consent'; label.append(consent, document.createTextNode(' 我已核对差异，允许覆盖此项'));
        diff.append(label, button('确认覆盖此项', async () => { if (!consent.checked) throw new Error('请先核对差异并允许覆盖此项'); update(await request('fill', { scanId: row.field.scanId, confirmed: true, overwriteToken: row.conflict.token })); })); card.append(diff);
      }
      if (row.suggestion) {
        card.append(node('pre', JSON.stringify(row.suggestion, null, 2)));
        const apply = button(row.suggestion.action === 'skip_non_resume_control' ? '确认本次忽略' : directFill ? '采用此建议' : '采用此建议并核对', async () => {
          const suggestion = row.suggestion;
          if (suggestion.action === 'skip_non_resume_control') { update(await request('ignore', { scanId: row.field.scanId, ignored: true })); return; }
          const source = current.sources.find((source) => source.ref === suggestion.sourceRef);
          if (suggestion.definition) { drafts.set(row.field.scanId, { newField: true, ...suggestion.definition, aliases: suggestion.definition.aliases.join('、'), options: suggestion.definition.options.join('\n'), value: source ? display(source.value) : '', sourceRef: source?.ref || '', source: source ? 'local-confirmed' : 'manual' }); render(); const entry = [...document.querySelectorAll('.smart-row')].find((item) => item.dataset.scanId === row.field.scanId); entry.querySelector('details').open = true; }
          else { const choices = current.sources.filter((source) => source.fieldId === suggestion.existingFieldId); const chosen = source || (choices.length === 1 ? choices[0] : null); if (!chosen) throw new Error('存在多段经历，请在来源列表中明确选择'); selected.add(row.field.scanId); update(await request('select', { scanId: row.field.scanId, fieldId: chosen.fieldId, entryId: chosen.entryId })); }
        }); apply.classList.add('smart-apply-suggestion');
        if (row.suggestion.action === 'needs_user_choice') card.append(node('p', 'AI 无法确定，请手动选择本地来源或填写资料。'));
        else card.append(apply);
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
      const scope = rulesView.scopes?.find((item) => item.mappingId === rule.mappingId);
      if (scope) card.append(node('p', `控件：${rule.features.type} · 同语义 ${scope.count} 个变体（${scope.controls.join('、')}）。本卡仅修改当前变体；冲突、待验证或禁用变体会阻止跨控件自动复用。`, 'muted'));
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

  // 扫描绑定用户点击的当前文档；卡片无需授权复选框，后台仍校验会话与来源。
  async function scanPage(targetTabId, legacyAction = false) {
    if (!directFill && !legacyAction && !$('smartPageConsent').checked) throw new Error('请先勾选授权扫描当前招聘页'); // 旧填写按钮本身沿用原有主动扫描许可，普通智能扫描仍保留勾选。
    await flushSaves(); const state = await getState();
    if (directFill && !globalThis.LocalApplyPanelContext) throw new Error('页面正在连接，请稍后重试');
    // 悬浮卡片固定绑定打开时的顶层标签，不能跟随另一个活动标签操作资料。
    const tab = Number.isInteger(targetTabId)?{id:targetTabId}:globalThis.LocalApplyPanelContext || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    current = null; selectionInitialized = false; selected.clear(); aiSelected.clear(); drafts.clear(); $('smartAIReview').hidden = true; if ($('smartFillReview')) $('smartFillReview').hidden = true; render(); $('smartStatus').textContent = directFill ? '正在识别当前页面字段…' : '正在扫描已授权页面…';
    update(await request('scanPage', { tabId: tab?.id, profileId: state.activeProfileId, confirmed: true }));
  }
  // 直接模式在填写或 AI 识别前刷新来源；配置/资料变化后自动重建本页扫描。
  async function ensureCurrent() {
    if (!current) await scanPage();
    else { try { update(await request('session')); } catch { await scanPage(); } }
  }
  $('smartScan').addEventListener('click', () => task(scanPage));
  // 只筛选可见列表，不清空选择、草稿或后台扫描会话。
  $('smartOnlyUnknown')?.addEventListener('change', render);
  $('smartRefresh').addEventListener('click', () => task(async () => { if (directFill && !current) await scanPage(); else update(await request('session')); }));
  $('smartRevoke').addEventListener('click', async () => {const sessionId=current?.sessionId;await stopFill();if(sessionId)await sendMessage('learning:revoke',{sessionId}).catch(()=>{});clear();$('smartStatus').textContent=directFill?'已清除扫描结果，点击即可重新填写':'已撤销本页授权';});
  $('smartAI').addEventListener('click', () => task(async () => { if (directFill) await ensureCurrent(); aiPreview = await request('prepareAI', { scanIds: current.rows.filter((row) => !row.target && !row.ignored && aiSelected.has(row.field.scanId)).map((row) => row.field.scanId) }); $('smartRecipient').textContent = `${aiPreview.recipient.name} · ${aiPreview.recipient.baseUrl} · ${aiPreview.recipient.model} · ${aiPreview.recipient.protocol}`; $('smartAIPayload').textContent = JSON.stringify(aiPreview.payload, null, 2); $('smartAIConsent').checked = false; $('smartAIReview').dataset.token = aiPreview.token; $('smartAIReview').hidden = false; }));
  // 取消按钮不进入忙碌屏障，能够中止正在等待的模型请求并丢弃晚到建议。
  $('smartAICancel').addEventListener('click', async () => { aiPreview = null; $('smartAIReview').hidden = true; if (current) { try { await request('cancelAI'); } catch { /* 失效会话无需继续等待取消。 */ } } });
  $('smartAISend').addEventListener('click', () => task(async () => { if (!$('smartAIConsent').checked || !aiPreview) throw new Error('请先核对模型接收方及发送内容并勾选确认'); const preview = aiPreview; aiPreview = null; $('smartAICancel').disabled = false; const result = await request('recognize', { token: preview.token, confirmed: true }); update(result); $('smartAIReview').hidden = true; $('smartStatus').textContent = `AI 返回 ${result.suggestionCount} 条待确认建议；没有修改个人资料`; }));
  $('smartFillAll').addEventListener('click', () => task(async () => {
    if (directFill) { await ensureCurrent(); await fillSelected([...selected],$('smartRememberAfter').checked,true);return; }
    else if (!current) throw new Error('请先扫描页面');
    await prepareFill([...selected], directFill);
  }));
  $('smartFillCancel')?.addEventListener('click', () => { fillIds = []; $('smartFillReview').hidden = true; });
  $('smartStopFill').addEventListener('click',()=>{void stopFill();});
  // 切到其他浏览器标签时暂停后续写入，返回原页继续；换档案/撤销立即释放等待，不抢用户焦点。
  async function waitForPage(job) {
    job.check();
    if (!directFill) return;
    // tabs.active 同样适用于不派发 visibilitychange 的浏览器窗口，始终查询卡片绑定的标签。
    pageActive = (await chrome.tabs.get(globalThis.LocalApplyPanelContext.id)).active;
    if (pageActive && !document.hidden) return;
    const started = generation;
    $('smartStatus').textContent = '已暂停后续填写，当前结果已保留；回到此页面后自动继续。';
    await new Promise((resolve) => {
      const resume = () => { if (job.controller.signal.aborted||pageActive && !document.hidden || started !== generation) { document.removeEventListener('visibilitychange', resume); document.removeEventListener('localapply:page-activation', resume); document.removeEventListener('localapply:learning-reset', resume);job.controller.signal.removeEventListener('abort',resume); resolve(); } };
      document.addEventListener('visibilitychange', resume); document.addEventListener('localapply:page-activation', resume); document.addEventListener('localapply:learning-reset', resume);job.controller.signal.addEventListener('abort',resume,{once:true}); resume();
    });
    if (started !== generation) throw new Error('档案或页面已变化，已停止填写');
    job.check();await job.send('leaseFill');
    // 返回时再次经过后台文档、URL、档案及有效期校验，不沿用过期执行许可。
    update(await request('session'));
    $('smartStatus').textContent = '已回到原页面，正在继续填写…';
  }
  // 批量只补本次新启用的确定字段；每项最多尝试一次，单项填写不扩展队列，失败项不无限重试。
  async function fillSelected(ids, remember, includeDynamic = false) {
    const started=generation;let success=0;let failed=0;let pending=0;
    const outcome=await withFill(async(job)=>{
      const initiallyMatched=new Set(current.rows.filter((row)=>row.status==='matched').map((row)=>row.field.scanId));
      if(includeDynamic){await waitForPage(job);update(await job.send('prepareRecords',{confirmed:true}));}
      let queue=[...new Set([...ids,...(includeDynamic?current.rows.filter((row)=>row.status==='matched'&&(row.source==='record'||!initiallyMatched.has(row.field.scanId))).map((row)=>row.field.scanId):[])])];
      const attempted=new Set();const known=new Set(current.rows.map((row)=>row.field.scanId));
      for(let round=0;queue.length&&round<4&&attempted.size<500;round++){
        for(const scanId of queue){
          await waitForPage(job);job.check();if(attempted.has(scanId))continue;attempted.add(scanId);
          const row=current.rows.find((row)=>row.field.scanId===scanId);if(!row||!row.target||directFill&&!unfinished(row))continue;
          const card=[...document.querySelectorAll('.smart-row')].find((node)=>node.dataset.scanId===scanId);if(card){card.dataset.status='filling';card.querySelector('h4').append(document.createTextNode(' · 正在填写'));}
          update(await job.send('fill',{scanId,confirmed:true}));const status=current.rows.find((row)=>row.field.scanId===scanId)?.status;
          if(status==='success'){success++;if(remember)update(await job.send('remember',{scanId,confirmed:true}));}else if(status==='needs_confirmation')pending++;else failed++;
        }
        queue=[];if(!includeDynamic)break;
        await waitForPage(job);update(await job.send('session'));if(!current.rows.some((row)=>!known.has(row.field.scanId)))break;
        update(await job.send('prepareRecords',{confirmed:true}));
        for(const row of current.rows){if(!known.has(row.field.scanId)&&row.status==='matched'&&unfinished(row)&&!attempted.has(row.field.scanId))queue.push(row.field.scanId);known.add(row.field.scanId);}
      }
    });
    if(started!==generation)return;
    if(outcome?.cancelled&&current){try{update(await request('session'));}catch{}}
    $('smartStatus').textContent=`${outcome?.cancelled?'已停止填写':'填写完成'}：本次成功填入 ${success} 个字段，失败/不支持 ${failed}，需确认 ${pending}${directFill?`，剩余 ${current.rows.filter(unfinished).length} 个未完成`:''}。未提交申请。${current.notice||''}`;
  }
  $('smartFillConfirm')?.addEventListener('click', () => task(async () => {
    if (!$('smartFillConsent').checked) throw new Error('请先核对填写预览并勾选确认');
    $('smartFillReview').hidden = true; await fillSelected([...fillIds], $('smartRememberAfter').checked);
  }));
  $('smartRules').addEventListener('click', () => task(showRules));
  $('smartUndo').addEventListener('click', () => task(async () => { if (confirm('确认撤销最近一次规则操作？')) { await request('undoRule', { revision: rulesView.revision, confirmed: true }); await showRules(); } }));
  $('smartExportV3').addEventListener('click', () => task(async () => { const result = await request('exportV3'); const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' })); const link = node('a'); link.href = url; link.download = 'localapply-compatible-v3.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  // 悬浮卡片绑定原文档，切标签保留扫描与草稿；旧侧栏跟随活动标签，换档案仍须清空。
  function clear() { void stopFill();generation++; document.dispatchEvent(new Event('localapply:learning-reset')); current = null; selectionInitialized = false; selected.clear(); aiSelected.clear(); drafts.clear(); if ($('smartPageConsent')) $('smartPageConsent').checked = false; $('smartAIReview').hidden = true; if ($('smartFillReview')) $('smartFillReview').hidden = true; render(); $('smartStatus').textContent = directFill ? '点击自动填写，使用当前档案匹配网页字段' : '请选择当前招聘页并主动授权扫描'; }
  window.addEventListener('pagehide',()=>{void stopFill();activeFill?.port?.disconnect();});
  // 旧侧栏只交字段标识和唯一网页标签；来源由最新规范绑定解析，绝不接受任意文本值或计划。
  globalThis.LocalApplyLearningUI=Object.freeze({
    async legacyFill(tabId,items,bulk=false){
      const result=await task(async()=>{
        if(directFill||!Number.isInteger(tabId)||!Array.isArray(items)||items.length>500)throw new Error('旧入口填写请求无效');
        $('tabSmartBtn').click();await scanPage(tabId,true);const response=await sendMessage('localapply:read');if(!response.ok)throw new Error(response.error);const db=response.database;const chosen=[];const outcomes=[];
        for(const item of items){
          const binding=db.bindings.find((binding)=>binding.profileId===current.profileId&&binding.fid===item.fid);const rows=current.rows.filter((row)=>row.field.label===item.label);
          const row=rows.length===1?rows[0]:null;
          // 旧按钮明确选用档案平面字段；允许它从合法候选中选平面槽，但不绕过历史冲突或学历筛选。
          const same=!!binding&&row?.target?.fieldId===binding.fieldId&&row.target.entryId===null;
          const flatCandidate=!!binding&&row?.candidates.some((target)=>target.fieldId===binding.fieldId&&target.entryId===null);
          const allowed=row?.source==='memory'?row.confirmed&&same:row?.status==='matched'&&same||row?.source==='context'&&flatCandidate||row?.source==='definition-suggestion'&&same&&!db.publicFieldIds.includes(binding.fieldId);
          if(!binding||!row||row.status==='unsupported'||bulk&&!allowed){outcomes.push({id:item.id,label:item.label,ok:false,reason:'网页字段或来源不唯一，请在智能填写中选择'});continue;}
          update(await request('select',{scanId:row.field.scanId,fieldId:binding.fieldId,entryId:null}));chosen.push({item,scanId:row.field.scanId});
        }
        if(chosen.length)await fillSelected(chosen.map((row)=>row.scanId),false);
        for(const {item,scanId}of chosen){const row=current?.rows.find((row)=>row.field.scanId===scanId);outcomes.push({id:item.id,label:item.label,ok:row?.status==='success',reason:row?.reason});}
        return {ok:true,results:outcomes,manualFirst:false};
      });return result||{ok:false,error:'填写已停止或界面正忙，请在智能填写中查看结果'};
    }
  });
  $('profileSel').addEventListener('change', clear);
  // 管理页或另一卡片切换活动档案时也清空旧来源；只检查 ID，不读取通知中的个人值。
  chrome.storage.onChanged.addListener((changes,area)=>{const profileId=changes['localapply.database']?.newValue?.activeProfileId;if(area==='local'&&profileId&&current&&profileId!==current.profileId)clear();});
  chrome.tabs.onActivated.addListener((info) => { if (!directFill) clear(); else if (globalThis.LocalApplyPanelContext) { pageActive = info.tabId === globalThis.LocalApplyPanelContext.id; document.dispatchEvent(new Event('localapply:page-activation')); } });
  // 后台观察只在未编辑时重绘；展开资料编辑器后保留 DOM，避免手填内容使读取按钮消失。
  setInterval(async () => {
    if (!current || busy || polling || !pageActive || document.hidden || $('tab-smart').hidden || document.querySelector('.smart-editor[open]') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    const id = current.sessionId; const startedActivity = activity; polling = true;
    try {
      const view = await request('session');
      if (current?.sessionId === id && startedActivity === activity && !busy && !document.querySelector('.smart-editor[open]') && (view.revision !== current.revision || JSON.stringify(view.rows.map((row) => [row.field, directFill && row.webFilled, row.status])) !== JSON.stringify(current.rows.map((row) => [row.field, directFill && row.webFilled, row.status])))) update(view);
    } catch (error) { if (current?.sessionId === id && startedActivity === activity && !busy) { $('smartStatus').textContent = error.message; $('smartStatus').className = 'err'; } }
    finally { polling = false; }
  }, 2000);
})();
