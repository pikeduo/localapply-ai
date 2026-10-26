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
| Administrative-divisions-of-China 省市区地名 | 2026-10-26 固定离线快照 | regions/LICENSE（WTFPL v2） |

当前 DOCX 转图使用 docx-preview/html2canvas。历史 Mammoth 资源与版权保留，不再加载或提取文本。

生成入口为 `npm run vendor:libs`，资源全部本地分发；不包含 PDF JavaScript 执行器 QuickJS。
原项目根目录 MIT 许可证及作者声明保持原样。

core-js 许可来源：https://github.com/zloirock/core-js/blob/v3.50.0/LICENSE

地区数据来源：https://github.com/modood/Administrative-divisions-of-China 的 `dist/pca.json`。原始文件 SHA256 为 `4422a0976fbae5d9feb3f8edafa3eb4964489f8f5162d6ec5034ab3ab3f67649`；`data/regions.js` 将直辖市的“市辖区/县”归并为市名。仅提供离线候选，不自动联网更新，缺失地区可手动填写；该文件直接随包分发，不由 `vendor:libs` 重新下载。
