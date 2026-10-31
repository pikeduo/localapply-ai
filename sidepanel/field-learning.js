// 复用字段学习界面：悬浮卡片点击即填，旧界面保留预览；模型调用和资料入库仍独立确认。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const directFill = document.body.dataset.fillMode === 'direct';
  const labels = { matched: '已匹配', needs_confirmation: '需要确认', missing_value: '缺少资料', filling: '正在填写', success: '填写成功', failed: '填写失败', unsupported: '控件暂不支持' };
  // 仅展示固定保护检查说明，绝不拼入属性、日期或原始异常。
  const guardLabels = Object.freeze({ context: '页面、授权或扫描绑定已变化', members: '日期或电话的子控件已变化', attributes: '控件属性已变化', safety: '控件已断开、禁用或受到保护', value: '交互期间输入框内容发生变化', date_projection: '日期来源或目标精度不一致' });
  let current = null; let aiPreview = null; let fillIds = []; let busy = false; let rulesView = null; let selectionInitialized = false;
  let generation = 0; let polling = false; let activity = 0; let pageActive = true;
  let needsSessionRefresh = false;
  let activeFill = null;
  const drafts = new Map(); const selected = new Set(); const aiSelected = new Set();
  // 点选或聚焦使已在途的轮询结果失效，避免重绘替换正在操作的复选框、吞掉用户点击。
  function markInteraction() { activity++; }
  $('tab-smart').addEventListener('pointerdown', markInteraction);
  $('tab-smart').addEventListener('focusin', markInteraction);
  const learningSelected = new Set(); const manualFields = new Set(); const webValues = new Map(); let learningPreview = null;
  let overwritePreview = null; let overwriteVersion = 0;
  // 覆盖许可仅属于当前预览；切页、取消或更换经历来源时立即丢弃，不保存全局开关。
  function cancelOverwrite() { overwriteVersion++; overwritePreview=null; if($('smartOverwriteReview')) { $('smartOverwriteReview').hidden=true; $('smartOverwriteChanges').replaceChildren(); $('smartOverwriteRecords').replaceChildren(); $('smartOverwriteConsent').checked=false; } }
  // 勾选变化即废弃差异确认；不因为勾选或取消而读取网页内容、写入数据库。
  function cancelLearningPreview() { learningPreview = null; if ($('smartLearnReview')) $('smartLearnReview').hidden = true; }
  // 按当前扫描候选显示已读的选项标签，不把内部编码当成用户看到的内容。
  function webDisplay(row, value) {
    const labelOf = (item) => { const options = row.field.options.filter((option) => option.value === String(item)); return options.length === 1 ? options[0].text : item; };
    return display(Array.isArray(value) ? value.map(labelOf) : labelOf(value));
  }
  // 只有语义未确定的字段可送AI；经历未配对须由用户确认，不让模型代替配对。
  function canAskAI(row) { return !row.target && !row.recordBindingRequired && !row.ignored && row.status !== 'unsupported'; }
  // 勾选只建立本次AI清单；明确展示下一步入口，不将勾选本身当成付费调用授权。
  function syncAISelection() {
    if (!directFill) return;
    const count = current?.rows.filter((row) => canAskAI(row) && aiSelected.has(row.field.scanId)).length || 0;
    $('smartAI').textContent = count ? `AI 识别已勾选字段（${count}）` : 'AI 识别未知字段（可选）';
  }
  // 模型仅推荐已存资料的语义关联；本地预览、用户确认后才进入原填写及回读管线。
  function pendingSuggestion(card, row) {
    const suggestion = row.suggestion; if (!suggestion || row.recordBindingRequired) return;
    if (suggestion.action === 'needs_user_choice') { card.append(node('p', 'AI 无法确定，请在网页手动填写。', 'muted')); return; }
    if (suggestion.action === 'skip_non_resume_control') { card.append(node('p', 'AI 建议忽略此字段，请自行确认是否忽略。', 'muted')); return; }
    const def = current.definitions.find((def) => def.fieldId === suggestion.existingFieldId);
    card.append(node('p', 'AI 建议：' + (def?.label || suggestion.definition?.label || '尚无法匹配'), 'muted'));
    if (!suggestion.existingFieldId) { card.append(node('p', 'AI 建议新增字段，不能据此生成个人内容。请在网页填写，需要记住时勾选后统一更新。', 'muted')); return; }
    if (!current.sources.some((source) => source.fieldId === suggestion.existingFieldId && source.hasValue)) { card.append(node('p', '本地没有该字段的内容，请在网页手动填写；AI 不会编造个人资料。', 'muted')); return; }
    card.append(button('查看建议并填写', async () => {
      const preview = await request('previewSuggestion', { scanId: row.field.scanId });
      if (!confirm(`确认采用AI建议填写此项？\n网页字段：${preview.fieldLabel}\n资料字段：${preview.sourceLabel}\n拟填内容：${display(preview.value)}\n保留网页已有内容，不提交申请，也不修改个人资料。`)) return;
      cancelLearningPreview(); update(await request('acceptSuggestion', { scanId: row.field.scanId, token: preview.token, confirmed: true }));
      aiSelected.delete(row.field.scanId); await fillSelected([row.field.scanId], false);
    }, 'btn smart-apply-suggestion'));
  }
  // 悬浮处理区保留原控件手填，并为AI提供就近入口；不重新引入本地来源选择或资料编辑器。
  function pendingActions(card, row) {
    const scanId = row.field.scanId;
    card.append(node('p', webValues.has(scanId) ? '网页内容：' + webDisplay(row, webValues.get(scanId)) : '网页内容：尚未读取', 'smart-web-value'));
    card.append(button('手动填写（网页原控件）', async () => { manualFields.add(scanId); cancelLearningPreview(); await request('focusField', { scanId }); $('smartStatus').textContent = '已定位网页原控件，请在网页填写；完成后勾选并统一更新。'; }, 'btn smart-manual'),
      button('查看网页内容', async () => { const result = await request('readField', { scanId }); webValues.set(scanId, result.value); manualFields.add(scanId); cancelLearningPreview(); render(); }, 'btn ghost smart-read-web'),
      button('忽略此字段', async () => { learningSelected.delete(scanId); manualFields.delete(scanId); webValues.delete(scanId); aiSelected.delete(scanId); cancelLearningPreview(); update(await request('ignore', { scanId, ignored: true })); }, 'btn ghost smart-ignore'));
    if (row.recordBindingRequired) card.append(button('配对经历并核对填写', async () => openOverwrite(), 'btn ghost smart-pair-record'));
    if (canAskAI(row)) {
      const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.className = 'smart-ai-check'; input.checked = aiSelected.has(scanId);
      input.addEventListener('change', () => { input.checked ? aiSelected.add(scanId) : aiSelected.delete(scanId); syncAISelection(); }); label.append(input, document.createTextNode(' 加入 AI 识别清单（勾选不会自动发送）')); card.append(label);
      card.append(button('AI 识别此字段', async () => { aiSelected.add(scanId); input.checked = true; syncAISelection(); await prepareAI([scanId]); }, 'btn ghost smart-ai-start'));
    }
    pendingSuggestion(card, row);
  }
  // DOM 元素只通过 textContent 显示不可信标签和模型内容。
  function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  // 个人值只在用户核对/编辑时展开，默认预览保持遮挡。
  function display(value) { return value === null || value === undefined ? '（空）' : typeof value === 'string' ? value : JSON.stringify(value); }
  // 卡片只保留未完成项；未知但已手填的内容也不反复要求处理，冲突/失败仍可见。
  function unfinished(row) { return !row.ignored && row.status !== 'success' && (!row.webFilled || row.conflict || ['failed', 'unsupported'].includes(row.status)); }
  // 用户正在手填或勾选待学习的行即使网页已填也保留，避免失去确认入口。
  function pendingVisible(row) { return !row.ignored && (unfinished(row) || learningSelected.has(row.field.scanId) || manualFields.has(row.field.scanId)); }
  // 明确说明已有内容和来源配对的保护，避免将零写入误报为扫描失败或建议无谓调用AI。
  function fillGuidance() {
    if (!directFill || !current) return '';
    const pairing = current.rows.filter((row) => !row.ignored && row.recordBindingRequired).length;
    const existing = current.rows.filter((row) => !row.ignored && row.webOccupied && row.status !== 'success').length;
    return (pairing ? ` ${pairing} 个已识别字段需先配对经历。` : '') + (pairing || existing ? ' 网站上传解析后的纠错或补填，请点击“覆盖网页已填内容”，核对经历及勾选范围后确认。' : '');
  }
  // 仅卡片的会话缺失可主动恢复；导航、档案变化及其他业务错误仍按原保护拒绝。
  function canReconnect(error) { return directFill && ['learning_session_unavailable', 'panel_session_invalid'].includes(error.code); }
  // 被动观察不续权、不重扫，保留列表与勾选；过期预览不能继续用于AI发送、学习或覆盖。
  function retainResults() {
    needsSessionRefresh = true; aiPreview = null; fillIds = []; cancelLearningPreview(); cancelOverwrite();
    $('smartAIReview').hidden = true; $('smartAIConsent').checked = false; $('smartAIPayload').textContent = ''; delete $('smartAIReview').dataset.token;
    if ($('smartLearnConsent')) $('smartLearnConsent').checked = false;
    if ($('smartLearnChanges')) $('smartLearnChanges').replaceChildren();
    if ($('smartFillReview')) $('smartFillReview').hidden = true;
    $('smartStatus').textContent = '已保留上次扫描结果，点击自动填写或刷新结果即可重新连接；旧确认需要重新核对。'; $('smartStatus').className = 'muted';
  }
  // 用户操作中丢会话只恢复最新列表，不重放旧字段命令或确认；真实错误仍明确显示。
  async function task(operation) {
    if (busy) return;
    activity++; // 新操作使更早的轮询结果失效，避免清空后被旧的“已填”标记覆盖。
    const started = generation;
    busy = true;
    $('tab-smart').setAttribute('aria-busy', 'true');
    $('tab-smart').querySelectorAll('button').forEach((button) => { button.disabled = true; });
    if (directFill) $('tab-smart').querySelectorAll('.smart-check').forEach((input) => { input.disabled = true; });
    try { return await operation(); }
    catch (error) {
      if (started === generation) {
        if (canReconnect(error)) {
          retainResults();
          try { await scanPage(); error = new Error('已重新连接并刷新字段列表，请重新选择此项；旧确认已失效。'); error.code = 'stale_field'; }
          catch (recoveryError) { if (canReconnect(recoveryError)) { retainResults(); return; } error = recoveryError; }
        }
        if (started === generation) { $('smartStatus').textContent = error.message; $('smartStatus').className = error.code === 'stale_field' ? 'muted' : 'err'; if (directFill) $('smartStatus').scrollIntoView({ block: 'center' }); }
      }
    }
    finally { busy = false; $('tab-smart').setAttribute('aria-busy', 'false'); $('tab-smart').querySelectorAll('button').forEach((button) => { button.disabled = button.id === 'smartUndo' ? !rulesView?.canUndo : false; }); if (directFill) $('tab-smart').querySelectorAll('.smart-check').forEach((input) => { input.disabled = false; }); }
  }
  // 所有业务仍经后台校验；区分旧后台误分派和单项扫描失效，恢复不转移旧字段许可。
  async function request(type, payload = {}, allowReconnect = true) {
    const started = generation; const sessionId = payload.sessionId || current?.sessionId;
    const result = await sendMessage('learning:' + type, { sessionId, ...payload }, allowReconnect);
    if (result.diagnosticsSaved === false && $('logsStorageStatus')) { $('logsStorageStatus').textContent = '本次操作的日志保存失败；填写结果仍有效，请打开诊断面板检查存储并重试。'; $('logsStorageStatus').className = 'err'; }
    if (started !== generation) throw new Error(directFill ? '页面或档案已切换，请重新点击填写' : '页面或档案已切换，请重新授权');
    if (!result.ok) {
      // 这些批次命令不接受 scanId；旧后台误走 rowOf 时必须停止，不能降级绕过批次安全检查。
      if (['beginFill', 'leaseFill', 'prepareRecords'].includes(type) && ['网页字段不在授权扫描范围内', '未知字段学习操作'].some((message) => result.error?.startsWith(message))) {
        throw new Error('扩展组件版本不一致，请在扩展管理页点击“重新加载”，再刷新招聘页后重试。无需卸载，已保存资料会保留。');
      }
      if (result.error === '网页字段不在授权扫描范围内' && typeof payload.scanId === 'string' && current?.sessionId === sessionId) {
        const fresh = await sendMessage('learning:session', { sessionId });
        if (started !== generation || current?.sessionId !== sessionId) throw new Error('页面或档案已切换，请重新点击填写');
        if (!fresh.ok) { const error = new Error(fresh.error); error.code = fresh.code; throw error; }
        update(fresh); aiPreview = null; $('smartAIReview').hidden = true; if ($('smartFillReview')) $('smartFillReview').hidden = true;
        const error = new Error('网页字段已更新，列表已刷新，请重新选择此项。'); error.code = 'stale_field'; throw error;
      }
      const error = new Error(result.error); error.code = result.code; throw error;
    }
    return result;
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
    needsSessionRefresh = false;
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
  // 渲染状态、固定保护诊断及确认入口，模型建议不直接生成网页点击。
  function render() {
    syncAISelection();
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
    $('smartStatus').textContent = directFill ? `扫描 ${current.rows.length} 个字段，成功填入 ${current.rows.filter((row) => row.status === 'success').length} 个，剩余 ${current.rows.filter(unfinished).length} 个未完成。${current.notice || ''}${fillGuidance()}` : `${current.origin} · 扫描 ${current.rows.length} 个字段；可填写 ${current.rows.filter((row) => row.status === 'matched').length}，待处理 ${current.rows.filter((row) => !row.target && !row.ignored).length}，缺资料 ${current.rows.filter((row) => row.status === 'missing_value').length}；资料版本 ${current.revision} ${current.notice || ''}`; $('smartStatus').className = 'muted';
    if (directFill) {
      $('smartMatchedHeading').hidden = $('smartOnlyUnknown').checked || !current.rows.some((row) => pendingVisible(row) && row.source !== 'unknown');
      $('smartUnknownHeading').hidden = !current.rows.some((row) => pendingVisible(row) && row.source === 'unknown');
    }
    for (const row of current.rows) {
      if (directFill && !row.ignored && !pendingVisible(row)) continue;
      if (row.ignored) { const ignored = node('p', row.field.label + ' · 本次已忽略'); ignored.append(button('恢复此字段', async () => update(await request('ignore', { scanId: row.field.scanId, ignored: false })))); excluded.append(ignored); continue; }
      const card = node('article', '', 'card smart-row'); card.dataset.scanId = row.field.scanId; card.dataset.status = row.status;
      const title = node('h4', row.field.label + ' · ' + (directFill && row.status === 'needs_confirmation' ? '待处理' : labels[row.status])); const check = node('input'); check.type = 'checkbox'; check.className = 'smart-check'; check.setAttribute('aria-label', '选择填写' + row.field.label); check.checked = selected.has(row.field.scanId); check.disabled = !row.target || ['unsupported','missing_value'].includes(row.status);
      if (directFill) { check.setAttribute('aria-label', '添加并记住字段：' + row.field.label); check.checked = learningSelected.has(row.field.scanId); check.disabled = busy; }
      check.addEventListener('change', () => { const selection = directFill ? learningSelected : selected; check.checked ? selection.add(row.field.scanId) : selection.delete(row.field.scanId); if (directFill) cancelLearningPreview(); }); const heading = node('div', '', 'smart-row-heading'); heading.append(check, title); card.append(heading, node('p', [row.field.group, row.field.type, directFill ? row.reason.replace('未知字段，请手动选择或主动使用 AI', '本地未识别此字段，可手动填写或使用 AI').replace('存在多段经历，请明确选择来源', '存在多段经历，暂不能确定对应记录，请在网页手动填写').replace('填写前仍需确认', '可直接填写') : row.reason].filter(Boolean).join(' · '), 'muted'));
      // 固定原因和扫描序号可与导出日志对照，不显示候选内容或网页实际值。
      if (row.diagnostic?.message && row.status !== 'success') {
        card.append(node('p', `诊断 #${row.diagnostic.fieldNumber}：${row.diagnostic.message}`, 'muted'));
        const check = row.diagnostic.guardCheck;
        if (Object.hasOwn(guardLabels, check)) card.append(node('p', `保护检查：${guardLabels[check]}（${check}）`, 'muted smart-guard'));
        else if (row.diagnostic.reasonCode === 'stale_context') card.append(node('p', '未收到具体保护检查；请重新加载扩展并刷新招聘页后重试，在“运行日志与错误诊断”中查看本次记录。', 'muted smart-guard'));
      }
      if (directFill) { pendingActions(card, row); (row.source === 'unknown' ? $('smartUnknown') : $('smartMatched')).append(card); continue; }
      card.append(sourceSelect(row, async (source) => { selected.add(row.field.scanId); update(await request('select', { scanId: row.field.scanId, fieldId: source.fieldId, entryId: source.entryId })); }));
      // 跨站建议不预选、不填写；点击仅等同手选来源，仍须新控件回读和独立确认记忆。
      if (!row.target) for (const candidate of row.historyCandidates || []) {
        const source = current.sources.find((source) => source.fieldId === candidate.fieldId && source.entryId === candidate.entryId);
        if (source) card.append(button('选择历史建议来源：' + source.label, async () => { selected.add(row.field.scanId); update(await request('select', { scanId: row.field.scanId, fieldId: source.fieldId, entryId: source.entryId })); }, 'btn ghost smart-history-choice'));
      }
      if (canAskAI(row)) {
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

  // 扫描绑定用户点击的当前文档；成功后才替换旧结果，恢复失败时保留原列表。
  async function scanPage(targetTabId, legacyAction = false) {
    if (!directFill && !legacyAction && !$('smartPageConsent').checked) throw new Error('请先勾选授权扫描当前招聘页'); // 旧填写按钮本身沿用原有主动扫描许可，普通智能扫描仍保留勾选。
    await flushSaves(); const state = await getState();
    if (directFill && !globalThis.LocalApplyPanelContext) throw new Error('页面正在连接，请稍后重试');
    // 悬浮卡片固定绑定打开时的顶层标签，不能跟随另一个活动标签操作资料。
    const tab = Number.isInteger(targetTabId)?{id:targetTabId}:globalThis.LocalApplyPanelContext || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    $('smartStatus').textContent = directFill ? '正在识别当前页面字段…' : '正在扫描已授权页面…';
    const view = await request('scanPage', { tabId: tab?.id, profileId: state.activeProfileId, confirmed: true });
    current = null; selectionInitialized = false; selected.clear(); aiSelected.clear(); drafts.clear(); learningSelected.clear(); manualFields.clear(); webValues.clear(); aiPreview = null; fillIds = []; cancelLearningPreview(); cancelOverwrite(); $('smartAIReview').hidden = true; if ($('smartFillReview')) $('smartFillReview').hidden = true;
    update(view);
  }
  // 主动填写/刷新才重建缺失会话，不能因普通业务错误绕过导航或档案保护。
  async function ensureCurrent() {
    if (!current || needsSessionRefresh) await scanPage();
    else { try { update(await request('session')); } catch (error) { if (!canReconnect(error)) throw error; await scanPage(); } }
  }
  $('smartScan').addEventListener('click', () => task(scanPage));
  // 单次校对复用同一入口，先选择整条经历再读取补填及覆盖差异；打开不改变来源。
  async function openOverwrite() {
    await ensureCurrent(); cancelOverwrite(); const result=await request('overwriteContext');
    for(const record of result.records) {
      const label=node('label',record.label); const select=node('select'); select.className='smart-overwrite-record'; select.dataset.recordId=record.recordId; select.setAttribute('aria-label',record.label+'对应的本地经历');
      select.append(new Option('请选择本地经历，或跳过此记录',''));
      for(const option of record.options) select.append(new Option(option.label,JSON.stringify(option.entryId)));
      if(Object.hasOwn(record,'entryId')) select.value=JSON.stringify(record.entryId);
      // 改配后必须重新生成差异，不能沿用在途预览或旧确认。
      select.addEventListener('change',()=>{overwriteVersion++; overwritePreview=null; $('smartOverwriteChanges').replaceChildren(); $('smartOverwriteConsent').checked=false;});
      label.append(select); $('smartOverwriteRecords').append(label);
    }
    $('smartOverwriteReview').hidden=false; $('smartOverwriteReview').scrollIntoView({block:'start'});
  }
  $('smartOverwriteOpen')?.addEventListener('click',()=>task(openOverwrite));
  // 差异内容只在可信卡片以内显示，复选框仅选择本次写入范围，不写本地资料。
  $('smartOverwritePreview')?.addEventListener('click',()=>task(async()=> {
    const version=overwriteVersion; overwritePreview=null; $('smartOverwriteConsent').checked=false;
    const bindings=[...$('smartOverwriteRecords').querySelectorAll('select')].filter((select)=>select.value!=='').map((select)=>({recordId:select.dataset.recordId,entryId:JSON.parse(select.value)}));
    const result=await request('previewOverwrite',{bindings}); if(version!==overwriteVersion) throw new Error('经历选择已变化，请重新预览覆盖差异'); overwritePreview=result;
    $('smartOverwriteChanges').replaceChildren();
    if(!result.changes.length) $('smartOverwriteChanges').append(node('p','没有可填写的已识别差异；本地缺值、未知字段及未配对经历已保留。','muted'));
    for(const change of result.changes) {
      const row=current.rows.find((row)=>row.field.scanId===change.scanId); const item=node('article','','smart-overwrite-change'); const label=node('label'); const input=node('input'); input.type='checkbox'; input.checked=true; input.dataset.scanId=change.scanId;
      const blank = change.before === '' || Array.isArray(change.before) && !change.before.length;
      label.append(input,document.createTextNode(' '+(blank?'补填空白 · ':'覆盖已有 · ')+[change.recordLabel || change.group,change.label].filter(Boolean).join(' · '))); item.append(label,node('pre',`网页原内容：${blank?'（空）':row?webDisplay(row,change.before):display(change.before)}\n本地拟填内容：${display(change.after)}`)); $('smartOverwriteChanges').append(item);
    }
  }));
  // 统一确认只换取每项短期覆盖令牌，后续仍走原批次、原值保护及控件验证管线。
  $('smartOverwriteConfirm')?.addEventListener('click',()=>task(async()=> {
    if(!overwritePreview || !$('smartOverwriteConsent').checked) throw new Error('请先预览差异并确认本次覆盖');
    const scanIds=[...$('smartOverwriteChanges').querySelectorAll('input:checked')].map((input)=>input.dataset.scanId);
    if(!scanIds.length) throw new Error('请勾选需要覆盖的字段');
    const result=await request('confirmOverwrite',{token:overwritePreview.token,scanIds,confirmed:true}); cancelOverwrite(); cancelLearningPreview(); update(result);
    // 后台按同一记录日期范围排定安全顺序；不增加用户未勾选的字段。
    await fillSelected(result.overwrite.map((row)=>row.scanId),false,false,new Map(result.overwrite.map((row)=>[row.scanId,row.token])));
  }));
  // 取消不写网页或资料，同时释放后台尚未确认的覆盖快照。
  $('smartOverwriteCancel')?.addEventListener('click',()=>task(async()=>{cancelOverwrite(); if(current) await request('cancelOverwrite');}));
  // 集中预览由后台主动读取勾选项；确认仅交回一次性令牌，不让 UI 提交原始值或映射。
  $('smartLearnPreview')?.addEventListener('click', () => task(async () => {
    cancelLearningPreview(); const scanIds = [...learningSelected];
    const result = await request('previewLearnedFields', { scanIds });
    if (JSON.stringify(scanIds) !== JSON.stringify([...learningSelected])) throw new Error('勾选项已变化，请重新预览');
    learningPreview = result;
    $('smartLearnChanges').replaceChildren(...learningPreview.changes.map((change) => node('pre', JSON.stringify({ 网页字段: change.label, 保存到: change.targetLabel, 操作: change.action, 网页控件: change.controlType, 资料类型: change.type, 可选项: change.options, 原内容: change.oldValue, 新内容: change.newValue }, null, 2))));
    $('smartLearnConsent').checked = false; $('smartLearnReview').hidden = false;
  }));
  $('smartLearnCancel')?.addEventListener('click', () => task(async () => { cancelLearningPreview(); await request('cancelLearnedFields'); }));
  // 仅显式确认后一次写入；失败保留勾选，要求重新预览而非循环逐条保存。
  $('smartLearnCommit')?.addEventListener('click', () => task(async () => {
    if (!learningPreview || !$('smartLearnConsent').checked) throw new Error('请先核对差异并勾选确认');
    const token = learningPreview.token; cancelLearningPreview(); const view = await request('commitLearnedFields', { token, confirmed: true });
    learningSelected.clear(); manualFields.clear(); webValues.clear(); update(view); $('smartStatus').textContent = '已统一保存字段、内容和本站控件映射，下次遇到时优先本地匹配。';
  }));
  // 只筛选可见列表，不清空选择、草稿或后台扫描会话。
  $('smartOnlyUnknown')?.addEventListener('change', render);
  // 刷新与直接填写共用主动恢复，避免后台重建后反复请求已不存在的旧扫描。
  $('smartRefresh').addEventListener('click', () => task(async () => { if (directFill) await ensureCurrent(); else update(await request('session')); }));
  $('smartRevoke').addEventListener('click', async () => {const sessionId=current?.sessionId;await stopFill();if(sessionId)await sendMessage('learning:revoke',{sessionId}).catch(()=>{});clear();$('smartStatus').textContent=directFill?'已清除扫描结果，点击即可重新填写':'已撤销本页授权';});
  // 就近入口和批量入口共享发送预览；只展示脱敏元数据，用户确认前不调用模型。
  async function prepareAI(scanIds) {
    if (directFill) await ensureCurrent();
    const chosen = scanIds || current.rows.filter((row) => canAskAI(row) && aiSelected.has(row.field.scanId)).map((row) => row.field.scanId);
    if (!chosen.length) throw new Error('请先勾选需要 AI 识别的未知字段；已识别但未配对的经历请先核对整条来源。');
    aiPreview = await request('prepareAI', { scanIds: chosen });
    $('smartRecipient').textContent = `${aiPreview.recipient.name} · ${aiPreview.recipient.baseUrl} · ${aiPreview.recipient.model} · ${aiPreview.recipient.protocol}`;
    $('smartAICoverage').textContent = aiPreview.coverage ? `本次目录包含 ${aiPreview.coverage.included}/${aiPreview.coverage.available} 个字段；按分类与标签分配预算。${aiPreview.coverage.omitted ? '部分字段未发送，未见不代表不存在；可取消后手动匹配。' : '已有资料实际值不会发送。'}` : '请核对候选目录，不确定时可取消并手动匹配。';
    $('smartAIPayload').textContent = JSON.stringify(aiPreview.payload, null, 2); $('smartAIConsent').checked = false; $('smartAIReview').dataset.token = aiPreview.token; $('smartAIReview').hidden = false;
    if (directFill) { $('smartAIReview').scrollIntoView({ block: 'start' }); $('smartAIConsent').focus({ preventScroll: true }); }
  }
  $('smartAI').addEventListener('click', () => task(() => prepareAI()));
  // 取消按钮不进入忙碌屏障，能够中止正在等待的模型请求并丢弃晚到建议。
  $('smartAICancel').addEventListener('click', async () => { aiPreview = null; $('smartAIReview').hidden = true; if (current) { try { await request('cancelAI'); } catch { /* 失效会话无需继续等待取消。 */ } } });
  // 返回建议不会自动写网页；明确引导到逐项确认入口，缺值或新字段仍由用户手填。
  $('smartAISend').addEventListener('click', () => task(async () => { if (!$('smartAIConsent').checked || !aiPreview) throw new Error('请先核对模型接收方及发送内容并勾选确认'); const preview = aiPreview; aiPreview = null; $('smartAICancel').disabled = false; const result = await request('recognize', { token: preview.token, confirmed: true }); update(result); $('smartAIReview').hidden = true; $('smartStatus').textContent = `AI 返回 ${result.suggestionCount} 条待确认建议；${directFill ? '可在字段卡片点击“查看建议并填写”；' : ''}没有修改个人资料`; if (directFill) document.querySelector('.smart-apply-suggestion')?.scrollIntoView({ block: 'center' }); }));
  $('smartFillAll').addEventListener('click', () => task(async () => {
    if (directFill) { await ensureCurrent(); await fillSelected(current.rows.filter((row) => row.target && !row.ignored && (row.status === 'matched' || row.chosen && ['failed', 'unsupported'].includes(row.status))).map((row) => row.field.scanId),$('smartRememberAfter').checked,true);return; }
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
  // 单次覆盖仅放行已核对项的非空状态；令牌逐项复用既有原值保护，不扩大动态填写队列。
  async function fillSelected(ids, remember, includeDynamic = false, overwriteTokens = new Map()) {
    const started=generation;let success=0;let failed=0;let pending=0;
    const outcome=await withFill(async(job)=>{
      const initiallyMatched=new Set(current.rows.filter((row)=>row.status==='matched').map((row)=>row.field.scanId));
      if(includeDynamic){await waitForPage(job);update(await job.send('prepareRecords',{confirmed:true}));}
      let queue=[...new Set([...ids,...(includeDynamic?current.rows.filter((row)=>row.status==='matched'&&(row.source==='record'||!initiallyMatched.has(row.field.scanId))).map((row)=>row.field.scanId):[])])];
      const attempted=new Set();const known=new Set(current.rows.map((row)=>row.field.scanId));
      for(let round=0;queue.length&&round<4&&attempted.size<500;round++){
        for(const scanId of queue){
          await waitForPage(job);job.check();if(attempted.has(scanId))continue;attempted.add(scanId);
          const row=current.rows.find((row)=>row.field.scanId===scanId);if(!row||!row.target||directFill&&!overwriteTokens.has(scanId)&&!unfinished(row))continue;
          const card=[...document.querySelectorAll('.smart-row')].find((node)=>node.dataset.scanId===scanId);if(card){card.dataset.status='filling';card.querySelector('h4').append(document.createTextNode(' · 正在填写'));}
          // 动态批量只让后续扫描重新匹配新节点；旧手选/覆盖令牌绝不按相同标签继承。
          try{update(await job.send('fill',{scanId,confirmed:true,...(overwriteTokens.has(scanId)?{overwriteToken:overwriteTokens.get(scanId)}:{})}));}catch(error){if(error.code==='stale_field'&&includeDynamic){pending++;continue;}throw error;}
          const status=current.rows.find((row)=>row.field.scanId===scanId)?.status;
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
    if (directFill) pending = current.rows.filter((row) => unfinished(row) && row.status === 'needs_confirmation').length;
    $('smartStatus').textContent=`${outcome?.cancelled?'已停止填写':success||failed?'填写完成':'本次未写入字段'}：本次成功填入 ${success} 个字段，失败/不支持 ${failed}，需确认 ${pending}${directFill?`，剩余 ${current.rows.filter(unfinished).length} 个未完成`:''}。未提交申请。${current.notice||''}${fillGuidance()}`;
  }
  $('smartFillConfirm')?.addEventListener('click', () => task(async () => {
    if (!$('smartFillConsent').checked) throw new Error('请先核对填写预览并勾选确认');
    $('smartFillReview').hidden = true; await fillSelected([...fillIds], $('smartRememberAfter').checked);
  }));
  $('smartRules').addEventListener('click', () => task(showRules));
  $('smartUndo').addEventListener('click', () => task(async () => { if (confirm('确认撤销最近一次规则操作？')) { await request('undoRule', { revision: rulesView.revision, confirmed: true }); await showRules(); } }));
  $('smartExportV3').addEventListener('click', () => task(async () => { const result = await request('exportV3'); const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' })); const link = node('a'); link.href = url; link.download = 'localapply-compatible-v3.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  // 悬浮卡片绑定原文档，切标签保留扫描与草稿；旧侧栏跟随活动标签，换档案仍须清空。
  function clear() { void stopFill();generation++; document.dispatchEvent(new Event('localapply:learning-reset')); current = null; needsSessionRefresh = false; aiPreview = null; fillIds = []; selectionInitialized = false; selected.clear(); aiSelected.clear(); drafts.clear(); learningSelected.clear(); manualFields.clear(); webValues.clear(); cancelLearningPreview(); cancelOverwrite(); if ($('smartPageConsent')) $('smartPageConsent').checked = false; $('smartAIReview').hidden = true; if ($('smartFillReview')) $('smartFillReview').hidden = true; render(); $('smartStatus').textContent = directFill ? '点击自动填写，使用当前档案匹配网页字段' : '请选择当前招聘页并主动授权扫描'; }
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
  // 后台观察不续权；会话丢失只标记待主动恢复，保留用户正在处理的DOM与勾选。
  setInterval(async () => {
    if (!current || needsSessionRefresh || busy || polling || !pageActive || document.hidden || $('tab-smart').hidden || document.querySelector('.smart-editor[open]') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    const id = current.sessionId; const startedActivity = activity; polling = true;
    try {
      const view = await request('session', {}, false);
      if (current?.sessionId === id && startedActivity === activity && !busy && !document.querySelector('.smart-editor[open]') && (view.revision !== current.revision || JSON.stringify(view.rows.map((row) => [row.field, directFill && row.webFilled, row.status])) !== JSON.stringify(current.rows.map((row) => [row.field, directFill && row.webFilled, row.status])))) update(view);
    } catch (error) { if (current?.sessionId === id && startedActivity === activity && !busy) { if (canReconnect(error)) retainResults(); else { $('smartStatus').textContent = error.message; $('smartStatus').className = 'err'; } } }
    finally { polling = false; }
  }, 2000);
})();
