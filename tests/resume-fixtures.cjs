// 仅含合成资料的 PDF/DOCX 夹具，供 Node 和真实浏览器复用。
'use strict';
const { zipSync, strToU8 } = require('fflate');
const text = 'Test Person; 13800000000; test@example.test; Alpha University; Beta University; Sample Corp; Lab Corp; Project One; Built a parser with JavaScript.';
// 创建包含真实段落和表格文本的最小 OOXML 文档。
function docx() {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>'),
  }, { mtime: new Date('2000-01-01T00:00:00Z') }));
}
// 生成可实际提取文字的 PDF，避免用解析器桩替代真实文件读取。
function pdf() {
  const stream = 'BT /F1 9 Tf 20 760 Td (' + text + ') Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  result += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
// 多段教育/实习/工作/项目均带原文来源；虚构值用于验证不默认勾选。
function parsed() {
  const cell = (value) => ({ value, evidence: value, page: 1 });
  return { basic: { name: cell('Test Person'), email: cell('test@example.test'), gpa: cell('4.0') },
    education: [{ school: cell('Alpha University') }, { school: cell('Beta University') }],
    internship: [{ company: cell('Sample Corp') }], employment: [{ company: cell('Lab Corp') }],
    project: [{ title: cell('Project One'), description: cell('Built a parser with JavaScript.') }] };
}
module.exports = { text, docx, pdf, parsed };
