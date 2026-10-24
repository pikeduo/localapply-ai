// 通过合成图片/文件的实际识别结果检测能力，不根据型号、HTTP 200 或模型自述推断。
(function (global) {
  'use strict';
  // 每个客户端独立缓存检测结果，按端点、模型和凭据隔离，不持久化任何探针文件。
  function create(readSettings, call) {
    const records = new Map();
    const TTL = 30 * 60 * 1000;
    // 凭据只参与内存中的摘要匹配，不出现在 UI、日志或缓存键明文中。
    async function context(settings, model) {
      const provider = global.LocalApplyProviders.resolve(settings);
      const bytes = new TextEncoder().encode(JSON.stringify([provider.providerId, provider.baseUrl, model, settings.apiKeys?.[provider.providerId] || '']));
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
    }
    // 仅验证输入封套；识别成功必须由模型回复中准确读出图片里的随机数字证明。
    function validate(probe) {
      if (!probe || !/^\d{8}$/.test(probe.nonce) || typeof probe.image !== 'string' || !probe.image.startsWith('data:image/jpeg;base64,')
        || probe.image.length > 500000) throw new Error('能力检测图片无效');
      for (const type of ['pdf', 'docx']) {
        const file = probe[type];
        const mime = type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (!file || file.filename !== 'probe.' + type || typeof file.file_data !== 'string'
          || !file.file_data.startsWith('data:' + mime + ';base64,') || file.file_data.length > 1000000) throw new Error('能力检测文件无效');
      }
    }
    // 分别实测图片、图片型 PDF、仅含图片的 DOCX，任何格式失败都不能提升其他能力。
    async function probe(input, signal) {
      validate(input);
      const settings = await readSettings();
      const models = [...new Set([settings.model, settings.visionModel].filter(Boolean))];
      if (!models.length) throw new Error('请先选择主模型或视觉模型');
      const results = [];
      for (const model of models) {
        const scope = await context(settings, model);
        const report = { model, checkedAt: Date.now(), token: crypto.randomUUID(), image: 'unknown', pdf: 'unknown', docx: 'unknown', reasons: {} };
        records.delete(scope);
        for (const type of ['image', 'pdf', 'docx']) {
          if (signal?.aborted) throw new Error('已取消能力检测');
          try {
            const attachment = type === 'image' ? { type: 'image_url', image_url: { url: input.image } } : { type: 'file', file: input[type] };
            const out = await call({ model, expectedContext: scope, signal, fileInput: type !== 'image', timeoutMs: 30000, maxTokens: 40,
              messages: [{ role: 'user', content: [attachment, { type: 'text', text: '读取附件图片中唯一的8位数字，只回复数字。不要猜测，无法看到图片则回复 UNKNOWN。' }] }] });
            // 预期数字从未放入提示词，接口忽略附件或只回复“支持”也不能通过。
            report[type] = out.content.trim() === input.nonce ? 'supported' : 'unverified';
            if (report[type] !== 'supported') report.reasons[type] = '未正确读出测试图片，识别能力未验证';
          } catch (error) {
            if (signal?.aborted) throw new Error('已取消能力检测');
            report[type] = ['HTTP_400', 'HTTP_404', 'HTTP_415', 'HTTP_422'].includes(error.code) ? 'unsupported' : 'unknown';
            report.reasons[type] = error.message;
          }
        }
        if (await context(await readSettings(), model) !== scope) throw new Error('检测期间服务商或凭据已变化，请重新检测');
        records.set(scope, report); results.push(report);
      }
      return { results };
    }
    // 只有当前配置、近期通过实测的能力可用于发送简历；先原文件，再完整页面图片。
    async function route(type) {
      if (!['pdf', 'docx'].includes(type)) throw new Error('不支持的简历格式');
      const settings = await readSettings();
      const provider = global.LocalApplyProviders.resolve(settings);
      const models = [...new Set([settings.model, settings.visionModel].filter(Boolean))];
      const candidates = [];
      for (const model of models) {
        const scope = await context(settings, model); const report = records.get(scope);
        if (report && Date.now() - report.checkedAt < TTL) candidates.push({ model, scope, report });
      }
      const native = candidates.find((item) => item.report[type] === 'supported');
      const visual = candidates.find((item) => item.model === settings.visionModel && item.report.image === 'supported')
        || candidates.find((item) => item.report.image === 'supported');
      const chosen = native || visual;
      if (!chosen) throw new Error('当前模型尚未通过此格式或图片识别检测，请先检测能力或更换支持文件/图片的模型。纯文本模型不能解析简历文件。');
      return { mode: native ? 'file' : 'vision', model: chosen.model, token: chosen.report.token,
        scope: chosen.scope, providerId: provider.providerId, baseUrl: provider.baseUrl, type };
    }
    return { context, probe, route };
  }
  global.LocalApplyCapabilities = { create };
})(globalThis);
