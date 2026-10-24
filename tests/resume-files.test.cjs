// 验证文档容器的资源边界；真实 PDF/DOCX 解析另由浏览器验收。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fflate = require('fflate');
const fixtures = require('./resume-fixtures.cjs');
// 只加载无持久化能力的文件解析模块，测试不能访问个人资料。
function parser() {
  const context = vm.createContext({ fflate, Uint8Array, DataView });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../options/resume-files.js'), 'utf8'), context);
  return context.LocalApplyFiles;
}
test('DOCX 仅重建已验证 XML，丢弃嵌入媒体；损坏/重名/超限容器被拒绝', () => {
  const files = parser();
  const entries = fflate.unzipSync(fixtures.docx()); entries['word/media/private.png'] = new Uint8Array([1, 2, 3]);
  const checked = fflate.unzipSync(files.inspectDocx(fflate.zipSync(entries)));
  assert.ok(checked['word/document.xml']); assert.equal(checked['word/media/private.png'], undefined);
  assert.throws(() => files.inspectDocx(new Uint8Array([1, 2])), /ZIP/);
  assert.throws(() => files.inspectDocx(fixtures.docx().subarray(0, 100)), /ZIP/);
  const declared = fflate.zipSync(entries, { level: 0 }); new DataView(declared.buffer).setUint32(22, 50 * 1024 * 1024, true);
  assert.throws(() => files.inspectDocx(declared), /超限/);
});
test('文件大小和格式先校验，不读取超限原文件', async () => {
  const files = parser();
  await assert.rejects(files.read({ name: 'huge.pdf', size: 11 * 1024 * 1024 }), /10 MiB/);
  await assert.rejects(files.read({ name: 'legacy.doc', size: 12 }), /仅支持/);
});
