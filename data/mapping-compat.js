// 旧规则只投影为内存语义索引；不迁移指纹，不保存个人值或控件执行证据。
(function (global) {
  'use strict';
  const M = global.FieldMatchingEngine;
  const indexes = new WeakMap();

  // 散列只缩小范围，后续仍完整比较语义结构；origin/profile 不能跨域或跨档案。
  function key(origin, profileId, semantic) { return JSON.stringify([origin, profileId, semantic.key]); }
  // 对照完整规范描述，排除只靠散列相等或某一标签相同的命中。
  function equal(left, right) { return ['label','group','kind','degree'].every((name) => left[name] === right[name]); }

  // 每个不可变库投影按 revision 缓存，替换/导入的新对象或新版本必定重新建索引。
  function indexFor(db) {
    const previous = indexes.get(db);
    if (previous?.revision === db.revision && previous.rules === db.mappingRules) return previous.buckets;
    const buckets = new Map();
    for (const rule of db.mappingRules) {
      if (!rule.semanticId || !rule.features) continue; // 最老无特征规则仍需重新学习，不能升级为已验证。
      try { M.validateField({ ...rule.features, scanId:'scan.compat', semanticId:rule.semanticId, name:'', placeholder:'', options:[] }); }
      catch { continue; }
      const semantic = M.semanticDescriptor(rule.features); const bucket = key(rule.origin, rule.profileId, semantic);
      const row = { mappingId:rule.mappingId, semantic, control:M.controlDescriptor(rule.features), fieldId:rule.fieldId, entryId:rule.entryId,
        enabled:rule.enabled === true, verified:rule.confirmed === true && typeof rule.lastVerifiedAt === 'string' && Number.isFinite(Date.parse(rule.lastVerifiedAt)) };
      if (!buckets.has(bucket)) buckets.set(bucket, []); buckets.get(bucket).push(row);
    }
    indexes.set(db, { revision:db.revision, rules:db.mappingRules, buckets }); return buckets;
  }

  // 校验当前档案绑定及记录归属；索引只存元数据，不索引用户实际字段值。
  function owned(db, profileId, target, kind = '') {
    const definition = db.fieldDefinitions.find((row) => row.fieldId === target.fieldId);
    if (!definition || !db.profiles.some((row) => row.profileId === profileId)
      || !db.bindings.some((row) => row.profileId === profileId && row.fieldId === target.fieldId)) return false;
    const definedKind = global.WangshenTemplates.recordKind(definition.group);
    if (kind && definedKind !== kind) return false;
    return target.entryId === null || db.entries.some((row) => row.entryId === target.entryId && row.profileId === profileId && (!kind || row.kind === kind));
  }

  // 来源学历只核对档案中明确已有的枚举；未知/不符即交给人工，不按学校名或历史序号猜测。
  function educationRole(db, profileId, target, degree) {
    if (!degree) return true;
    const rank = M.degreeOf(db, { profileId, entryId:target.entryId });
    const expected = degree === 'highest' ? Math.max(0, ...[null, ...db.entries.filter((row) => row.profileId === profileId && row.kind === 'education').map((row) => row.entryId)]
      .map((entryId) => M.degreeOf(db, { profileId, entryId }))) : ({ first:2, undergrad:2, master:3, doctor:4 })[degree];
    return rank > 0 && rank === expected;
  }

  // 非精确命中只有当前控件确实变化时才参与；不凭历史 index 推断新记录配对。
  function find(db, profileId, origin, field, fields = [field], bindings = {}) {
    const semantic = M.semanticDescriptor(field); const control = M.controlDescriptor(field);
    const rules = (indexFor(db).get(key(origin, profileId, semantic)) || []).filter((row) => equal(row.semantic, semantic));
    if (!rules.some((row) => JSON.stringify(row.control) !== JSON.stringify(control))) return null;
    const targets = [...new Map(rules.map((row) => [JSON.stringify([row.fieldId,row.entryId]), { fieldId:row.fieldId, entryId:row.entryId }])).values()];
    const base = { target:null, candidates:targets.filter((target) => owned(db, profileId, target)), confirmed:false, memoryMatch:'semantic', verification:null };
    if (rules.some((row) => !row.enabled)) return { ...base, reason:'同语义存在已禁用的控件变体，请重新选择来源' };
    if (rules.some((row) => !row.verified)) return { ...base, reason:'同语义规则尚未确认或已修改，需重新选择及验证' };
    if (!semantic.label || !semantic.group) return { ...base, reason:'历史语义可能相同，但缺少完整分组上下文，请手动选择' };
    const fieldIds = new Set(rules.map((row) => row.fieldId));
    if (fieldIds.size !== 1) return { ...base, reason:'历史语义规则的字段来源冲突，请手动选择' };
    const definition = db.fieldDefinitions.find((row) => row.fieldId === rules[0].fieldId);
    const kind = semantic.kind || global.WangshenTemplates.recordKind(definition?.group) || '';
    let target;
    if (kind) {
      const binding = bindings[field.scanId];
      if (!binding || binding.kind !== kind || !Object.hasOwn(binding, 'entryId')) return { ...base, reason:'重复经历尚未绑定本次网页记录，不能沿用历史序号，请选择来源或绑定整条经历' };
      // 只复用 fieldId 关联，entryId 完全来自本次已确认整条记录绑定。
      target = { fieldId:rules[0].fieldId, entryId:binding.entryId };
    } else {
      if (targets.length !== 1 || targets[0].entryId !== null) return { ...base, reason:'历史语义规则的记录来源冲突，请手动选择' };
      if (fields.filter((row) => equal(M.semanticDescriptor(row), semantic)).length !== 1) return { ...base, reason:'当前页面存在多个同语义字段，请逐项选择来源' };
      target = targets[0];
    }
    if (!owned(db, profileId, target, kind) || rules.some((row) => !owned(db, profileId, row, kind))) return { ...base, reason:'历史来源已移除或不属于当前档案/模块，请重新选择' };
    if (kind === 'education' && !educationRole(db, profileId, target, semantic.degree)) return { ...base, reason:'当前绑定来源的学历不明确或不符合网页角色，请重新选择' };
    return { ...base, target, candidates:[target], confirmed:true, reason:'已复用本地字段语义；当前控件尚未验证，填写后独立回读' };
  }

  // 管理页只获得变体范围和控件类型，不把内存索引/语义 key 写回规则或备份。
  function scopes(db) {
    const result = [];
    for (const bucket of indexFor(db).values()) {
      const groups = new Map();
      for (const row of bucket) { const description = JSON.stringify([row.semantic.label,row.semantic.group,row.semantic.kind,row.semantic.degree]); if (!groups.has(description)) groups.set(description, []); groups.get(description).push(row); }
      for (const related of groups.values()) {
        const controls = [...new Set(related.map((other) => other.control.type))];
        for (const row of related) result.push({ mappingId:row.mappingId, count:related.length, controls:[...controls] });
      }
    }
    return result;
  }
  global.LocalApplyMappingCompat = Object.freeze({ find, scopes });
})(globalThis);
