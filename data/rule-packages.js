// 离线公共规则包：校验/差异/受限回滚均为纯数据操作，不下载、不执行规则脚本或读取凭据。
(function (global) {
  'use strict';
  const KEY = 'localapply.rulePackages';
  // 错误不回显输入正文；传输对象仅允许明确的数据属性。
  function check(ok, message = '离线规则包格式错误') { if (!ok) throw new Error(message); }
  // 拒绝额外属性和访问器，防止公共包夹带个人值、脚本或隐式计算。
  function shape(value, keys) {
    check(value && Object.prototype.toString.call(value) === '[object Object]');
    check(Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
  }
  // 深拷贝只用于已校验 JSON 数据，不保留页面或库对象引用。
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  // 字段对象键顺序不构成更新或漂移，数组原文及顺序仍参与内容比较。
  function publicDefinition(input) {
    const value = global.LocalApplyStore.definition(input);
    return Object.fromEntries(['fieldId', 'label', 'type', 'group', 'aliases', 'options', 'description', 'version'].map((key) => [key, value[key]]));
  }
  // 只比较公共定义，不能用该方法比较或归一化个人字段值。
  function sameDefinition(left, right) { return JSON.stringify(publicDefinition(left)) === JSON.stringify(publicDefinition(right)); }
  // 元数据文本有界，包不接受任意 HTML、令牌或包含凭据的来源地址。
  function text(value, max = 120) { check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[<>\u0000-\u001f]|Bearer\s|sk-[\w-]+/i.test(value)); }
  // SHA-256 仅证明内容一致性，不能证明包来自可信作者。
  async function digest(value) {
    const bytes = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // 规范固定键顺序与字段顺序，保持别名/选项原文，不转换任何个人值。
  function body(input) {
    check(input.kind === 'localapply-rule-package' && input.formatVersion === 1);
    text(input.packageId); check(/^[a-z][a-z0-9.-]{2,119}$/.test(input.packageId));
    check(Number.isSafeInteger(input.release) && input.release > 0);
    shape(input.compatibility, ['minSchema', 'maxSchema', 'fillContract']);
    const { minSchema, maxSchema, fillContract } = input.compatibility;
    check(Number.isInteger(minSchema) && Number.isInteger(maxSchema) && minSchema > 0 && maxSchema >= minSchema && fillContract === 1, '规则包兼容范围错误');
    shape(input.source, ['name', 'reference']); text(input.source.name, 80);
    check(typeof input.source.reference === 'string' && input.source.reference.length <= 500);
    if (input.source.reference) {
      let url; try { url = new URL(input.source.reference); } catch { throw new Error('规则包来源地址格式错误'); }
      check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, '来源只允许不含凭据和查询参数的公开HTTPS地址');
    }
    check(Array.isArray(input.fields) && input.fields.length > 0 && input.fields.length <= 2000);
    const fields = input.fields.map(publicDefinition); const ids = new Set(fields.map((field) => field.fieldId));
    check(ids.size === fields.length, '规则包字段ID重复');
    fields.sort((a, b) => a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0);
    return { kind: input.kind, formatVersion: 1, packageId: input.packageId, release: input.release,
      compatibility: { minSchema, maxSchema, fillContract }, source: { name: input.source.name, reference: input.source.reference }, fields };
  }
  // 创建公开离线包，调用者只能提供独立审核的定义；不会自动读取个人库。
  async function create(input) {
    shape(input, ['kind', 'formatVersion', 'packageId', 'release', 'compatibility', 'source', 'fields']);
    const result = body(input); check(new TextEncoder().encode(JSON.stringify(result)).length <= 1024 * 1024 - 80, '规则包超过1MiB');
    return { ...result, sha256: await digest(result) };
  }
  // 完整校验包内容及摘要；无联网、降级兼容或执行任意选择器的路径。
  async function parse(input) {
    shape(input, ['kind', 'formatVersion', 'packageId', 'release', 'compatibility', 'source', 'fields', 'sha256']);
    check(new TextEncoder().encode(JSON.stringify(input)).length <= 1024 * 1024, '规则包超过1MiB');
    check(typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.sha256));
    const result = body(input); check(await digest(result) === input.sha256, '规则包内容摘要不符'); return { ...result, sha256: input.sha256 };
  }
  // 本机安装回执单独保存，最多10个包/每包3个版本；不进入公共包或个人备份。
  function registry(input = { version: 1, packages: [] }) {
    shape(input, ['version', 'packages']); check(input.version === 1 && Array.isArray(input.packages) && input.packages.length <= 10, '本机规则包记录格式错误');
    const ids = new Set();
    for (const entry of input.packages) {
      shape(entry, ['packageId', 'releases']); text(entry.packageId); check(/^[a-z][a-z0-9.-]{2,119}$/.test(entry.packageId) && !ids.has(entry.packageId)); ids.add(entry.packageId);
      check(Array.isArray(entry.releases) && entry.releases.length > 0 && entry.releases.length <= 3, '规则包版本记录已达上限');
      let previous = 0;
      for (const release of entry.releases) {
        shape(release, ['release', 'sha256', 'source', 'fieldIds', 'changes']);
        check(Number.isSafeInteger(release.release) && release.release > previous); previous = release.release;
        check(typeof release.sha256 === 'string' && /^[a-f0-9]{64}$/.test(release.sha256));
        shape(release.source, ['name', 'reference']); text(release.source.name, 80); check(typeof release.source.reference === 'string' && release.source.reference.length <= 500);
        check(Array.isArray(release.fieldIds) && release.fieldIds.length <= 2000 && new Set(release.fieldIds).size === release.fieldIds.length && release.fieldIds.every((fieldId) => typeof fieldId === 'string' && fieldId.length > 0 && fieldId.length <= 500));
        check(Array.isArray(release.changes) && release.changes.length <= 2000); const fields = new Set();
        for (const change of release.changes) {
          shape(change, ['fieldId', 'before', 'after', 'bindingFids']); text(change.fieldId, 500); check(release.fieldIds.includes(change.fieldId) && !fields.has(change.fieldId)); fields.add(change.fieldId);
          if (change.before !== null) check(global.LocalApplyStore.definition(change.before).fieldId === change.fieldId);
          check(global.LocalApplyStore.definition(change.after).fieldId === change.fieldId);
          check(Array.isArray(change.bindingFids) && change.bindingFids.length <= 1000 && change.bindingFids.every((fid) => typeof fid === 'string' && fid.length <= 500));
        }
      }
    }
    check(new TextEncoder().encode(JSON.stringify(input)).length <= 4 * 1024 * 1024, '本机规则包记录超过4MiB，请先导出并检查');
    return clone(input);
  }
  // 包级版本、字段版本与数据库Schema分开；预览逐项展示实际差异，不持久化个人值。
  async function preview(input, db, installed) {
    const pack = await parse(input); const records = registry(installed);
    check(db.schemaVersion >= pack.compatibility.minSchema && db.schemaVersion <= pack.compatibility.maxSchema, '规则包不兼容当前Schema');
    const last = records.packages.find((row) => row.packageId === pack.packageId)?.releases.at(-1);
    check(!last || pack.release > last.release || pack.release === last.release && pack.sha256 === last.sha256, '规则包版本倒退或同版本内容冲突');
    const changes = []; const conflicts = [];
    for (const after of pack.fields) {
      const before = db.fieldDefinitions.find((def) => def.fieldId === after.fieldId) || null;
      if (before && sameDefinition(before, after)) continue;
      let reason = '';
      if (before && !db.publicFieldIds.includes(before.fieldId)) reason = 'private_id';
      else if (before && (before.label !== after.label || before.group !== after.group || before.type !== after.type)) reason = 'semantic_change';
      else if (before && after.version <= before.version) reason = 'field_version';
      if (reason) conflicts.push({ fieldId: after.fieldId, reason });
      else changes.push({ fieldId: after.fieldId, before: clone(before), after: clone(after) });
    }
    // 已安装同版本时也核对当前元数据，漂移后不能用旧回执静默覆盖。
    if (last && pack.release === last.release) check(changes.length === 0 && conflicts.length === 0, '已安装字段发生变化，请人工检查');
    return { packageId: pack.packageId, release: pack.release, sha256: pack.sha256, source: pack.source, fieldIds: pack.fields.map((def) => def.fieldId), revision: db.revision, changes, conflicts,
      alreadyInstalled: !!last && pack.release === last.release };
  }
  // 安装后保存实际生成的空绑定身份；已有字段不新增绑定，删除过的简历项不复活。
  function installed(plan, db, previous) {
    const next = registry(previous); let entry = next.packages.find((row) => row.packageId === plan.packageId);
    if (!entry) { entry = { packageId: plan.packageId, releases: [] }; next.packages.push(entry); }
    check(entry.releases.length < 3, '规则包版本记录已达上限，请先检查或回滚');
    entry.releases.push({ release: plan.release, sha256: plan.sha256, source: plan.source, fieldIds: [...plan.fieldIds], changes: plan.changes.map((change) => ({ ...clone(change),
      bindingFids: change.before ? [] : db.bindings.filter((binding) => binding.fieldId === change.fieldId).map((binding) => binding.fid) })) });
    return registry(next);
  }
  // 回滚仅改包的元数据贡献：有值/映射/后续绑定/定义改动时拒绝删除，禁止恢复整份个人库。
  function rollback(db, installed, packageId) {
    const records = registry(installed); const entry = records.packages.find((row) => row.packageId === packageId); check(entry, '规则包未安装');
    const last = entry.releases.at(-1); const conflicts = [];
    for (const change of last.changes) {
      const current = db.fieldDefinitions.find((def) => def.fieldId === change.fieldId);
      let reason = '';
      if (records.packages.some((row) => row.packageId !== packageId && row.releases.at(-1).fieldIds.includes(change.fieldId))) reason = 'other_package';
      else if (!current || !db.publicFieldIds.includes(change.fieldId) || !sameDefinition(current, change.after)) reason = 'metadata_changed';
      else if (change.before === null) {
        if (db.fieldValues.some((row) => row.fieldId === change.fieldId && global.FieldMatchingEngine.hasValue(row.value))) reason = 'has_values';
        else if (db.mappingRules.some((row) => row.fieldId === change.fieldId)) reason = 'has_mappings';
        else if (db.bindings.some((row) => row.fieldId === change.fieldId && !change.bindingFids.includes(row.fid))) reason = 'bindings_changed';
      }
      if (reason) conflicts.push({ fieldId: change.fieldId, reason });
    }
    return { packageId, release: last.release, sha256: last.sha256, source: clone(last.source), revision: db.revision, changes: clone(last.changes), conflicts };
  }
  global.LocalApplyRulePackages = Object.freeze({ KEY, create, parse, registry, preview, installed, rollback });
})(globalThis);
