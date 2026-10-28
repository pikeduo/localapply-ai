// 真实 React/Vue 级联状态，只由 loopback 测试临时打包，不进入发行依赖。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref } from '@vue/runtime-dom';
globalThis.__addressProbe = {};

// React 原生三级 select 的值和异步选项都由状态驱动，初始下级禁用。
function ReactAddress() {
  const [province,setProvince]=useState('');const [city,setCity]=useState('');const [district,setDistrict]=useState('');const [cities,setCities]=useState([]);const [districts,setDistricts]=useState([]);const [tick,setTick]=useState(0);
  globalThis.__addressProbe.react=()=>({province,city,district});globalThis.__addressProbe.redrawReact=()=>setTick((value)=>value+1);
  // 单项共享渲染结构，选项代码来自当前父级，不把标签写成代码。
  function select(key,label,value,options,onChange,disabled=false){return React.createElement('select',{key,id:'react-'+key,'aria-label':label,value,onChange,disabled},React.createElement('option',{value:''},'请选择'),...options.map(([code,text])=>React.createElement('option',{key:code,value:code},text)));}
  return React.createElement('div',{className:'form-item'},React.createElement('span',{className:'label'},'React地址'),
    select('province','省',province,[['pa','甲省'],['pb','乙省']],(event)=>{const value=event.target.value;setProvince(value);setCity('');setDistrict('');setCities([]);setDistricts([]);setTimeout(()=>setCities([[value==='pa'?'ca':'cb','同名市']]),180);}),
    select('city','市',city,cities,(event)=>{setCity(event.target.value);setDistrict('');setDistricts([]);setTimeout(()=>setDistricts([[province==='pa'?'da':'db','中心区']]),180);},!cities.length),select('district','区',district,districts,(event)=>setDistrict(event.target.value),!districts.length),React.createElement('span',{hidden:true},tick));
}
createRoot(document.getElementById('address-react')).render(React.createElement(ReactAddress));

// Vue ref/render 同样保留明确父级与独立异步选项，重绘只认组件状态。
createApp({setup(){
  const province=ref('');const city=ref('');const district=ref('');const cities=ref([]);const districts=ref([]);const tick=ref(0);
  globalThis.__addressProbe.vue=()=>({province:province.value,city:city.value,district:district.value});globalThis.__addressProbe.redrawVue=()=>{tick.value++;};
  // 候选和 disabled 随实际状态变化，测试不能通过单改 DOM 冒充选中。
  function select(key,label,value,options,onChange,disabled=false){return h('select',{key,id:'vue-'+key,'aria-label':label,value,onChange,disabled},[h('option',{value:''},'请选择'),...options.map(([code,text])=>h('option',{key:code,value:code},text))]);}
  return()=>h('div',{class:'form-item'},[h('span',{class:'label'},'Vue地址'),select('province','省',province.value,[['pa','甲省'],['pb','乙省']],(event)=>{const value=event.target.value;province.value=value;city.value='';district.value='';cities.value=[];districts.value=[];setTimeout(()=>{cities.value=[[value==='pa'?'ca':'cb','同名市']];},180);}),
    select('city','市',city.value,cities.value,(event)=>{city.value=event.target.value;district.value='';districts.value=[];setTimeout(()=>{districts.value=[[province.value==='pa'?'da':'db','中心区']];},180);},!cities.value.length),select('district','区',district.value,districts.value,(event)=>{district.value=event.target.value;},!districts.value.length),h('span',{hidden:true},tick.value)]);
}}).mount('#address-vue');
