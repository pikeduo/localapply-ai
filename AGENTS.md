# 开发约束与阶段进度

遵循当前用户提供的全局约束：中文注释、保留 MIT/作者版权，不自动 stage/commit/push，不创建分支或配置 upstream。

## 数据架构

- 本阶段按用户最新要求采用 `chrome.storage.local`，保持无构建的原生 JS；阶段零的 IndexedDB/Vite/Vue 工程化方案后置。
- `data/local-store.js` 为规范数据入口，`background.js` 持有唯一 repository 实例。页面禁止绕开后台直接写数据库；内容脚本只能请求阈值/开关等安全投影。
- `localapply.database` 是 Schema v2 个人库；`localapply.apiSettings` 是独立 API 设置。`wangshenAutofill` 仅为只读迁移源，不得清理。`localapply.recovery` 保留最近一次导入前的个人库，不含 API 设置。
- 用户后续授权 file:// 设置页独立操作：options/standalone.js 复用同一 repository，将存储适配到按文件目录隔离的 IndexedDB，多页写入由 Web Lock 串行。它不访问/同步扩展私有数据，仅允许文件协议启用；不得将此回退推广到任意 HTTP 页面。
- data/ai-client.js 为后台和文件页共用的 AI 管线，配置通过读取函数注入。文件 API 请求遵守 CORS，不能使用关闭浏览器安全策略的方式绕过；页面必须说明独立存储边界。
- API 设置中的 customProviders 保存按地址建立的服务商，providerModels 按服务商保存模型；data/providers.js 统一解析和规范化地址。新增端点不得继承上一家的 Key/模型，默认备份也不得夹带这些 API 配置。
- 模型列表只在设置页主动获取，wsa:listModels 仅接受可信扩展页面调用。列表不持久化，切换服务商/Key 后使旧响应失效；没有明确选择时不可回退预设第一个模型发请求。
- 公共 FieldDefinition 只允许 fieldId/label/type/group/aliases/options/description/version。个人值位于 fieldValues，重复经历由 entries.entryId 关联。
- 私有字段元数据默认不进入公共导出；publishDefinition 必须接收独立审核后的定义，不能自动复制经历标题。禁止新增 GitHub 上传功能，除非后续用户明确授权。
- 现有 UI 通过 readLegacy/saveLegacy 兼容投影接入；三方合并只改用户编辑的路径，同字段冲突拒绝。不要重新引入整份旧状态直接覆盖存储。
- 任何导入先完整校验、预览 revision，再提交；未知版本/类型/额外属性/断裂引用拒绝。原 PDF/DOCX、全文缓存、data URL、File/Blob 不进入新库。

## 测试

- `npm test`：Node 语法/基础/数据契约，不需要 npm 测试依赖。
- `npm run test:e2e`：需开发者手动执行 npm ci 和 npx playwright install chromium。只能使用独立测试 profile，关闭自己资源，禁止按固定端口强杀用户进程。
- Playwright 夹具只用合成资料；浏览器真实重启持久性不能用内存桩通过来替代。
- 旧 tools/verify.js、debug-ui.js 仍有历史副作用，不作为新测试入口。

## 本阶段边界

阶段一仅交付数据架构、兼容迁移、备份、公共字段接口和必要管理 UI。重复经历已可保存，原填充引擎仍使用平面字段投影。AI 字段学习、整套新 UI、公共仓库上传、凭据口令加密与重复经历网页匹配均留待后续授权阶段；不得自动开始阶段二。

已知旧 PDF.js 版本安全问题见阶段零报告；本阶段不声称已升级第三方库。

阶段一验证：`npm test` 的 34 项基础/数据层测试通过；Playwright 已在配套 Chromium 中实际验证迁移、管理 UI、内容脚本隔离、旧表单填充及整个浏览器重启持久性，详见 docs/阶段1数据架构与验收.md。
