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
    ['docx-preview/dist/docx-preview.mjs', 'libs/docx/docx-preview.min.js', 'docx'],
    ['html2canvas/dist/html2canvas.esm.js', 'libs/docx/html2canvas.min.js', 'html2canvas'],
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
  // 收集渲染器及历史依赖的许可，兼容禁止导出 package.json 的包。
  function collect(pkg, from = root) {
    let filename;
    try { filename = require.resolve(pkg + '/package.json', { paths: [from] }); }
    catch {
      let folder = path.dirname(require.resolve(pkg, { paths: [from] }));
      while (!fs.existsSync(path.join(folder, 'package.json'))) {
        const parent = path.dirname(folder); if (parent === folder) throw new Error('无法查找依赖许可：' + pkg);
        folder = parent;
      }
      filename = path.join(folder, 'package.json');
    }
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
  notices.length = 0; visited.clear(); collect('docx-preview'); collect('html2canvas');
  fs.writeFileSync(path.join(root, 'libs/docx/NOTICE.rendering.txt'), notices.join('\n'));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
