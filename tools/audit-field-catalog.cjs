// 公共词典只读审计：仅加载本仓库模板，不读取用户存储、不联网、不执行词典中的正则。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
let templates;

// 只运行固定的自有模板文件；沙箱不提供浏览器、网络、文件或动态代码生成能力。
function repositoryTemplates() {
  if (!templates) {
    const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/templates.js'), 'utf8'), context, { filename: 'data/templates.js', timeout: 1000 });
    templates = context.WangshenTemplates;
  }
  return templates;
}

// 明确投影公共元数据，禁止将模板的其他属性或个人库作为审计输入。
function repositoryCatalog() {
  const source = repositoryTemplates();
  return structuredClone({ fields: source.PROFILE_TEMPLATE.map(({ key, label, group, patterns }) => ({ key, label, group, patterns: patterns || [] })),
    synonyms: source.SYNONYMS.map(({ key, patterns, material }) => ({ key, patterns, material: !!material })), indexKeys: Object.keys(source.FIELD_INDEX) });
}

// 结构错误只报固定说明，不回显可能误传的个人数据或异常正文。
function check(ok) { if (!ok) throw new Error('审计仅接受有界公共词典元数据'); }

// 限定输入对象属性和字符串长度；正则标记只作为普通文本，不构造 RegExp。
function validateCatalog(input) {
  check(input && typeof input === 'object' && Object.keys(input).sort().join() === 'fields,indexKeys,synonyms');
  for (const name of ['fields', 'synonyms', 'indexKeys']) check(Array.isArray(input[name]) && input[name].length <= 2000);
  // 固定表达式只校验字段标识，不使用任何输入作为表达式代码。
  const key = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value);
  for (const value of input.indexKeys) check(key(value));
  for (const [scope, rows] of [['fields', input.fields], ['synonyms', input.synonyms]]) {
    for (const row of rows) {
      check(row && typeof row === 'object' && Object.keys(row).every((name) => (scope === 'fields' ? ['key', 'label', 'group', 'patterns'] : ['key', 'patterns', 'material']).includes(name)));
      check(key(row.key) && Array.isArray(row.patterns) && row.patterns.length <= 200);
      check(row.patterns.every((value) => typeof value === 'string' && value.length <= 1000));
      if (scope === 'fields') check(typeof row.label === 'string' && row.label.length <= 1000 && typeof row.group === 'string' && row.group.length <= 1000);
      else check(row.material === undefined || typeof row.material === 'boolean');
    }
  }
}

// 稳定排序不依赖系统语言，也不以出现顺序掩盖同名多目标。
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// 按实际 normalizeLabel 审计字面量；返回问题和上下文提示，绝不修改匹配策略。
function auditCatalog(input) {
  validateCatalog(input);
  const normalize = repositoryTemplates().normalizeLabel;
  const findings = []; const groups = new Map(input.fields.map((field) => [field.key, field.group]));
  const index = new Set(input.indexKeys); const aliases = new Map(); let literals = 0; let regex = 0;
  // 报告只记录允许的元数据字段，额外属性在入口已经拒绝。
  function add(code, scope, keys, detail = {}) { findings.push({ code, scope, keys: [...new Set(keys)].sort(compare), ...detail }); }
  // 各匹配入口分别统计，不能将旧词典与公共定义混成一个实际不存在的索引。
  function inspect(rows, scope) {
    const keys = new Set();
    for (const row of rows) {
      if (keys.has(row.key)) add('duplicate_key', scope, [row.key]);
      keys.add(row.key);
      if (!index.has(row.key)) add('missing_target', scope, [row.key]);
      if (row.material) continue;
      const seen = new Map();
      if (scope === 'fields' && (!normalize(row.label) || !normalize(row.group))) add('empty_metadata', scope, [row.key]);
      const patterns = [...row.patterns].sort(compare);
      const entries = scope === 'fields' ? [row.label, ...patterns] : patterns;
      for (let n = 0; n < entries.length; n++) {
        const raw = entries[n];
        if (raw.startsWith('re:')) { regex++; add('regex_review', scope, [row.key], { pattern: raw }); continue; }
        literals++;
        const normalized = normalize(raw);
        if (!normalized) { add('empty_alias', scope, [row.key]); continue; }
        // 默认 label 通常也在 patterns 中；仅 patterns 内的重复列为问题。
        if (!(scope === 'fields' && n === 0)) {
          if (seen.has(normalized)) add(seen.get(normalized) === raw ? 'duplicate_alias' : 'normalized_duplicate', scope, [row.key], { alias: raw, normalized });
          else seen.set(normalized, raw);
        }
        if (raw !== normalized) add('normalization_change', scope, [row.key], { alias: raw, normalized });
        const token = scope + ':' + normalized;
        if (!aliases.has(token)) aliases.set(token, { scope, normalized, targets: new Map() });
        aliases.get(token).targets.set(row.key, groups.get(row.key) || '其他');
      }
    }
  }
  inspect(input.fields, 'fields'); inspect(input.synonyms, 'synonyms');
  for (const { scope, normalized, targets } of aliases.values()) {
    if (targets.size < 2) continue;
    const byGroup = new Map();
    for (const [key, group] of targets) { if (!byGroup.has(group)) byGroup.set(group, []); byGroup.get(group).push(key); }
    for (const [group, keys] of byGroup) if (keys.length > 1) add('same_group_collision', scope, keys, { normalized, group });
    if (byGroup.size > 1) add('context_required', scope, [...targets.keys()], { normalized, groups: [...byGroup.keys()].sort(compare) });
  }
  // 去掉完全重复的提示，使报告与字段/别名排列无关，便于版本差异审查。
  const unique = [...new Map(findings.map((row) => [JSON.stringify(row), row])).values()].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const counts = {};
  for (const row of unique) counts[row.code] = (counts[row.code] || 0) + 1;
  return { kind: 'localapply-field-catalog-audit', version: 1,
    summary: { fields: input.fields.length, groups: new Set(input.fields.map((field) => field.group)).size, indexKeys: index.size,
      synonymGroups: input.synonyms.length, literalEntries: literals, regexEntries: regex, counts }, findings: unique };
}

// 命令行只接受固定输出模式，不接受任意脚本/输入路径；结果可自行重定向到忽略目录。
function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== '--json')) throw new Error('用法：node tools/audit-field-catalog.cjs [--json]');
  const report = auditCatalog(repositoryCatalog());
  if (args[0] === '--json') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write('LocalApply 公共词典只读审计（不判断实际填写准确率）\n' + JSON.stringify(report.summary, null, 2) + '\n');
    process.stdout.write('详细条目：npm run audit:fields -- --json；正则仅标记审查，跨分类同名需要上下文。\n');
  }
}

module.exports = { auditCatalog, repositoryCatalog, main };
if (require.main === module) {
  try { main(); } catch { process.stderr.write('公共词典审计失败，请检查元数据或命令参数；不输出输入内容。\n'); process.exitCode = 1; }
}
