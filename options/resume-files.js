// PDF/DOCX 只在页面内存解析，限制文件、解压大小、页数及输出；不使用文件上传接口。
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
    let total = 0; let count = 0; let completed = 0; const names = new Set(); const xml = {};
    const unzip = new fflate.Unzip((file) => {
      if (++count > 2000 || names.has(file.name)) throw new Error('DOCX 文件条目过多或重名');
      names.add(file.name);
      if (file.originalSize > MAX_EXPANDED || file.size > MAX_FILE) throw new Error('DOCX 解压大小超限');
      const chunks = [];
      const keep = /^(\[Content_Types\]\.xml|_rels\/\.rels|word\/(document|footnotes|endnotes)\.xml|word\/_rels\/document\.xml\.rels)$/.test(file.name);
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
            xml[file.name] = bytes;
          }
        }
      };
      file.start();
    });
    unzip.register(fflate.UnzipInflate);
    for (let i = 0; i < bytes.length; i += 4096) unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
    if (!names.has('word/document.xml') || !names.has('[Content_Types].xml') || completed !== count
      || count !== view.getUint16(end + 10, true)) throw new Error('不是完整有效的 DOCX 文档');
    // 仅把已验证的 XML 重建为内存 ZIP，Mammoth 不再信任原中央目录、嵌入媒体或外部关系。
    return fflate.zipSync(xml, { level: 0 });
  }
  // 打开独立 PDF 任务并关闭其 worker/字体/页面资源，避免原字节长期驻留。
  async function pdf(bytes, signal, render = false) {
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
            pages.push({ dataUrl, hint: i });
          } finally { canvas.width = canvas.height = 0; }
        } else {
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim());
          size += pages.at(-1).length;
          if (size > 100000) throw new Error('简历文本超过 10 万字');
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
    let pages;
    if (type === 'pdf') pages = await pdf(bytes, signal);
    else {
      const checked = inspectDocx(bytes);
      const result = await mammoth.extractRawText({ arrayBuffer: checked.buffer });
      if (result.value.length > 100000) throw new Error('简历文本超过 10 万字');
      pages = [result.value];
    }
    if (signal?.aborted) throw new Error('已取消解析');
    const text = pages.join('\n');
    // DOCX 无稳定物理页码；显示为文本块，不把推测页数当成真实分页。
    const mode = type === 'pdf' && text.replace(/\s/g, '').length < 80 ? 'vision' : 'text';
    return { type, fingerprint, pages, text, mode, bytes: mode === 'vision' ? bytes : null };
  }
  global.LocalApplyFiles = { read, pdf, inspectDocx };
})(globalThis);
