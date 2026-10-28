// 地址只接受明确省/市/区路径，顺序选择本地绑定成员，不猜省略层级或跨父级同名项。
(function (global) {
  'use strict';
  const A = global.LocalApplyFieldAdapters; const S = global.LocalApplyDatePhoneControls;
  const keys = ['province', 'city', 'district']; const executions = new WeakMap();

  // 固定错误不包含实际地址、候选文字或页面 URL。
  function failure(reason, status = 'unsupported', code = status === 'unsupported' ? 'unsupported_control' : 'write_rejected', key, counts = {}) { return { ok: false, status, reason, diagnostic: { phase: 'options', reasonCode: code, ...(key ? { part: key } : {}), ...counts } }; }
  // 原生编码和实际标签分别读取，避免把省份代码与中文名称直接比较。
  function raw(node) {
    const value = A.dropdown(node) ? A.dropdownText(node) : 'value' in node ? node.value : node.textContent.trim();
    return custom(node) && /^(请选择(?:省|市|区|地区|一项)?|省|市|区|Select|Please select)$/i.test(value.trim()) ? '' : value;
  }
  // 界面差异预览读取完整局部路径，包含空子项；只有三项都空才返回空字符串。
  function read(item) {
    const values = keys.map((key) => { const node = item.compound.parts[key]; return raw(node) && node.tagName === 'SELECT' ? node.selectedOptions?.[0]?.textContent.trim() || raw(node) : raw(node); });
    return values.some(Boolean) ? values.join(' / ') : '';
  }
  // 原生 select 优先，即使带显式 combobox 角色也不能当作网页自定义弹层。
  function custom(node) { return node.tagName !== 'SELECT' && (!!A.dropdown(node) || node.getAttribute('role') === 'combobox'); }
  // 单项候选必须唯一；重复标签/编码、禁用或协议候选均不选择。
  function resolve(node, expected, key) {
    const options = [...node.options]; const found = options.filter((option) => option.value === expected || (option.label || option.textContent).trim() === expected);
    const counts = { candidateCount: options.length, matchCount: found.length };
    if (found.length !== 1) return { error: failure('地址下级没有唯一精确选项，请在网页确认', 'unsupported', found.length ? 'ambiguous_option' : 'no_exact_option', key, counts) };
    const target = found[0]; const label = (target.label || target.textContent).trim();
    if (!target.value) return { error: failure('地址占位选项不作为实际资料', 'unsupported', 'no_exact_option', key, counts) };
    if (options.some((option) => option !== target && (option.value === target.value || label && (option.label || option.textContent).trim() === label))) return { error: failure('地址候选标签或编码有歧义，未进行选择', 'unsupported', 'ambiguous_option', key, counts) };
    if (target.disabled || target.getAttribute('aria-disabled') === 'true' || target.closest('optgroup[disabled]') || global.FieldMatchingEngine.restricted({ label, group: '' })) return { error: failure('地址目标选项禁用或受保护，请手动选择', 'unsupported', 'unsupported_control', key, counts) };
    return { target };
  }
  // 子项是否真正接受目标：文本精确回读，下拉需确认标记，原生检查唯一实际选项。
  function matches(node, expected, key) {
    if (!node.isConnected || node.getAttribute('aria-invalid') === 'true' || node.validity?.valid === false) return false;
    if (node.tagName === 'SELECT') { const found = resolve(node, expected, key); return !!found.target && node.value === found.target.value; }
    if (custom(node)) return global.LocalApplyDropdownControls.accepted(node, expected)
      || !!A.dropdown(node)?.querySelector('[class*="sd-Input-display-value-"]')?.textContent.trim() && A.dropdownText(node) === expected;
    return raw(node) === expected;
  }
  // 显式父级绑定存在时必须与实际父级编码一致，不能沿用另一条路径的同名城市。
  function bound(node, parent) {
    const value = node.getAttribute('data-parent-value');
    return value === null ? null : value === (parent.getAttribute('data-value') || raw(parent));
  }
  // 比较所有已填子项；选择上级可能清空下级时，默认也必须先获逐项覆盖许可。
  function hasConflict(item, value) {
    const next = A.plan(item, value); if (next.error) return false; const parts = item.compound.parts;
    return keys.some((key, index) => raw(parts[key]) && !matches(parts[key], next.parts[key], key)
      || !matches(parts[key], next.parts[key], key) && keys.slice(index + 1).some((child) => !!raw(parts[child])));
  }
  // 完整省市区及显式父级关系全部一致才算成功，不靠一段拼接文字冒充三级结果。
  function accepted(item, value) {
    const next = A.plan(item, value); if (next.error || item.compound?.kind !== 'address') return false;
    return keys.every((key, index) => matches(item.compound.parts[key], next.parts[key], key) && (!index || bound(item.compound.parts[key], item.compound.parts[keys[index - 1]]) !== false));
  }
  // 稳定安全属性不含正常加载时变化的 disabled/busy；节点及语义成员仍须保持原身份。
  function shape(node) { return JSON.stringify(['type', 'role', 'name', 'readonly', 'aria-readonly', 'aria-label', 'placeholder'].map((key) => node.getAttribute(key))); }
  // 页面局部快照供外层一次性计划核对，包含全部部分值/候选和节点，不进入数据库。
  function snapshot(item) { return { parts: S.snapshot(item), shapes: keys.map((key) => shape(item.compound.parts[key])), parents: keys.map((key) => item.compound.parts[key].getAttribute('data-parent-value')) }; }
  // 未执行计划的任意子项/候选/部分值变化必须拒绝，即使主省份节点没有变化。
  function unchanged(state, item) { return S.unchanged(state.parts, item) && keys.every((key, index) => item.compound.parts[key].getAttribute('data-parent-value') === state.parents[index]); }
  // 每次动作前检查授权、节点/安全属性与原分组；允许空的下级选择器正常启用。
  function guard(context, state) {
    if (context.signal?.aborted) throw failure('已取消填写', 'failed', 'write_rejected');
    const item = context.assertActive() || context.item;
    if (item.compound?.kind !== 'address' || Object.keys(item.compound.parts).join(',') !== keys.join(',')) throw failure('地址分组已变化，请重新扫描', 'failed');
    if (keys.some((key, index) => { const node = item.compound.parts[key]; return node !== state.parts[index].node || shape(node) !== state.shapes[index] || !node.isConnected
      || node.closest('button,a,[role="button"],fieldset[disabled]') || A.exclusion(node, item.field.label)?.category === 'security_control'; })) throw failure('地址子控件已变化或受保护，已停止填写', 'failed');
  }
  // 有界等待只回读，取消即释放计时器，不安排迟到赋值。
  function delay(signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      // 取消和到时共享清理入口。
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 60); signal?.addEventListener('abort', done, { once: true });
    });
  }
  // 只用当前下级原生候选的身份/内容变化证明父级刷新，不以延迟时长猜请求已完成。
  function generation(node) { return [...(node.options || [])].map((option) => [option, option.value, option.textContent, !!option.disabled]); }
  // 引用、编码或文字任一变化都表示候选换代；显示状态不构成父级归属证据。
  function changedGeneration(before, node) { const now = generation(node); return before.length !== now.length || now.some((row, index) => row.some((value, i) => value !== before[index][i])); }
  // 上级仅有一个完整原生候选或普通文本时，可兼容已有静态三字段表单。
  function independent(parent) { return parent.tagName === 'SELECT' ? [...parent.options].filter((option) => option.value !== '').length === 1 : !custom(parent); }

  const adapter = Object.freeze({ id: 'address',
    // 只接管扫描器明确识别的三成员地址，单个地址文本仍走文本能力。
    detect(control, { item }) { return item.compound?.kind === 'address'; },
    // 准备不点击、不打开菜单；缺失层级不从城市名、国内词典或海外自由文本推断。
    prepare(control, intent, context) {
      const next = A.plan(context.item, intent.value); if (next.error) return next;
      if (Object.keys(context.item.compound.parts).join(',') !== keys.join(',')) return { error: failure('地址必须有唯一明确的省、市、区子项') };
      const state = snapshot(context.item);
      try { guard(context, state); } catch (error) { return { error: error?.diagnostic ? error : failure('地址控件不可操作，请重新扫描') }; }
      const parts = context.item.compound.parts;
      if (parts.province.disabled || parts.province.getAttribute('aria-disabled') === 'true') return { error: failure('省份选择器未启用，请在网页操作') };
      if (keys.some((key) => parts[key].readOnly && !custom(parts[key]) && !matches(parts[key], next.parts[key], key))) return { error: failure('地址包含只读子项，未修改任何内容') };
      return { operation: accepted(context.item, intent.value) ? 'verify-existing' : 'fill-address', adapterState: state,
        targetParts: keys.map((key) => ({ key, handle: 'part.' + crypto.randomUUID() })) };
    },
    // 按固定路径逐级写入；下级只接受当前父级的加载证据，绝不跨路径选同名项。
    async execute(plan, context) {
      if (plan.adapterId !== 'address') throw new Error('地址计划不匹配'); const state = context.consumePlan(plan); executions.set(plan, state);
      const parts = context.item.compound.parts; const next = A.plan(context.item, context.intent.value); if (next.error) return next.error;
      const observed = new Map(keys.map((key) => [parts[key], raw(parts[key])])); const transitions = new Map(); let index = 0; let writing = false;
      // 回调只承认本次目标的修改；其他子项的外部变化必须停止，覆盖许可也不允许任意替换。
      const lifecycle = {
        check() {
          guard(context, state);
          if (keys.some((key, i) => i > 0 && (i < index || i === index && writing) && bound(parts[key], parts[keys[i - 1]]) === false)) throw failure('地址父级路径在填写中变化，已停止选择', 'failed', 'existing_value_preserved', keys[index]);
          if (keys.some((key, i) => raw(parts[key]) !== observed.get(parts[key]) || i < index && !matches(parts[key], next.parts[key], key))) throw failure('地址内容在填写中变化，已停止后续操作', 'failed', 'existing_value_preserved', keys[index]);
        },
        changed(node) {
          guard(context, state); observed.set(node, raw(node));
          if (context.overwrite) for (const key of keys.slice(index + 1)) if (!raw(parts[key])) observed.set(parts[key], '');
        }
      };
      try {
        lifecycle.check(); if (plan.operation === 'verify-existing') return { ok: true };
        for (index = 0; index < keys.length; index++) {
          writing = false;
          const key = keys[index]; const node = parts[key]; const parent = index ? parts[keys[index - 1]] : null; let ready = false; let lastError;
          for (let attempt = 0; attempt < 30; attempt++) {
            lifecycle.check(); const transition = transitions.get(key); const binding = parent ? bound(node, parent) : true;
            const pathReady = binding !== false && (!transition || binding === true || independent(parent) || changedGeneration(transition, node));
            if (!node.disabled && node.getAttribute('aria-disabled') !== 'true' && node.getAttribute('aria-busy') !== 'true' && pathReady) {
              const resolved = node.tagName === 'SELECT' ? resolve(node, next.parts[key], key) : {};
              if (!resolved.error) { ready = true; break; } lastError = resolved.error;
              if (lastError.diagnostic.reasonCode === 'ambiguous_option') break;
            }
            await delay(context.signal);
          }
          if (!ready) return lastError || failure('下级地址未就绪或缺少当前父级路径证据，请手动确认', 'unsupported', 'no_exact_option', key);
          writing = true;
          if (matches(node, next.parts[key], key)) continue;
          if (index < 2) transitions.set(keys[index + 1], generation(parts[keys[index + 1]]));
          lifecycle.check();
          if (custom(node)) {
            const result = await global.LocalApplyDropdownControls.interact(node, next.parts[key], { signal: context.signal, fieldLabel: context.item.field.label, lifecycle }); if (!result.ok) return { ...result, diagnostic: { ...result.diagnostic, part: key } };
          } else {
            const resolved = node.tagName === 'SELECT' ? resolve(node, next.parts[key], key) : null;
            if (resolved?.error) return resolved.error;
            if (!await global.LocalApplyAddressDOM.setPart(node, resolved?.target.value || next.parts[key], key, lifecycle)) return failure('网页拒绝地址子项，未重复写入', 'failed', 'write_rejected', key);
          }
          lifecycle.check(); if (!matches(node, next.parts[key], key)) return failure('网页未接受地址子项或控件已回退', 'failed', 'value_not_accepted', key);
        }
        return { ok: true };
      } catch (error) { return error?.diagnostic ? error : failure('地址控件、内容或授权已变化，已停止填写', 'failed', 'write_rejected', keys[index]); }
    },
    // 三个成员跨延迟重绘窗口都须保持相同路径，任一级回退均不计成功。
    async verify(plan, context) {
      const state = executions.get(plan); if (!state) return global.LocalApplyFillResult.failure('stale_plan');
      executions.delete(plan);
      return global.LocalApplyFillVerification.run(context, () => guard(context, state), () => accepted(context.item, context.intent.value));
    }
  });
  global.LocalApplyAddressControls = Object.freeze({ snapshot, unchanged, accepted, hasConflict, read });
  global.LocalApplyAddressAdapters = Object.freeze([adapter]);
})(globalThis);
