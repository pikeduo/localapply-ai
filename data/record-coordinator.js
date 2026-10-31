// 重复记录属于批次编排：为网页空槽或可靠对应的已有记录绑定会话来源，不包含单项控件执行逻辑。
(function (global) {
  'use strict';
  const M = global.FieldMatchingEngine; const T = global.WangshenTemplates;
  // 注入现有授权、扫描和消息接口，生产与测试复用相同编排，不直接读写数据库。
  function create({ refresh, session, pageMessage, alive }) {
    const automatic = new WeakMap();
    const identities = { education:['school','degree','major'], employment:['employmentCompany','employmentPosition'], internship:['internshipCompany','internshipPosition'], project:['projectName'] };
    // 当前记录的明确学历角色必须与已有来源一致；缺少学历时不按顺序硬塞。
    function fits(item,db,record,entryId){return record.kind!=='education'||record.scanIds.every((id)=>M.sourceRole(db,item.profileId,{entryId},item.fields.find((field)=>field.scanId===id)?.degree||''));}
    // 本地有内容的整条经历才参与配对，排除空模板并保留网页明确学历限制。
    function localSources(item, db, block) {
      const roles=block.kind==='education'?[...new Set(block.records.flatMap((record)=>record.scanIds).map((id)=>item.fields.find((field)=>field.scanId===id)?.degree).filter(Boolean))]:[];
      const local=[null,...db.entries.filter((entry)=>entry.profileId===item.profileId&&entry.kind===block.kind).sort((a,b)=>a.order-b.order||a.entryId.localeCompare(b.entryId)).map((entry)=>entry.entryId)]
        .filter((entryId)=>db.fieldValues.some((value)=>value.profileId===item.profileId&&value.entryId===entryId&&T.recordKind(db.fieldDefinitions.find((def)=>def.fieldId===value.fieldId)?.group)===block.kind&&M.hasValue(value.value))&&(roles.length!==1||M.sourceRole(db,item.profileId,{entryId},roles[0])));
      return {local,roles};
    }
    // 身份只规范排版空白与全半角，不作简称、模糊相似或按位置匹配。
    function identityText(value) { return typeof value==='string' ? value.normalize('NFKC').replace(/\s+/g,' ').trim() : ''; }
    // 绑定依据限当前记录及其已选中字段，值只驻留协调器内存，不进入库、日志或AI。
    function signature(item, record) { return JSON.stringify(record.scanIds.map((id)=>[id,item.fields.find((field)=>field.scanId===id)?.semanticId])); }
    // 明确映射和人工单项来源优先，未确认搜索词不能作为配对证据。
    function locked(item, record) { return record.scanIds.some((id)=>{const row=item.rows.find((row)=>row.field.scanId===id);return row?.source==='memory'&&row.memoryMatch!=='semantic'||row?.chosen&&row.source==='manual';}); }
    // 只读已授权记录的公共身份字段；多条配对必须有主身份，单条也保留原内容防止途中换条。
    async function anchors(item, db, block, record, task, requirePrimary = true) {
      const keys=identities[block.kind] || []; const result=[];
      for(const scanId of record.scanIds) {
        const row=item.rows.find((row)=>row.field.scanId===scanId); if(!row?.webFilled || row.ignored)continue;
        const def=M.definitionFor(db,row.field)?.definition;
        if(!def || !db.publicFieldIds.includes(def.fieldId) || !keys.includes(def.fieldId.replace(/^builtin\./,'')))continue;
        task.check(); const response=await pageMessage(item.tabId,{type:'learning:read',documentId:item.documentId,scanId,semanticId:row.field.semanticId}); task.check();
        const options=row.field.options.filter((option)=>option.value===response.value); if(options.length>1)return [];
        const text=identityText(options.length===1?options[0].text:response.value); if(!text || text.length>200)continue;
        if(result.some((anchor)=>anchor.fieldId===def.fieldId))return [];
        result.push({scanId,fieldId:def.fieldId,text});
      }
      return !requirePrimary || result.some((anchor)=>anchor.fieldId==='builtin.'+keys[0])?result:[];
    }
    // 已填记录仅在单条唯一或身份精确且双向唯一时自动关联，歧义记录不拖累已确认记录。
    async function bindExisting(item, db, block, local, occupied, task) {
      const unbound=block.records.filter((record)=>!Object.hasOwn(item.recordBindings,record.recordId));
      if(unbound.some((record)=>locked(item,record)))return;
      const evidence=automatic.get(item) || new Map(); automatic.set(item,evidence);
      const proposals=[];
      for(const record of unbound.filter(occupied)) {
        if(record.scanIds.some((id)=>{const row=item.rows.find((row)=>row.field.scanId===id);return row?.webOccupied&&!row.webFilled;}))continue;
        const single=block.records.length===1&&local.length===1;
        const read=await anchors(item,db,block,record,task,!single);
        const candidates=local.filter((entryId)=>fits(item,db,{...record,kind:block.kind},entryId)&&(single||read.length&&read.every((anchor)=>identityText(M.valueOf(db,item.profileId,{fieldId:anchor.fieldId,entryId})?.value)===anchor.text)));
        proposals.push({record,candidates,anchors:read,mode:single?'single':'identity'});
      }
      task.check(); const latest=await session(item.sessionId); task.check(); if(latest.db.revision!==db.revision)throw new Error('资料已变化，请重新识别经历');
      const used=new Set(block.records.filter((record)=>Object.hasOwn(item.recordBindings,record.recordId)).map((record)=>item.recordBindings[record.recordId]));
      for(const proposal of proposals) {
        const entryId=proposal.candidates[0];
        if(proposal.candidates.length!==1 || used.has(entryId) || proposals.some((other)=>other!==proposal&&other.candidates.includes(entryId)))continue;
        item.recordBindings[proposal.record.recordId]=entryId; used.add(entryId);
        evidence.set(proposal.record.recordId,{entryId,blockId:block.blockId,mode:proposal.mode,signature:signature(item,proposal.record),anchors:proposal.anchors});
      }
    }
    // 自动配对在每次写入前重核文档、记录与身份；网页手改后只撤销本会话配对，不回写网页。
    async function validateBinding(item, db, scanId, task) {
      const selected=item.rows.find((row)=>row.field.scanId===scanId);
      if(selected?.chosen&&selected.source==='manual')return true; // 用户主动核对的单项来源继续优先，不用自动推断反向拦截。
      const evidence=automatic.get(item); const original=(item.recordBlocks || []).flatMap((block)=>block.records).find((record)=>record.scanIds.includes(scanId));
      const saved=original&&evidence?.get(original.recordId); if(!saved)return true;
      if(item.recordBindings[original.recordId]!==saved.entryId) { evidence.delete(original.recordId); return true; }
      await refresh(item,db); task.check();
      const block=item.recordBlocks.find((block)=>block.blockId===saved.blockId); const record=block?.records.find((record)=>record.recordId===original.recordId);
      let valid=!!record&&signature(item,record)===saved.signature&&Object.hasOwn(item.recordBindings,record.recordId)&&item.recordBindings[record.recordId]===saved.entryId;
      if(valid&&saved.mode==='single') { const {local}=localSources(item,db,block); valid=block.records.length===1&&local.length===1&&local[0]===saved.entryId&&!record.scanIds.some((id)=>{const row=item.rows.find((row)=>row.field.scanId===id);return row?.webOccupied&&!row.webFilled;}); }
      if(valid) {
        const current=await anchors(item,db,block,record,task,saved.mode!=='single');
        // 单条允许网页原解析值不同，但必须保持原内容；本批新填身份字段仍须与本地来源一致。
        valid=saved.anchors.every((anchor)=>current.some((next)=>JSON.stringify(next)===JSON.stringify(anchor)))&&current.every((anchor)=>saved.mode==='single'&&saved.anchors.some((previous)=>JSON.stringify(previous)===JSON.stringify(anchor))||identityText(M.valueOf(db,item.profileId,{fieldId:anchor.fieldId,entryId:saved.entryId})?.value)===anchor.text);
      }
      const latest=await session(item.sessionId); task.check(); if(latest.db.revision!==db.revision)throw new Error('资料已变化，请重新识别经历');
      if(valid)return true;
      evidence.delete(original.recordId); delete item.recordBindings[original.recordId]; item.protectedRecords ||= new Set();
      for(const id of new Set([...original.scanIds,...(record?.scanIds || [])])) { item.protectedRecords.add(id); const row=item.rows.find((row)=>row.field.scanId===id); if(row?.source==='record'){delete row.chosen;delete row.verification;delete row.conflict;} }
      synchronize(item,db); return false;
    }
    // 用户确认整条经历配对后，人工决定取代自动依据，后续不再用旧解析身份反向拦截。
    function confirmBinding(item, recordId) { automatic.get(item)?.delete(recordId); }
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
    // 已填记录先尝试可靠配对，歧义和未确认搜索仍保护；空槽沿用原增补顺序及20条上限。
    async function prepare(item, db, task) {
      task.check(); await refresh(item, db); task.check(); item.recordBindings ||= {}; item.protectedRecords = new Set();
      let added = 0; let protectedGroups = 0; let remaining = 0;
      for (const initial of item.recordBlocks) {
        task.check();
        const {local,roles}=localSources(item,db,initial);
        if (!local.length) continue;
        const occupied = (record) => record.scanIds.some((id) => { const row = item.rows.find((row) => row.field.scanId === id); return row?.webOccupied || row?.webFilled; });
        await bindExisting(item,db,initial,local,occupied,task); task.check();
        if (initial.records.some((record) => !Object.hasOwn(item.recordBindings,record.recordId) && (occupied(record) || locked(item,record)))) {
          protectedGroups++; initial.records.filter((record)=>!Object.hasOwn(item.recordBindings,record.recordId)).forEach((record)=>record.scanIds.forEach((id)=>item.protectedRecords.add(id))); continue;
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
    return Object.freeze({ prepare, synchronize, validateBinding, confirmBinding });
  }
  global.LocalApplyRecordCoordinator=Object.freeze({ create });
})(globalThis);
