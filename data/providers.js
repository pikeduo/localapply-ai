// 服务商解析与地址标准化：仅配置元数据，不联网、不复制其他端点凭据。
(function (global) {
  'use strict';

  // 接受 IP:端口、域名或完整兼容地址；根路径补 /v1，完整聊天端点去掉后缀。
  function normalizeBase(raw) {
    let text = String(raw || '').trim();
    if (!text || /\s/.test(text)) throw new Error('请输入有效的 IP 或 API 接口地址');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
      const local = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?::\d+)?(?:\/|$)/i.test(text);
      text = (local ? 'http://' : 'https://') + text;
    }
    let url;
    try { url = new URL(text); } catch { throw new Error('地址格式不正确，请填写 IP:端口 或完整 http(s) 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('接口地址只支持 HTTP/HTTPS，不能包含账号密码、查询参数或片段');
    }
    if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('[') && !/^https?:\/\//i.test(raw)) {
      throw new Error('请选择已有服务商，或输入 IP:端口 / 完整接口地址');
    }
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') || '/v1';
    return url.origin + pathname;
  }

  // 返回内置预设与本地自定义项，保持原服务商 ID 和旧配置兼容。
  function entries(settings) {
    return [...Object.entries(global.WangshenTemplates.PROVIDERS).map(([providerId, provider]) => ({ providerId, ...provider })),
      ...Object.entries(settings.customProviders || {}).map(([providerId, provider]) => ({
        providerId, ...provider, models: [], visionModels: [], visionDefault: false, requiresKey: false, custom: true,
        note: '自定义 OpenAI 兼容接口；填写该服务支持的模型 ID，API Key 按服务端要求填写。',
      }))];
  }

  // 后台与 UI 使用同一个解析规则，未知服务商明确报错，避免凭据误发到默认服务商。
  function resolve(settings) {
    const provider = entries(settings).find((item) => item.providerId === (settings.provider || 'zhipu'));
    if (!provider) throw new Error('服务商配置不存在，请重新选择');
    return { ...provider, baseUrl: provider.providerId === 'custom' ? settings.customBase || '' : provider.baseUrl,
      custom: provider.custom || provider.providerId === 'custom', requiresKey: provider.requiresKey !== false && provider.providerId !== 'custom' };
  }

  // 名称/ID/常见别名均可选择；地址规范化后复用已有项，避免重复创建。
  function find(settings, raw) {
    const text = String(raw || '').trim().toLowerCase();
    const alias = { qwen: 'qwen', '通义千问': 'qwen', '阿里通义千问': 'qwen', kimi: 'moonshot', glm: 'zhipu', '硅基流动': 'siliconflow' }[text];
    const items = entries(settings);
    const direct = items.find((item) => item.providerId === (alias || text) || item.name.toLowerCase() === text);
    if (direct) return direct.providerId;
    const base = normalizeBase(raw);
    return items.find((item) => {
      const address = item.providerId === 'custom' ? settings.customBase : item.baseUrl;
      return address && normalizeBase(address) === base;
    })?.providerId || null;
  }

  // 标准 /models 响应只读取 ID，忽略不可信的其他元数据，不推断模型能力。
  function parseModels(data) {
    if (!data || !Array.isArray(data.data) || data.data.length > 10000) throw new Error('模型列表格式异常，需要 OpenAI 兼容的 data 数组，可改为手动填写模型 ID。');
    const models = [...new Set(data.data.map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
      .filter((model) => model.length > 0 && model.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(model)))].sort();
    if (data.data.length && !models.length) throw new Error('接口没有返回有效模型 ID，可改为手动填写。');
    return models;
  }

  global.LocalApplyProviders = { normalizeBase, entries, resolve, find, parseModels };
})(globalThis);
