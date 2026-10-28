// 存储基准只使用合成资料；输出数量/字节/耗时，不输出数据库内容。
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
// 在隔离上下文加载实际数据模块，避免复制数据库实现。
function modules() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, URL, TextEncoder, TextDecoder, btoa, atob });
  for (const name of ['templates', 'key-vault', 'resume', 'resume-catalog', 'field-matching', 'applications', 'local-store']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', name + '.js'), 'utf8'), context);
  return context;
}
// 构造多档案、字段、规则及岗位；所有内容均为虚构，保留真实 Schema 校验。
function dataset(context) {
  const db = context.LocalApplyStore.migrate(context.WangshenTemplates.defaultState()).db;
  const original = structuredClone(db); db.profiles = []; db.bindings = []; db.fieldValues = []; db.entries = []; db.mappingRules = []; db.applications = [];
  for (let p = 0; p < 12; p++) {
    const profileId = 'bench.' + p; db.profiles.push({ ...structuredClone(original.profiles[0]), profileId, name: '合成简历' + p });
    for (const binding of original.bindings.filter((row) => row.profileId === original.profiles[0].profileId)) {
      db.bindings.push({ ...structuredClone(binding), profileId });
      const def = db.fieldDefinitions.find((row) => row.fieldId === binding.fieldId);
      if (['text', 'textarea'].includes(def.type)) db.fieldValues.push({ profileId, fieldId: def.fieldId, entryId: null, value: '合成测试内容' + p, updatedAt: '2026-10-28T00:00:00.000Z', source: 'manual' });
    }
    for (let n = 0; n < 100; n++) db.mappingRules.push({ mappingId: 'bench.' + p + '.' + n, origin: 'https://jobs.example.test', path: '/apply', label: '合成字段', fieldId: 'builtin.name', profileId, entryId: null });
  }
  db.activeProfileId = 'bench.0'; db.drafts = {}; db.ledger = [];
  for (let n = 0; n < 200; n++) context.LocalApplyApplications.save(db.applications, { confirmed: true, newRound: false, record: { companyName: '合成企业', jobTitle: '合成岗位' + n, jobUrl: 'https://jobs.example.test/jobs/' + n, jobId: '' + n, jobSource: '合成平台', location: '合成城市', employmentType: '全职', summary: '' } });
  context.LocalApplyStore.validate(db); return structuredClone(db);
}
// 同一测量函数可运行于 Node 隔离介质和真实扩展后台；仅返回白名单指标。
async function measure({ db, cached, iterations = 30 }) {
  const S = globalThis.LocalApplyStore; const storage = globalThis.__benchmarkStorage; let reads = 0; let writes = 0;
  const area = { QUOTA_BYTES: storage.QUOTA_BYTES, ...(storage.getBytesInUse ? { getBytesInUse: (keys) => storage.getBytesInUse(keys) } : {}), setAccessLevel: (v) => storage.setAccessLevel(v), get: (keys) => { if ([keys].flat().includes(S.DB_KEY)) reads++; return storage.get(keys); }, set: (v) => { if (Object.hasOwn(v, S.DB_KEY)) writes++; return storage.set(v); } };
  await storage.set({ [S.DB_KEY]: db, [S.API_KEY]: S.migrate(globalThis.WangshenTemplates.defaultState()).api, [S.CATALOG_KEY]: { version: globalThis.WangshenTemplates.CATALOG_VERSION } });
  const repo = S.createRepository(area, { cache: cached, changes: globalThis.__benchmarkChanges }); const results = {};
  // 使用顺序样本计算分位数，避免将一次时延误称为分位统计。
  async function samples(name, count, work) {
    const times = []; const r = reads; const w = writes;
    for (let i = 0; i < count; i++) { const at = performance.now(); await work(i); times.push(performance.now() - at); }
    times.sort((a, b) => a - b); results[name] = { samples: count, p50Ms: +times[Math.ceil(count * .5) - 1].toFixed(3), p95Ms: +times[Math.ceil(count * .95) - 1].toFixed(3), dbReads: reads - r, dbWrites: writes - w };
  }
  await samples('cold', 10, async () => { const cold = S.createRepository(area, { cache: cached, changes: globalThis.__benchmarkChanges }); await cold.read(); cold.dispose?.(); });
  await repo.read();
  await samples('read', iterations, () => repo.read());
  await samples('fields', iterations, () => repo.readLegacy());
  await samples('fieldContext', iterations, () => repo.readFieldContext ? repo.readFieldContext(db.activeProfileId) : repo.read());
  await samples('write', 10, (i) => repo.command({ action: 'setValue', payload: { profileId: db.activeProfileId, fieldId: 'builtin.name', value: '合成更新' + i } }));
  await samples('concurrent', 10, () => Promise.all([repo.read(), repo.readLegacy(), repo.command({ action: 'setValue', payload: { profileId: db.activeProfileId, fieldId: 'builtin.name', value: '合成并发' } }), repo.read()]));
  const metrics = repo.storageStatus ? await repo.storageStatus() : null; repo.dispose?.();
  return { results, reads, writes, metrics };
}
// 命令行基准支持真实独立 Chromium 或克隆内存介质；绝不连接用户浏览器。
async function main() {
  const context = modules(); const db = dataset(context); const cached = process.argv.includes('--cached'); const browserMode = process.argv.includes('--browser'); let result;
  if (browserMode) {
    const { chromium } = require('playwright'); const profile = fs.mkdtempSync(path.join(ROOT, '.browser-tests', 'storage-bench-')); let browser; let runtime = ROOT;
    if (process.argv.includes('--baseline')) {
      // 在独立目录运行修改前已提交的源码；只复制发行资源，不复制用户文档、数据或测试输出。
      runtime = path.join(profile, 'baseline-extension'); fs.mkdirSync(runtime);
      for (const name of ['manifest.json', 'background.js', 'data', 'content', 'options', 'panel', 'sidepanel', 'icons', 'libs', 'LICENSE']) if (fs.existsSync(path.join(ROOT, name))) fs.cpSync(path.join(ROOT, name), path.join(runtime, name), { recursive: true });
      for (const name of ['data/local-store.js', 'background.js', 'data/field-learning.js', 'options/standalone.js', 'options/diagnostics.js']) {
        const source = require('node:child_process').execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'show', 'HEAD:' + name], { cwd: ROOT }); fs.writeFileSync(path.join(runtime, name), source);
      }
    }
    // 只创建/关闭本基准自己的浏览器；重启复用同一个合成持久目录。
    const open = () => chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', args: ['--disable-extensions-except=' + runtime, '--load-extension=' + runtime] });
    try {
      browser = await open();
      const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
      // 基准独占这个合成后台的写入；关闭默认仓库，避免第二个监听器干扰时延统计。
      await worker.evaluate(() => { repository.dispose?.(); globalThis.__benchmarkStorage = chrome.storage.local; globalThis.__benchmarkChanges = chrome.storage.onChanged; });
      result = await worker.evaluate(measure, { db, cached });
      const restartTimes = []; let restartReads = 0; let occupiedBytes = null;
      for (let n = 0; n < 5; n++) {
        await browser.close(); browser = await open(); const next = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
        const sample = await next.evaluate(async (cached) => {
          repository.dispose?.(); let reads = 0; const area = chrome.storage.local;
          const storage = { setAccessLevel: (v) => area.setAccessLevel(v), get: (keys) => { if ([keys].flat().includes(LocalApplyStore.DB_KEY)) reads++; return area.get(keys); }, set: (v) => area.set(v) };
          const repo = LocalApplyStore.createRepository(storage, { cache: cached, changes: chrome.storage.onChanged }); const at = performance.now(); const db = await repo.read(); const ms = performance.now() - at; repo.dispose?.();
          return { ms, reads, revision: db.revision, bytes: await area.getBytesInUse('localapply.database') };
        }, cached);
        if (sample.revision !== 20) throw new Error('重启后 revision 不符'); restartTimes.push(sample.ms); restartReads += sample.reads; occupiedBytes = sample.bytes;
      }
      restartTimes.sort((a, b) => a - b); result.results.browserRestart = { samples: 5, p50Ms: +restartTimes[2].toFixed(3), p95Ms: +restartTimes[4].toFixed(3), dbReads: restartReads, dbWrites: 0 }; result.actualDatabaseBytes = occupiedBytes;
    } finally {
      await browser?.close();
      if (!path.resolve(profile).startsWith(path.resolve(ROOT, '.browser-tests') + path.sep)) throw new Error('基准清理路径越界');
      fs.rmSync(profile, { recursive: true, force: true });
    }
  } else {
    const disk = {}; context.performance = performance; context.__benchmarkStorage = { setAccessLevel: async () => {}, get: async (keys) => structuredClone(Object.fromEntries([keys].flat().map((key) => [key, disk[key]]))), set: async (v) => Object.assign(disk, structuredClone(v)) };
    result = await vm.runInContext('(' + measure.toString() + ')', context)({ db, cached });
  }
  const report = { mode: browserMode ? 'chromium-storage-local' : 'node-clone-memory', cached, baseline: process.argv.includes('--baseline'), quantiles: 'nearest-rank', scale: { profiles: db.profiles.length, definitions: db.fieldDefinitions.length, values: db.fieldValues.length, bindings: db.bindings.length, mappings: db.mappingRules.length, applications: db.applications.length, jsonBytes: Buffer.byteLength(JSON.stringify(db)) }, ...result };
  const out = process.argv.find((v) => v.startsWith('--out='))?.slice(6); if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { modules, dataset, measure };
