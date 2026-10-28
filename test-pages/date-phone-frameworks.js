// 真实框架仅在 loopback 夹具临时打包，不属于发行运行依赖。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref } from '@vue/runtime-dom';
globalThis.__datePhoneProbe = {};

// React 原生月份及国码/号码是状态驱动，拒绝组件通过延迟重绘还原空值。
function ReactDatePhone() {
  const [date, setDate] = useState(''); const [country, setCountry] = useState('cn'); const [phone, setPhone] = useState(''); const [tick, setTick] = useState(0);
  globalThis.__datePhoneProbe.react = () => ({ date, country, phone }); globalThis.__datePhoneProbe.redrawReact = () => setTick((value) => value + 1);
  return React.createElement('fieldset', null, React.createElement('legend', null, 'React 组件'),
    React.createElement('label', null, 'React月份', React.createElement('input', { id: 'react-month', type: 'month', value: date, onChange: (event) => setDate(event.target.value) })),
    React.createElement('div', { className: 'form-item' }, React.createElement('label', { htmlFor: 'react-phone' }, 'React手机号'),
      React.createElement('select', { 'aria-label': '区号', value: country, onChange: (event) => setCountry(event.target.value) }, React.createElement('option', { value: 'cn' }, '中国 (+86)'), React.createElement('option', { value: 'gb' }, '英国 (+44)')),
      React.createElement('input', { id: 'react-phone', type: 'tel', value: phone, onChange: (event) => setPhone(event.target.value) })),
    React.createElement('label', null, 'React拒绝月份', React.createElement('input', { id: 'react-date-reject', type: 'month', value: '', onChange: () => setTimeout(() => setTick((value) => value + 1), 30) })), React.createElement('span', { hidden: true }, tick));
}
createRoot(document.getElementById('date-react')).render(React.createElement(ReactDatePhone));

// Vue ref 使用实际 input/change 事件，重绘后读取状态，不能以 DOM 赋值当作框架接受。
createApp({ setup() {
  const date = ref(''); const country = ref('cn'); const phone = ref(''); const tick = ref(0);
  globalThis.__datePhoneProbe.vue = () => ({ date: date.value, country: country.value, phone: phone.value }); globalThis.__datePhoneProbe.redrawVue = () => { tick.value++; };
  return () => h('fieldset', [h('legend', 'Vue 组件'), h('label', ['Vue月份', h('input', { id: 'vue-month', type: 'month', value: date.value, onInput: (event) => { date.value = event.target.value; } })]),
    h('div', { class: 'form-item' }, [h('label', { for: 'vue-phone' }, 'Vue手机号'), h('select', { 'aria-label': '区号', value: country.value, onChange: (event) => { country.value = event.target.value; } }, [h('option', { value: 'cn' }, '中国 (+86)'), h('option', { value: 'gb' }, '英国 (+44)')]), h('input', { id: 'vue-phone', type: 'tel', value: phone.value, onInput: (event) => { phone.value = event.target.value; } })]),
    h('label', ['Vue拒绝月份', h('input', { id: 'vue-date-reject', type: 'month', value: '', onInput: () => { setTimeout(() => { tick.value++; }, 30); } })]), h('span', { hidden: true }, tick.value)]);
} }).mount('#date-vue');
