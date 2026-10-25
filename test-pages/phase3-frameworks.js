// 仅用于 loopback 测试的真实框架夹具，由 esbuild 临时打包，不进入插件运行包。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref } from '@vue/runtime-dom';
globalThis.__frameworkProbe = {};

// React 的状态是唯一数据源；拒绝组件会在下一次重渲染时回退 DOM。
function ReactControls() {
  const [name, setName] = useState(''); const [tick, setTick] = useState(0);
  globalThis.__frameworkProbe.react = () => name;
  globalThis.__frameworkProbe.rerenderReact = () => setTick((value) => value + 1);
  return React.createElement('fieldset', null, React.createElement('legend', null, 'React 组件'),
    React.createElement('label', { htmlFor: 'real-react-name' }, 'React受控姓名'),
    React.createElement('input', { id: 'real-react-name', value: name, onChange: (event) => setName(event.target.value) }),
    React.createElement('label', { htmlFor: 'real-react-reject' }, 'React拒绝回退姓名'),
    React.createElement('input', { id: 'real-react-reject', value: '', onChange: () => setTimeout(() => setTick((value) => value + 1), 30) }),
    React.createElement('span', { hidden: true }, tick));
}
createRoot(document.getElementById('real-react')).render(React.createElement(ReactControls));

// Vue render/ref 使用真实 runtime-dom，额外提供受控回退组件作为失败反例。
createApp({ setup() {
  const name = ref(''); const tick = ref(0);
  globalThis.__frameworkProbe.vue = () => name.value;
  globalThis.__frameworkProbe.rerenderVue = () => { tick.value++; };
  return () => h('fieldset', null, [h('legend', 'Vue 组件'), h('label', { for: 'real-vue-name' }, 'Vue受控姓名'),
    h('input', { id: 'real-vue-name', value: name.value, onInput: (event) => { name.value = event.target.value; } }),
    h('label', { for: 'real-vue-reject' }, 'Vue拒绝回退姓名'), h('input', { id: 'real-vue-reject', value: '', onInput: () => { setTimeout(() => { tick.value++; }, 30); } }), h('span', { hidden: true }, tick.value)]);
} }).mount('#real-vue');
