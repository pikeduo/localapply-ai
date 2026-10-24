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

    // 按当前服务商调用兼容接口；自定义/本地服务可不发送认证头。
    async function callGLM(req) {
      const state = await getState();
      const settings = state.settings || {};
      const provider = getProvider(settings);
      const key = (settings.apiKeys || {})[settings.provider] || '';
      if (!key && provider.requiresKey) {
        throw aiError(`尚未配置 ${provider.name} 的 API Key。不配置 AI 也完全可以使用：在字段库手动录入后一键填充不受影响；如需 PDF 提取/开放题起草，请到设置页填写。`);
      }
      const model = req.model || settings.model || '';
      if (!model) throw aiError('请先获取模型列表并选择模型，或手动填写模型 ID。');
      const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
      if (!baseUrl) throw aiError('自定义服务商缺少接口地址，请到设置页填写（OpenAI 兼容地址，如 https://xx.com/v1）。');
      const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
          redirect: 'error', // 不把端点 A 的凭据经重定向转发到其他服务商。
          body: JSON.stringify({
            model,
            messages: req.messages,
            temperature: req.temperature != null ? req.temperature : 0.6,
            max_tokens: req.maxTokens,
            stream: false,
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw aiError(`AI 请求超时（${Math.round(timeoutMs / 1000)} 秒），请重试或检查网络。`);
        }
        throw aiError('网络请求失败：' + (err && err.message ? err.message : String(err)));
      } finally {
        clearTimeout(timer);
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        /* 保留 data=null，走下面的状态码分支 */
      }
      if (!res.ok) {
        const apiMsg = data && data.error && data.error.message ? data.error.message : '';
        if (res.status === 401) throw aiError(`API Key 无效（401），请到设置页检查 ${provider.name} 的 Key 是否复制完整。`, apiMsg);
        if (res.status === 429) throw aiError('调用频率/额度受限（429），请稍后再试或检查账户余额。', apiMsg);
        throw aiError(`${provider.name} 接口返回 ${res.status}：${apiMsg || res.statusText}`, apiMsg);
      }
      if (data && data.error) {
        throw aiError(provider.name + ' 接口报错：' + (data.error.message || JSON.stringify(data.error)));
      }
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string') {
        throw aiError('AI 返回格式异常，未找到回复内容。原始返回：' + JSON.stringify(data).slice(0, 300));
      }
      return { content, usage: data.usage || null, model };
    }

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
    async function visionExtract(pages, visionModel) {
      const merged = {};
      const schemaPrompt =
        '你是简历信息抽取助手。请从这一页简历图片中提取信息，只输出一个 JSON 对象，不要输出任何其他文字。' +
        'JSON 字段：name(姓名), phone(手机号), email(邮箱), school(毕业院校), major(专业), degree(学历), graduation(毕业时间), ' +
        'gpa(绩点或排名), languages(数组,语言/证书), skills(数组,技能), ' +
        'experiences(数组,每项{company,role,start,end,bullets:[字符串数组]}), ' +
        'projects(数组,每项{name,role,start,end,bullets:[字符串数组]}), ' +
        'customs(对象,其他所有能识别到的字段,如政治面貌/籍贯/四六级/获奖等,键用中文标签)。' +
        '本页没有的字段省略或留空，不要编造。';
      for (const page of pages) {
        const out = await callGLM({
          model: visionModel,
          messages: [
            { role: 'user', content: [
              { type: 'image_url', image_url: { url: page.dataUrl } },
              { type: 'text', text: schemaPrompt + (page.hint ? `\n（这是第 ${page.hint} 页）` : '') },
            ] },
          ],
          temperature: 0.2,
          timeoutMs: 120000,
          maxTokens: 4096,
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

    return { callGLM, listAvailableModels, extractJson, resolveVisionModel, visionExtract, mergeResumePart, aiError };
  }
  global.LocalApplyAI = { createClient };
})(globalThis);
