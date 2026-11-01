# 飞书 Schema 测试资料

这四份夹具来自用户交接包 `codex-input/feishu-schema-handoff/fixtures/`，仅包含经过白名单提取的企业表单配置，不含候选人资料、认证信息或专有扩展代码。

- `moonton.website-info.json`：飞书 Schema v5，13 组、51 字段。
- `modelbest.website-info.json`：飞书 Schema v2，12 组、46 字段。
- 两份 `inline-script.fixture.html` 是配置的模拟 HTML 包装，没有真实申请表控件，不能作为线上填写成功的证据。

浏览器测试的控件由本项目合成；企业域名请求由 Playwright 本地响应替代，不访问真实招聘网站。
