// 阶段三后台服务：网页授权、字段建议、差异确认、验证填写及本地规则记忆。
(function (global) {
  'use strict';
  const M = global.FieldMatchingEngine;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  // 依赖通过参数传入，测试使用本地 Mock；浏览器中始终复用唯一 repository/AI 客户端。
  function create(repository, ai, browser) {
    const sessions = new Map(); const queues = new Map(); const aiJobs = new Map(); let undo = null;
    // 页面退出时立即释放待确认个人值、覆盖令牌及模型任务，不保留隐藏的输入历史。
    function drop(id) { aiJobs.get(id)?.abort(); sessions.delete(id); }
    // 顶层导航/关闭绑定页面时，终止该页所有扫描会话；其他页面资料不受影响。
    function invalidate(tabId) { for (const [id, item] of sessions) if (item.tabId === tabId) drop(id); }
    // 可读错误不包含模型原文、凭据或网页值。
    function check(ok, message) { if (!ok) throw new Error(message); }
    // 标准内容脚本缺失时只注入当前已授权页面，不跨标签页广播个人资料。
    async function pageMessage(tabId, message, inject = false) {
      let response;
      try { response = await browser.tabs.sendMessage(tabId, message); }
      catch (error) {
        if (!inject) throw new Error('页面未连接，请重新授权扫描');
        await browser.scripting.executeScript({ target: { tabId }, files: ['data/templates.js', 'data/field-matching.js', 'data/fill-contract.js', 'data/applications.js', 'content/field-adapters.js', 'content/field-scanner.js', 'content/detector.js', 'content/filler.js', 'content/controls/text.js', 'content/controls/registry.js', 'content/verified-fill.js', 'content/page-presence.js', 'content/job-recognizer.js', 'content/floatbar.js'] });
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
    // 获取并核对当前文档，导航/过期/切换档案后旧确认不能继续使用。
    async function session(id) {
      const item = sessions.get(id);
      if (item && Date.now() - item.createdAt >= 1800000) drop(id);
      check(sessions.has(id), '扫描会话已过期或页面已导航/关闭，请重新授权扫描');
      const tab = await browser.tabs.get(item.tabId);
      if (tab.url !== item.url) { drop(id); throw new Error('页面已导航，请重新授权扫描'); }
      const db = await repository.read(); check(db.profiles.some((profile) => profile.profileId === item.profileId), '档案已删除');
      check(db.activeProfileId === item.profileId, '活动档案已变化，请重新授权扫描');
      return { item, db };
    }
    // 规则写入不会清掉同批次其他已确认来源；值或规则目标改变则丢弃旧确认/验证。
    function rebuild(item, db, fields = item.fields) {
      const old = item.rows || [];
      const oldSources = item.sources || [];
      item.fields = fields; item.rows = M.match(db, item.profileId, item.origin, fields);
      for (const row of item.rows) {
        // 自动增补只绑定到本次明确分配的整条记录，绝不改变同站已验证的映射优先级。
        const assigned = item.recordTargets?.[row.field.scanId]; const assignedTarget = assigned && { fieldId: assigned.fieldId, entryId: assigned.entryId };
        if (assigned?.semanticId === row.field.semanticId && row.source !== 'memory' && db.publicFieldIds.includes(assigned.fieldId)) Object.assign(row, { target: assignedTarget, candidates: [assignedTarget], source: 'record', reason: '当前简历的整条经历已绑定此网页记录，只填写空白项', status: M.hasValue(M.valueOf(db, item.profileId, assignedTarget)?.value) ? 'matched' : 'missing_value' });
        const previous = old.find((value) => value.field.scanId === row.field.scanId && value.field.semanticId === row.field.semanticId);
        if (previous) row.webFilled = previous.webFilled === true;
        if (previous?.ignored) row.ignored = true;
        const source = previous?.target && item.sources?.find((source) => source.fieldId === previous.target.fieldId && source.entryId === previous.target.entryId);
        const sameTarget = JSON.stringify(row.target) === JSON.stringify(previous?.target);
        const unchanged = source && JSON.stringify(source.value) === JSON.stringify(M.valueOf(db, item.profileId, previous.target)?.value)
          && (previous.source !== 'memory' || row.source === 'memory') && (row.source !== 'memory' || (sameTarget && row.status !== 'needs_confirmation'));
        if (previous?.chosen && (item.revision === db.revision || unchanged)) {
          Object.assign(row, { target: previous.target, chosen: true, status: previous.status, reason: row.source === 'memory' ? '填写已验证，已记住本地网站映射' : previous.reason, source: row.source === 'memory' ? 'memory' : previous.source });
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
        // 未确认来源的已有经历不能将另一条简历资料补进其空字段，需逐项明确选择。
        if (item.protectedRecords?.has(row.field.scanId) && !row.chosen && row.source !== 'memory' && row.target) Object.assign(row, { target: null, status: 'needs_confirmation', reason: '网页已有经历但尚未绑定来源，请手动选择，避免混入另一条记录' });
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
    // 完成状态只接受当前扫描项的布尔标记；清空已成功字段后允许用户再次填写。
    function completion(item, snapshot) {
      const rows = snapshot.completion || [];
      check(Array.isArray(rows) && rows.length <= item.rows.length && rows.every((row) => row && Object.keys(row).sort().join() === 'present,scanId' && typeof row.present === 'boolean' && item.rows.some((item) => item.field.scanId === row.scanId)) && new Set(rows.map((row) => row.scanId)).size === rows.length, '网页完成状态格式错误');
      for (const row of item.rows) {
        const state = rows.find((item) => item.scanId === row.field.scanId); row.webFilled = state?.present === true;
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

    // 本地整条记录按简历现有顺序分配空白网页槽位；已有非空且未绑定的记录保留，避免混写或重复添加。
    async function prepareRecords(item, db) {
      await refresh(item, db); item.recordBindings ||= {}; item.recordTargets ||= {}; item.protectedRecords = new Set(); let added = 0; let protectedGroups = 0; let remaining = 0;
      for (const initial of item.recordBlocks) {
        const belongs = (fieldId) => global.WangshenTemplates.recordKind(db.fieldDefinitions.find((def) => def.fieldId === fieldId)?.group) === initial.kind;
        const local = [null, ...db.entries.filter((entry) => entry.profileId === item.profileId && entry.kind === initial.kind).sort((a, b) => a.order - b.order || a.entryId.localeCompare(b.entryId)).map((entry) => entry.entryId)]
          .filter((entryId) => db.fieldValues.some((value) => value.profileId === item.profileId && value.entryId === entryId && belongs(value.fieldId) && M.hasValue(value.value)));
        if (!local.length) continue;
        const occupied = (record) => record.scanIds.some((id) => item.rows.find((row) => row.field.scanId === id)?.webFilled);
        // 单项人工选择不能推断为整条经历授权；已有映射/手选或非空的未绑定模块交给用户处理。
        if (initial.records.some((record) => !Object.hasOwn(item.recordBindings, record.recordId) && (occupied(record) || record.scanIds.some((id) => { const row = item.rows.find((row) => row.field.scanId === id); return row?.source === 'memory' || row?.chosen && row.source === 'manual'; })))) {
          protectedGroups++; initial.records.forEach((record) => record.scanIds.forEach((scanId) => item.protectedRecords.add(scanId))); continue;
        }
        const used = initial.records.filter((record) => Object.hasOwn(item.recordBindings, record.recordId)).map((record) => item.recordBindings[record.recordId]);
        const pending = local.filter((entryId) => !used.includes(entryId));
        let block = initial;
        while (block.canAdd && block.records.filter((record) => !occupied(record) && !Object.hasOwn(item.recordBindings, record.recordId)).length < pending.length && block.records.length < 20 && added < 20) {
          const latest = await session(item.sessionId); check(latest.db.revision === db.revision, '资料已变化，已停止添加，请重新扫描');
          await pageMessage(item.tabId, { type: 'learning:addRecord', documentId: item.documentId, blockId: block.blockId }); added++;
          const after = await session(item.sessionId); check(after.db.revision === db.revision, '添加期间资料已变化，已停止，请重新扫描');
          await refresh(item, db); block = item.recordBlocks.find((value) => value.blockId === initial.blockId);
          check(block, '模块已重建，请重新扫描，不继续猜测添加按钮');
        }
        check(sessions.has(item.sessionId), '页面已关闭，已停止补充经历');
        for (const record of block.records) {
          if (!Object.hasOwn(item.recordBindings, record.recordId) && !occupied(record) && pending.length) item.recordBindings[record.recordId] = pending.shift();
          // 网页槽位多于本地记录时保留多余空槽，不能让单来源回退把同一段经历重复填入。
          if (!Object.hasOwn(item.recordBindings, record.recordId)) { record.scanIds.forEach((scanId) => item.protectedRecords.add(scanId)); continue; }
          for (const scanId of record.scanIds) {
            const field = item.fields.find((field) => field.scanId === scanId); const def = M.definitionFor(db, field)?.definition;
            if (def && belongs(def.fieldId) && db.publicFieldIds.includes(def.fieldId)) item.recordTargets[scanId] = { ...M.targetForRecord(db, item.profileId, field, def.fieldId, item.recordBindings[record.recordId]), semanticId: field.semanticId };
          }
        }
        remaining += pending.length;
      }
      item.recordNotice = `已补充 ${added} 条网页经历${protectedGroups ? `；${protectedGroups} 个模块已有未绑定内容，保留原记录，请手动选择来源` : ''}${remaining ? `；没有更多可用槽位或已达到本次添加上限，另有 ${remaining} 条经历尚未分配，请检查网页后继续` : ''}`;
      rebuild(item, db); return view(item, db);
    }
    // 再扫描只读取已经授权的同一文档，动态新增时清理旧建议/确认令牌。
    async function refresh(item, db) {
      const response = await pageMessage(item.tabId, { type: 'learning:scan', authorize: false });
      check(response.snapshot.documentId === item.documentId, '页面已刷新，请重新授权扫描');
      response.snapshot.fields.forEach(M.validateField);
      // 新增记录会改变字段集合；保留稳定字段的人工来源与验证，仅清除依赖旧扫描的 AI 建议和确认令牌。
      if (JSON.stringify(response.snapshot.fields) !== JSON.stringify(item.fields)) { item.rows.forEach((row) => { delete row.suggestion; }); item.aiPreview = null; item.valuePreview = null; }
      rebuild(item, db, response.snapshot.fields); completion(item, response.snapshot); item.excluded = response.snapshot.excluded || []; item.dirty = false;
    }
    // 选择仅允许本档案来源，不能通过 AI/页面提供的 ID 读取其他人的值。
    function target(item, fieldId, entryId) {
      const found = item.sources.find((source) => source.fieldId === fieldId && source.entryId === (entryId || null));
      check(found, '请选择当前档案已有的字段来源'); return { fieldId, entryId: entryId || null };
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
    // 规则写入保留本会话撤销点，后续外部改动时拒绝覆盖。
    async function ruleCommand(db, action, payload) {
      const before = clone(db.mappingRules);
      const result = await repository.command({ action, payload, expectedRevision: db.revision });
      undo = { before, revision: result.revision }; return result;
    }
    // 后台统一校验会话和确认；填写意图只由规范库生成，不接受 UI/AI 提供计划或值。
    async function handle(msg) {
      if (msg.type === 'learning:scanPage') {
        check(msg.confirmed === true && Number.isInteger(msg.tabId), '扫描前须明确授权当前页面');
        const tab = await browser.tabs.get(msg.tabId); check(/^https?:\/\//.test(tab.url || ''), '只能扫描用户授权的普通招聘网页');
        const db = await repository.read(); const profileId = msg.profileId || db.activeProfileId;
        check(db.profiles.some((profile) => profile.profileId === profileId), '档案不存在');
        const response = await pageMessage(msg.tabId, { type: 'learning:scan', authorize: true, expectedUrl: tab.url }, true);
        const snapshot = response.snapshot; check(snapshot.origin === new URL(tab.url).origin && snapshot.fields.length <= 500, '页面来源或字段数量错误');
        snapshot.fields.forEach(M.validateField);
        for (const [id, previous] of sessions) if (previous.tabId === msg.tabId || sessions.size >= 8) drop(id);
        const item = { sessionId: crypto.randomUUID(), createdAt: Date.now(), tabId: msg.tabId, url: tab.url, origin: snapshot.origin,
          documentId: snapshot.documentId, fillContractVersion: snapshot.fillContractVersion, profileId, fields: snapshot.fields, excluded: snapshot.excluded || [], notice: snapshot.notice || '' };
        rebuild(item, db); completion(item, snapshot); sessions.set(item.sessionId, item); return view(item, db);
      }
      if (msg.type === 'learning:rules') { const db = await repository.read(); return { rules: db.mappingRules, definitions: db.fieldDefinitions, profiles: db.profiles, entries: db.entries, revision: db.revision, canUndo: !!undo }; }
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
      if (msg.type === 'learning:revoke') { await pageMessage(item.tabId, { type: 'learning:revoke' }); drop(item.sessionId); return {}; }
      if (msg.type === 'learning:session') { await refresh(item, db); return view(item, db); }
      check(item.revision === db.revision, '资料已变化，请重新扫描并预览');
      if (msg.type === 'learning:prepareRecords') { check(msg.confirmed === true, '补充网页经历需要用户主动操作'); return prepareRecords(item, db); }
      if (msg.type === 'learning:prepareAI') {
        check(Array.isArray(msg.scanIds) && msg.scanIds.length > 0 && msg.scanIds.length <= 20 && new Set(msg.scanIds).size === msg.scanIds.length, '请勾选 1–20 个需要 AI 识别的未知字段');
        const fields = msg.scanIds.map((scanId) => { const row = rowOf(item, scanId); check(!row.target && !row.ignored && row.status !== 'unsupported', '只能选择未忽略的未知字段使用 AI'); return row.field; });
        const settings = await repository.readAiSettings(); const provider = global.LocalApplyProviders.resolve(settings);
        check(settings.model, '请先配置模型；不配置 AI 仍可手动匹配');
        const catalog = db.fieldDefinitions.filter((def) => item.sources.some((source) => source.fieldId === def.fieldId)).slice(0, 200)
          .map((def) => ({ fieldId: def.fieldId, label: M.redact(def.label), type: def.type, group: M.redact(def.group), aliases: def.aliases.slice(0, 20).map((alias) => M.redact(alias)), options: def.options.slice(0, 100).map((option) => M.redact(option)) }));
        const payload = { fields, catalog, sources: item.sources.filter((source) => catalog.some((def) => def.fieldId === source.fieldId))
          .map(({ ref, fieldId, kind, hasValue }) => ({ ref, fieldId, kind, hasValue })) };
        check(JSON.stringify(payload).length <= 60000, '发送元数据过多，请先手动匹配部分字段');
        item.aiPreview = { token: crypto.randomUUID(), payload, context: await aiContext(settings), revision: db.revision, createdAt: Date.now() };
        return { token: item.aiPreview.token, recipient: { name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, model: settings.model }, payload };
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
        check((await repository.read()).revision === preview.revision && await aiContext(await repository.readAiSettings()) === preview.context, '识别期间资料或 API 已变化，请重新扫描');
        let parsed; try { parsed = JSON.parse(out.content); } catch { throw new Error('AI 字段建议不是有效 JSON，请重试或手动选择'); }
        const suggestions = global.FieldSuggestions.validate(parsed, preview.payload);
        suggestions.forEach((suggestion) => { const row = rowOf(item, suggestion.scanId); row.suggestion = suggestion; row.status = 'needs_confirmation'; row.reason = 'AI 建议尚未确认；置信度不能代替用户核对'; });
        return { ...view(item, db), suggestionCount: suggestions.length };
      }
      const row = rowOf(item, msg.scanId);
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
        const latest = await repository.read(); rebuild(item, latest); const updated = rowOf(item, msg.scanId);
        Object.assign(updated, { target: saved.result, chosen: true, status: M.hasValue(preview.next.value) ? 'matched' : 'missing_value', source: 'manual', reason: '已确认保存到个人档案，尚未学习网页映射' });
        return view(item, latest);
      }
      if (msg.type === 'learning:fill') {
        check(Object.keys(msg).every((key) => ['type', 'sessionId', 'scanId', 'confirmed', 'overwriteToken', 'panelToken'].includes(key)), '填写意图只能由后台生成');
        check(msg.confirmed === true && row.target, '填写前必须核对本地来源并确认');
        check(item.fillContractVersion === global.LocalApplyFillContract.VERSION, '页面填写契约尚未加载，请刷新网页后重新扫描');
        const value = M.valueOf(db, item.profileId, row.target)?.value; check(M.hasValue(value), '本地没有该字段值，请先填写资料');
        // 覆盖令牌只允许当前项、当前资料版本及五分钟内已展示的差异，不能用布尔开关绕过。
        const overwrite = msg.overwriteToken !== undefined;
        if (overwrite) check(row.conflict?.token === msg.overwriteToken && row.conflict.revision === db.revision && Date.now() - row.conflict.createdAt < 300000 && JSON.stringify(value) === JSON.stringify(row.conflict.after), '覆盖确认已失效，请重新填写并预览差异');
        row.status = 'filling'; delete row.diagnostic;
        try {
          const intent = global.LocalApplyFillContract.createIntent(db, item.profileId, row.target, row.field, { sessionId: item.sessionId, tabId: item.tabId, documentId: item.documentId });
          const result = await pageMessage(item.tabId, { type: 'learning:fill', documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId, value, intent, ...(overwrite ? { overwrite: true, expectedCurrent: row.conflict.before } : {}) });
          check(['success', 'failed', 'unsupported', 'needs_confirmation'].includes(result.result.status), '网页返回无效填写结果');
          row.status = result.result.status; row.reason = result.result.reason || '事件派发后已跨延迟复读，网页未回退';
          row.chosen = true;
          row.conflict = result.result.conflict ? { ...result.result.conflict, token: crypto.randomUUID(), revision: db.revision, createdAt: Date.now() } : null;
          row.verification = row.status === 'success' ? { target: clone(row.target), value: clone(value), verifiedAt: result.result.verifiedAt } : null;
          // 旧内容脚本可能没有轨迹，显式标记可用性；后台补编号并再次过滤个人值和网页文字。
          row.diagnostic = global.LocalApplyDiagnostics.fillInfo({ ...result.result.diagnostic, traceAvailable: !!result.result.diagnostic,
            fieldNumber: item.fields.findIndex((field) => field.scanId === row.field.scanId) + 1, controlType: row.field.type, fieldKind: row.field.kind, status: row.status });
        } catch (error) {
          row.status = 'failed'; row.reason = error.message; row.verification = null; row.chosen = true;
          row.diagnostic = global.LocalApplyDiagnostics.fillInfo({ phase: 'write', reasonCode: 'operation_error', status: 'failed', traceAvailable: false,
            fieldNumber: item.fields.findIndex((field) => field.scanId === row.field.scanId) + 1, controlType: row.field.type, fieldKind: row.field.kind });
        }
        return view(item, db);
      }
      if (msg.type === 'learning:remember') {
        check(msg.confirmed === true && row.status === 'success' && row.verification, '只有用户确认且填写验证成功后才能记住');
        const value = M.valueOf(db, item.profileId, row.target)?.value;
        check(JSON.stringify(value) === JSON.stringify(row.verification.value), '本地值已变化，请重新填写验证');
        const verified = await pageMessage(item.tabId, { type: 'learning:verify', documentId: item.documentId, scanId: row.field.scanId, semanticId: row.field.semanticId, value });
        check(verified.result.status === 'success', '网页值已变化，未保存规则');
        const old = db.mappingRules.find((rule) => rule.profileId === item.profileId && rule.origin === item.origin && rule.semanticId === row.field.semanticId);
        await ruleCommand(db, 'saveMapping', { mappingId: old?.mappingId || 'mapping.' + crypto.randomUUID(), origin: item.origin, path: '/', label: row.field.label,
          ...row.target, profileId: item.profileId, semanticId: row.field.semanticId, features: M.features(row.field), confirmed: true, enabled: true,
          lastVerifiedAt: verified.result.verifiedAt, ruleVersion: (old?.ruleVersion || 0) + 1 });
        const latest = await repository.read(); rebuild(item, latest); return view(item, latest);
      }
      throw new Error('未知字段学习操作');
    }
    // 内容脚本只能发送无值的结构变化通知，不能请求资料或创建字段。
    function changed(sender, msg) { for (const item of sessions.values()) if (item.tabId === sender.tab?.id && item.documentId === msg.documentId) item.dirty = true; }
    // 同一会话串行执行，防止后台刷新替换正在填写的行对象或覆盖确认结果。
    async function dispatch(msg) {
      if (msg.type === 'learning:cancelAI') { const { item } = await session(msg.sessionId); aiJobs.get(item.sessionId)?.abort(); item.aiPreview = null; return { cancelled: true }; }
      const key = msg.sessionId || 'management';
      const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => handle(msg)); queues.set(key, pending);
      try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
    }
    return { handle: dispatch, changed, invalidate };
  }
  global.FieldLearning = { create };
})(globalThis);
