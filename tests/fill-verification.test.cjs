// 第八步纯契约与统一回读测试；只用合成节点，不触碰真实档案/凭据。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// 小型可变节点用于校验守卫和状态机，真实框架仍由浏览器用例覆盖。
function fixture(type = 'text') {
  const scope = vm.createContext({ Date, setTimeout, clearTimeout, AbortController });
  for (const file of ['data/fill-result.js','content/controls/verification.js','data/diagnostics.js']) vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8'),scope);
  const attrs = {}; const el = { isConnected:true, value:'', getAttribute:(key)=>attrs[key] ?? null, closest:()=>null };
  let active = true; let accepted = true; let reads = 0;
  const context = { item:{el,members:[el],field:{label:'合成字段',type},control:{type}}, intent:{value:'合成值'},
    // 扫描撤销与回读计数仅驻留本测试。
    assertActive() { if (!active) throw new Error('synthetic-secret-url'); }, accepted() { reads++; return accepted; } };
  return { scope, F:scope.LocalApplyFillResult, V:scope.LocalApplyFillVerification, context, attrs, el, reads:()=>reads,
    revoke:()=>{active=false;}, accept:(next)=>{accepted=next;} };
}

test('统一结果只认可带回读时间的成功终态，拒绝 ready/执行尝试及冲突状态的假成功', () => {
  const { F } = fixture();
  for (const result of [{ok:true},{ok:true,status:'ready'},{ok:true,status:'success'},{ok:true,status:'success',verifiedAt:'bad'},{ok:false,status:'success',verifiedAt:new Date().toISOString()}]) {
    const next = F.normalize(result); assert.equal(next.ok,false); assert.equal(next.status,'failed'); assert.notEqual(next.diagnostic.reasonCode,'verified');
  }
  assert.equal(F.normalize({ok:true,status:'success',verifiedAt:new Date().toISOString()}).diagnostic.reasonCode,'verified');
  const conflict = F.normalize({ok:false,status:'needs_confirmation',conflict:{before:0,after:false},reason:'网页已有内容'});
  assert.equal(conflict.diagnostic.reasonCode,'existing_value_preserved'); assert.equal(conflict.conflict.before,0); assert.equal(conflict.conflict.after,false);
});

test('旧固定提示与新增固定原因码兼容，任意异常/字段/值不得进入结果或轨迹', () => {
  const { F } = fixture();
  for (const [reason,code] of [['已取消填写','cancelled'],['填写计划尚未执行','stale_plan'],['控件已变化','stale_context'],['日期精度不足','insufficient_date_precision'],['只读控件','readonly_control'],['选项已禁用','disabled_control'],['受保护字段','protected_control']]) assert.equal(F.normalize({reason}).diagnostic.reasonCode,code);
  for (const code of Object.keys(F.REASONS).filter((code)=>code!=='verified')) assert.equal(F.normalize(F.failure(code)).diagnostic.reasonCode,code);
  const text = JSON.stringify(F.normalize({reason:'synthetic-secret-value',html:'secret',diagnostic:{reasonCode:'bad',label:'secret',url:'secret',plan:'secret',candidateCount:2}}));
  assert.ok(!text.includes('secret')); assert.ok(text.includes('candidateCount')); assert.ok(Object.isFrozen(F.REASONS));
});

test('文本、选择及复合控件共用 500ms 有界回读，未验证前不得成功', async () => {
  for (const type of ['text','select','month','combobox']) {
    const env=fixture(type); const started=Date.now(); const result=await env.V.run(env.context);
    assert.equal(result.status,'success'); assert.ok(Date.now()-started>=480); assert.equal(env.reads(),4); assert.ok(result.verifiedAt);
  }
});

test('有界重试仅重读：延迟接受需最后两次一致，从未接受不得成功', async () => {
  const delayed=fixture(); delayed.accept(false); const timer=setTimeout(()=>delayed.accept(true),180);
  try { assert.equal((await delayed.V.run(delayed.context)).status,'success'); } finally { clearTimeout(timer); }
  const rejected=fixture(); rejected.accept(false); const result=await rejected.V.run(rejected.context);
  assert.equal(result.diagnostic.reasonCode,'value_not_accepted'); assert.equal(rejected.reads(),4);
});

test('只有观察到先接受后丢失才报告受控回退，不从错误文字推断', async () => {
  const env=fixture(); const timer=setTimeout(()=>env.accept(false),300);
  try { const result=await env.V.run(env.context); assert.equal(result.diagnostic.reasonCode,'controlled_reverted'); assert.equal(result.ok,false); } finally { clearTimeout(timer); }
  assert.notEqual(env.F.normalize({reason:'未接受或回退'}).diagnostic.reasonCode,'controlled_reverted');
});

