# 随包第三方资源

| 组件 | 版本 | 许可文件 |
| --- | --- | --- |
| Mozilla PDF.js | 6.4.299 | pdfjs/LICENSE（Apache-2.0） |
| PDF.js legacy build 内含 core-js | 3.50.0 | pdfjs/LICENSE.core-js（MIT） |
| PDF CMap/标准字体/图像解码器 | 随 PDF.js 分发 | pdfjs/cmaps/LICENSE、standard_fonts/LICENSE_*、wasm/LICENSE_* |
| Mammoth | 1.13.0 | docx/LICENSE.mammoth（BSD-2-Clause） |
| Mammoth 依赖链 | package-lock.json 固定 | docx/NOTICE.dependencies.txt |
| fflate | 0.8.3 | docx/LICENSE.fflate（MIT） |
| docx-preview | 0.4.1 | docx/NOTICE.rendering.txt（Apache-2.0） |
| html2canvas | 1.4.1 | docx/NOTICE.rendering.txt（MIT） |

当前 DOCX 转图使用 docx-preview/html2canvas。历史 Mammoth 资源与版权保留，不再加载或提取文本。

生成入口为 `npm run vendor:libs`，资源全部本地分发；不包含 PDF JavaScript 执行器 QuickJS。
原项目根目录 MIT 许可证及作者声明保持原样。

core-js 许可来源：https://github.com/zloirock/core-js/blob/v3.50.0/LICENSE
