// 第九步语义兼容只使用合成元数据；规则与个人值均不被索引改写。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');

// 构造两个档案和明确绑定；字段标签刻意不属于标准词典，确保命中来自历史语义。
function fixture() {
  const context=vm.createContext({});
  for(const file of ['templates','field-matching','mapping-compat']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../data',file+'.js'),'utf8'),context);
  const M=context.FieldMatchingEngine;const U=context.LocalApplyMappingCompat;
  const definitions=[['builtin.gender','性别','基本信息'],['builtin.email','邮箱','基本信息'],['builtin.school','学校','教育经历']].map(([fieldId,label,group])=>({fieldId,label,group,aliases:[],type:'text'}));
  const db={revision:1,profiles:[{profileId:'profile.a'},{profileId:'profile.b'}],entries:[],fieldDefinitions:definitions,
    bindings:['profile.a','profile.b'].flatMap((profileId)=>definitions.map(({fieldId})=>({profileId,fieldId}))),publicFieldIds:definitions.map(({fieldId})=>fieldId),
    fieldValues:[{profileId:'profile.a',fieldId:'builtin.gender',entryId:null,value:'男'}],mappingRules:[]};
  // 生产扫描封套保留原指纹，运行时 semantic.key 不进入规则。
  function field(type='select',extra={}) {const row={scanId:'scan.'+type,label:'合成映射代号',type,group:'个人信息',kind:'',degree:'',index:0,name:'',placeholder:'',options:[],...extra};row.semanticId=M.semanticId(row);return row;}
  // 保存形状严格使用旧规则属性，时间只代表旧控件，不能作为当前执行成功。
  function rule(source=field(),extra={}) {return {mappingId:'mapping.'+db.mappingRules.length,origin:'https://jobs.example.test',profileId:'profile.a',entryId:null,path:'/',label:source.label,fieldId:'builtin.gender',features:M.features(source),semanticId:source.semanticId,enabled:true,confirmed:true,lastVerifiedAt:'2026-01-01T00:00:00.000Z',ruleVersion:1,...extra};}
  const match=(rows,profileId='profile.a',origin='https://jobs.example.test',bindings={})=>M.match(db,profileId,origin,rows,bindings);
  db.mappingRules.push(rule());return {context,M,U,db,field,rule,match};
}

test('select→radio/combobox 复用字段语义，仍需当前控件验证，旧规则字节不变',()=>{
  const env=fixture();const before=JSON.stringify(env.db);
  for(const type of ['radio','combobox']) {const row=env.match([env.field(type)])[0];assert.equal(row.source,'memory');assert.equal(row.memoryMatch,'semantic');assert.equal(row.status,'matched');assert.equal(row.target.fieldId,'builtin.gender');assert.equal(row.verification,null);assert.ok(!JSON.stringify(row).includes('2026-01-01'));}
  assert.equal(JSON.stringify(env.db),before);
});

test('旧精确规则及精确冲突始终优先，不被已验证的其他变体覆盖',()=>{
  const env=fixture();const field=env.field('radio');env.db.mappingRules.push(env.rule(field,{mappingId:'mapping.exact',fieldId:'builtin.email',confirmed:false,lastVerifiedAt:null}));
  let row=env.match([field])[0];assert.equal(row.memoryMatch,'exact');assert.equal(row.status,'needs_confirmation');assert.equal(row.target.fieldId,'builtin.email');
  env.db.mappingRules.push(env.rule(field,{mappingId:'mapping.conflict'}));env.db.revision++;row=env.match([field])[0];assert.equal(row.memoryMatch,'exact');assert.equal(row.target,null);
});

test('无 semanticId 的最老规则及非法特征不升级为跨控件记忆',()=>{
  const env=fixture();const legacy={...env.db.mappingRules[0]};for(const key of ['semanticId','features','confirmed','enabled','lastVerifiedAt','ruleVersion'])delete legacy[key];env.db.mappingRules=[legacy];
  assert.equal(env.match([env.field('radio')])[0].source,'unknown');
  env.db.mappingRules=[env.rule()];env.db.mappingRules[0].semanticId='semantic.invalid';env.db.revision++;assert.equal(env.match([env.field('radio')])[0].source,'unknown');
});

test('缺少分组只建议，多个实例不能自动复用，历史 index 相同也不提供配对证据',()=>{
  const env=fixture();const blank=env.field('select',{group:''});env.db.mappingRules=[env.rule(blank)];let row=env.match([env.field('radio',{group:''})])[0];assert.equal(row.status,'needs_confirmation');assert.equal(row.target,null);assert.equal(row.candidates.length,1);
  env.db.mappingRules=[env.rule()];env.db.revision++;const fields=[env.field('radio'),env.field('combobox',{index:1})];assert.ok(env.match(fields).every((row)=>row.target===null&&row.status==='needs_confirmation'));
  assert.equal(env.match([env.field('select',{index:1})])[0].source,'unknown');
});

test('origin、档案、分组及学历角色隔离，禁止跨域或相似含义猜测',()=>{
  const env=fixture();const field=env.field('radio');
  assert.equal(env.match([field],'profile.b')[0].target,null);assert.equal(env.match([field],'profile.a','https://other.example.test')[0].target,null);
  for(const extra of [{group:'其他信息'},{degree:'master'},{label:'另一个代号'}])assert.equal(env.match([env.field('radio',extra)])[0].source,'unknown');
  assert.equal(env.match([env.field('radio',{label:'密码'})])[0].status,'unsupported');
});

test('任一禁用或修改待验证变体会阻止跨控件自动复用，旧精确行为保留',()=>{
  for(const extra of [{enabled:false},{confirmed:false,lastVerifiedAt:null}]){
    const env=fixture();env.db.mappingRules.push(env.rule(env.field('text'),{mappingId:'mapping.blocker',...extra}));const row=env.match([env.field('radio')])[0];assert.equal(row.memoryMatch,'semantic');assert.equal(row.target,null);assert.equal(row.status,'needs_confirmation');assert.equal(env.match([env.field()])[0].memoryMatch,'exact');assert.equal(env.match([env.field()])[0].status,'matched');
  }
});

test('同语义不同字段来源或非经历字段的 entryId 冲突不得择优忽略',()=>{
  const env=fixture();env.db.mappingRules.push(env.rule(env.field('text'),{fieldId:'builtin.email',mappingId:'mapping.other'}));let row=env.match([env.field('radio')])[0];assert.equal(row.target,null);assert.equal(row.candidates.length,2);
  env.db.mappingRules=[env.rule(env.field(),{entryId:'entry.a'})];env.db.entries.push({entryId:'entry.a',profileId:'profile.a',kind:'education'});env.db.revision++;row=env.match([env.field('radio')])[0];assert.equal(row.target,null);
});

test('重复经历必须用当前明确绑定，重排后只复用 fieldId 而不套用旧 entryId',()=>{
  const env=fixture();env.db.entries=[{entryId:'entry.old',profileId:'profile.a',kind:'education'},{entryId:'entry.new',profileId:'profile.a',kind:'education'}];
  const extra={label:'就读机构代号',kind:'education',group:'教育经历'};env.db.mappingRules=[env.rule(env.field('select',extra),{fieldId:'builtin.school',entryId:'entry.old'})];
  const field=env.field('radio',{...extra,index:0});assert.equal(env.match([field])[0].target,null);
  let row=env.match([field],'profile.a','https://jobs.example.test',{[field.scanId]:{kind:'education',entryId:'entry.new'}})[0];assert.equal(row.target.entryId,'entry.new');assert.equal(row.target.fieldId,'builtin.school');
  const second=env.field('combobox',{...extra,index:1});const rows=env.match([field,second],'profile.a','https://jobs.example.test',{[field.scanId]:{kind:'education',entryId:'entry.new'},[second.scanId]:{kind:'education',entryId:'entry.old'}});assert.equal(rows[0].target.entryId,'entry.new');assert.equal(rows[1].target.entryId,'entry.old');
  row=env.match([field],'profile.a','https://jobs.example.test',{[field.scanId]:{kind:'employment',entryId:'entry.new'}})[0];assert.equal(row.target,null);
});

test('当前档案绑定/定义/记录已移除或记录属于别的档案时只允许重新选择',()=>{
  for(const kind of ['binding','definition','entry']) {const env=fixture();if(kind==='binding')env.db.bindings=[];else if(kind==='definition')env.db.fieldDefinitions=[];else env.db.mappingRules[0].entryId='entry.foreign';const row=env.match([env.field('radio')])[0];assert.equal(row.target,null);assert.equal(row.status,'needs_confirmation');}
});

test('明确第一学历/最高学历角色仍核对当前绑定来源，不把硕士当成本科或推算未知学历',()=>{
  const env=fixture();env.db.entries=[{entryId:'entry.undergrad',profileId:'profile.a',kind:'education'},{entryId:'entry.master',profileId:'profile.a',kind:'education'}];
  env.db.fieldDefinitions.push({fieldId:'builtin.degree',label:'学历',group:'教育经历',aliases:[]});env.db.bindings.push({profileId:'profile.a',fieldId:'builtin.degree'});
  env.db.fieldValues.push({profileId:'profile.a',fieldId:'builtin.degree',entryId:'entry.undergrad',value:'本科'},{profileId:'profile.a',fieldId:'builtin.degree',entryId:'entry.master',value:'硕士'});
  for(const degree of ['first','highest']){
    const extra={kind:'education',group:'教育经历',degree};env.db.mappingRules=[env.rule(env.field('select',extra),{fieldId:'builtin.school',entryId:'entry.undergrad'})];env.db.revision++;const field=env.field('radio',extra);
    const correct=degree==='first'?'entry.undergrad':'entry.master';const wrong=degree==='first'?'entry.master':'entry.undergrad';
    assert.equal(env.match([field],'profile.a','https://jobs.example.test',{[field.scanId]:{kind:'education',entryId:correct}})[0].target.entryId,correct);assert.equal(env.match([field],'profile.a','https://jobs.example.test',{[field.scanId]:{kind:'education',entryId:wrong}})[0].target,null);
  }
});

test('revision、规则数组及数据库身份变化均使旧兼容索引失效，删除/撤销不复活旧目标',()=>{
  const env=fixture();const field=env.field('radio');assert.equal(env.match([field])[0].status,'matched');
  env.db.mappingRules[0].enabled=false;env.db.revision++;assert.equal(env.match([field])[0].target,null);
  env.db.mappingRules[0].enabled=true;env.db.mappingRules[0].fieldId='builtin.email';env.db.revision++;assert.equal(env.match([field])[0].target.fieldId,'builtin.email');
  const saved=structuredClone(env.db.mappingRules);env.db.mappingRules=[];assert.equal(env.match([field])[0].source,'unknown');env.db.mappingRules=saved;assert.equal(env.match([field])[0].target.fieldId,'builtin.email');
  const replaced=structuredClone(env.db);replaced.mappingRules[0].fieldId='builtin.gender';assert.equal(env.M.match(replaced,'profile.a','https://jobs.example.test',[field])[0].target.fieldId,'builtin.gender');
});

test('即使 SemanticKey 碰撞也完整比较结构，管理范围按真实语义分区',()=>{
  const env=fixture();const original=env.M.semanticDescriptor;env.M.semanticDescriptor=(field)=>({...original(field),key:'semantic.v1.collision'});
  env.db.mappingRules.push(env.rule(env.field('text',{group:'其他组'}),{mappingId:'mapping.other'}));
  assert.equal(env.match([env.field('radio')])[0].status,'matched');const scopes=env.U.scopes(env.db);assert.ok(scopes.every((scope)=>scope.count===1));
});

test('投影不读取个人值，范围只暴露固定控件类别，不进入规则 JSON',()=>{
  const env=fixture();Object.defineProperty(env.db,'fieldValues',{get(){throw new Error('不得读取个人值');}});const row=env.U.find(env.db,'profile.a','https://jobs.example.test',env.field('radio'));assert.equal(row.confirmed,true);
  const scope=env.U.scopes(env.db)[0];assert.deepEqual(Object.keys(scope),['mappingId','count','controls']);assert.equal(scope.count,1);assert.ok(!JSON.stringify(env.db.mappingRules).includes('semantic.v1.'));
});

test('关闭兼容模块即回到旧精确查询，不需要迁移或恢复个人库',()=>{
  const env=fixture();env.context.LocalApplyMappingCompat=undefined;assert.equal(env.match([env.field('radio')])[0].source,'unknown');assert.equal(env.match([env.field()])[0].memoryMatch,'exact');
});
