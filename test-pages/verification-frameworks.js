// 真实框架仅供 loopback 临时打包，显式模拟接受后延迟回退，不进入扩展发行资源。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref } from '@vue/runtime-dom';
globalThis.__verifyProbe={};

// 两个受控输入先接受事件，再独立验证稳定保留与 300ms 后状态回退。
function ReactVerification() {
  const [stable,setStable]=useState(''); const [revert,setRevert]=useState(''); const [tick,setTick]=useState(0);
  globalThis.__verifyProbe.react=()=>stable; globalThis.__verifyProbe.redrawReact=()=>setTick((value)=>value+1);
  return React.createElement('fieldset',null,React.createElement('legend',null,'真实 React'),
    React.createElement('label',null,'React稳定',React.createElement('input',{id:'verify-react-stable',value:stable,onChange:(event)=>setStable(event.target.value)})),
    React.createElement('label',null,'React延迟回退',React.createElement('input',{id:'verify-react-revert',value:revert,onChange:(event)=>{setRevert(event.target.value);setTimeout(()=>setRevert(''),300);}})),
    React.createElement('span',{hidden:true},tick));
}
createRoot(document.getElementById('verify-react')).render(React.createElement(ReactVerification));

// Vue 使用独立 ref 作为实际数据源，回退由状态更新触发真实重绘。
createApp({setup(){
  const stable=ref('');const revert=ref('');const tick=ref(0);
  globalThis.__verifyProbe.vue=()=>stable.value;globalThis.__verifyProbe.redrawVue=()=>{tick.value++;};
  return ()=>h('fieldset',[h('legend','真实 Vue'),h('label',['Vue稳定',h('input',{id:'verify-vue-stable',value:stable.value,onInput:(event)=>{stable.value=event.target.value;}})]),
    h('label',['Vue延迟回退',h('input',{id:'verify-vue-revert',value:revert.value,onInput:(event)=>{revert.value=event.target.value;setTimeout(()=>{revert.value='';},300);}})]),h('span',{hidden:true},tick.value)]);
}}).mount('#verify-vue');
