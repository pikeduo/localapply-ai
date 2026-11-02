# 飞书 Schema 测试资料

原有四份夹具来自用户交接包 `codex-input/feishu-schema-handoff/fixtures/`，仅包含经过白名单提取的企业表单配置，不含候选人资料、认证信息或专有扩展代码。

- `moonton.website-info.json`：飞书 Schema v5，13 组、51 字段。
- `modelbest.website-info.json`：飞书 Schema v2，12 组、46 字段。
- `poizon.website-info.json`：从用户提供的得物HTML中单独提取公共字段元数据，飞书Schema v11、数字站点路径，22组/174字段/34个有效可见字段。租户、站点及Schema标识替换为合成值；不复制其他页面配置或脚本。原HTML只有页面壳和配置，没有渲染后的表单控件。
- 两份 `inline-script.fixture.html` 是配置的模拟 HTML 包装，没有真实申请表控件，不能作为线上填写成功的证据。

浏览器测试的控件由本项目合成；企业域名请求由 Playwright 本地响应替代，不访问真实招聘网站。
