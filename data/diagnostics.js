// 本地诊断日志：只保存白名单操作、数量、耗时及错误分类，绝不接收资料或原始错误正文。
(function (global) {
  'use strict';
  const KEY = 'localapply.diagnostics';
  const MAX_ROWS = 400;
  const operations = ['panel.open','panel.close','page.presence','page.error','ui.error','learning.scanPage','learning.prepareAI','learning.recognize','learning.select','learning.readField','learning.previewValue','learning.commitValue','learning.fill','learning.remember','learning.revoke','learning.editRule','learning.deleteRule','learning.undoRule','localapply.command','localapply.saveLegacy','localapply.vault','localapply.previewImport','wsa.aiChat','wsa.listModels','wsa.probeCapabilities','wsa.resumeRoute','wsa.aiExtractResume','wsa.cancelResume','runtime.request'];
  // 将异常归为稳定错误码，外部响应、用户标签和凭据不进入日志。
  function errorInfo(error) {
    const message = String(error?.message || error || '');
    const status = Number(message.match(/(?:HTTP\s*|[（(])(401|403|404|405|429|5\d\d)/i)?.[1]) || null;
    const code = /超时|timeout/i.test(message) ? 'timeout' : /取消|abort/i.test(message) ? 'cancelled' : /401|403|密钥|口令|Key/i.test(message) ? 'credentials' : /429|额度|频率/.test(message) ? 'rate_limit' : /网络|连接|fetch/i.test(message) ? 'network' : /授权|仅允许|权限|过期|导航|切换/.test(message) ? 'authorization' : /JSON|校验|格式|Schema|无效|变化|不存在|缺少|请选择/.test(message) ? 'validation' : status >= 500 ? 'server' : 'unexpected';
    const location = String(error?.stack || '').match(/(?:chrome-extension:\/\/[^/]+\/)?((?:data|content|panel|options|sidepanel)\/[a-z0-9-]+\.js|background\.js|common\.js):(\d+):(\d+)/i);
    return { code, ...(status ? { httpStatus: status } : {}), ...(location ? { file: location[1], line: Number(location[2]), column: Number(location[3]) } : {}) };
  }
  // 序列化读写并限制七天/400 条，日志存储独立于资料与备份。
  function create(storage) {
    let pending = Promise.resolve();
    // 每次只接收有限的固定操作与数字统计，调用方无法夹带任意文本。
    function append(operation, detail = {}) {
      if (!operations.includes(operation)) operation = 'runtime.request';
      const row = { id: crypto.randomUUID(), at: new Date().toISOString(), operation, level: ['DEBUG','INFO','WARNING','ERROR'].includes(detail.level) ? detail.level : 'INFO' };
      for (const key of ['durationMs','count','success','failed']) if (Number.isFinite(detail[key]) && detail[key] >= 0) row[key] = Math.min(Math.round(detail[key]), 10000000);
      if (['application','login','other'].includes(detail.kind)) row.kind = detail.kind;
      if (detail.error) Object.assign(row, errorInfo(detail.error));
      const job = pending.then(async () => { const data = await storage.get(KEY); const cutoff = Date.now() - 7 * 86400000;
        const rows = Array.isArray(data[KEY]) ? data[KEY].filter((item) => Date.parse(item.at) >= cutoff).slice(-(MAX_ROWS - 1)) : [];
        await storage.set({ [KEY]: [...rows, row] });
      });
      pending = job.catch(() => {}); return job;
    }
    // 读取等待已有写入，导出不会丢掉刚完成的错误记录。
    async function read() { await pending; const data = await storage.get(KEY); const cutoff = Date.now() - 7 * 86400000; return { version: 1, rows: (data[KEY] || []).filter((row) => Date.parse(row.at) >= cutoff).slice(-MAX_ROWS) }; }
    // 清理仅删除诊断日志，不能影响个人库或凭据。
    function clear() { const job = pending.then(() => storage.set({ [KEY]: [] })); pending = job.catch(() => {}); return job; }
    return { append, read, clear };
  }
  global.LocalApplyDiagnostics = { create, errorInfo, KEY };
})(globalThis);
