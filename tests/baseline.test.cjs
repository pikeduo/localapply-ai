// 阶段零基线：只在内存中执行原有脚本，不联网、不启动浏览器、不读写用户档案。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

// 读取仓库源码，测试不依赖运行命令所在的目录。
function source(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// 为每项测试创建隔离的 Chrome 存储和消息桩；fetch 调用一律阻止。
function sandbox(file = 'data/templates.js', initial = {}) {
  const storage = structuredClone(initial);
  const listeners = [];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, AbortController, crypto: require('node:crypto').webcrypto,
    fetch: async () => { throw new Error('基线测试禁止联网'); },
    chrome: {
      storage: { local: {
        get: async (key) => structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map((item) => [item, storage[item]]))),
        set: async (value) => { Object.assign(storage, structuredClone(value)); },
        setAccessLevel: async () => {},
      } },
      runtime: {
        id: 'test-extension', getURL: (name) => 'chrome-extension://test-extension/' + name,
        onMessage: { addListener: (listener) => listeners.push(listener) },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
      },
    },
  });
  // 原 service worker 通过 importScripts 加载模板，保持相同执行顺序。
  context.importScripts = (...names) => names.forEach((name) => vm.runInContext(source(name), context, { filename: name }));
  vm.runInContext(source(file), context, { filename: file });
  return { context, storage, listeners };
}

// 枚举手写 JavaScript，第三方压缩代码单独做语法检查。
function scripts(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? scripts(file) : /\.(js|cjs)$/.test(file) ? [file] : [];
  });
}

test('全部 JavaScript 可通过 Node 语法检查（不执行脚本）', () => {
  for (const file of ['background.js', 'common.js', ...['content', 'data', 'sidepanel', 'options', 'tools', 'libs', 'tests'].flatMap(scripts)]) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('MV3 清单的脚本、页面及图标资源均存在', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  const files = [manifest.background.service_worker, manifest.side_panel.default_path,
    manifest.options_page, ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => entry.js)];
  for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  for (const html of [manifest.side_panel.default_path, manifest.options_page]) {
    for (const match of source(html).matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(html), match[1])), `${html}: ${match[1]}`);
    }
  }
});

test('默认档案包含 51 个唯一字段及隐私默认值', () => {
  const state = sandbox().context.WangshenTemplates.defaultState();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.profiles[0].fields.length, 51);
  assert.equal(new Set(state.profiles[0].fields.map((field) => field.key)).size, 51);
  assert.equal(state.settings.privacyMask, true);
  assert.equal(Object.keys(state.settings.apiKeys).length, 0);
});

test('不同档案的字段值和选项互不污染', () => {
  const templates = sandbox().context.WangshenTemplates;
  const first = templates.makeProfile('甲', 'all');
  const second = templates.makeProfile('乙', 'all');
  first.fields[0].value = '虚构姓名';
  first.fields.find((field) => field.options).options.push('测试选项');
  assert.equal(second.fields[0].value, '');
  assert.ok(!second.fields.find((field) => field.options).options.includes('测试选项'));
});

test('常用中文标签正确匹配；素材和未知标签不冒充已知字段', () => {
  const templates = sandbox().context.WangshenTemplates;
  for (const [label, key] of [[' * 姓名：', 'name'], ['手机号码', 'phone'], ['电子邮箱', 'email'], ['毕业院校', 'school'], ['期望工作城市', 'expectedCity']]) {
    assert.equal(templates.matchLabel(label).key, key);
  }
  assert.equal(templates.matchLabel('项目深挖'), null);
  assert.equal(templates.matchLabel('火星基地编号'), null);
});

test('旧档案升级保留已有值与自定义字段且可重复执行', () => {
  const templates = sandbox().context.WangshenTemplates;
  const profile = { id: 'old', fields: [
    { key: 'name', value: '测试姓名' }, { key: 'c_example', custom: true, value: '测试内容' },
  ] };
  templates.upgradeProfile(profile);
  const snapshot = JSON.stringify(profile);
  templates.upgradeProfile(profile);
  assert.equal(JSON.stringify(profile), snapshot);
  assert.equal(profile.fields.length, 52);
  assert.equal(profile.fields[0].value, '测试姓名');
  assert.equal(profile.fields[1].value, '测试内容');
});