test('网页标准校验和复合子项校验单独返回 validation_failed，绝不读取 validationMessage', async () => {
  for (const compound of [false,true]) {
    const env=fixture(); const node={...env.el,validity:{valid:false}}; Object.defineProperty(node,'validationMessage',{get(){throw new Error('不得读取');}});
    if(compound) env.context.item.compound={kind:'phone',parts:{number:node}}; else env.el.validity=node.validity;
    const result=await env.V.run(env.context); assert.equal(result.diagnostic.reasonCode,'validation_failed'); assert.equal(env.reads(),0);
  }
  const env=fixture(); env.attrs['aria-invalid']='true'; assert.equal((await env.V.run(env.context)).diagnostic.reasonCode,'validation_failed');
});

test('取消立即结束观察并释放后续回读，节点/授权失效不再记成功', async () => {
  const env=fixture(); const controller=new AbortController(); env.context.signal=controller.signal;
  const started=Date.now(); const pending=env.V.run(env.context); controller.abort(); const result=await pending;
  assert.equal(result.diagnostic.reasonCode,'cancelled'); assert.ok(Date.now()-started<250); const reads=env.reads(); await new Promise((done)=>setTimeout(done,520)); assert.equal(env.reads(),reads);
  for(const mutation of ['revoke','disconnect']) { const next=fixture(); const task=next.V.run(next.context); if(mutation==='revoke') next.revoke(); else next.el.isConnected=false; assert.equal((await task).diagnostic.reasonCode,'stale_context'); }
});

test('适配器专有守卫仍检查候选/父级；异常正文不泄漏到终态', async () => {
  const env=fixture(); assert.equal((await env.V.run(env.context,()=>env.F.failure('ambiguous_option'))).diagnostic.reasonCode,'ambiguous_option');
  const result=await env.V.run(env.context,()=>{throw new Error('synthetic-private-key');}); assert.equal(result.diagnostic.reasonCode,'stale_context'); assert.ok(!JSON.stringify(result).includes('private-key'));
  const broken=await env.V.run(env.context,undefined,()=>{throw new Error('synthetic-private-value');}); assert.equal(broken.diagnostic.reasonCode,'operation_error'); assert.ok(!JSON.stringify(broken).includes('private-value'));
});

test('统一守卫保留网页安全/只读边界，专用日历与下拉允许只读交互', () => {
  const env=fixture(); env.el.readOnly=true; assert.equal(env.V.guard(env.context).diagnostic.reasonCode,'readonly_control');
  env.context.item.control.type='combobox'; assert.equal(env.V.guard(env.context),null); env.el.disabled=true; assert.equal(env.V.guard(env.context).diagnostic.reasonCode,'disabled_control');
  env.el.disabled=false; env.context.item.field.label='同步更新在线简历'; assert.equal(env.V.guard(env.context).diagnostic.reasonCode,'protected_control');
  const button=fixture('combobox');button.el.tagName='BUTTON';button.el.type='button';button.attrs.role='combobox';button.el.closest=(selector)=>selector.includes('button')?button.el:null;
  assert.equal(button.V.guard(button.context),null);button.el.type='submit';assert.equal(button.V.guard(button.context).diagnostic.reasonCode,'protected_control');
});

test('全部十种固定适配器拒绝未执行计划的验证，不因节点已有相同值冒充成功', async () => {
  const scope=vm.createContext({Date,setTimeout,clearTimeout});
  for(const file of ['data/fill-result.js','content/controls/verification.js','content/controls/text.js','content/controls/native.js','content/controls/date-phone.js','content/controls/dropdown.js','content/controls/address.js']) vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8'),scope);
  for(const group of ['Text','Native','DatePhone','Dropdown','Address']) for(const adapter of scope['LocalApply'+group+'Adapters']) assert.equal((await adapter.verify({},{})).diagnostic.reasonCode,'stale_plan',adapter.id);
});

test('新旧原因码均通过原诊断管线落盘，重建后可读，原值/计划/异常不进入日志', async () => {
  const env=fixture(); const disk={}; const storage={get:async(key)=>({[key]:structuredClone(disk[key])}),set:async(value)=>Object.assign(disk,structuredClone(value))}; const D=env.scope.LocalApplyDiagnostics;
  env.scope.crypto=require('node:crypto').webcrypto; const log=D.create(storage);
  for(const reasonCode of Object.keys(env.F.REASONS)) await log.append('learning.fill',{fill:{reasonCode,status:'failed',value:'synthetic-secret',intent:'intent.secret',reason:'external-secret'}});
  const {rows}=await D.create(storage).read(); assert.equal(rows.length,Object.keys(env.F.REASONS).length); assert.ok(rows.some((row)=>row.fill.reasonCode==='validation_failed')); assert.ok(!JSON.stringify(rows).includes('secret'));
});
