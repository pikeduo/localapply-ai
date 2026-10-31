// 阶段三后台服务：网页授权、字段建议、差异确认、验证填写及本地规则记忆。
(function (global) {
  'use strict';
  const M = global.FieldMatchingEngine;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  // 依赖通过参数传入，测试使用本地 Mock；浏览器中始终复用唯一 repository/AI 客户端。
  function create(repository, ai, browser) {
    const sessions = new Map(); const queues = new Map(); const aiJobs = new Map(); let undo = null;
    const records = global.LocalApplyRecordCoordinator.create({ refresh, session, pageMessage, alive:(item)=>sessions.get(item.sessionId)===item });
    // 生产仓库提供按档案索引的只读上下文；旧测试/兼容仓库仍可使用原完整读取接口。
    function fieldContext(profileId) { return repository.readFieldContext ? repository.readFieldContext(profileId) : repository.read(); }
    // 取消先使本地任务失效，再通知原文档终止等待；通道已关闭不触发重试或重新注入。
    async function stop(item, job) {
      if (!job) return; job.controller.abort();
      await browser.tabs.sendMessage(item.tabId,{type:'learning:cancelFill',documentId:item.documentId,operationId:job.id}).catch(()=>{});
    }
    // 页面退出时终止模型和所有批次/单项，丢弃预览；不删除资料、规则或网页已填内容。
    async function drop(id) {
      const item=sessions.get(id);aiJobs.get(id)?.abort();sessions.delete(id);
      if(item)await Promise.all([item.batch,...(item.jobs?.values()||[])].filter(Boolean).map((job)=>stop(item,job)));
    }
    // 顶层导航/关闭绑定页面时，终止该页所有扫描会话；其他页面资料不受影响。
    function invalidate(tabId) { for (const [id, item] of sessions) if (item.tabId === tabId) void drop(id); }
    // 外部切档案也立即撤销旧来源的进行中操作，不能等待下一次点击才发现变化。
    function profileChanged(profileId) { for(const [id,item]of sessions)if(item.profileId!==profileId)void drop(id); }
    // 批次只保存版本、数量和取消信号；不持有整份意图/计划或个人值。
    function jobFor(item, db, batchId) {
      const batched=batchId!==undefined;
      const job=batched?item.batch:{id:'operation.'+crypto.randomUUID(),controller:new AbortController(),revision:db.revision,budget:{added:0},implicit:true};
      check(job && (!batched || typeof batchId==='string'&&job.id===batchId),'填写批次已结束或不属于当前会话');
      if(job.implicit){item.jobs ||= new Map();item.jobs.set(job.id,job);}
      return {id:job.id,budget:job.budget,signal:job.controller.signal,
        // 每次等待后核对会话和来源版本，取消后不能发布晚到成功或继续下一项。
        check(){check(sessions.get(item.sessionId)===item&&!job.controller.signal.aborted,'已取消填写或页面会话已过期/关闭');check(job.revision===db.revision,'资料已变化，请重新扫描并开始填写');},
        // 仅本批用户确认的规则写入可推进版本；外部修改仍使下一项失效。
        advance(revision){job.revision=revision;},
        // 单项无 UI 批次时也参与关闭/导航取消，完成后立即释放。
        done(){if(job.implicit)item.jobs.delete(job.id);}
      };
    }
    // 可读错误不包含模型原文、凭据或网页值。
    function check(ok, message) { if (!ok) throw new Error(message); }
    // 标准内容脚本缺失时只注入当前已授权页面，不跨标签页广播个人资料。
    async function pageMessage(tabId, message, inject = false) {
      let response;
      try { response = await browser.tabs.sendMessage(tabId, message); }
      catch (error) {
        if (!inject) throw new Error('页面未连接，请重新授权扫描');
        await browser.scripting.executeScript({ target: { tabId }, files: ['data/templates.js', 'data/field-matching.js', 'data/value-resolver.js', 'data/fill-contract.js', 'data/fill-result.js', 'data/applications.js', 'content/atsx-controls.js', 'content/field-adapters.js', 'content/field-scanner.js', 'content/fill-session.js', 'content/detector.js', 'content/filler.js', 'content/controls/verification.js', 'content/controls/text.js', 'content/controls/native.js', 'content/controls/date-phone.js', 'content/controls/dropdown.js', 'content/controls/address.js', 'content/controls/registry.js', 'content/verified-fill.js', 'content/page-presence.js', 'content/job-recognizer.js', 'content/floatbar.js'] });
        response = await browser.tabs.sendMessage(tabId, message);
      }
      check(response?.ok, response?.error || '页面操作失败'); return response;
    }
    // 只为当前档案建立来源目录，真实值留在后台/可信侧栏，不发给模型。
    function sources(db, profileId) {
      const rows = db.fieldValues.filter((row) => row.profileId === profileId);
      for (const binding of db.bindings.filter((row) => row.profileId === profileId)) if (!rows.some((row) => row.fieldId === binding.fieldId && row.entryId === null)) rows.push({ profileId, fieldId: binding.fieldId, entryId: null, value: null });
      return rows.map((row, index) => {
        const def = db.fieldDefinitions.find((item) => item.fieldId === row.fieldId);
        const entry = db.entries.find((item) => item.entryId === row.entryId);
        return { ref: 'source.' + index, fieldId: row.fieldId, entryId: row.entryId, value: row.value,
          label: def.label + (entry ? ' · ' + (global.WangshenTemplates.RECORD_GROUPS[entry.kind] || '记录') + '第' + (entry.order + 1) + '条' : ''),
          kind: entry?.kind || '', hasValue: M.hasValue(row.value) };
      });
    }
    // 区分内存扫描会话丢失与实际页面变化，可信界面可在用户下次操作时重新扫描。
    async function session(id) {
      const item = sessions.get(id);
      if (item && Date.now() - item.createdAt >= 1800000) void drop(id);
      if (!sessions.has(id)) { const error = new Error('扫描会话已过期或页面已导航/关闭，请重新授权扫描'); error.code = 'learning_session_unavailable'; throw error; }
      const tab = await browser.tabs.get(item.tabId);
      if (tab.url !== item.url) { void drop(id); throw new Error('页面已导航，请重新授权扫描'); }
      const db = await fieldContext(item.profileId); check(db.profiles.some((profile) => profile.profileId === item.profileId), '档案已删除');
      check(db.activeProfileId === item.profileId, '活动档案已变化，请重新授权扫描');
      return { item, db };
    }
    // 规则写入不会清掉同批次其他已确认来源；值或规则目标改变则丢弃旧确认/验证。
    function rebuild(item, db, fields = item.fields) {
      const old = item.rows || [];
      const oldSources = item.sources || [];
      // 来源只取已校验网页记录和会话绑定；人工改配须经独立覆盖预览，AI不能决定配对。
      const bindings = {};
      for (const block of item.recordBlocks || []) for (const record of block.records) if (Object.hasOwn(item.recordBindings || {}, record.recordId)) {
        for (const scanId of record.scanIds) bindings[scanId] = { kind:block.kind, entryId:item.recordBindings[record.recordId] };
      }
      item.fields = fields; item.rows = M.match(db, item.profileId, item.origin, fields, bindings);
      for (const row of item.rows) {
        // 自动增补只绑定到本次明确分配的整条记录，绝不改变同站已验证的映射优先级。
        const assigned = item.recordTargets?.[row.field.scanId]; const assignedTarget = assigned && { fieldId: assigned.fieldId, entryId: assigned.entryId };
        if (assigned?.semanticId === row.field.semanticId && row.source !== 'memory' && db.publicFieldIds.includes(assigned.fieldId)) Object.assign(row, { target: assignedTarget, candidates: [assignedTarget], source: 'record', reason: '当前简历的整条经历已绑定此网页记录，只填写空白项', status: M.hasValue(M.valueOf(db, item.profileId, assignedTarget)?.value) ? 'matched' : 'missing_value' });
        const previous = old.find((value) => value.field.scanId === row.field.scanId && value.field.semanticId === row.field.semanticId);
        if (previous) { row.webFilled = previous.webFilled === true; row.webOccupied = previous.webOccupied === true; }
        if (previous?.ignored) row.ignored = true;
        const source = previous?.target && item.sources?.find((source) => source.fieldId === previous.target.fieldId && source.entryId === previous.target.entryId);
        const sameTarget = JSON.stringify(row.target) === JSON.stringify(previous?.target);
        const unchanged = source && JSON.stringify(source.value) === JSON.stringify(M.valueOf(db, item.profileId, previous.target)?.value)
          && (previous.source !== 'memory' || row.source === 'memory') && (row.source !== 'memory' || (sameTarget && row.status !== 'needs_confirmation'));
        const compatible = previous?.source !== 'memory' || previous.memoryMatch !== 'semantic' || row.source === 'memory' && row.confirmed && sameTarget;
        if (previous?.chosen && compatible && (item.revision === db.revision || unchanged)) {
          // 只有已确认且同目标的记忆能接续状态；保守建议不得吞掉用户本次手选或冒称验证成功。
          const remembered = row.source === 'memory' && row.confirmed && sameTarget;
          const memoryReason = previous.verification ? row.memoryMatch === 'semantic' ? '当前控件填写已验证，尚未保存此控件变体' : '填写已验证，已记住本地网站映射' : row.reason;
          Object.assign(row, { target: previous.target, chosen: true, status: previous.status, reason: remembered ? memoryReason : previous.reason, source: remembered ? 'memory' : previous.source });
          if (previous.verification) row.verification = previous.verification;
          if (previous.conflict) row.conflict = previous.conflict;
          if (previous.diagnostic) row.diagnostic = previous.diagnostic;
        }
        if (previous?.suggestion && !row.target) {
          const suggestion = previous.suggestion;
          const source = oldSources.find((source) => source.ref === suggestion.sourceRef);
          const latest = source && sources(db, item.profileId).find((value) => value.fieldId === source.fieldId && value.entryId === source.entryId && JSON.stringify(value.value) === JSON.stringify(source.value));
          if ((!suggestion.existingFieldId || db.fieldDefinitions.some((def) => def.fieldId === suggestion.existingFieldId)) && (suggestion.sourceRef === null || latest)) row.suggestion = { ...suggestion, sourceRef: latest?.ref || null };
        }
        // 已知字段与经历配对分开标记；不能把来源待确认伪装成未知语义再交给AI猜配。
        if (item.protectedRecords?.has(row.field.scanId) && !row.chosen && row.source !== 'memory' && (row.target || row.source === 'context' && row.candidates.length)) Object.assign(row, { target: null, recordBindingRequired: true, status: 'needs_confirmation', reason: '已识别字段含义，但网页已有经历尚未配对；请在“覆盖网页已填内容”中核对整条来源及补填范围' });
      }
      item.revision = db.revision; item.sources = sources(db, item.profileId);
    }
    // 仅可信 UI 接收个人值预览；字段元数据不夹带 HTML 或网页其他输入值。
    function view(item, db) {
      return { sessionId: item.sessionId, origin: item.origin, profileId: item.profileId, revision: db.revision, notice: [item.notice, item.recordNotice].filter(Boolean).join('；'),
        rows: item.rows.map((row) => ({ ...row, value: row.target ? M.valueOf(db, item.profileId, row.target)?.value ?? null : null })),
        sources: item.sources, entries: db.entries.filter((entry) => entry.profileId === item.profileId).map(({ entryId, kind, order }) => ({ entryId, kind, order })),
        definitions: db.fieldDefinitions.filter((def) => item.sources.some((source) => source.fieldId === def.fieldId)),
        excluded: item.excluded || [], canUndo: !!undo };
    }
    // 完成/占用只接受当前项布尔标记；兼容旧快照，但禁止将实际值或矛盾标记带入会话。
    function completion(item, snapshot) {
      const rows = snapshot.completion || [];
      check(Array.isArray(rows) && rows.length <= item.rows.length && rows.every((row) => row && ['present,scanId', 'occupied,present,scanId'].includes(Object.keys(row).sort().join()) && typeof row.present === 'boolean' && (!Object.hasOwn(row, 'occupied') || typeof row.occupied === 'boolean' && (row.occupied || !row.present)) && item.rows.some((item) => item.field.scanId === row.scanId)) && new Set(rows.map((row) => row.scanId)).size === rows.length, '网页完成状态格式错误');
      for (const row of item.rows) {
        const state = rows.find((item) => item.scanId === row.field.scanId); row.webFilled = state?.present === true; row.webOccupied = state?.occupied ?? state?.present === true;
        if (state?.present === false && row.status === 'success' && !(row.field.type === 'checkbox' && row.verification?.value === false)) { row.status = 'matched'; row.reason = '网页内容已清空，可以重新填写'; delete row.verification; }
      }
      // 重复模块只接受本次扫描字段的引用，不接收网页值或任意按钮选择器。
      const blocks = snapshot.recordBlocks || []; const ids = new Set(); const referenced = new Set();
      check(Array.isArray(blocks) && blocks.length <= 20, '网页经历结构格式错误');
      for (const block of blocks) {
        check(block && Object.keys(block).sort().join() === 'blockId,canAdd,kind,records' && /^scan\.[\w.-]{1,100}$/.test(block.blockId) && !ids.has(block.blockId) && Object.hasOwn(global.WangshenTemplates.RECORD_GROUPS, block.kind) && typeof block.canAdd === 'boolean' && Array.isArray(block.records) && block.records.length <= 20, '网页经历结构格式错误'); ids.add(block.blockId);
        for (const record of block.records) {
          check(record && Object.keys(record).sort().join() === 'recordId,scanIds' && /^scan\.[\w.-]{1,100}$/.test(record.recordId) && !ids.has(record.recordId) && Array.isArray(record.scanIds) && record.scanIds.length <= 100 && new Set(record.scanIds).size === record.scanIds.length && record.scanIds.every((scanId) => !referenced.has(scanId) && item.rows.some((row) => row.field.scanId === scanId && row.field.kind === block.kind)), '网页经历结构格式错误'); ids.add(record.recordId); record.scanIds.forEach((scanId) => referenced.add(scanId));
        }
      }
      item.recordBlocks = blocks;
    }

    // 经独立协调器绑定整条来源；控件适配器只执行一个字段，不负责添加或分配记录。
    async function prepareRecords(item, db, task) {
      const { added, protectedGroups, remaining } = await records.prepare(item, db, task);
      item.recordNotice = `已补充 ${added} 条网页经历${protectedGroups ? `；${protectedGroups} 个模块已有未绑定内容，保留原记录；请在“覆盖网页已填内容”中配对经历并核对补填或覆盖范围` : ''}${remaining ? `；没有更多可用槽位或已达到本次添加上限，另有 ${remaining} 条经历尚未分配，请检查网页后继续` : ''}`;
      rebuild(item, db); return view(item, db);
    }
    // 再扫描只读取已经授权的同一文档，动态新增时清理旧建议/确认令牌。
    async function refresh(item, db) {
      const response = await pageMessage(item.tabId, { type: 'learning:scan', authorize: false });
      check(response.snapshot.documentId === item.documentId, '页面已刷新，请重新授权扫描');
      response.snapshot.fields.forEach(M.validateField);
      // 新增记录会改变字段集合；保留稳定字段的人工来源与验证，仅清除依赖旧扫描的 AI 建议和确认令牌。
      if (JSON.stringify(response.snapshot.fields) !== JSON.stringify(item.fields)) { item.rows.forEach((row) => { delete row.suggestion; }); item.aiPreview = null; item.valuePreview = null; }
      rebuild(item, db, response.snapshot.fields); completion(item, response.snapshot);
      // 容器重排/成员移动后按刚校验的 recordId 重新查询语义，不能沿用上一次分组配对。
      if (item.recordBindings) { records.synchronize(item,db); rebuild(item,db); }
      item.excluded = response.snapshot.excluded || []; item.dirty = false;
    }
    // 选择仅允许本档案来源，不能通过 AI/页面提供的 ID 读取其他人的值。
    function target(item, fieldId, entryId) {
      const found = item.sources.find((source) => source.fieldId === fieldId && source.entryId === (entryId || null));
      check(found, '请选择当前档案已有的字段来源'); return { fieldId, entryId: entryId || null };
    }
    // 覆盖预览只展示本地经历摘要；未绑定的网页记录须由用户明确配对，不按序号猜测。
    function overwriteRecords(item, db) {
      const T = global.WangshenTemplates; const primary = { education:'school', employment:'employmentCompany', internship:'internshipCompany', project:'projectName' };
      return (item.recordBlocks || []).flatMap((block) => {
        const options = [null, ...db.entries.filter((entry) => entry.profileId === item.profileId && entry.kind === block.kind).sort((a,b) => a.order-b.order).map((entry) => entry.entryId)]
          .filter((entryId) => item.sources.some((source) => source.entryId === entryId && source.hasValue && T.recordKind(db.fieldDefinitions.find((def) => def.fieldId === source.fieldId)?.group || '') === block.kind))
          .map((entryId, index) => ({ entryId, label: `${T.RECORD_GROUPS[block.kind]} · ${String(M.valueOf(db,item.profileId,{fieldId:'builtin.'+primary[block.kind],entryId})?.value || db.entries.find((entry)=>entry.entryId===entryId)?.title || '本地记录'+(index+1)).slice(0,100)}` }));
        return options.length ? block.records.map((record,index) => ({ recordId:record.recordId, label:`网页${T.RECORD_GROUPS[block.kind]}第${index+1}条`, options,
          ...(Object.hasOwn(item.recordBindings || {}, record.recordId) ? { entryId:item.recordBindings[record.recordId] } : {}) })) : [];
      });
    }
    // 在独立会话副本中预演记录配对，预览/取消均不改变原匹配、网页或数据库。
    function overwriteProjection(item, db, bindings) {
      check(Array.isArray(bindings) && bindings.length <= 400 && new Set(bindings.map((row)=>row?.recordId)).size === bindings.length, '覆盖经历对应关系格式错误');
      const staged = { ...item, recordBindings:{}, protectedRecords:new Set() }; const changed = new Set(); const available=new Map(overwriteRecords(item,db).map((row)=>[row.recordId,row]));
      for (const binding of bindings) {
        check(binding && Object.keys(binding).sort().join() === 'entryId,recordId' && (binding.entryId === null || typeof binding.entryId === 'string'), '覆盖经历对应关系格式错误');
        const block = item.recordBlocks.find((block)=>block.records.some((record)=>record.recordId===binding.recordId)); const record = block?.records.find((record)=>record.recordId===binding.recordId);
        check(record && available.get(record.recordId)?.options.some((option)=>option.entryId===binding.entryId), '覆盖来源不属于当前经历');
        check(record.scanIds.every((id)=>M.sourceRole(db,item.profileId,{entryId:binding.entryId},item.fields.find((field)=>field.scanId===id)?.degree || '')), '覆盖经历不符合网页要求的学历');
        check(!block.records.some((row)=>row.recordId!==record.recordId && Object.hasOwn(staged.recordBindings,row.recordId) && staged.recordBindings[row.recordId]===binding.entryId), '同一模块不能重复使用同一条本地经历');
        staged.recordBindings[record.recordId] = binding.entryId;
        if (!Object.hasOwn(item.recordBindings || {},record.recordId) || item.recordBindings[record.recordId]!==binding.entryId) record.scanIds.forEach((id)=>changed.add(id));
      }
      staged.rows = item.rows.filter((row)=>!changed.has(row.field.scanId)); records.synchronize(staged,db); rebuild(staged,db);
      staged.rows = staged.rows.filter((row)=> {
        const previous=item.rows.find((value)=>value.field.scanId===row.field.scanId); if(previous?.ignored || !row.target || !M.hasValue(M.valueOf(db,item.profileId,row.target)?.value)) return false;
        if (!['matched','success'].includes(row.status) && !row.chosen) return false;
        const record=item.recordBlocks.flatMap((block)=>block.records).find((record)=>record.scanIds.includes(row.field.scanId));
        if (row.field.kind && (!record || !Object.hasOwn(staged.recordBindings,record.recordId) || row.target.entryId!==staged.recordBindings[record.recordId])) return false;
        return M.sourceRole(db,item.profileId,row.target,row.field.degree || '');
      });
      return staged;
    }
    // 同一记录的年月范围只调整已勾选两端的执行顺序，保证中间范围有效，不临时清空对侧。
    function overwriteOrder(item, changes) {
      const ordered=[...changes]; const pairs={education:['educationStartDate','graduationDate'],employment:['employmentStartDate','employmentEndDate'],internship:['internshipStartDate','internshipEndDate'],project:['projectStartDate','projectEndDate']};
      // 仅比较明确年月投影；精度不足或未知格式仍交给原控件校验，不能补全日期。
      const month=(value)=>typeof value==='string' && /^\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?$/.test(value)?value.slice(0,7):null;
      for(const block of item.recordBlocks || []) for(const record of block.records) {
        const pair=pairs[block.kind]; if(!pair)continue;
        const ends=pair.map((key)=>ordered.filter((change)=>record.scanIds.includes(change.scanId) && change.target.fieldId==='builtin.'+key && item.fields.some((field)=>field.scanId===change.scanId && field.type==='month' && field.layout==='date:year-month')));
        if(ends.some((rows)=>rows.length!==1))continue;
        const [start,end]=ends.map((rows)=>rows[0]); const [oldStart,oldEnd,nextStart,nextEnd]=[start.before,end.before,start.after,end.after].map(month);
        if(!oldStart || !oldEnd || !nextStart || !nextEnd)continue;
        check(nextStart<=nextEnd, '本地起止年月范围无效，请先修正资料');
        const startFirst=nextStart<=oldEnd; const endFirst=nextEnd>=oldStart;
        check(startFirst || endFirst, '起止年月无法安全逐项覆盖，请在网页手动调整范围');
        const [first,last]=startFirst?[start,end]:[end,start];
        if(ordered.indexOf(first)>ordered.indexOf(last)) { ordered.splice(ordered.indexOf(first),1); ordered.splice(ordered.indexOf(last),0,first); }
      }
      return ordered;
    }
    // AI只推荐字段语义；已绑定经历决定实际来源，模型引用不能改配或阻止正确的本地配对。
    function suggestedSource(item, db, row) {
      const suggestion = row.suggestion;
      check(!row.ignored && !row.target && suggestion?.existingFieldId && !suggestion.definition && !['skip_non_resume_control', 'needs_user_choice'].includes(suggestion.action), '此建议没有可填写的已有字段，请在网页手动填写');
      const def = db.fieldDefinitions.find((def) => def.fieldId === suggestion.existingFieldId);
      const kind = global.WangshenTemplates.recordKind(def?.group || '');
      check(!row.field.kind || !kind || row.field.kind === kind, 'AI建议的经历分类不一致，请在网页手动填写');
      let choices = item.sources.filter((source) => source.fieldId === suggestion.existingFieldId);
      const block = (item.recordBlocks || []).find((block) => block.records.some((record) => record.scanIds.includes(row.field.scanId)));
      const record = block?.records.find((record) => record.scanIds.includes(row.field.scanId));
      const bound = !!(kind && record && Object.hasOwn(item.recordBindings || {}, record.recordId));
      if (bound) choices = choices.filter((source) => source.entryId === item.recordBindings[record.recordId]);
      else if (kind) {
        const localEntries = [null, ...db.entries.filter((entry) => entry.profileId === item.profileId && entry.kind === kind).map((entry) => entry.entryId)]
          .filter((entryId) => db.fieldValues.some((value) => value.profileId === item.profileId && value.entryId === entryId && M.hasValue(value.value) && global.WangshenTemplates.recordKind(db.fieldDefinitions.find((def) => def.fieldId === value.fieldId)?.group || '') === kind));
        check(localEntries.length <= 1 && (!block || block.records.length === 1) && !record?.scanIds.some((id) => item.rows.find((row) => row.field.scanId === id)?.webOccupied), '多段或已填写经历尚未绑定，AI不能代替选择对应记录，请在网页手动填写');
        // 唯一经历仍须预览确认，空首条模板不能制造重复来源，也不能替缺值记录借用内容。
        if (localEntries.length === 1) choices = choices.filter((source) => source.entryId === localEntries[0]);
      }
      // 即使模型只返回一个sourceRef，也不能将未绑定的多段来源冒充唯一来源。
      check(choices.length === 1, 'AI建议的资料来源不唯一，请在网页手动填写');
      // sourceRef已校验为同字段引用；有独立记录绑定时只取该条，未绑定时仍须一致且唯一。
      const source = choices[0]; check(bound || !suggestion.sourceRef || source.ref === suggestion.sourceRef, 'AI建议与当前资料来源不一致，请重新识别');
      check(M.sourceRole(db, item.profileId, source, row.field.degree || ''), 'AI建议的学历来源与网页要求不符，请在网页手动填写');
      check(source.hasValue, '本地没有该字段的内容，请在网页手动填写；AI不会编造个人资料');
      const rule = db.mappingRules.find((rule) => rule.profileId === item.profileId && rule.origin === item.origin && rule.semanticId === row.field.semanticId && rule.features && JSON.stringify(M.features(rule.features)) === JSON.stringify(M.features(row.field)));
      check(!rule || rule.enabled !== false, '此网站规则已禁用，请先在规则管理中处理');
      return source;
    }
    // 选中网页字段必须来自本次扫描，认证/条款状态不能被人工映射绕过。
    function rowOf(item, scanId) {
      const row = item.rows.find((row) => row.field.scanId === scanId); check(row && !M.restricted(row.field), '网页字段不在授权扫描范围内'); return row;
    }
    // API 配置摘要只存内存；发送前后均核对，不把预览授权套用到另一端点/Key。
    async function aiContext(settings) {
      const provider = global.LocalApplyProviders.resolve(settings);
      const bytes = new TextEncoder().encode(JSON.stringify([provider.providerId, provider.baseUrl, provider.protocol, settings.model, settings.apiKeys?.[provider.providerId] || '']));
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    // 规则写入的撤销点必须包含全部档案规则，不能用局部匹配投影覆盖其他档案。
    async function ruleCommand(db, action, payload, task) {
      const complete = await repository.read(); check(complete.revision === db.revision, '规则或资料已变化，请重新预览');
      task?.check();
      const before = clone(complete.mappingRules);
      const result = await repository.command({ action, payload, expectedRevision: db.revision });
      undo = { before, revision: result.revision }; return result;
    }
    // 仅主动勾选的字段进入学习；读取并跨延迟验证真实网页值，不接收 UI 提供的答案或控件脚本。
    async function learningItem(item, db, row, task) {
      check(!row.ignored, '已忽略字段不能保存');
      const message = { documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId };
      const response = await pageMessage(item.tabId, { type: 'learning:read', ...message }); task.check();
      const raw = response.value; check(M.hasValue(raw) || raw === false, '请先在网页填写已勾选字段');
      const verified = await pageMessage(item.tabId, { type: 'learning:verify', ...message, value: raw, operationId: task.id }); task.check();
      check(verified.result?.status === 'success' && verified.result.verifiedAt, '网页字段尚未稳定或控件不支持验证，请在网页确认后重试');
      let selected = row.target;
      if (!selected && row.suggestion?.existingFieldId) {
        const choices = item.sources.filter((source) => source.fieldId === row.suggestion.existingFieldId && (!row.suggestion.sourceRef || source.ref === row.suggestion.sourceRef));
        check(choices.length === 1, 'AI 建议的资料来源不唯一，未自动选择经历');
        selected = { fieldId: choices[0].fieldId, entryId: choices[0].entryId };
      }
      // 歧义来源不得静默落入新字段或第一段经历；已有确定匹配可直接复用，不展示本地选择器。
      check(selected || !row.candidates?.length, '字段来源存在歧义，暂不支持集中保存此项');
      let entryId = selected?.entryId || null;
      if (!selected && row.field.kind) {
        const record = (item.recordBlocks || []).flatMap((block) => block.records).find((record) => record.scanIds.includes(row.field.scanId));
        check(record && Object.hasOwn(item.recordBindings || {}, record.recordId), '此经历尚未绑定，暂不支持集中保存，避免混入其他记录');
        entryId = item.recordBindings[record.recordId];
      }
      const options = [...new Set(row.field.options.filter((option) => option.value !== '').map((option) => option.text).filter(Boolean))];
      const type = Array.isArray(raw) ? 'multiSelect' : typeof raw === 'boolean' ? 'boolean' : row.field.type === 'number' ? 'number'
        : ['date', 'month'].includes(row.field.type) ? 'date' : ['select', 'radio', 'combobox'].includes(row.field.type) ? 'select' : ['textarea', 'contenteditable'].includes(row.field.type) ? 'textarea' : 'text';
      const definition = selected ? null : { label: row.field.label, type, group: row.field.group || '其他', aliases: [], options: ['select', 'multiSelect'].includes(type) ? options : [] };
      if (definition) {
        global.FieldSuggestions.validate({ suggestions: [{ scanId: row.field.scanId, existingFieldId: null, definition, sourceRef: null, confidence: 0 }] }, { fields: [row.field], catalog: [], sources: [] });
        const normalize = global.WangshenTemplates.normalizeLabel;
        check(!db.fieldDefinitions.some((def) => item.sources.some((source) => source.fieldId === def.fieldId) && [def.label, ...def.aliases].some((label) => normalize(label) === normalize(definition.label))), '同名字段已存在但来源不确定，未创建重复字段');
      }
      const valueType = definition?.type || db.fieldDefinitions.find((def) => def.fieldId === selected.fieldId).type;
      // 原生控件编码转为唯一显示标签；不猜选、不把搜索词当成已选择结果。
      const labelOf = (value) => { const found = row.field.options.filter((option) => option.value === String(value) || option.text === String(value)); check(found.length <= 1, '选项编码或标签存在歧义'); return found[0]?.text || value; };
      let value = valueType === 'multiSelect' ? (Array.isArray(raw) ? raw.map(labelOf) : null) : valueType === 'select' ? labelOf(raw) : valueType === 'number' ? Number(raw) : raw;
      check(value !== null && (valueType !== 'number' || Number.isFinite(value)), '网页值与字段类型不兼容');
      const old = db.mappingRules.find((rule) => rule.profileId === item.profileId && rule.origin === item.origin && rule.semanticId === row.field.semanticId && rule.features && JSON.stringify(M.features(rule.features)) === JSON.stringify(M.features(row.field)));
      check(!old || old.enabled !== false, '此网站规则已禁用，请先在规则管理中处理');
      return { scanId: row.field.scanId, raw, definition, fieldId: selected?.fieldId || null, entryId, value,
        mapping: { mappingId: old?.mappingId || 'mapping.' + crypto.randomUUID(), origin: item.origin, path: '/', label: row.field.label, semanticId: row.field.semanticId, features: M.features(row.field), confirmed: true, enabled: true, lastVerifiedAt: verified.result.verifiedAt, ruleVersion: (old?.ruleVersion || 0) + 1 } };
    }
    // 后台统一校验会话和确认；填写意图只由规范库生成，不接受 UI/AI 提供计划或值。
    async function handle(msg, access) {
      if (msg.type === 'learning:scanPage') {
        check(msg.confirmed === true && Number.isInteger(msg.tabId), '扫描前须明确授权当前页面');
        const tab = await browser.tabs.get(msg.tabId); check(/^https?:\/\//.test(tab.url || ''), '只能扫描用户授权的普通招聘网页');
        const db = await fieldContext(msg.profileId); const profileId = msg.profileId || db.activeProfileId;
        check(db.profiles.some((profile) => profile.profileId === profileId), '档案不存在');
        for (const [id, previous] of sessions) if (previous.tabId === msg.tabId || sessions.size >= 8) await drop(id);
        const response = await pageMessage(msg.tabId, { type: 'learning:scan', authorize: true, expectedUrl: tab.url }, true);
        const snapshot = response.snapshot; check(snapshot.origin === new URL(tab.url).origin && snapshot.fields.length <= 500, '页面来源或字段数量错误');
        if(access)check(snapshot.documentId===access.documentId,'不能沿用其他页面的悬浮会话');
        snapshot.fields.forEach(M.validateField);
        const item = { sessionId: crypto.randomUUID(), createdAt: Date.now(), tabId: msg.tabId, url: tab.url, origin: snapshot.origin,
          fillSessionVersion:snapshot.fillSessionVersion,
          documentId: snapshot.documentId, fillContractVersion: snapshot.fillContractVersion, profileId, fields: snapshot.fields, excluded: snapshot.excluded || [], notice: snapshot.notice || '' };
        rebuild(item, db); completion(item, snapshot); sessions.set(item.sessionId, item); return view(item, db);
      }
      if (msg.type === 'learning:rules') { const db = await repository.read(); return { rules: db.mappingRules, scopes:global.LocalApplyMappingCompat?.scopes(db) || [], definitions: db.fieldDefinitions, profiles: db.profiles, entries: db.entries, revision: db.revision, canUndo: !!undo }; }
      if (msg.type === 'learning:exportV3') { const backup = await repository.exportBackup(3); backup.database.mappingRules = backup.database.mappingRules.map(({ mappingId, origin, path, label, fieldId, profileId, entryId }) => ({ mappingId, origin, path, label, fieldId, profileId, entryId })); return { backup }; }
      if (['learning:editRule', 'learning:deleteRule', 'learning:undoRule'].includes(msg.type)) {
        check(msg.confirmed === true, '规则操作需要明确确认'); const db = await repository.read(); check(msg.revision === db.revision, '规则或资料已变化，请重新预览');
        if (msg.type === 'learning:undoRule') { check(undo?.revision === db.revision, '撤销点已过期，请刷新规则'); const previous = undo; await repository.command({ action: 'restoreMappings', payload: { rules: previous.before, confirmed: true }, expectedRevision: db.revision }); undo = null; }
        else if (msg.type === 'learning:deleteRule') await ruleCommand(db, 'deleteMapping', { mappingId: msg.mappingId, confirmed: true });
        else {
          const rule = db.mappingRules.find((row) => row.mappingId === msg.mappingId); check(rule?.semanticId, '旧规则须重新确认学习');
          check(typeof msg.enabled === 'boolean', '规则开关格式错误');
          const available = sources(db, rule.profileId); check(available.some((row) => row.fieldId === msg.fieldId && row.entryId === (msg.entryId || null)), '规则目标不属于该档案');
          const changed = rule.fieldId !== msg.fieldId || rule.entryId !== (msg.entryId || null);
          await ruleCommand(db, 'saveMapping', { ...rule, fieldId: msg.fieldId, entryId: msg.entryId || null, enabled: msg.enabled,
            confirmed: changed ? false : rule.confirmed, lastVerifiedAt: changed ? null : rule.lastVerifiedAt, ruleVersion: rule.ruleVersion + 1 });
        }
        return { done: true };
      }
      const { item, db } = await session(msg.sessionId);
      if(msg.type==='learning:beginFill'){
        check(msg.confirmed===true&&item.revision===db.revision,'须先扫描当前资料并确认填写');check(!item.batch,'当前已有填写批次，请先停止');
        check(item.fillSessionVersion===1,'页面尚未加载批次取消组件，请刷新招聘页后重新扫描');
        item.batch={id:'operation.'+crypto.randomUUID(),controller:new AbortController(),revision:db.revision,budget:{added:0}};return {batchId:item.batch.id};
      }
      if(msg.type==='learning:leaseFill'){check(typeof msg.batchId==='string'&&item.batch?.id===msg.batchId,'填写连接尚未绑定批次');const task=jobFor(item,db,msg.batchId);try{task.check();return {leased:true};}finally{task.done();}}
      if (msg.type === 'learning:revoke') { await drop(item.sessionId); await pageMessage(item.tabId, { type: 'learning:revoke' }); return {}; }
      if (msg.type === 'learning:session') { await refresh(item, db); return view(item, db); }
      if (msg.type === 'learning:cancelLearnedFields') { item.learnPreview = null; return { cancelled: true }; }
      if (msg.type === 'learning:cancelOverwrite') { item.overwritePreview = null; return { cancelled:true }; }
      check(item.revision === db.revision, '资料已变化，请重新扫描并预览');
      if (['learning:overwriteContext','learning:previewOverwrite','learning:confirmOverwrite'].includes(msg.type)) {
        check(!item.batch && !item.jobs?.size, '请先等待填写结束');
        const task=jobFor(item,db);
        try {
          await refresh(item,db); task.check();
          if(msg.type==='learning:overwriteContext') { item.overwritePreview=null; return { records:overwriteRecords(item,db) }; }
          if(msg.type==='learning:previewOverwrite') {
            item.overwritePreview=null; const staged=overwriteProjection(item,db,msg.bindings || []); const changes=[];
            for(const row of staged.rows) {
              const {value:before}=await pageMessage(item.tabId,{type:'learning:read',documentId:item.documentId,scanId:row.field.scanId,semanticId:row.field.semanticId}); task.check();
              const after=M.valueOf(db,item.profileId,row.target).value;
              // 空白项也进入明确勾选范围，让网站解析后的缺项可随经历配对补齐；无法回读仍跳过。
              if(before===null || before===undefined || JSON.stringify(before)===JSON.stringify(after)) continue;
              const block=item.recordBlocks.find((block)=>block.records.some((record)=>record.scanIds.includes(row.field.scanId)));
              const recordLabel=block?`网页${global.WangshenTemplates.RECORD_GROUPS[block.kind]}第${block.records.findIndex((record)=>record.scanIds.includes(row.field.scanId))+1}条`:'';
              changes.push({scanId:row.field.scanId,semanticId:row.field.semanticId,label:row.field.label,group:row.field.group,recordLabel,target:clone(row.target),before:clone(before),after:clone(after)});
            }
            item.overwritePreview={token:crypto.randomUUID(),revision:db.revision,createdAt:Date.now(),structure:JSON.stringify([item.fields,item.recordBlocks]),bindings:clone(msg.bindings || []),changes};
            return {token:item.overwritePreview.token,changes:changes.map(({semanticId,target,...change})=>change)};
          }
          const preview=item.overwritePreview; item.overwritePreview=null;
          check(msg.confirmed===true && preview?.token===msg.token && preview.revision===db.revision && Date.now()-preview.createdAt<300000 && preview.structure===JSON.stringify([item.fields,item.recordBlocks]), '覆盖预览已变化或过期，请重新核对差异');
          check(Array.isArray(msg.scanIds) && msg.scanIds.length>0 && msg.scanIds.length<=500 && new Set(msg.scanIds).size===msg.scanIds.length && msg.scanIds.every((id)=>preview.changes.some((row)=>row.scanId===id)), '请选择预览中的覆盖字段');
          const staged=overwriteProjection(item,db,preview.bindings); const selected=overwriteOrder(item,preview.changes.filter((row)=>msg.scanIds.includes(row.scanId)));
          // 整批先回读核对，尚未签发覆盖令牌时不改变来源；每项实际写入仍复核原网页值。
          for(const change of selected) {
            const row=staged.rows.find((row)=>row.field.scanId===change.scanId);
            check(row && JSON.stringify(row.target)===JSON.stringify(change.target) && JSON.stringify(M.valueOf(db,item.profileId,row.target)?.value)===JSON.stringify(change.after), '覆盖来源已变化，请重新预览');
            const result=await pageMessage(item.tabId,{type:'learning:read',documentId:item.documentId,scanId:change.scanId,semanticId:change.semanticId}); task.check();
            check(JSON.stringify(result.value)===JSON.stringify(change.before), '网页内容在预览后已变化，请重新核对差异');
          }
          item.recordBindings ||= {}; item.protectedRecords ||= new Set(); const rebound=new Set();
          // 同一模块按已确认的整套配对原子更新；仅更新勾选记录会在交换来源时造成重复绑定。
          for(const block of item.recordBlocks) if(block.records.some((record)=>selected.some((row)=>record.scanIds.includes(row.scanId)))) for(const record of block.records) {
            const wasBound=Object.hasOwn(item.recordBindings,record.recordId); const bound=Object.hasOwn(staged.recordBindings,record.recordId);
            if(wasBound!==bound || bound && item.recordBindings[record.recordId]!==staged.recordBindings[record.recordId]) record.scanIds.forEach((id)=>rebound.add(id));
            if(bound) item.recordBindings[record.recordId]=staged.recordBindings[record.recordId]; else delete item.recordBindings[record.recordId];
            records.confirmBinding(item,record.recordId);
            record.scanIds.forEach((id)=>bound?item.protectedRecords.delete(id):item.protectedRecords.add(id));
          }
          // 改配只重建运行时来源，清除旧手选/验证/覆盖许可；未勾选项不会获得写入令牌。
          item.rows=item.rows.map((row)=>rebound.has(row.field.scanId)?{field:row.field,ignored:row.ignored,webFilled:row.webFilled,webOccupied:row.webOccupied}:row);
          if(rebound.size) { item.valuePreview=null; item.learnPreview=null; }
          records.synchronize(item,db); rebuild(item,db);
          const overwrite=selected.map((change)=> {
            const row=rowOf(item,change.scanId); const token=crypto.randomUUID();
            Object.assign(row,{target:change.target,chosen:true,source:'manual',status:'matched',reason:'已核对本次覆盖差异，尚未写入验证',conflict:{before:change.before,after:change.after,token,revision:db.revision,createdAt:Date.now()}});
            delete row.verification; return {scanId:change.scanId,token};
          });
          return {...view(item,db),overwrite};
        } finally { task.done(); }
      }
      if (['learning:previewSuggestion', 'learning:acceptSuggestion'].includes(msg.type)) {
        check(!item.batch && !item.jobs?.size, '请先等待填写结束');
        await refresh(item, db); const row = rowOf(item, msg.scanId); const source = suggestedSource(item, db, row);
        if (msg.type === 'learning:previewSuggestion') {
          // 确认令牌只在后台会话中保存，不写个人库、不发送模型，也不允许UI传入实际值。
          item.suggestionPreview = { token: crypto.randomUUID(), scanId: row.field.scanId, revision: db.revision, createdAt: Date.now(), suggestion: JSON.stringify(row.suggestion), source: clone(source) };
          return { token: item.suggestionPreview.token, fieldLabel: row.field.label, sourceLabel: source.label, value: clone(source.value) };
        }
        const preview = item.suggestionPreview; item.suggestionPreview = null;
        check(msg.confirmed === true && preview?.token === msg.token && preview.scanId === row.field.scanId && preview.revision === db.revision && Date.now() - preview.createdAt < 300000 && preview.suggestion === JSON.stringify(row.suggestion) && JSON.stringify(preview.source) === JSON.stringify(source), 'AI建议或资料已变化，请重新预览并确认');
        Object.assign(row, { target: target(item, source.fieldId, source.entryId), chosen: true, source: 'manual', status: 'matched', reason: '已确认AI建议的本地来源，尚未填写验证' });
        delete row.verification; delete row.suggestion; return view(item, db);
      }
      if (msg.type === 'learning:previewLearnedFields' || msg.type === 'learning:commitLearnedFields') {
        check(!item.batch && !item.jobs?.size, '请先等待填写结束');
        const task = jobFor(item, db);
        try {
          if (msg.type === 'learning:previewLearnedFields') {
            item.learnPreview = null;
            check(Array.isArray(msg.scanIds) && msg.scanIds.length > 0 && msg.scanIds.length <= 20 && new Set(msg.scanIds).size === msg.scanIds.length, '请选择 1–20 个字段');
            const items = [];
            for (const scanId of msg.scanIds) items.push(await learningItem(item, db, rowOf(item, scanId), task));
            check(new Set(items.map((value) => value.mapping.semanticId)).size === items.length, '重复语义字段请分开处理');
            task.check(); item.learnPreview = { token: crypto.randomUUID(), revision: db.revision, createdAt: Date.now(), items };
            return { token: item.learnPreview.token, changes: items.map((value) => ({ label: value.mapping.label, targetLabel: value.definition?.label || item.sources.find((source) => source.fieldId === value.fieldId && source.entryId === value.entryId)?.label, controlType: value.mapping.features.type, action: value.definition ? '添加私有字段' : '更新已匹配字段', type: value.definition?.type || db.fieldDefinitions.find((def) => def.fieldId === value.fieldId).type, options: value.definition?.options || db.fieldDefinitions.find((def) => def.fieldId === value.fieldId)?.options || [], oldValue: value.fieldId ? M.valueOf(db, item.profileId, value)?.value ?? null : null, newValue: value.value })) };
          }
          const preview = item.learnPreview; item.learnPreview = null;
          check(msg.confirmed === true && preview?.token === msg.token && preview.revision === db.revision && Date.now() - preview.createdAt < 300000, '请重新预览并确认集中更新');
          const items = [];
          for (const before of preview.items) {
            const next = await learningItem(item, db, rowOf(item, before.scanId), task);
            check(JSON.stringify([next.raw, next.value, next.fieldId, next.entryId, next.definition]) === JSON.stringify([before.raw, before.value, before.fieldId, before.entryId, before.definition]), '网页内容或字段已变化，请重新预览');
            items.push({ definition: before.definition, fieldId: before.fieldId, entryId: before.entryId, value: before.value, mapping: next.mapping });
          }
          task.check();
          await repository.command({ action: 'confirmLearnedFields', payload: { profileId: item.profileId, items, confirmed: true }, expectedRevision: preview.revision });
          const latest = await fieldContext(item.profileId); rebuild(item, latest); return view(item, latest);
        } finally { task.done(); }
      }
      if (msg.type === 'learning:prepareRecords') { check(msg.confirmed === true, '补充网页经历需要用户主动操作');const task=jobFor(item,db,msg.batchId);try{task.check();return await prepareRecords(item,db,task);}finally{task.done();} }
      if (msg.type === 'learning:prepareAI') {
        check(Array.isArray(msg.scanIds) && msg.scanIds.length > 0 && msg.scanIds.length <= 20 && new Set(msg.scanIds).size === msg.scanIds.length, '请勾选 1–20 个需要 AI 识别的未知字段');
        const fields = msg.scanIds.map((scanId) => { const row = rowOf(item, scanId); check(!row.recordBindingRequired, '字段含义已识别，请先在“覆盖网页已填内容”中配对经历，AI不能代替来源确认'); check(!row.target && !row.ignored && row.status !== 'unsupported', '只能选择未忽略的未知字段使用 AI'); return row.field; });
        const settings = await repository.readAiSettings(); const provider = global.LocalApplyProviders.resolve(settings);
        check(settings.model, '请先配置模型；不配置 AI 仍可手动匹配');
        // 只在用户主动预览时按上下文分配目录预算，省略范围必须可见，不改变本地匹配。
        const { payload, coverage } = global.FieldSuggestions.catalogPreview(db.fieldDefinitions, item.sources, fields);
        item.aiPreview = { token: crypto.randomUUID(), payload, context: await aiContext(settings), revision: db.revision, createdAt: Date.now() };
        return { token: item.aiPreview.token, recipient: { name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, model: settings.model }, payload, coverage };
      }
      if (msg.type === 'learning:recognize') {
        const preview = item.aiPreview; check(msg.confirmed === true && preview?.token === msg.token && Date.now() - preview.createdAt < 300000, '请先预览接收方和发送内容并确认');
        item.aiPreview = null;
        const settings = await repository.readAiSettings(); check(await aiContext(settings) === preview.context, 'API 配置已变化，请重新预览');
        // 取消不等待同会话队列；过期响应即便底层未及时中止也不得成为可采用建议。
        check(sessions.get(item.sessionId) === item, '页面会话已撤销，请重新扫描');
        const controller = new AbortController(); aiJobs.set(item.sessionId, controller);
        let out;
        try { out = await ai.callGLM({ model: settings.model, expectedContext: preview.context, messages: global.FieldSuggestions.messages(preview.payload), signal: controller.signal, disableThinking: true, maxTokens: 5000, timeoutMs: 30000 }); check(!controller.signal.aborted, '已取消字段识别'); }
        catch (error) { if (controller.signal.aborted) throw new Error('已取消字段识别'); throw error; }
        finally { if (aiJobs.get(item.sessionId) === controller) aiJobs.delete(item.sessionId); }
        check((await fieldContext(item.profileId)).revision === preview.revision && await aiContext(await repository.readAiSettings()) === preview.context, '识别期间资料或 API 已变化，请重新扫描');
        let parsed; try { parsed = JSON.parse(out.content); } catch { throw new Error('AI 字段建议不是有效 JSON，请重试或手动选择'); }
        const suggestions = global.FieldSuggestions.validate(parsed, preview.payload);
        suggestions.forEach((suggestion) => { const row = rowOf(item, suggestion.scanId); row.suggestion = suggestion; row.status = 'needs_confirmation'; row.reason = 'AI 建议尚未确认；置信度不能代替用户核对'; });
        return { ...view(item, db), suggestionCount: suggestions.length };
      }
      // 会话命令先明确分派；未知/旧版本命令不能误报为缺少单字段扫描授权。
      check(['learning:ignore', 'learning:select', 'learning:focusField', 'learning:readField', 'learning:previewValue', 'learning:commitValue', 'learning:fill', 'learning:remember'].includes(msg.type), '未知字段学习操作，请重新加载扩展并刷新招聘页');
      let row = rowOf(item, msg.scanId);
      if (msg.type === 'learning:focusField') {
        await pageMessage(item.tabId, { type: 'learning:focus', documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId }); return { focused: true };
      }
      if (msg.type === 'learning:ignore') { row.ignored = msg.ignored === true; item.aiPreview = null; return view(item, db); }
      if (msg.type === 'learning:select') {
        row.target = target(item, msg.fieldId, msg.entryId); row.chosen = true; delete row.verification;
        row.status = M.hasValue(M.valueOf(db, item.profileId, row.target)?.value) ? 'matched' : 'missing_value'; row.source = 'manual'; row.reason = '用户已选择本地来源，填写前仍需确认';
        return view(item, db);
      }
      if (msg.type === 'learning:readField') {
        const response = await pageMessage(item.tabId, { type: 'learning:read', documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId });
        return { value: response.value };
      }
      if (msg.type === 'learning:previewValue') {
        check(msg.definition || msg.fieldId, '请选择已有字段或填写新字段定义');
        if (msg.definition) {
          global.FieldSuggestions.validate({ suggestions: [{ scanId: row.field.scanId, existingFieldId: null, definition: msg.definition, sourceRef: null, confidence: 0 }] }, { fields: [row.field], catalog: [], sources: [] });
          // 当前档案已有相同定义时引导选择来源，避免把缺少值误当成缺少字段。
          const normalize = global.WangshenTemplates.normalizeLabel;
          check(!db.fieldDefinitions.some((def) => item.sources.some((source) => source.fieldId === def.fieldId) && def.type === msg.definition.type && [def.label, ...def.aliases].some((label) => normalize(label) === normalize(msg.definition.label))), '该字段定义已存在，请选择已有字段来源后补充值');
        }
        const selected = msg.definition ? null : target(item, msg.fieldId, msg.entryId);
        let entryId = selected?.entryId || null;
        if (msg.definition && msg.entryId) { check(db.entries.some((entry) => entry.entryId === msg.entryId && entry.profileId === item.profileId), '新字段经历不属于当前档案'); entryId = msg.entryId; }
        let value = msg.value; let source = msg.source === 'web-confirmed' ? 'web-confirmed' : 'manual';
        if (msg.sourceRef) { const ref = item.sources.find((source) => source.ref === msg.sourceRef && source.hasValue); check(ref, '本地来源已失效'); value = clone(ref.value); source = 'local-confirmed'; if (msg.definition && !msg.entryId) entryId = ref.entryId; }
        const def = msg.definition || db.fieldDefinitions.find((definition) => definition.fieldId === selected.fieldId);
        const next = { definition: msg.definition || null, fieldId: selected?.fieldId || null, entryId, value, source };
        item.valuePreview = { token: crypto.randomUUID(), scanId: row.field.scanId, next, revision: db.revision, createdAt: Date.now() };
        return { token: item.valuePreview.token, diff: { action: msg.definition ? '创建私有字段及值' : '更新个人字段值', label: def.label,
          oldValue: selected ? M.valueOf(db, item.profileId, selected)?.value ?? null : null, newValue: value, definition: msg.definition || null, source } };
      }
      if (msg.type === 'learning:commitValue') {
        const preview = item.valuePreview; check(msg.confirmed === true && preview?.token === msg.token && preview.scanId === row.field.scanId && Date.now() - preview.createdAt < 300000, '须先预览差异并明确确认');
        item.valuePreview = null;
        const saved = await repository.command({ action: 'confirmField', payload: { ...preview.next, profileId: item.profileId, confirmed: true }, expectedRevision: preview.revision });
        const latest = await fieldContext(item.profileId); rebuild(item, latest); const updated = rowOf(item, msg.scanId);
        Object.assign(updated, { target: saved.result, chosen: true, status: M.hasValue(preview.next.value) ? 'matched' : 'missing_value', source: 'manual', reason: '已确认保存到个人档案，尚未学习网页映射' });
        return view(item, latest);
      }
      if (msg.type === 'learning:fill') {
        check(Object.keys(msg).every((key) => ['type', 'sessionId', 'scanId', 'confirmed', 'overwriteToken', 'panelToken','batchId'].includes(key)), '填写意图只能由后台生成');
        check(msg.confirmed === true && row.target, '填写前必须核对本地来源并确认');
        check(item.fillContractVersion === global.LocalApplyFillContract.VERSION, '页面填写契约尚未加载，请刷新网页后重新扫描');
        const source = clone(row.target); const value = M.valueOf(db, item.profileId, source)?.value; check(M.hasValue(value), '本地没有该字段值，请先填写资料');
        // 覆盖令牌只允许当前项、当前资料版本及五分钟内已展示的差异，不能用布尔开关绕过。
        const overwrite = msg.overwriteToken !== undefined;
        if (overwrite) check(row.conflict?.token === msg.overwriteToken && row.conflict.revision === db.revision && Date.now() - row.conflict.createdAt < 300000 && JSON.stringify(value) === JSON.stringify(row.conflict.after), '覆盖确认已失效，请重新填写并预览差异');
        const task=jobFor(item,db,msg.batchId);task.check();
        try {
          // 自动配对也须在写入前复核当前记录，不能沿用用户已改动的学校/公司/项目依据。
          if(!await records.validateBinding(item,db,row.field.scanId,task)) { rebuild(item,db); return view(item,db); }
          row=rowOf(item,msg.scanId); check(row.target&&row.target.fieldId===source.fieldId&&row.target.entryId===source.entryId&&JSON.stringify(M.valueOf(db,item.profileId,row.target)?.value)===JSON.stringify(value),'经历来源已变化，请重新识别');
          row.status='filling'; delete row.diagnostic;
          const intent = global.LocalApplyFillContract.createIntent(db, item.profileId, row.target, row.field, { sessionId: item.sessionId, tabId: item.tabId, documentId: item.documentId });
          task.check();const result = await pageMessage(item.tabId, { type: 'learning:fill', documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId, value, intent,operationId:task.id, ...(overwrite ? { overwrite: true, expectedCurrent: row.conflict.before } : {}) });task.check();
          check(['success', 'failed', 'unsupported', 'needs_confirmation'].includes(result.result.status), '网页返回无效填写结果');
          row.status = result.result.status; row.reason = result.result.reason || '事件派发后已跨延迟复读，网页未回退';
          row.chosen = true;
          row.conflict = result.result.conflict ? { ...result.result.conflict, token: crypto.randomUUID(), revision: db.revision, createdAt: Date.now() } : null;
          row.verification = row.status === 'success' ? { target: clone(row.target), value: clone(value), verifiedAt: result.result.verifiedAt } : null;
          // 旧内容脚本可能没有轨迹，显式标记可用性；后台补编号并再次过滤个人值和网页文字。
          row.diagnostic = global.LocalApplyDiagnostics.fillInfo({ ...result.result.diagnostic, traceAvailable: !!result.result.diagnostic,
            fieldNumber: item.fields.findIndex((field) => field.scanId === row.field.scanId) + 1, controlType: row.field.type, fieldKind: row.field.kind, status: row.status });
        } catch (error) {
          // 来源复核可能已重建行对象，失败必须落到当前界面行，不能留在旧引用上。
          row = item.rows.find((current) => current.field.scanId === msg.scanId) || row;
          row.status = 'failed'; row.reason = task.signal.aborted?'已取消填写':error.message; row.verification = null; row.chosen = true;
          row.diagnostic = global.LocalApplyDiagnostics.fillInfo({ phase: 'write', reasonCode: task.signal.aborted?'cancelled':'operation_error', status: 'failed', traceAvailable: false,
            fieldNumber: item.fields.findIndex((field) => field.scanId === row.field.scanId) + 1, controlType: row.field.type, fieldKind: row.field.kind });
        } finally {task.done();}
        return view(item, db);
      }
      if (msg.type === 'learning:remember') {
        const task=jobFor(item,db,msg.batchId);try{task.check();
        check(msg.confirmed === true && row.status === 'success' && row.verification, '只有用户确认且填写验证成功后才能记住');
        const value = M.valueOf(db, item.profileId, row.target)?.value;
        check(JSON.stringify(value) === JSON.stringify(row.verification.value), '本地值已变化，请重新填写验证');
        const verified = await pageMessage(item.tabId, { type: 'learning:verify', documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId, value,operationId:task.id });task.check();
        check(verified.result.status === 'success', '网页值已变化，未保存规则');
        // 变体单独学习；散列相同仍须完整特征一致，不能覆盖另一控件的旧验证证据。
        const old = db.mappingRules.find((rule) => rule.profileId === item.profileId && rule.origin === item.origin && rule.semanticId === row.field.semanticId
          && rule.features && JSON.stringify(M.features(rule.features)) === JSON.stringify(M.features(row.field)));
        await ruleCommand(db, 'saveMapping', { mappingId: old?.mappingId || 'mapping.' + crypto.randomUUID(), origin: item.origin, path: '/', label: row.field.label,
          ...row.target, profileId: item.profileId, semanticId: row.field.semanticId, features: M.features(row.field), confirmed: true, enabled: true,
          lastVerifiedAt: verified.result.verifiedAt, ruleVersion: (old?.ruleVersion || 0) + 1 },task);
        const latest = await fieldContext(item.profileId);check(latest.revision===db.revision+1,'资料已变化，请重新扫描');task.advance(latest.revision);rebuild(item, latest); return view(item, latest);
        }finally{task.done();}
      }
      throw new Error('未知字段学习操作');
    }
    // 内容脚本只能发送无值的结构变化通知，不能请求资料或创建字段。
    function changed(sender, msg) { for (const item of sessions.values()) if (item.tabId === sender.tab?.id && item.documentId === msg.documentId) item.dirty = true; }
    // 同一会话串行执行，防止后台刷新替换正在填写的行对象或覆盖确认结果。
    async function dispatch(msg, access) {
      const owned=msg.sessionId&&sessions.get(msg.sessionId);
      if(access)check(msg.type==='learning:scanPage'?msg.tabId===access.tabId:!owned||owned.tabId===access.tabId&&owned.documentId===access.documentId,'不能操作其他页面的字段会话');
      // 停止不排队等待正在填写的项，也不要求旧档案仍是活动档案；只能停止已签发的本批次。
      if(['learning:cancelFill','learning:endFill'].includes(msg.type)){
        if(owned?.batch?.id===msg.batchId){await stop(owned,owned.batch);if(msg.type==='learning:endFill')owned.batch=null;}
        return {cancelled:true};
      }
      // 撤销消息也先中止进行中项，不能排在长查询/模型请求后才撤销页面许可。
      if(msg.type==='learning:revoke'&&owned){aiJobs.get(owned.sessionId)?.abort();await Promise.all([owned.batch,...(owned.jobs?.values()||[])].filter(Boolean).map((job)=>stop(owned,job)));}
      if (msg.type === 'learning:cancelAI') { const { item } = await session(msg.sessionId); aiJobs.get(item.sessionId)?.abort(); item.aiPreview = null; return { cancelled: true }; }
      const key = msg.sessionId || 'management';
      const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => handle(msg,access)); queues.set(key, pending);
      try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
    }
    return { handle: dispatch, changed, invalidate, profileChanged };
  }
  global.FieldLearning = { create };
})(globalThis);