test('旧单 Key 配置迁移至服务商配置且保持幂等', () => {
  const templates = sandbox().context.WangshenTemplates;
  const state = { settings: { apiKey: 'fake-test-key' } };
  assert.equal(templates.normalizeSettings(state), true);
  assert.equal(state.settings.apiKeys.zhipu, 'fake-test-key');
  assert.equal('apiKey' in state.settings, false);
  assert.equal(templates.normalizeSettings(state), false);
});

test('共享存储首次初始化和再次读取保持档案一致', async () => {
  const { context, storage } = sandbox('background.js');
  const first = await context.getState();
  const second = await context.getState();
  assert.equal(first.profiles[0].id, second.profiles[0].id);
  assert.equal(storage['localapply.database'].schemaVersion, 2);
});

test('AI 回复 JSON 围栏可解析，异常文本返回空结果', () => {
  const { context } = sandbox('background.js');
  assert.equal(context.extractJson('说明\n```json\n{"name":"测试"}\n```').name, '测试');
  assert.equal(context.extractJson('不是 JSON'), null);
  assert.equal(context.extractJson('{bad}'), null);
});

test('无 Key 请求在联网前返回可读错误', async () => {
  const { context } = sandbox('background.js');
  await assert.rejects(context.callGLM({}), /尚未配置/);
});

test('消息层 ping 和无 Key 错误可异步返回', async () => {
  const { listeners } = sandbox('background.js');
  // 使用原消息回调验证异步响应；超时由 node:test 的测试选项控制。
  const ping = await new Promise((resolve) => listeners[0]({ type: 'wsa:ping' }, {}, resolve));
  assert.equal(ping.pong, true);
  const error = await new Promise((resolve) => listeners[0]({ type: 'wsa:aiChat', payload: {} },
    { id: 'test-extension', url: 'chrome-extension://test-extension/options/options.html' }, resolve));
  assert.equal(error.ok, false);
  assert.match(error.error, /尚未配置/);
});

test('内容脚本不能读取个人库、导出、命令写入或代理 AI', async () => {
  const { listeners } = sandbox('background.js');
  const sender = { id: 'test-extension', url: 'https://recruit.example.test/apply', tab: { id: 1 } };
  for (const type of ['wsa:getState', 'localapply:read', 'localapply:command', 'localapply:exportBackup', 'localapply:exportPublicFields', 'wsa:aiChat']) {
    const response = await new Promise((resolve) => listeners[0]({ type }, sender, resolve));
    assert.equal(response.ok, false, type);
    assert.match(response.error, /仅允许/);
  }
  const safe = await new Promise((resolve) => listeners[0]({ type: 'wsa:contentSettings' }, sender, resolve));
  assert.equal(safe.ok, true);
  assert.deepEqual(Object.keys(safe.settings).sort(), ['autoFloatbar', 'autoThreshold', 'privacyMask']);
});

test('CSV 保留 BOM、中文、双引号与换行转义', () => {
  const { context } = sandbox('background.js');
  const csv = context.buildCsv([{ company: '测试"公司\n第二行', autoCount: 2 }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('"测试""公司\n第二行"'));
  assert.ok(csv.includes('"2"'));
});

test('视觉页结果合并保留首个标量和去重技能', () => {
  const { context } = sandbox('background.js');
  const merged = {};
  context.mergeResumePart(merged, { name: '第一页', skills: ['JS'] });
  context.mergeResumePart(merged, { name: '第二页', skills: ['JS', 'CSS'] });
  assert.equal(merged.name, '第一页');
  // VM 数组来自不同原型域，转为宿主数组后比较实际内容。
  assert.deepEqual(Array.from(merged.skills), ['JS', 'CSS']);
});

test('PDF.js 可本地解析扫描夹具（不渲染、不联网）', async () => {
  const pdfjs = require('../libs/pdfjs/pdf.min.js');
  assert.equal(pdfjs.version, '3.11.174');
  // Node 默认寻找未压缩 worker；仓库仅携带压缩版，显式使用现有文件。
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'libs/pdfjs/pdf.worker.min.js');
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(path.join(ROOT, 'test-pages/fake-scan.pdf'))),
    isEvalSupported: false, useSystemFonts: false,
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 1);
    const content = await (await document.getPage(1)).getTextContent();
    assert.equal(content.items.length, 0);
  } finally {
    await task.destroy();
  }
});
