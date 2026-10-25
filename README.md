# LocalApply · 本地智能网申助手

Manifest V3 浏览器扩展（Edge / Chrome 通用，原生 JavaScript，运行无需构建）。把简历信息一次性录入字段库后，在招聘网申页面上**短字段一键自动填、长文本点选填、开放题用 AI 起草**。资料默认保存在本机，AI 调用由你主动触发，永不自动点提交。

基于 [xiaoxiaobaijiangjun/wangshen-autofill](https://github.com/xiaoxiaobaijiangjun/wangshen-autofill) 重构，保留原项目 MIT 许可证与作者版权。

![manifest](https://img.shields.io/badge/manifest-v3-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/runtime-browser%20only-orange)

## 功能

- **一键自动填充**：label 同义词匹配（60 组词库，覆盖互联网 + 央国企网申常见字段），得分 ≥ 阈值才填，已填字段高亮标记 + 复查清单
- **框架兼容**：绕过 React 受控组件的 value tracker，Vue/select/radio/checkbox/contenteditable 都能填
- **平台增强**：Moka（mokahr.com）、国聘（iguopin.com）定制识别；其余网站走通用启发式；手机号 +86 区号框、家庭成员表格、验证码控件自动避让
- **下拉框智能匹配**：`CET-4` ↔ `四级`、`共青团员` ↔ `团员`、`硕士` ↔ `研究生` 等同义写法自动对上
- **PDF/DOCX 简历导入**：检测模型的文件/图片识别能力后，优先直接提交原文件；不接受该格式时交由已验证的视觉模型读取完整页面图片。代码不抽取正文或识别简历字段，DOCX 嵌入图片保留。所有候选逐项人工校对、勾选后保存，同一文件重复导入复用经历；原文件和页面图片不保存。
- **能力实测**：主动检测图片、图片型 PDF、图片型 DOCX 是否能读出随机数字，每个所选模型最多 3 次请求，可能计费。仅使用合成样例，不发送简历；连接成功、模型名称或自述不能当作识别通过。
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

> **AI 是可选的**：手动录入和规则填表无需 AI。解析 PDF/DOCX 时，模型必须通过当前接口的原文件或图片识别测试；纯文本模型仍可用于开放题起草。可以为解析单独配置视觉模型。

> Chrome 同理：`chrome://extensions` → 开发人员模式 → 加载已解压的扩展程序。

自定义接口请填写与可用客户端一致的完整 Base URL。`http://地址:端口/` 会保留根路径，`http://地址:端口/v1` 会使用 `/v1`；旧配置不会自动更改。可选择 Chat Completions 或 Responses 协议（如 Codex/sub2api），界面显示实际调用地址。获取模型列表失败时，可手填服务端实际支持的模型 ID 后单独测试连接；列表、推理及文件能力须分别验证。新建地址后需重新保存 Key。

设置页支持两种入口：从插件的「设置/扩展选项」进入时使用插件资料；直接双击 `options/options.html`（`file://`）进入时使用独立的本地文件管理模式，可配置 API、查询模型、读取 PDF/DOCX 并校对导入、编辑重复经历和备份恢复，无需安装扩展。两者不自动同步，也不共享 Key；通过 JSON 备份交换个人资料，API 配置分别填写。文件页数据保存在此浏览器、此文件目录对应的 IndexedDB，移动目录或更换浏览器前请导出备份。

文件管理模式访问 API 受浏览器 [CORS 规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) 限制：服务端需要允许 `Origin: null`、相关请求方法及认证头；无法访问时会显示原因，其他本地操作仍可使用。无需关闭浏览器安全策略。网页自动填充和扩展权限功能仍需插件入口。普通 HTTP 预览不会开启文件管理模式；重新加载插件后，旧的插件设置页应关闭再打开。

AI 服务商可以从输入框的建议列表选择，也可以输入 `192.168.1.10:8000` 后按回车或移开焦点，自动保存为 `http://192.168.1.10:8000/v1`。域名默认使用 HTTPS；完整地址保留自定义路径，粘贴 `/chat/completions` 地址时自动提取 Base URL。相同地址不重复创建，新地址不继承其他服务商的 Key 或模型。

配置顺序：选择服务商 → 在 **API Key** 输入框粘贴 Key 并点击“保存 Key” → 获取可用模型 → 选择主模型 → 测试连接及文件/图片识别能力。默认无需安全口令；无认证的本地服务可不填 Key。“口令保护”是可选折叠项：原 Key 已加密时，可用原口令取消保护；忘记口令也能直接重填新 Key，旧密文保留。模型列表通过当前接口的 `GET /models` 获取，不发送简历，不自动选第一个型号；失败或空列表时可手动填写模型 ID。切换服务商或 Key 后需重新获取、检测。保存配置本身不联网或下载模型。

服务端需支持 OpenAI Chat Completions 兼容协议。接口参考：[DeepSeek](https://api-docs.deepseek.com/)、[DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[Qwen/阿里云百炼](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[Ollama 本地接口](https://docs.ollama.com/api/openai-compatibility)。

主模型和视觉模型下拉均显示当前端点已获取的完整列表，已选值不会过滤其他型号；手动输入时也可直接从下拉切回。近期列表仅在当前标签页临时缓存 30 分钟，刷新可复用，不会自动联网；更换端点/Key 后重新获取，不自动改动已保存型号。

DeepSeek 官方 `deepseek-flash` 支持图片，`deepseek-v4-pro` 不支持图片。其 Files API 当前列出的格式为图片；本插件可把 PDF/DOCX 的完整页面图交给 Flash 识别。主模型选 Flash 时，视觉模型可留为“使用主模型”，然后主动检测识别能力。检测失败/超时/截断不等于不支持；官方 DeepSeek 的短检测与结构化抽取使用非思考模式，避免短预算被默认思考消耗。参考：[图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)、[模型说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[Files API](https://api-docs.deepseek.com/zh-cn/guides/files_api/)。

## 快速上手

阶段三智能填表入口在侧栏“智能填表”：勾选授权当前招聘页 → 扫描 → 核对本地匹配；未知字段可预览服务商及脱敏内容后主动使用 AI。采用建议后需单独预览并确认新字段/值；单项或批量填写也先确认。成功验证后可记住映射，历史规则支持修改、禁用、删除及本会话撤销。无 Key 仍能使用本地来源及手动操作；不自动提交申请。刷新或导航后需重新授权。

1. **录入简历**：将 PDF/DOCX 拖入简历区域，或点击选择文件 → 自动展开页面预览 → 主动发送模型解析 → 校对来源、选择字段及目标档案 → 确认导入。拖入和预览不会自动调用模型，也可在简历中心或侧边栏手填。
2. **填充**：打开网申页 → 浮条/侧边栏显示 `可自动填 N · 点选 M · 开放题 K` → 点「一键填充」→ 对照复查清单
3. **开放题**：点「✨起草」生成草稿（可换一版），改好后点「填入」
4. **台账**：投递完在「台账」页导出 CSV

## 数据与隐私

- 简历字段、档案、台账、草稿**全部只存在本机** `chrome.storage.local`，卸载扩展即彻底删除；插件没有服务器、没有统计埋点
- 对外请求仅由你主动触发：能力检测发送合成图片/文件，简历识别发送原文件或完整页面图片，开放题起草发送题目及素材；均发往所选服务商。保存配置和本地预览不会调用 AI。
- 附件清单只登记文件名和备注，不读取文件本体
- 升级迁移原 `wangshenAutofill` 和 Schema v2 资料至 v3。Key 默认在本机自动保存，无需口令；AES-GCM 密文与自动密钥同机保存，不提供独立口令保护。可选口令模式使用 PBKDF2-SHA256（600,000 次）派生密钥，重启后须解锁；可随时取消保护。迁移先验证密文再清理旧明文，其他旧资料保留。个人简历库本身不加密，口令不可找回。
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
data/resume.js           模型输出契约与人工校对候选
data/model-capabilities.js 原文件/图片能力实测及安全路由
options/resume-files.js  文件校验与 PDF 转图，不抽取正文
options/document-renderer.js DOCX 图文渲染
options/resume-ui.js     简历中心、预览、取消与确认导入
libs/pdfjs/              PDF.js 6.4.299，本地字体/CMap/WASM 与许可
libs/docx/               docx-preview、html2canvas、fflate 及许可；历史 Mammoth 不再加载
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
- **文件/图片识别**：能力实测基于当前接口的 Chat Completions 内容块协议，不代表服务商的全部专用文件 API。检测结果按端点/型号/凭据隔离，30 分钟或后台重启后过期。样例通过也不保证所有版式都能准确识别，所有候选默认不勾选。
- **DOCX 预览**：网页转图可能与 Word 分页不同。请检查图片是否完整；图片无法渲染时会阻止发送并提示转 PDF，避免静默遗漏。
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
- [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)（Apache-2.0）与 [html2canvas](https://github.com/niklasvh/html2canvas)（MIT）：仅本地页面转图；许可见 `libs/docx/NOTICE.rendering.txt`。历史 Mammoth 资源/许可保留，已从运行页面移除。

本项目以 [MIT](LICENSE) 发布。欢迎使用、修改与二次发布；请勿将本工具用于任何需要代他人填写真实身份信息的场景。

## 免责声明

本工具只做表单填写辅助，不模拟登录、不处理验证码、不自动提交。使用本工具产生的一切投递行为由使用者本人负责。
