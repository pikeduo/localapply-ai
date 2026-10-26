// 通过合成图片/文件的实际识别结果检测能力，不根据型号、HTTP 200 或模型自述推断。
(function (global) {
  'use strict';
  // 可选诊断结果与发送令牌独立，均按端点、模型和凭据隔离，不持久化探针文件。
  function create(readSettings, call) {
    const records = new Map();
    const routes = new Map();
    const TTL = 30 * 60 * 1000;
    // 协议也参与能力作用域；换协议后必须重测，凭据仅进入内存摘要。
    async function context(settings, model) {
      const provider = global.LocalApplyProviders.resolve(settings);
      const bytes = new TextEncoder().encode(JSON.stringify([provider.providerId, provider.baseUrl, provider.protocol, model, settings.apiKeys?.[provider.providerId] || '']));
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
            const out = await call({ model, expectedContext: scope, signal, fileInput: type !== 'image', disableThinking: true, timeoutMs: 30000, maxTokens: 512,
              messages: [{ role: 'user', content: [attachment, { type: 'text', text: '读取附件图片中唯一的8位数字，只回复数字。不要猜测，无法看到图片则回复 UNKNOWN。' }] }] });
            // 预期数字从未放入提示词，接口忽略附件或只回复“支持”也不能通过。
            report[type] = out.finishReason === 'length' ? 'unknown' : out.content.trim() === input.nonce ? 'supported' : 'unverified';
            if (report[type] !== 'supported') report.reasons[type] = out.finishReason === 'length'
              ? '检测输出被截断，可能是推理/输出预算不足，不能据此判定不支持识别' : '未正确读出测试图片，识别能力未验证';
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
    // 默认直接发送完整页面图；近期已确认支持原文件时沿用直传，不要求先执行诊断。
    async function route(type) {
      if (!['pdf', 'docx'].includes(type)) throw new Error('不支持的简历格式');
      const settings = await readSettings();
      const provider = global.LocalApplyProviders.resolve(settings);
      const models = [...new Set([settings.model, settings.visionModel].filter(Boolean))];
      if (!models.length) throw new Error('请先选择主模型或视觉模型');
      const candidates = [];
      for (const model of models) {
        const scope = await context(settings, model); const report = records.get(scope);
        if (report && Date.now() - report.checkedAt < TTL) candidates.push({ model, scope, report });
      }
      const native = candidates.find((item) => item.report[type] === 'supported');
      const model = settings.visionModel || settings.model;
      const chosen = native || { model, scope: await context(settings, model) };
      const mode = native ? 'file' : 'vision'; const key = JSON.stringify([type, mode, chosen.scope]);
      let ticket = routes.get(key);
      if (!ticket || Date.now() - ticket.createdAt >= TTL) { ticket = { token: crypto.randomUUID(), createdAt: Date.now() }; routes.delete(key); routes.set(key, ticket); }
      // 令牌只绑定此次配置和发送方式，不代表模型能力已验证；切换配置或过期须重新取令牌。
      while (routes.size > 64) routes.delete(routes.keys().next().value);
      return { mode, model: chosen.model, token: ticket.token,
        scope: chosen.scope, providerId: provider.providerId, baseUrl: provider.baseUrl, type };
    }
    return { context, probe, route };
  }
  global.LocalApplyCapabilities = { create };
})(globalThis);
