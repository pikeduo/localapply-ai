// file:// 设置页运行时：复用规范数据仓库，通过独立 IndexedDB 保存，不伪造 Chrome API。
(function (global) {
  'use strict';
  const enabled = global.location?.protocol === 'file:';
  if (!enabled) { global.LocalApplyStandalone = { enabled: false }; return; }
  const databaseName = 'localapply-file:' + new URL('.', global.location.href).href;
  let connection;

  // 按设置页所在目录隔离数据，移动文件或更换浏览器时需通过备份迁移。
  function openDatabase() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('storage');
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); connection = null; };
        resolve(database);
      };
      request.onerror = () => { connection = null; reject(new Error('无法打开文件页本地数据库，请检查浏览器存储权限。')); };
      request.onblocked = () => { connection = null; reject(new Error('本地数据库被旧页面占用，请关闭其他文件设置页后重试。')); };
    });
    return connection;
  }

  // 将一个 Chrome Storage 风格的批量操作映射为 IndexedDB 事务，完成事件才算落盘。
  async function transaction(mode, work) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('storage', mode);
      const result = {};
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('文件页本地数据保存失败，请检查空间或存储权限。'));
      try { work(tx.objectStore('storage'), result); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  const storage = {
    // 此数据库只属于文件管理模式，扩展内容脚本不获得任何访问权限。
    async setAccessLevel() {},
    // 按规范仓库要求读取多个 JSON 键，未存储的键返回 undefined。
    get(names) {
      return transaction('readonly', (store, result) => {
        for (const name of Array.isArray(names) ? names : [names]) {
          const request = store.get(name);
          request.onsuccess = () => { result[name] = request.result; };
        }
      });
    },
    // 配置与个人库仍保存为独立记录，禁止把原文件放入此适配器。
    set(values) {
      return transaction('readwrite', (store) => {
        for (const [key, value] of Object.entries(values)) store.put(value, key);
      });
    },
  };
  const repository = global.LocalApplyStore.createRepository(storage);
  const ai = global.LocalApplyAI.createClient(() => repository.readAiSettings());

  // 与扩展使用相同命令语义，文件页从不调用插件私有存储或网页填充权限。
  async function dispatch(type, payload) {
    switch (type) {
      case 'wsa:getState': return { state: await repository.readLegacy() };
      case 'localapply:saveLegacy': return { state: await repository.saveLegacy(payload.base, payload.state, payload.source) };
      case 'localapply:read': return { database: await repository.read() };
      case 'localapply:vault': return { settings: await repository.vaultCommand(payload.action, payload.payload) };
      case 'localapply:command': return repository.command(payload.request || {});
      case 'localapply:exportBackup': return { backup: await repository.exportBackup() };
      case 'localapply:previewImport': return { preview: await repository.previewImport(payload.backup, payload.mode) };
      case 'localapply:exportPublicFields': return { fields: await repository.exportPublicFields() };
      case 'wsa:listModels': return ai.listAvailableModels(payload.providerId);
      case 'wsa:aiChat': return ai.callGLM(payload.payload || {});
      case 'wsa:cancelResume': ai.cancel(payload.requestId); return {};
      case 'wsa:aiExtractResume': return { data: await ai.extractResume(payload.payload || {}) };
      default: throw new Error('文件管理模式不支持此操作；网页自动填充请从浏览器插件入口使用。');
    }
  }

  // 多个文件设置页通过同名 Web Lock 串行访问仓库，避免各自读改写覆盖。
  async function request(type, payload = {}) {
    try {
      // 网络请求不持有存储锁，让用户能在请求期间切换服务商/修改配置。
      const network = ['wsa:listModels', 'wsa:aiChat', 'wsa:aiExtractResume'].includes(type);
      const execute = () => dispatch(type, payload);
      const result = !network && navigator.locks
        ? await navigator.locks.request(databaseName, execute) : await execute();
      return { ok: true, ...result };
    } catch (error) {
      const networkError = /网络请求失败|无法连接模型列表接口|failed to fetch/i.test(error.message || '');
      return { ok: false, error: networkError
        ? '无法连接接口。文件页请求受 CORS 限制，请检查地址、服务是否可达及服务端是否允许 Origin: null；也可使用插件设置页。'
        : error.message || String(error) };
    }
  }

  global.LocalApplyStandalone = { enabled: true, request };
})(globalThis);
