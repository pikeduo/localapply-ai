// 固定版本本地打包：运行时不下载远程代码，file:// 也能加载经典脚本。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
// 保留第三方完整许可证，生成物直接随扩展分发。
async function main() {
  for (const [entry, output, name] of [
    ['pdfjs-dist/legacy/build/pdf.mjs', 'libs/pdfjs/pdf.min.js', 'pdfjsLib'],
    ['pdfjs-dist/legacy/build/pdf.worker.mjs', 'libs/pdfjs/pdf.worker.min.js', 'pdfjsWorker'],
    ['fflate/lib/browser.cjs', 'libs/docx/fflate.min.js', 'fflate'],
    ['mammoth/lib/index.js', 'libs/docx/mammoth.min.js', 'mammoth'],
  ]) {
    await esbuild.build({ entryPoints: [path.join(root, 'node_modules', entry)], outfile: path.join(root, output),
      bundle: true, format: 'iife', globalName: name, minify: true, legalComments: 'inline', platform: 'browser', target: 'chrome116' });
  }
  for (const [pkg, file, output] of [['pdfjs-dist', 'LICENSE', 'libs/pdfjs/LICENSE'],
    ['mammoth', 'LICENSE', 'libs/docx/LICENSE.mammoth'], ['fflate', 'LICENSE', 'libs/docx/LICENSE.fflate']]) {
    fs.copyFileSync(path.join(root, 'node_modules', pkg, file), path.join(root, output));
  }
  // 中文 CMap、标准字体和 WASM 均随包提供，禁止解析器回源 CDN。
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    fs.cpSync(path.join(root, 'node_modules/pdfjs-dist', dir), path.join(root, 'libs/pdfjs', dir), {
      recursive: true, filter: (source) => !path.basename(source).startsWith('quickjs-eval'),
    });
  }
  const visited = new Set(); const notices = [];
  // 包含 Mammoth 依赖链的许可全文，避免压缩后丢失版权声明。
  function collect(pkg, from = root) {
    const filename = require.resolve(pkg + '/package.json', { paths: [from] });
    if (visited.has(filename)) return;
    visited.add(filename);
    const folder = path.dirname(filename); const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
    notices.push(`\n=== ${metadata.name} ${metadata.version} (${metadata.license || 'see license'}) ===\n`);
    for (const file of fs.readdirSync(folder).filter((name) => /^(license|licence|copying|notice)(\.|$)/i.test(name))) {
      if (fs.statSync(path.join(folder, file)).isFile()) notices.push(fs.readFileSync(path.join(folder, file), 'utf8'));
    }
    for (const dependency of Object.keys(metadata.dependencies || {})) collect(dependency, folder);
  }
  collect('mammoth');
  fs.writeFileSync(path.join(root, 'libs/docx/NOTICE.dependencies.txt'), notices.join('\n'));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
