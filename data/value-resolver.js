// 选项语义只处理明确的公共等价，不读取 DOM/个人库，不修改来源值或选择首项。
(function (global) {
  'use strict';
  // 保留普通词间空格，仅规范全角、零宽字符和排版空白。
  function normalize(value) { return String(value).normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim(); }

  // 按后台来源 fieldId 使用有限业务同义词；一年以内/以上、在校生均不与一年以下混同。
  function equivalent(fieldId, actual, expected) {
    const left = normalize(actual); const right = normalize(expected);
    if (left === right) return true;
    if (fieldId === 'builtin.workExperience') {
      const belowOne = /^(?:(?:1|一)\s*年以下(?:(?:工作)?经验)?|不足\s*(?:1|一)\s*年|少于\s*(?:1|一)\s*年)$/;
      const graduate = /^(应届生|应届毕业生)$/;
      return belowOne.test(left) && belowOne.test(right) || graduate.test(left) && graduate.test(right);
    }
    if (fieldId === 'builtin.gender') return ['男', '男性'].includes(left) && ['男', '男性'].includes(right) || ['女', '女性'].includes(left) && ['女', '女性'].includes(right);
    return false;
  }

  // 只返回当前候选序号及固定原因；重复标签/编码或禁用项不因等价解析而放宽。
  function resolve(fieldId, value, options) {
    if (!['string', 'number'].includes(typeof value) || !Array.isArray(options) || options.length > 500
      || options.some((row) => !row || typeof row.label !== 'string' || typeof row.value !== 'string')) return { status: 'incompatible', reasonCode: 'unsupported_control', matchCount: 0 };
    const found = options.map((row, index) => ({ row, index })).filter(({ row }) => row.value === String(value) || equivalent(fieldId, row.label, value));
    if (found.length !== 1) return { status: found.length ? 'ambiguous' : 'incompatible', reasonCode: found.length ? 'ambiguous_option' : 'no_exact_option', matchCount: found.length };
    const { row, index } = found[0];
    if (options.some((other, n) => n !== index && (other.value === row.value || equivalent(fieldId, other.label, row.label)))) return { status: 'ambiguous', reasonCode: 'ambiguous_option', matchCount: found.length };
    if (row.disabled || row.protected) return { status: 'incompatible', reasonCode: 'unsupported_control', matchCount: found.length };
    return { status: 'resolved', index, reasonCode: row.value === String(value) || normalize(row.label) === normalize(value) ? 'exact' : 'explicit_equivalent', matchCount: 1 };
  }

  global.LocalApplyValueResolver = Object.freeze({ normalize, equivalent, resolve });
})(globalThis);
