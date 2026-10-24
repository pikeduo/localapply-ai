// DOCX 只转成完整页面图片，不抽取文本、不识别简历字段，嵌入图片保留给视觉模型。
(function (global) {
  'use strict';
  // 在禁脚本、禁外网的临时 iframe 渲染，结束或取消后移除整个文档。
  async function render(bytes, signal) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin'); frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1100px;height:1200px;border:0;pointer-events:none';
    let rejectReady = null;
    const cancel = () => { rejectReady?.(new Error('已取消转图')); frame.remove(); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) throw new Error('已取消转图');
      await new Promise((resolve, reject) => { rejectReady = reject; frame.onload = resolve; frame.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; font-src data: blob:; style-src \'unsafe-inline\'"></head><body style="margin:0;background:#fff"></body></html>'; document.body.append(frame); });
      rejectReady = null;
      if (signal?.aborted) throw new Error('已取消转图');
      const doc = frame.contentDocument;
      await global.docx.renderAsync(bytes, doc.body, doc.head, { inWrapper: false, className: 'resume-page', ignoreHeight: true,
        useBase64URL: true, breakPages: true, ignoreLastRenderedPageBreak: false, renderAltChunks: false, renderComments: false });
      if (signal?.aborted) throw new Error('已取消转图');
      const images = [...doc.images];
      let timer;
      try {
        await Promise.race([
          Promise.all(images.map((img) => img.decode().catch(() => {}))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DOCX 图片加载超时，请转成 PDF 后重试')), 10000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (images.some((img) => !img.naturalWidth)) throw new Error('DOCX 有图片无法显示，请转成 PDF 后重试，避免漏读图片');
      const sections = [...doc.querySelectorAll('section.resume-page')];
      if (!sections.length || sections.length > 30) throw new Error('DOCX 无可渲染页面或超过 30 页');
      const pages = []; let size = 0;
      for (const section of sections) {
        const width = Math.ceil(Math.max(section.scrollWidth, section.getBoundingClientRect().width));
        const height = Math.ceil(Math.max(section.scrollHeight, section.getBoundingClientRect().height));
        if (!width || !height || width > 3000 || height > 40000) throw new Error('DOCX 页面尺寸超限，请转成 PDF 后重试');
        // 长流式文档按可见高度切图，避免只截取固定纸张大小而遗漏下方内容。
        const tile = Math.round(width * 1.45);
        for (let top = 0; top < height; top += tile) {
          if (signal?.aborted) throw new Error('已取消转图');
          if (pages.length >= 30) throw new Error('DOCX 转图超过 30 张，请缩减文档');
          const canvas = await (global.html2canvas.default || global.html2canvas)(section, { backgroundColor: '#fff', scale: Math.min(2, 1600 / width),
            width, height: Math.min(tile, height - top), y: top, logging: false, allowTaint: false, useCORS: false, imageTimeout: 5000 });
          try {
            const dataUrl = canvas.toDataURL('image/jpeg', 0.9); size += dataUrl.length;
            if (size > 16 * 1024 * 1024) throw new Error('DOCX 页面图片总大小超过 16 MiB');
            pages.push({ dataUrl, width: canvas.width, height: canvas.height, hint: pages.length + 1 });
          } finally { canvas.width = canvas.height = 0; }
        }
      }
      if (signal?.aborted) throw new Error('已取消转图');
      return pages;
    } finally { signal?.removeEventListener('abort', cancel); frame.remove(); }
  }
  global.LocalApplyDocumentRenderer = { render };
})(globalThis);
