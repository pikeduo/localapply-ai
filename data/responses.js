// Responses 适配：仅转换消息与读取响应，不发起额外请求、不保存文件或服务端会话。
(function (global) {
  'use strict';

  // 将现有文本/图片/文件消息转为 Responses 输入；系统指令独立传递以兼容 Codex 反代。
  function request(req, model) {
    const instructions = [];
    const input = (req.messages || []).filter((message) => {
      if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) throw new Error('Responses 消息角色不受支持');
      if (['system', 'developer'].includes(message.role)) {
        if (typeof message.content !== 'string') throw new Error('Responses 系统指令须为文本');
        instructions.push(message.content); return false;
      }
      return true;
    }).map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map((part) => {
      if (part.type === 'text') return { type: 'input_text', text: part.text };
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url };
      if (part.type === 'file') return { type: 'input_file', filename: part.file.filename, file_data: part.file.file_data };
      throw new Error('Responses 消息内容不受支持');
    }) }));
    const body = { model, instructions: instructions.join('\n\n') || '请准确回答用户的问题。', input, store: false, stream: true };
    if (req.maxTokens) body.max_output_tokens = req.maxTokens;
    // Sol 不支持关闭推理；短探针使用官方支持的 low，并保留推理和最终答案的共同预算。
    if (req.disableThinking && /^gpt-6\.1-sol(?:-|$)/.test(model)) {
      body.reasoning = { effort: 'low' };
      body.max_output_tokens = Math.max(2048, req.maxTokens || 0);
    }
    return body;
  }

  // 只接受终态助手正文；推理、工具输出及未完成的流不能冒充识别结果。
  function result(data) {
    if (data?.error || !['completed', 'incomplete'].includes(data?.status)) throw new Error('Responses 未返回成功终态，请检查反代日志及协议兼容性');
    const length = data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens';
    if (data.status === 'incomplete' && !length) throw new Error('Responses 返回未完成结果，请重试');
    const parts = (Array.isArray(data.output) ? data.output : []).filter((item) => item.type === 'message' && item.role === 'assistant')
      .flatMap((item) => Array.isArray(item.content) ? item.content : []).filter((part) => part.type === 'output_text' && typeof part.text === 'string');
    const content = parts.map((part) => part.text).join('');
    if (length && !content) { const error = new Error('模型输出被截断，请增加输出预算后重试'); error.code = 'OUTPUT_LIMIT'; throw error; }
    if (!parts.length || content.length > 300000) throw new Error('Responses 返回正文格式异常或内容超限');
    return { content, usage: data.usage || null, finishReason: length ? 'length' : 'stop' };
  }

  // 有界读取 SSE；终态到达即释放流，超时/取消继续由共用客户端的 AbortSignal 控制。
  async function read(response) {
    const sse = /text\/event-stream/i.test(response.headers?.get('content-type') || '');
    if (!response.body?.getReader) {
      if (sse) throw new Error('Responses 流不可读取');
      let data;
      try { data = await response.json(); }
      catch (error) { if (error.name === 'AbortError' || error instanceof TypeError) throw error; throw new Error('Responses 回复不是有效 JSON'); }
      return result(data);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 2 * 1024 * 1024) throw new Error('Responses 流超过大小限制');
        buffer += decoder.decode(value, { stream: true });
        if (!sse) continue;
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length);
          const text = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!text || text === '[DONE]') continue;
          let event;
          try { event = JSON.parse(text); } catch { throw new Error('Responses 流不是有效 JSON'); }
          if (['error', 'response.failed'].includes(event.type)) throw new Error('Responses 流返回失败，请检查反代日志');
          if (['response.completed', 'response.incomplete'].includes(event.type)) return result(event.response);
        }
      }
      if (!sse) {
        let data;
        try { data = JSON.parse(buffer + decoder.decode()); } catch { throw new Error('Responses 回复不是有效 JSON'); }
        return result(data);
      }
      throw new Error('Responses 流提前结束，未收到完成事件');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  global.LocalApplyResponses = { request, read };
})(globalThis);
