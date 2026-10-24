// 扩展后台与本地文件页共用的 AI 客户端；配置通过注入函数读取，不依赖 Chrome API。
(function (global) {
  'use strict';
  // 为一种存储上下文创建独立客户端，不跨上下文读取或同步 Key。
  function createClient(readSettings) {
    const DEFAULT_TIMEOUT_MS = 30000;
    // 兼容现有解析管线的数据形状。
    async function getState() { return { settings: await readSettings() }; }
    // 使用统一的服务商解析，避免端点与凭据错配。
    function getProvider(settings) { return global.LocalApplyProviders.resolve(settings); }
    // 扫描件回退的视觉模型解析：主模型带视觉或用户显式配置了视觉模型才放行
    async function resolveVisionModel() {
      const state = await getState();
      const settings = state.settings || {};
      const provider = getProvider(settings);
      const vm = settings.visionModel || settings.model || '';
      if (!vm) throw aiError('请先在设置页获取模型列表并选择模型，或手动填写模型 ID。');
      const ok =
        provider.custom ||
        provider.visionDefault ||
        !!settings.visionModel ||
        (provider.visionModels || []).includes(vm);
      if (!ok) {
        throw aiError(
          `该 PDF 是扫描件，需要视觉模型。当前 ${provider.name} 的「${vm}」不支持图片输入。` +
          `解决办法：设置页把"视觉模型"设为该家的视觉型号（如 ${(provider.visionModels || [])[0] || '对应型号'}），` +
          `或换带视觉的服务商。不配置也行：对照 PDF 手动录入字段库即可。`
        );
      }
      return vm;
    }

    // ============ AI 调用 ============

    // 生成带可选诊断信息的统一 AI 错误。
    function aiError(message, detail) {
      const e = new Error(message);
      e.detail = detail;
      return e;
    }

    const jobs = new Map();
    // 请求可显式取消，超时覆盖响应体读取，错误不回显服务商原文或个人资料。
    async function callGLM(req) {
      const settings = (await getState()).settings;
      const provider = getProvider(settings);
      const key = settings.apiKeys?.[settings.provider] || '';
      if (!key && provider.requiresKey) throw aiError(`尚未配置 ${provider.name} 的 API Key，请先在设置页保存密钥。`);
      const model = req.model || settings.model || '';
      if (!model) throw aiError('请先获取模型列表并选择模型，或手动填写模型 ID。');
      const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
      if (!baseUrl) throw aiError('请先填写服务商接口地址。');
      const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      req.signal?.addEventListener('abort', cancel, { once: true });
      if (req.signal?.aborted) controller.abort();
      const timer = setTimeout(cancel, timeoutMs);
      try {
        const response = await fetch(baseUrl + '/chat/completions', { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({ model, messages: req.messages, temperature: req.temperature ?? 0.2, max_tokens: req.maxTokens, stream: false }),
          signal: controller.signal });
        if (!response.ok) {
          if (response.status === 401) throw aiError('API Key 无效（401），请检查当前服务商密钥。');
          if (response.status === 429) throw aiError('调用频率/额度受限（429），请稍后重试。');
          throw aiError('AI 接口返回 HTTP ' + response.status);
        }
        let data;
        try { data = await response.json(); }
        catch (error) { if (error.name === 'AbortError') throw error; throw aiError('AI 回复不是有效 JSON'); }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length > 300000) throw aiError('AI 返回格式异常或内容超限。');
        return { content, usage: data.usage || null, model };
      } catch (error) {
        if (controller.signal.aborted) throw aiError(req.signal?.aborted ? '已取消解析' : 'AI 请求超时，请重试或检查网络。');
        if (error instanceof TypeError) throw aiError('网络请求失败，请检查服务地址和访问权限。');
        throw error;
      } finally {
        clearTimeout(timer); req.signal?.removeEventListener('abort', cancel);
      }
    }
    // 一个导入对应一个可取消任务；结束后释放图像/全文引用，不写任何资料。
    async function extractResume(payload) {
      if (typeof payload.requestId !== 'string' || payload.requestId.length > 100) throw aiError('缺少解析任务标识');
      if (jobs.has(payload.requestId)) throw aiError('解析任务已存在');
      const controller = new AbortController(); jobs.set(payload.requestId, controller);
      try {
        let content;
        if (payload.pages?.length) content = await visionExtract(payload.pages, await resolveVisionModel(), controller.signal);
        else {
          if (typeof payload.text !== 'string' || payload.text.length > 100000) throw aiError('简历文本为空或超限');
          content = (await callGLM({ messages: [{ role: 'system', content: global.LocalApplyResume.prompt() },
            { role: 'user', content: payload.text }], signal: controller.signal, timeoutMs: 120000, maxTokens: 10000 })).content;
        }
        const data = extractJson(content);
        if (!data) throw aiError('AI 返回的内容无法解析为 JSON，请重试。');
        return data;
      } finally { jobs.delete(payload.requestId); }
    }
    // 仅取消指定任务，不影响其他页面正在执行的请求。
    function cancel(requestId) { jobs.get(requestId)?.abort(); }

    // 只向当前服务商获取模型 ID；不发送简历/聊天内容，不跟随携带凭据的重定向。
    async function listAvailableModels(expectedProviderId) {
      const state = await getState();
      const settings = state.settings;
      const provider = getProvider(settings);
      if (expectedProviderId && provider.providerId !== expectedProviderId) throw aiError('服务商已切换，请重新获取模型列表。');
      const key = settings.apiKeys?.[provider.providerId] || '';
      if (!key && provider.requiresKey) throw aiError('请先填写当前服务商的 API Key，再获取模型列表。');
      const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
      if (!baseUrl) throw aiError('请先填写服务商接口地址。');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetch(baseUrl + '/models', { method: 'GET',
          headers: { Accept: 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
          redirect: 'error', signal: controller.signal });
        if (!response.ok) {
          if ([401, 403].includes(response.status)) throw aiError('无法获取模型列表（' + response.status + '），请检查 API Key 和模型列表访问权限。');
          if ([404, 405].includes(response.status)) throw aiError('此服务未提供兼容的模型列表接口，可勾选「手动填写模型 ID」。');
          if (response.status === 429) throw aiError('获取模型列表受频率或额度限制（429），请稍后重试。');
          throw aiError('获取模型列表失败（HTTP ' + response.status + '），可稍后重试或手动填写。');
        }
        let data;
        try { data = await response.json(); }
        catch (error) {
          if (error.name === 'AbortError') throw error;
          throw aiError('模型列表不是有效 JSON，可重试或手动填写模型 ID。');
        }
        return { providerId: provider.providerId, baseUrl, models: LocalApplyProviders.parseModels(data) };
      } catch (error) {
        if (error.name === 'AbortError') throw aiError('获取模型列表超时，请检查服务地址或稍后重试。');
        if (error instanceof TypeError) throw aiError('无法连接模型列表接口，请检查地址、网络及站点访问权限。');
        throw error;
      } finally { clearTimeout(timer); }
    }

    // 从模型回复里稳健地抠出 JSON（容忍 ```json 围栏与前后杂文字）
    function extractJson(text) {
      if (!text) return null;
      let t = String(text).trim();
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) t = fence[1].trim();
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch (e) {
        return null;
      }
    }

    // 视觉模式：每页一条消息（含 PNG base64），顺序调用后合并
    async function visionExtract(pages, visionModel, signal) {
      if (pages.length > 30 || pages.reduce((n, page) => n + String(page.dataUrl).length, 0) > 16 * 1024 * 1024) throw aiError('扫描页数量或大小超限');
      const merged = {};
      const schemaPrompt = global.LocalApplyResume.prompt();
      for (const page of pages) {
        const out = await callGLM({
          model: visionModel, signal,
          messages: [
            { role: 'user', content: [
              { type: 'image_url', image_url: { url: page.dataUrl } },
              { type: 'text', text: schemaPrompt + (page.hint ? `\n（这是第 ${page.hint} 页）` : '') },
            ] },
          ],
          temperature: 0.2,
          timeoutMs: 120000,
          maxTokens: 10000,
        });
        const part = extractJson(out.content);
        if (part) mergeResumePart(merged, part);
      }
      return JSON.stringify(merged);
    }

    // 合并多页结构化结果，标量保留首值、数组按原策略合并。
    function mergeResumePart(dst, part) {
      for (const k of Object.keys(part)) {
        const v = part[k];
        if (v == null || v === '') continue;
        if (Array.isArray(v)) {
          if (!Array.isArray(dst[k])) dst[k] = [];
          for (const item of v) {
            if (item && typeof item === 'object') dst[k].push(item);
            else if (!dst[k].includes(item)) dst[k].push(item);
          }
        } else if (typeof v === 'object') {
          dst[k] = { ...(dst[k] || {}), ...v };
        } else if (!dst[k]) {
          dst[k] = v;
        }
      }
    }

    return { callGLM, extractResume, cancel, listAvailableModels, extractJson, resolveVisionModel, visionExtract, mergeResumePart, aiError };
  }
  global.LocalApplyAI = { createClient };
})(globalThis);
