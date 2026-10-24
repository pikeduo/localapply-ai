// 口令保险库：AES-GCM 密文落盘，派生密钥只保留在当前后台/文件页内存。
(function (global) {
  'use strict';
  const ITERATIONS = 600000;
  const encoder = new TextEncoder();
  const aad = encoder.encode('localapply-key-vault:v1');

  // 编码仅用于密文和随机参数，不能把 Base64 当加密。
  function encode(bytes) {
    let result = '';
    for (const byte of new Uint8Array(bytes)) result += String.fromCharCode(byte);
    return global.btoa(result);
  }
  // 限制密文规模与编码格式，避免畸形数据产生无限资源消耗。
  function decode(text) {
    if (typeof text !== 'string' || text.length > 1500000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('保险库数据损坏');
    return Uint8Array.from(global.atob(text), (char) => char.charCodeAt(0));
  }
  // 校验存储封套，KDF 参数有界，不能由导入内容任意放大。
  function validate(record) {
    if (!record || record.version !== 1 || !Number.isInteger(record.iterations) || record.iterations < ITERATIONS || record.iterations > 2000000
      || decode(record.salt).length !== 16 || decode(record.iv).length !== 12 || decode(record.ciphertext).length < 16
      || !Array.isArray(record.providers) || record.providers.some((id) => typeof id !== 'string')
      || !Number.isInteger(record.revision) || record.revision < 1) throw new Error('保险库格式不支持或已损坏');
    return record;
  }
  // 口令派生不可导出的 AES 密钥；口令本身不落盘。
  async function derive(password, salt, iterations = ITERATIONS) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('安全口令须为 8–1024 个字符');
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // 每次保存独立生成 IV，payload 只含服务商 Key 和旧 Key 的加密恢复资料。
  async function seal(payload, key, salt, revision, migrationPending = false) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(JSON.stringify(payload)));
    return { version: 1, iterations: ITERATIONS, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext),
      providers: Object.keys(payload.keys).filter((id) => payload.keys[id]), revision, migrationPending };
  }
  // 认证解密成功后才接受内容；错误口令不修改任何存储。
  async function open(record, key) {
    validate(record);
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.iv), additionalData: aad }, key, decode(record.ciphertext));
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      if (!payload || !payload.keys || typeof payload.keys !== 'object' || Array.isArray(payload.keys)
        || Object.values(payload.keys).some((value) => typeof value !== 'string')) throw new Error('bad payload');
      return payload;
    } catch { throw new Error('口令错误或保险库已损坏，未更改任何密钥'); }
  }
  // 首次设置返回密文与仅供当前会话使用的密钥。
  async function create(password, payload) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derive(password, salt);
    return { key, record: await seal(payload, key, salt, 1, true) };
  }
  // 从封套恢复当前会话的密钥，必须验证认证标签。
  async function unlock(password, record) {
    validate(record);
    const key = await derive(password, decode(record.salt), record.iterations);
    await open(record, key);
    return key;
  }
  global.LocalApplyVault = { validate, create, unlock, open, seal, decode };
})(globalThis);
