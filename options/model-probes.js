// 合成测试文件只含随机数字图片，不包含简历信息，也不把答案放进提示词或文件文本。
(function (global) {
  'use strict';
  const mimeDocx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // 分块编码原文件，避免大数组展开造成调用栈溢出。
  function dataUrl(bytes, mime) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return 'data:' + mime + ';base64,' + btoa(binary);
  }
  // 图片 PDF 不含可提取的文字层，文件能力测试必须能看到嵌入图片。
  function imagePdf(pages) {
    const encoder = new TextEncoder(); const objects = [];
    const add = (content) => { objects.push(content); return objects.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); const pageIds = [];
    for (const page of pages) {
      const bytes = Uint8Array.from(atob(page.dataUrl.split(',')[1]), (char) => char.charCodeAt(0));
      const image = add([encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`), bytes, encoder.encode('\nendstream')]);
      const stream = `q ${page.width} 0 0 ${page.height} 0 0 cm /Image Do Q`;
      const drawing = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Image ${image} 0 R >> >> /Contents ${drawing} 0 R >>`));
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map((n) => n + ' 0 R').join(' ')}] /Count ${pages.length} >>`;
    const chunks = [encoder.encode('%PDF-1.4\n')]; const offsets = [0]; let offset = chunks[0].length;
    for (const [i, value] of objects.entries()) {
      offsets.push(offset);
      const parts = [encoder.encode(`${i + 1} 0 obj\n`), ...(typeof value === 'string' ? [encoder.encode(value)] : value), encoder.encode('\nendobj\n')];
      for (const part of parts) { chunks.push(part); offset += part.length; }
    }
    chunks.push(encoder.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('')
      + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
    const result = new Uint8Array(chunks.reduce((n, part) => n + part.length, 0)); let position = 0;
    for (const part of chunks) { result.set(part, position); position += part.length; }
    return result;
  }
  // DOCX 只嵌入图片，不设置含答案的文件名、替代文字或 XML 文本。
  function imageDocx(image) {
    const text = fflate.strToU8;
    return fflate.zipSync({
      '[Content_Types].xml': text('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': text('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/_rels/document.xml.rels': text('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/probe.jpeg"/></Relationships>'),
      'word/document.xml': text('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="6096000" cy="1905000"/><wp:docPr id="1" name="test"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="test"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>'),
      'word/media/probe.jpeg': image,
    });
  }
  // 仅在用户点击检测时生成新挑战，数字只绘制进像素，测试结束即释放画布。
  function createProbe(nonce) {
    nonce ||= Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => String(n % 10)).join('');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 200;
    try {
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 200);
      ctx.fillStyle = '#000'; ctx.font = 'bold 72px monospace'; ctx.textAlign = 'center'; ctx.fillText(nonce, 320, 125);
      const image = canvas.toDataURL('image/jpeg', 0.95);
      const bytes = Uint8Array.from(atob(image.split(',')[1]), (char) => char.charCodeAt(0));
      return { nonce, image, pdf: { filename: 'probe.pdf', file_data: dataUrl(imagePdf([{ dataUrl: image, width: 640, height: 200 }]), 'application/pdf') },
        docx: { filename: 'probe.docx', file_data: dataUrl(imageDocx(bytes), mimeDocx) } };
    } finally { canvas.width = canvas.height = 0; }
  }
  global.LocalApplyProbes = { createProbe, dataUrl, imagePdf, imageDocx };
})(globalThis);
