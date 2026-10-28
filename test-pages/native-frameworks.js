// 真实 React/Vue 原生选择夹具，仅由 loopback 测试服务器临时打包。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref } from '@vue/runtime-dom';
globalThis.__nativeProbe = {};

// React 受控 select/radio/checkbox 接受状态；拒绝选择在延迟重绘时恢复为空。
function ReactChoices() {
  const [gender, setGender] = useState(''); const [radio, setRadio] = useState(''); const [checked, setChecked] = useState(false); const [tick, setTick] = useState(0);
  globalThis.__nativeProbe.react = () => ({ gender, radio, checked }); globalThis.__nativeProbe.redrawReact = () => setTick((value) => value + 1);
  // 每个 select 都有空占位项，不能依靠浏览器默认选择宣称填写成功。
  function select(id, text, value, onChange) { return React.createElement('label', { key: id }, text, React.createElement('select', { id, 'aria-label': text, value, onChange }, React.createElement('option', { value: '' }, '请选择'), React.createElement('option', { value: 'M' }, '男'), React.createElement('option', { value: 'F' }, '女'))); }
  return React.createElement('fieldset', null, React.createElement('legend', null, 'React 原生组件'),
    select('react-native-select', 'React选择', gender, (event) => setGender(event.target.value)),
    React.createElement('fieldset', null, React.createElement('legend', null, 'React单选'), ...['M', 'F'].map((code) => React.createElement('label', { key: code }, React.createElement('input', { type: 'radio', name: 'reactNativeRadio', value: code, checked: radio === code, onChange: (event) => setRadio(event.target.value) }), code === 'M' ? '男' : '女'))),
    React.createElement('label', null, React.createElement('input', { id: 'react-native-check', type: 'checkbox', checked, onChange: (event) => setChecked(event.target.checked) }), 'React布尔'),
    select('react-native-reject', 'React拒绝选择', '', () => setTimeout(() => setTick((value) => value + 1), 30)),
    React.createElement('span', { hidden: true }, tick));
}
createRoot(document.getElementById('native-react')).render(React.createElement(ReactChoices));

// Vue ref/render 用真实运行时处理 change，回退案例用于检测 DOM 假成功。
createApp({ setup() {
  const gender = ref(''); const radio = ref(''); const checked = ref(false); const tick = ref(0);
  globalThis.__nativeProbe.vue = () => ({ gender: gender.value, radio: radio.value, checked: checked.value }); globalThis.__nativeProbe.redrawVue = () => { tick.value++; };
  // Vue 选项节点由当前状态渲染，拒绝组件刻意保持空状态。
  function select(id, text, value, onChange) { return h('label', { key: id }, [text, h('select', { id, 'aria-label': text, value, onChange }, [h('option', { value: '' }, '请选择'), h('option', { value: 'M' }, '男'), h('option', { value: 'F' }, '女')])]); }
  return () => h('fieldset', [h('legend', 'Vue 原生组件'), select('vue-native-select', 'Vue选择', gender.value, (event) => { gender.value = event.target.value; }),
    h('fieldset', [h('legend', 'Vue单选'), ...['M', 'F'].map((code) => h('label', { key: code }, [h('input', { type: 'radio', name: 'vueNativeRadio', value: code, checked: radio.value === code, onChange: (event) => { radio.value = event.target.value; } }), code === 'M' ? '男' : '女']))]),
    h('label', [h('input', { id: 'vue-native-check', type: 'checkbox', checked: checked.value, onChange: (event) => { checked.value = event.target.checked; } }), 'Vue布尔']),
    select('vue-native-reject', 'Vue拒绝选择', '', () => { setTimeout(() => { tick.value++; }, 30); }), h('span', { hidden: true }, tick.value)]);
} }).mount('#native-vue');
