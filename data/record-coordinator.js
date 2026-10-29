// 重复记录属于批次编排：只绑定当前会话来源和网页空槽，不包含单项控件执行逻辑。
(function (global) {
  'use strict';
  const M = global.FieldMatchingEngine; const T = global.WangshenTemplates;
  // 注入现有授权、扫描和消息接口，生产与测试复用相同编排，不直接读写数据库。
  function create({ refresh, session, pageMessage, alive }) {
    // 当前记录的明确学历角色必须与已有来源一致；缺少学历时不按顺序硬塞。
    function fits(item,db,record,entryId){return record.kind!=='education'||record.scanIds.every((id)=>M.sourceRole(db,item.profileId,{entryId},item.fields.find((field)=>field.scanId===id)?.degree||''));}
    // 当前容器/来源变更时丢弃失效绑定，并按最新记录成员重建单项来源投影。
    function synchronize(item, db) {
      const records = new Map((item.recordBlocks || []).flatMap((block) => block.records.map((record) => [record.recordId, { ...record, kind:block.kind }])));
      item.recordTargets = {};
      for (const [recordId, entryId] of Object.entries(item.recordBindings || {})) {
        const record = records.get(recordId);
        if (!record || entryId !== null && !db.entries.some((entry) => entry.entryId === entryId && entry.profileId === item.profileId && entry.kind === record.kind) || !fits(item,db,record,entryId)) { delete item.recordBindings[recordId]; continue; }
        for (const scanId of record.scanIds) {
          const field = item.fields.find((field) => field.scanId === scanId); const def = field && M.definitionFor(db, field)?.definition;
          if (def && T.recordKind(def.group) === record.kind && db.publicFieldIds.includes(def.fieldId)) item.recordTargets[scanId] = { ...M.targetForRecord(db, item.profileId, field, def.fieldId, entryId), semanticId:field.semanticId };
        }
      }
    }
    // 未确认搜索文本也视为占用；只给完全空白且未绑定槽位分配来源，每批/模块最多20条。
    async function prepare(item, db, task) {
      task.check(); await refresh(item, db); task.check(); item.recordBindings ||= {}; item.protectedRecords = new Set();
      let added = 0; let protectedGroups = 0; let remaining = 0;
      for (const initial of item.recordBlocks) {
        task.check();
        const belongs = (fieldId) => T.recordKind(db.fieldDefinitions.find((def) => def.fieldId === fieldId)?.group) === initial.kind;
        const roles=initial.kind==='education'?[...new Set(initial.records.flatMap((record)=>record.scanIds).map((id)=>item.fields.find((field)=>field.scanId===id)?.degree).filter(Boolean))]:[];
        const local = [null, ...db.entries.filter((entry) => entry.profileId === item.profileId && entry.kind === initial.kind).sort((a,b) => a.order-b.order || a.entryId.localeCompare(b.entryId)).map((entry) => entry.entryId)]
          .filter((entryId) => db.fieldValues.some((value) => value.profileId === item.profileId && value.entryId === entryId && belongs(value.fieldId) && M.hasValue(value.value))&&(roles.length!==1||M.sourceRole(db,item.profileId,{entryId},roles[0])));
        if (!local.length) continue;
        const occupied = (record) => record.scanIds.some((id) => { const row = item.rows.find((row) => row.field.scanId === id); return row?.webOccupied || row?.webFilled; });
        if (initial.records.some((record) => !Object.hasOwn(item.recordBindings,record.recordId) && (occupied(record) || record.scanIds.some((id) => { const row=item.rows.find((row)=>row.field.scanId===id); return row?.source==='memory' && row.memoryMatch!=='semantic' || row?.chosen && row.source==='manual'; })))) {
          protectedGroups++; initial.records.forEach((record)=>record.scanIds.forEach((id)=>item.protectedRecords.add(id))); continue;
        }
        const used=initial.records.filter((record)=>Object.hasOwn(item.recordBindings,record.recordId)).map((record)=>item.recordBindings[record.recordId]);const pending=local.filter((entryId)=>!used.includes(entryId));let block=initial;
        while (block.canAdd && roles.length<=1 && block.records.filter((record)=>!occupied(record)&&!Object.hasOwn(item.recordBindings,record.recordId)).length<pending.length && block.records.length<20 && task.budget.added<20) {
          task.check(); const latest=await session(item.sessionId); task.check(); if(latest.db.revision!==db.revision)throw new Error('资料已变化，已停止添加，请重新扫描');
          await pageMessage(item.tabId,{type:'learning:addRecord',documentId:item.documentId,blockId:block.blockId,operationId:task.id});task.budget.added++;added++;task.check();
          const after=await session(item.sessionId);task.check();if(after.db.revision!==db.revision)throw new Error('添加期间资料已变化，已停止，请重新扫描');
          await refresh(item,db);task.check();block=item.recordBlocks.find((row)=>row.blockId===initial.blockId);if(!block)throw new Error('模块已重建，请重新扫描，不继续猜测添加按钮');
        }
        if(!alive(item))throw new Error('页面已关闭，已停止补充经历');task.check();
        for(const record of block.records){
          const candidate=pending.findIndex((entryId)=>fits(item,db,{...record,kind:block.kind},entryId));
          if(!Object.hasOwn(item.recordBindings,record.recordId)&&!occupied(record)&&candidate>=0)item.recordBindings[record.recordId]=pending.splice(candidate,1)[0];
          if(!Object.hasOwn(item.recordBindings,record.recordId))record.scanIds.forEach((id)=>item.protectedRecords.add(id));
        }
        remaining+=pending.length;
      }
      synchronize(item,db);return {added,protectedGroups,remaining};
    }
    return Object.freeze({ prepare, synchronize });
  }
  global.LocalApplyRecordCoordinator=Object.freeze({ create });
})(globalThis);
