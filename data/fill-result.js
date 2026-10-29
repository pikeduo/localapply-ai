// 填写终态与诊断原因的纯数据契约；不读取 DOM、个人资料或持久层。
(function (global) {
  'use strict';
  const REASONS = Object.freeze({
    verified: '填写后回读验证成功', popup_not_found: '未找到属于当前控件的弹层', options_not_found: '弹层已关联但没有可选项',
    no_exact_option: '候选中没有唯一精确匹配', ambiguous_option: '存在多个相同候选，已停止选择', focus_lost: '打开弹层后焦点离开当前控件',
    value_not_accepted: '网页未接受新值或选项，可能已回退', existing_value_preserved: '网页已有内容，已保留', invalid_date: '日期格式或范围不符合要求',
    insufficient_date_precision: '本地日期精度不足，未补月日', unsupported_control: '控件结构暂不支持', invalid_value_type: '资料类型不符合控件要求',
    write_rejected: '控件拒绝写入，未重复执行', operation_error: '填写通信或校验发生异常', cancelled: '已取消填写',
    stale_context: '页面、授权或控件已变化，已停止填写', stale_plan: '填写计划已失效，请重新准备', readonly_control: '只读控件需要网页手动操作',
    disabled_control: '控件或目标选项已禁用', protected_control: '受保护控件不允许自动填写',
    validation_failed: '网页校验未通过，未记为填写成功', controlled_reverted: '网页曾接受新值，但随后回退'
  });
  const enums = Object.freeze({ adapter: ['moka-dropdown','native-select','aria-combobox','date','phone','address','radio','checkbox','text'],
    phase: ['plan','protect','open','options','select','write','verify'], status: ['success','failed','unsupported','needs_confirmation'],
    part: ['year','month','day','country','number','province','city','district'], controlType: ['text','textarea','email','tel','number','url','date','month','datetime-local','select','radio','checkbox','combobox','contenteditable'],
    fieldKind: ['education','employment','internship','project','award','family','certificate','paper'], popupRelation: ['aria','portal','local','none'],
    guardCheck: ['context','members','attributes','safety','value','date_projection'] }); // 固定保护检查名称，不记录变化前后内容。

  // 只投影固定枚举/数字/布尔；网页文字、错误正文、来源与计划一律丢弃。
  function trace(detail) {
    const result = {}; if (!detail || typeof detail !== 'object') return result;
    for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(detail[key])) result[key] = detail[key];
    if (Object.hasOwn(REASONS, detail.reasonCode)) result.reasonCode = detail.reasonCode;
    for (const key of ['fieldNumber','candidateCount','matchCount','popupCount','newPopupCount','elapsedMs']) if (Number.isInteger(detail[key]) && detail[key] >= 0) result[key] = Math.min(detail[key], 10000000);
    for (const key of ['searchable','focused','associatedPopup','traceAvailable']) if (typeof detail[key] === 'boolean') result[key] = detail[key];
    return result;
  }

  // 统一失败形状，保留原有四种终态；不能用任意异常文字生成日志或 UI 提示。
  function failure(reasonCode, status = 'failed', detail = {}) {
    const code = Object.hasOwn(REASONS, reasonCode) && reasonCode !== 'verified' ? reasonCode : 'operation_error';
    return { ok: false, status: ['failed','unsupported','needs_confirmation'].includes(status) ? status : 'failed', reason: REASONS[code], diagnostic: { ...trace(detail), reasonCode: code } };
  }

  // 旧局部适配器的固定提示在此单点桥接；回退须由实际观察证明，不能从文字猜测。
  function legacyCode(result) {
    const reason = typeof result?.reason === 'string' ? result.reason : '';
    if (/取消/.test(reason)) return 'cancelled';
    if (/计划.*(失效|尚未执行|不匹配)/.test(reason)) return 'stale_plan';
    if (/已变化|已失效|授权.*失效|重新扫描|停止验证/.test(reason)) return 'stale_context';
    if (/受保护|认证/.test(reason)) return 'protected_control';
    if (/只读/.test(reason)) return 'readonly_control';
    if (/禁用|未启用/.test(reason)) return 'disabled_control';
    if (/精度|只有年|不能.*补日/.test(reason)) return 'insufficient_date_precision';
    const code = result?.diagnostic?.reasonCode;
    if (Object.hasOwn(REASONS, code) && code !== 'verified') return code;
    if (/日期/.test(reason) && result?.status !== 'unsupported') return 'invalid_date';
    return result?.status === 'needs_confirmation' ? 'existing_value_preserved' : result?.status === 'unsupported' ? 'unsupported_control' : 'write_rejected';
  }

  // 终态边界不接受 ready/执行尝试为成功；合法差异仅留在响应中，日志只取 trace。
  function normalize(result, detail = {}) {
    const diagnostic = trace({ ...detail, ...result?.diagnostic });
    if (result?.ok === true && result.status === 'success' && typeof result.verifiedAt === 'string' && Number.isFinite(Date.parse(result.verifiedAt))) {
      return { ok: true, status: 'success', verifiedAt: result.verifiedAt, diagnostic: { ...diagnostic, reasonCode: 'verified', status: 'success' } };
    }
    const next = failure(legacyCode(result), result?.status, diagnostic); next.diagnostic.status = next.status;
    if (next.status === 'needs_confirmation' && result?.conflict) next.conflict = { before: result.conflict.before, after: result.conflict.after };
    return next;
  }
  global.LocalApplyFillResult = Object.freeze({ REASONS, trace, failure, normalize });
})(globalThis);
