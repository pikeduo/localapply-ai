// 只做文件安全检查、页面转图和哈希；简历语义解析完全交给模型。
(function (global) {
  'use strict';
  const MAX_FILE = 10 * 1024 * 1024;
  const MAX_EXPANDED = 40 * 1024 * 1024;
  // DOCX 先逐块解压验证实际输出，防止伪造 ZIP 元数据绕过大小限制。
  function inspectDocx(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
      || view.getUint16(end + 10, true) > 2000 || view.getUint32(end + 12, true) + view.getUint32(end + 16, true) !== end) throw new Error('DOCX ZIP 目录损坏、多卷或 ZIP64 不受支持');
    let total = 0; let count = 0; let completed = 0; const names = new Set(); const entries = {};
    const unzip = new fflate.Unzip((file) => {
      if (++count > 2000 || names.has(file.name)) throw new Error('DOCX 文件条目过多或重名');
      if (file.name.includes('..') || /[\\\u0000]/.test(file.name) || file.name.startsWith('/')) throw new Error('DOCX 文件路径无效');
      names.add(file.name);
      if (file.originalSize > MAX_EXPANDED || file.size > MAX_FILE) throw new Error('DOCX 解压大小超限');
      const chunks = [];
      const keep = !file.name.endsWith('/') && !/\.(?:bin|html?|js)$/i.test(file.name);
      file.ondata = (error, chunk, final) => {
        if (error) throw new Error('DOCX 压缩内容损坏');
        total += chunk.length;
        if (total > MAX_EXPANDED) throw new Error('DOCX 实际解压大小超过 40 MiB');
        if (keep) chunks.push(chunk);
        if (final) {
          completed++;
          if (keep) {
            const bytes = new Uint8Array(chunks.reduce((n, value) => n + value.length, 0)); let offset = 0;
            for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
            entries[file.name] = bytes;
          }
        }
      };
      file.start();
    });
    unzip.register(fflate.UnzipInflate);
    for (let i = 0; i < bytes.length; i += 4096) unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
    if (!names.has('word/document.xml') || !names.has('[Content_Types].xml') || completed !== count
      || count !== view.getUint16(end + 10, true)) throw new Error('不是完整有效的 DOCX 文档');
    // 重建有界 ZIP 时保留图片、字体、版式。外部关系删除，禁止渲染器读取外网资源。
    for (const name of Object.keys(entries).filter((name) => name.endsWith('.rels'))) {
      const xml = new DOMParser().parseFromString(new TextDecoder().decode(entries[name]), 'application/xml');
      if (xml.getElementsByTagName('parsererror').length) throw new Error('DOCX 关系 XML 损坏');
      for (const relationship of Array.from(xml.getElementsByTagName('Relationship'))) {
        if (relationship.getAttribute('TargetMode') === 'External' || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(relationship.getAttribute('Target') || '')) relationship.parentNode.removeChild(relationship);
      }
      entries[name] = new TextEncoder().encode(new XMLSerializer().serializeToString(xml));
    }
    return fflate.zipSync(entries, { level: 0 });
  }
  // 打开独立 PDF 任务并关闭其 worker/字体/页面资源，避免原字节长期驻留。
  async function pdf(bytes, signal, render = true) {
    const base = new URL('../libs/pdfjs/', location.href).href;
    const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, cMapUrl: base + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', useWorkerFetch: false });
    const cancel = () => { task.destroy().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) throw new Error('已取消解析');
      const doc = await task.promise;
      if (doc.numPages > 30) throw new Error('简历最多支持 30 页');
      const pages = []; let size = 0;
      for (let i = 1; i <= doc.numPages; i++) {
        if (signal?.aborted) throw new Error('已取消解析');
        const page = await doc.getPage(i);
        if (render) {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
          const canvas = document.createElement('canvas');
          try {
            canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82); size += dataUrl.length;
            if (size > 16 * 1024 * 1024) throw new Error('扫描页总大小超限，请缩减简历页数');
            pages.push({ dataUrl, width: canvas.width, height: canvas.height, hint: i });
          } finally { canvas.width = canvas.height = 0; }
        } else {
          // 只读取页数元数据，禁止重新引入纯文本抽取或扫描件字数猜测。
          pages.push({ hint: i });
        }
        page.cleanup();
      }
      return pages;
    } finally { signal?.removeEventListener('abort', cancel); await task.destroy(); }
  }
  // 生成文件内容指纹以防同一档案重复导入；哈希可持久化，原文件不可持久化。
  async function read(file, signal) {
    if (!file || file.size > MAX_FILE || file.size === 0) throw new Error('请选择不超过 10 MiB 的 PDF/DOCX');
    const type = /\.pdf$/i.test(file.name) ? 'pdf' : /\.docx$/i.test(file.name) ? 'docx' : '';
    if (!type) throw new Error('仅支持 PDF 和 DOCX');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    let renderBytes = null;
    if (type === 'pdf' && !new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-')) throw new Error('不是有效的 PDF');
    if (type === 'docx') renderBytes = inspectDocx(bytes);
    if (signal?.aborted) throw new Error('已取消解析');
    return { type, fingerprint, bytes, renderBytes, pages: [], mode: 'model' };
  }
  // 渲染完整页面供预览和模型识别，包括文本型 PDF/DOCX 内嵌的图片。
  async function render(source, signal) {
    return source.type === 'pdf' ? pdf(source.bytes, signal) : global.LocalApplyDocumentRenderer.render(source.renderBytes, signal);
  }
  global.LocalApplyFiles = { read, render, pdf, inspectDocx };
})(globalThis);
