// 注册表只接收打包的固定能力；没有网页、模型或消息可调用的动态注册入口。
(function (global) {
  'use strict';
  const adapters = [...global.LocalApplyTextAdapters, ...global.LocalApplyNativeAdapters, ...global.LocalApplyDatePhoneAdapters, ...global.LocalApplyDropdownAdapters];
  const allowed = global.LocalApplyFillContract.ADAPTER_IDS;
  const seen = new Set();
  for (const adapter of adapters) {
    if (!allowed.includes(adapter.id) || seen.has(adapter.id)
      || Object.keys(adapter).some((key) => !['id', 'detect', 'prepare', 'execute', 'verify'].includes(key))
      || !['detect', 'prepare', 'execute', 'verify'].every((key) => typeof adapter[key] === 'function')) throw new Error('控件注册项不在白名单或发生重复');
    seen.add(adapter.id); Object.freeze(adapter);
  }
  Object.freeze(adapters);

  // 只按当前控件能力选择，多个命中时拒绝，不能用优先级猜测或执行双路径。
  function resolve(control, context) {
    const found = adapters.filter((adapter) => adapter.detect(control, context));
    if (found.length > 1) throw new Error('控件适配器存在歧义，请手动填写');
    return found[0] || null;
  }

  // 仅返回已打包且冻结的实现，不把计划中的任意字符串当作模块路径。
  function get(id) { return adapters.find((adapter) => adapter.id === id) || null; }

  global.LocalApplyAdapterRegistry = Object.freeze({ ids: Object.freeze([...seen]), resolve, get });
})(globalThis);
