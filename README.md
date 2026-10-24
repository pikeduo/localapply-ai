# LocalApply · 本地智能网申助手

Manifest V3 浏览器扩展（Edge / Chrome 通用，原生 JavaScript，运行无需构建）。把简历信息一次性录入字段库后，在招聘网申页面上**短字段一键自动填、长文本点选填、开放题用 AI 起草**。资料默认保存在本机，AI 调用由你主动触发，永不自动点提交。

基于 [xiaoxiaobaijiangjun/wangshen-autofill](https://github.com/xiaoxiaobaijiangjun/wangshen-autofill) 重构，保留原项目 MIT 许可证与作者版权。

![manifest](https://img.shields.io/badge/manifest-v3-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/runtime-browser%20only-orange)

## 功能

- **一键自动填充**：label 同义词匹配（60 组词库，覆盖互联网 + 央国企网申常见字段），得分 ≥ 阈值才填，已填字段高亮标记 + 复查清单
- **框架兼容**：绕过 React 受控组件的 value tracker，Vue/select/radio/checkbox/contenteditable 都能填
- **平台增强**：Moka（mokahr.com）、国聘（iguopin.com）定制识别；其余网站走通用启发式；手机号 +86 区号框、家庭成员表格、验证码控件自动避让
- **下拉框智能匹配**：`CET-4` ↔ `四级`、`共青团员` ↔ `团员`、`硕士` ↔ `研究生` 等同义写法自动对上
- **PDF/DOCX 简历导入**：本地读取预览后，由你主动发送给模型。基本资料及多段教育/实习/工作/项目逐项校对保存，来源无法核实的项默认不选。同一文件重复导入复用经历，默认仅补空白；原文件和全文不保存。
- **开放题 AI 起草**：用档案里的自我介绍/项目/动机素材生成 ≤350 字草稿，保留最近 3 版历史，确认后才落表
- **多 AI 服务商**：智谱 / DeepSeek / Qwen（通义千问）/ Kimi / OpenAI / 硅基流动 / OpenRouter / Ollama 任选；服务商框支持直接输入 IP 或 API 地址创建自定义 OpenAI 兼容服务。Key、主模型和视觉模型按服务商分别保存
- **多档案**：全字段模板 51 项（基本信息/教育/意向/政治面貌/家庭成员/四六级/奖惩…），有值就填、没值跳过；支持 JSON 备份导出/恢复
- **本地数据管理**：字段定义与个人值分离；设置页支持多段教育/实习/工作/项目经历、完整 JSON 备份、合并/覆盖预览及导入前恢复点。重复经历已可编辑保存，网页重复区块自动匹配尚待接入。
- **公共字段包**：可离线导出已审核的字段元数据、合并其他人的公共字段包，新字段为空白；个人自定义字段默认不公开，本版本不连接 GitHub。
- **投递台账**：每次填充自动记录（公司/系统/URL/时间/数量），一键导出 UTF-8 BOM CSV（Excel 打开不乱码）
- **隐私遮挡**：手机号/身份证/薪资/家庭成员等敏感字段默认 `••••`，点眼睛可见
- **安全红线**：代码层面禁止点击任何「提交/发送/投递/确认」按钮，最后一步永远由你本人操作；验证码一律跳过并提示

## 安装（Edge，三步）

1. 下载本仓库（Code → Download ZIP 解压，或 `git clone`）
2. Edge 地址栏打开 `edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选择本目录（`manifest.json` 所在层）
3. 固定工具栏图标。**到这里就能用了**——在「字段库」手动填好信息，去网申页一键填充，全程不需要任何 API Key

> **AI 是可选加速器**：想用 PDF 自动提取 / 开放题起草时，再点侧边栏 ⚙ 配置任一家 AI 服务商（智谱 / DeepSeek / Kimi / 通义 / OpenAI / 硅基流动 / OpenRouter / 自定义 OpenAI 兼容接口）。普通 PDF 用纯文本模型即可，只有扫描件 PDF 才需要配一个视觉模型。

> Chrome 同理：`chrome://extensions` → 开发人员模式 → 加载已解压的扩展程序。

设置页支持两种入口：从插件的「设置/扩展选项」进入时使用插件资料；直接双击 `options/options.html`（`file://`）进入时使用独立的本地文件管理模式，可配置 API、查询模型、读取 PDF/DOCX 并校对导入、编辑重复经历和备份恢复，无需安装扩展。两者不自动同步，也不共享 Key；通过 JSON 备份交换个人资料，API 配置分别填写。文件页数据保存在此浏览器、此文件目录对应的 IndexedDB，移动目录或更换浏览器前请导出备份。

文件管理模式访问 API 受浏览器 [CORS 规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) 限制：服务端需要允许 `Origin: null`、相关请求方法及认证头；无法访问时会显示原因，其他本地操作仍可使用。无需关闭浏览器安全策略。网页自动填充和扩展权限功能仍需插件入口。普通 HTTP 预览不会开启文件管理模式；重新加载插件后，旧的插件设置页应关闭再打开。

AI 服务商可以从输入框的建议列表选择，也可以输入 `192.168.1.10:8000` 后按回车或移开焦点，自动保存为 `http://192.168.1.10:8000/v1`。域名默认使用 HTTPS；完整地址保留自定义路径，粘贴 `/chat/completions` 地址时自动提取 Base URL。相同地址不重复创建，新地址不继承其他服务商的 Key 或模型。

配置顺序：选择服务商 → 首次设置口令或解锁 → 填写所需 API Key → 点击“获取可用模型” → 从主模型下拉列表选择 → “测试连接”。本地服务无认证要求时 Key 可留空。模型列表通过当前 Base URL 的 `GET /models` 获取，只发送所需认证，不发送简历内容；不会自动选中第一个模型。列表只在当前页面使用，选中的模型按服务商保存在本地；切换服务商或修改 Key 后需重新获取。未开放列表接口、获取失败或列表为空时，可勾选“手动填写模型 ID”。视觉模型也可从获取后的输入建议中选择，但是否支持图片须按服务商说明确认。只保存配置不会自动联网或下载模型。

服务端需支持 OpenAI Chat Completions 兼容协议。接口参考：[DeepSeek](https://api-docs.deepseek.com/)、[DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[Qwen/阿里云百炼](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[Ollama 本地接口](https://docs.ollama.com/api/openai-compatibility)。

## 快速上手

1. **录入简历**：设置页 → 选 PDF/DOCX → 本地读取与预览 → 主动发送解析 → 校对来源、选择字段及目标档案 → 确认导入；也可在「简历中心」或侧边栏手填
2. **填充**：打开网申页 → 浮条/侧边栏显示 `可自动填 N · 点选 M · 开放题 K` → 点「一键填充」→ 对照复查清单
3. **开放题**：点「✨起草」生成草稿（可换一版），改好后点「填入」
4. **台账**：投递完在「台账」页导出 CSV

## 数据与隐私

- 简历字段、档案、台账、草稿**全部只存在本机** `chrome.storage.local`，卸载扩展即彻底删除；插件没有服务器、没有统计埋点
- 唯一的对外请求是你**主动触发**的 AI 调用（PDF 提取发简历文本、开放题起草发题目+素材），发往你在设置页选择的服务商（智谱 / DeepSeek / Kimi / 通义 / OpenAI / 硅基流动 / OpenRouter，或自定义 OpenAI 兼容地址）；不用 AI 功能则零联网请求
- 附件清单只登记文件名和备注，不读取文件本体
- 升级迁移原 `wangshenAutofill` 和 Schema v2 资料至 v3。API Key 使用 PBKDF2-SHA256（600,000 次）与 AES-256-GCM 加密；首次设置口令并验证密文后，清理现用配置及旧源中的明文 Key，其他旧资料保留。口令与派生密钥不落盘，文件页关闭/后台回收/浏览器重启后须重新解锁。个人简历库本身不加密；口令无法找回，请自行保管。
- 备份包含档案、动态字段、重复经历、确认的来源片段、本地映射和记录，不含 API 配置/Key、口令、保险库或原文件。导入前预览差异；合并冲突保留当前内容，覆盖导入可恢复到导入前。
- 完整政策见 [store/PRIVACY.md](store/PRIVACY.md)

## 开发

扩展运行无需构建或安装 npm 包。开发测试要求 Node.js 22.13 及以上；浏览器测试使用 Playwright。依赖和 Chromium 由开发者手动安装：

```powershell
npm ci
npx playwright install chromium
npm test
npm run test:e2e
```

第三方库更新后运行 `npm run vendor:libs`，生成随扩展分发的本地资源及许可证；普通使用无需执行。文件最多 10 MiB，PDF 最多 30 页，DOCX 实际解压最多 40 MiB、2,000 项，不支持 DOC、加密 ZIP、ZIP64 或多卷。DOCX 按文本块展示，不推测物理页码。

浏览器测试使用独立临时 profile、loopback 动态端口和合成资料，验证真实文件解析、校对、取消、加密及完整浏览器重启；会关闭自己创建的资源。真实招聘网站仍需单独抽检。

以下为保留的历史工具；`verify.js`/`debug-ui.js` 会强制清理固定端口进程，日常回归优先使用上面的测试命令。

```bash
node tools/verify.js          # 历史 Edge/CDP 验收，不作为新的测试入口
WSA_RESUME=D:\\path\\to\\resume.pdf node tools/verify.js   # 附加真实简历 PDF 本地解析测试
node tools/gen-icons.js       # 重新生成图标（含全透明自检）
node tools/package.js         # 打商店上传包 dist/wangshen-autofill-v<版本>.zip
python -m http.server         # 手动测试 test-pages/ 下的 mock 表单
```

验收覆盖：扩展加载、档案/模板/隐私遮挡、generic + React 受控组件 + Moka + 国聘四页检测与填充、家庭成员表格红线、Edge 重启后 storage 持久、扫描件视觉模式判定、校对导入链路、AI 无 key 错误路径、CSV BOM、"无提交类点击"静态检查等。

## 目录结构

```
manifest.json            MV3 清单
background.js            service worker：智谱 AI 代理、CSV 导出、数据种子
content/detector.js      平台识别 + 字段发现（label 归一化 + 同义词评分）
content/filler.js        填充执行（React 兼容赋值、同义选项匹配、高亮）
content/floatbar.js      页面右下角浮条（Shadow DOM）
sidepanel/               侧边栏：字段库 / 填充 / 台账 / 附件
options/                 设置页：API / 阈值 / PDF 导入校对 / 备份
data/templates.js        60 组同义词 + 全字段模板 + 档案工厂/升级
data/local-store.js      Schema v3、迁移、字段/值/经历、备份与公共字段接口
data/providers.js        服务商统一解析、IP/URL 规范化与地址去重
data/ai-client.js        插件后台与文件页共用的模型查询和 AI 解析
options/standalone.js    file:// 运行时和独立 IndexedDB 适配
options/data-management.js 备份预览、公共字段包和重复经历编辑
tests/                   基础、数据层与 Playwright 浏览器测试
data/key-vault.js        口令派生与 AES-GCM 保险库
data/resume.js           简历抽取与来源验证契约
options/resume-files.js  有界 PDF/DOCX 本地解析
options/resume-ui.js     简历中心、预览、取消与确认导入
libs/pdfjs/              PDF.js 6.4.299，本地字体/CMap/WASM 与许可
libs/docx/               Mammoth 1.13.0、fflate 0.8.3 及依赖许可
test-pages/              mock 表单（generic / react / moka / iguopin / fake-scan.pdf）
store/                   Edge 商店上架材料（步骤文案 + 隐私政策）
tools/                   图标生成 / 打包 / 自动化验收
tools/dev-https-server.py + dev-proxy.js + test-cert.pem
                         验收的本地 HTTPS mock 服务器与转发代理（Edge 152.0.4191.66 起
                         --host-resolver-rules 失效，改用 --proxy-server + 自签证书）
```

## 已知限制（诚实清单）

- **所有自动化验收基于自写 mock 页**，真实招聘站点的兼容率未经系统验证（mock 尽量仿了 Moka/国聘的 DOM 风格，但真实站点更复杂）。遇到不兼容的站点欢迎提 issue 附页面结构。
- **iframe 里的表单检测不到**：内容脚本只注入顶层文档；如果目标站点把申请表放在 iframe 里（部分 ATS 这么做），需要手动复制粘贴。支持 iframe 在路线图上。
- **表单若在多步向导中**：每翻一步需要点一次「↻重新检测」（自动检测有约 1 秒延迟兜底）。
- **扫描件 PDF 需要视觉模型**：来源无法用本地文本核实，所有提取项默认不选。跨页同一经历可能被拆开，须人工取消重复项。
- **文件页复杂 PDF**：浏览器可能限制 file:// 字体/CMap/WASM 读取，复杂中文字体或扫描件请优先用插件设置页。普通 PDF/DOCX 及扫描夹具已实测，复杂版式仍须核对。
- **台账最多保留 500 条**（最新），更早的自动淘汰。
- **不模拟登录、不处理验证码、不自动提交**——这些是刻意的安全边界，不是缺陷。

## 路线图

- [ ] 更多 ATS 深度适配（北森、飞书招聘…欢迎提 issue 附站点）
- [ ] 商店上架（材料已备齐，见 store/）
- [ ] 字段库按站点记忆映射

## 致谢与许可边界

- [ritsth/job-autofill-extension](https://github.com/ritsth/job-autofill-extension)（MIT）：AI 答开放题的交互思路
- [1341524165/resume-autofill-ext](https://github.com/1341524165/resume-autofill-ext)（MIT）：国内 ATS 平台识别思路
- [23aaaa/jobfill](https://github.com/23aaaa/jobfill)：仅参考交互设计（无 License，未复制任何代码）
- [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0）：已 vendor 至 `libs/pdfjs/`
- [Mammoth](https://github.com/mwilliamson/mammoth.js)（BSD-2-Clause）和 [fflate](https://github.com/101arrowz/fflate)（MIT）：本地 DOCX 读取，依赖许可见 `libs/docx/NOTICE.dependencies.txt`。

本项目以 [MIT](LICENSE) 发布。欢迎使用、修改与二次发布；请勿将本工具用于任何需要代他人填写真实身份信息的场景。

## 免责声明

本工具只做表单填写辅助，不模拟登录、不处理验证码、不自动提交。使用本工具产生的一切投递行为由使用者本人负责。
