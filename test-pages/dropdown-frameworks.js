// 仅供 loopback 的真实受控 ARIA 异步菜单，不进入发行依赖。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref } from '@vue/runtime-dom';
globalThis.__dropdownProbe = {};

// React 显式选中状态和搜索状态分开，拒绝项只留下搜索文字而不确认选项。
function ReactDropdown({ reject = false }) {
  const id = reject ? 'react-dropdown-reject' : 'react-dropdown'; const [query, setQuery] = useState(''); const [ready, setReady] = useState(false); const [selected, setSelected] = useState(''); const [open, setOpen] = useState(false); const [tick, setTick] = useState(0);
  globalThis.__dropdownProbe[id] = () => selected; globalThis.__dropdownProbe[id + '-redraw'] = () => setTick((value) => value + 1);
  return React.createElement('fieldset', null, React.createElement('label', { htmlFor: id }, reject ? 'React拒绝下拉' : 'React异步下拉'),
    React.createElement('input', { id, role: 'combobox', 'aria-controls': id + '-menu', 'aria-autocomplete': 'list', 'aria-expanded': open, value: selected ? '男' : query,
      onClick: () => setOpen(true), onChange: (event) => { setQuery(event.target.value); setReady(false); setTimeout(() => setReady(true), 250); } }),
    React.createElement('div', { id: id + '-menu', role: 'listbox', hidden: !open }, ready && React.createElement('div', { role: 'option', 'data-value': 'M', 'aria-selected': selected === 'M', onClick: () => { if (!reject) setSelected('M'); setOpen(false); } }, '男')), React.createElement('span', { hidden: true }, tick));
}
createRoot(document.getElementById('dropdown-react')).render(React.createElement(React.Fragment, null, React.createElement(ReactDropdown), React.createElement(ReactDropdown, { reject: true })));

// Vue 使用真实响应式状态和异步候选；确认结果重绘后仍须保留。
createApp({ setup() {
  const selected = ref(''); const query = ref(''); const ready = ref(false); const open = ref(false); const tick = ref(0);
  globalThis.__dropdownProbe.vue = () => selected.value; globalThis.__dropdownProbe.redrawVue = () => { tick.value++; };
  return () => h('fieldset', [h('label', { for: 'vue-dropdown' }, 'Vue异步下拉'), h('input', { id: 'vue-dropdown', role: 'combobox', 'aria-controls': 'vue-dropdown-menu', 'aria-autocomplete': 'list', 'aria-expanded': open.value, value: selected.value ? '男' : query.value,
    onClick: () => { open.value = true; }, onInput: (event) => { query.value = event.target.value; ready.value = false; setTimeout(() => { ready.value = true; }, 250); } }),
    h('div', { id: 'vue-dropdown-menu', role: 'listbox', hidden: !open.value }, ready.value ? [h('div', { role: 'option', 'data-value': 'M', 'aria-selected': selected.value === 'M', onClick: () => { selected.value = 'M'; open.value = false; } }, '男')] : []), h('span', { hidden: true }, tick.value)]);
} }).mount('#dropdown-vue');
