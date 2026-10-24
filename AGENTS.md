# 开发约束与阶段进度

遵循当前用户提供的全局约束：中文注释、保留 MIT/作者版权，不自动 stage/commit/push，不创建分支或配置 upstream。

## 数据架构

- 本阶段按用户最新要求采用 `chrome.storage.local`，保持无构建的原生 JS；阶段零的 IndexedDB/Vite/Vue 工程化方案后置。
- `data/local-store.js` 为规范数据入口，`background.js` 持有唯一 repository 实例。页面禁止绕开后台直接写数据库；内容脚本只能请求阈值/开关等安全投影。
- `localapply.database` 为 Schema v3 个人库，v2 经完整校验后原子升级；`localapply.apiSettings` 为独立配置。`wangshenAutofill` 保留旧个人资料，唯一清理例外是用户设置口令并验证密文后删除旧 API Key。恢复点仅含个人库，v2 恢复点也必须升级后恢复。
- `localapply.keyVault` 仅保存 PBKDF2/AES-GCM 封套；派生密钥只驻留当前 repository 内存，错误口令不得修改存储。迁移分为先写密文、读回认证、清理明文；中断后须通过 unlock 继续。UI 不得读回已加密 Key，仅显示 keyStatus；新增 Key 必须通过 vaultCommand 保存。
- 用户后续授权 file:// 设置页独立操作：options/standalone.js 复用同一 repository，将存储适配到按文件目录隔离的 IndexedDB，多页写入由 Web Lock 串行。它不访问/同步扩展私有数据，仅允许文件协议启用；不得将此回退推广到任意 HTTP 页面。
- data/ai-client.js 为后台和文件页共用的 AI 管线，配置通过读取函数注入。文件 API 请求遵守 CORS，不能使用关闭浏览器安全策略的方式绕过；页面必须说明独立存储边界。
- API 设置中的 customProviders 保存按地址建立的服务商，providerModels 按服务商保存模型；data/providers.js 统一解析和规范化地址。新增端点不得继承上一家的 Key/模型，默认备份也不得夹带这些 API 配置。
- 模型列表只在设置页主动获取，wsa:listModels 仅接受可信扩展页面调用。列表不持久化，切换服务商/Key 后使旧响应失效；没有明确选择时不可回退预设第一个模型发请求。
- 公共 FieldDefinition 只允许 fieldId/label/type/group/aliases/options/description/version。个人值位于 fieldValues，重复经历由 entries.entryId 关联。
- 私有字段元数据默认不进入公共导出；publishDefinition 必须接收独立审核后的定义，不能自动复制经历标题。禁止新增 GitHub 上传功能，除非后续用户明确授权。
- 现有 UI 通过 readLegacy/saveLegacy 兼容投影接入；三方合并只改用户编辑的路径，同字段冲突拒绝。不要重新引入整份旧状态直接覆盖存储。
- 任何导入先完整校验、预览 revision，再提交；未知版本/类型/额外属性/断裂引用拒绝。原 PDF/DOCX、全文缓存、data URL、File/Blob 不进入新库。
- 用户已纠正简历解析方向：必须由模型读取原文件或完整页面图片，禁止本地抽取正文、OCR、按字数判断扫描件或用规则识别简历字段。代码仅做安全校验、转图、模型 JSON 契约校验和用户确认入库。Mammoth 不再加载。
- data/model-capabilities.js 通过随机数字图片、图片型 PDF、图片型 DOCX 分别实测，不以型号、自述或 HTTP 成功作为能力证明。结果只在内存缓存 30 分钟，按端点/型号/凭据隔离；未通过检测不得发送简历。检测与导入 RPC 仅限可信页面，禁止内容脚本调用。
- 简历解析使用 data/resume.js 契约，所有新模型候选默认不勾选，模型引用不是本地核实证据；编辑值标 manual。importResume 仍只接收确认项，按档案+文件 SHA-256+类别+序号去重。来源为私有资料，公共导出不可包含。
- options/resume-files.js 有界校验并保留 DOCX 图片/字体/版式，删除外部关系；document-renderer.js 在禁脚本、禁外网的临时 iframe 转图，不能遗漏图片后静默转纯文本。PDF/DOCX 最多 10 MiB、30 页/图，DOCX 解压最多 40 MiB/2,000 项，图片合计最多 16 MiB；取消/换文件释放资源，忽略迟到响应。
- 第三方代码通过 npm run vendor:libs 固定版本打包；保留 PDF.js/Mammoth/fflate 及依赖完整许可。PDF.js 使用带兼容补丁的同版本 legacy build，经典 worker 预载确保 file:// 不依赖动态模块加载。不要重新使用旧 PDF.js 3.11.174。

## 测试

- `npm test`：Node 语法/基础/数据与文档边界契约，需 npm ci 安装开发依赖，不需要下载浏览器。
- `npm run test:e2e`：需开发者手动执行 npm ci 和 npx playwright install chromium。只能使用独立测试 profile，关闭自己资源，禁止按固定端口强杀用户进程。
- Playwright 夹具只用合成资料；浏览器真实重启持久性不能用内存桩通过来替代。
- 旧 tools/verify.js、debug-ui.js 仍有历史副作用，不作为新测试入口。

## 本阶段边界

用户已授权执行阶段二：PDF.js 升级、API Key 口令加密、PDF/DOCX 结构化审核导入及简历中心。原填充引擎仍使用平面字段投影。网页字段学习、北森/飞书深度适配及重复区块自动匹配属于阶段三，须后续授权；本阶段不自动推进。

阶段二使用 PDF.js 6.4.299、Mammoth 1.13.0、fflate 0.8.3；依赖更新须同时生成运行资源和许可文件。

阶段一验证：`npm test` 的 34 项基础/数据层测试通过；Playwright 已在配套 Chromium 中实际验证迁移、管理 UI、内容脚本隔离、旧表单填充及整个浏览器重启持久性，详见 docs/阶段1数据架构与验收.md。

阶段二已验收：`npm test` 54 项、`npm run test:e2e` 31 项通过，覆盖两种入口的真实 PDF/DOCX、口令、取消及重启；AI 接口使用合成模拟服务。详见 docs/阶段2简历导入与密钥加密验收.md。

后续修正已验收：基础 58 项、浏览器 37 项通过；图像 PDF/DOCX 像素保留、原文件字节、能力拦截及旧填表回归均通过。模型优先识别及能力实测新增 docx-preview/html2canvas 本地渲染资源；普通用户仍不需安装依赖。详见最新阶段二记录。
