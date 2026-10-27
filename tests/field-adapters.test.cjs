// 日期和电话计划纯函数测试：没有浏览器、真实个人资料或网络请求。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({ Date, setTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/field-adapters.js'), 'utf8'), context);
const A = context.LocalApplyFieldAdapters;

// 等价表达必须保持经验区间边界；院校/专业的校区、标点及英文词间空格不能随意删除。
test('下拉正式标签的空白及一年以下同义表达有界匹配', () => {
  for (const label of ['1年以下', '一年以下经验', '1年以下工作经验', '不足一年']) assert.equal(A.optionEqual(label, '1年以下', '工作经验'), true);
  for (const label of ['1年以内', '1年以上', '1-3年', '应届毕业生', '不限']) assert.equal(A.optionEqual(label, '1年以下', '工作经验'), false);
  assert.equal(A.optionEqual('1年以下工作经验', '1年以下', '学校名称'), false);
  assert.equal(A.optionEqual('  合成大学\u200b ', '合成大学'), true);
  assert.equal(A.optionEqual('合成大学（分校）', '合成大学'), false);
  assert.equal(A.optionEqual('合成 专业', '合成专业'), false);
  assert.equal(A.optionEqual('06月', '6', '', '月'), true);
});

// 只提供适配器实际使用的属性，保证计划计算不依赖输入框当前值。
function input(type = 'date', placeholder = '') { return { type, getAttribute: (key) => key === 'type' ? type : key === 'placeholder' ? placeholder : null }; }

test('日期精度、闰年、跨年份及中文格式严格校验，不补日', () => {
  for (const value of ['2024-02-29', '2028年2月29日', '2026/12/31', '2027-01', '2026']) assert.ok(A.dateValue(value), value);
  for (const value of ['2027-02-29', '2028-02-30', '2028-13-01', '2028-00-01', '02/03/2028', '2028-02-00', '2028-01-01T24:00', '2028-01-01<script>']) assert.equal(A.dateValue(value), null, value);
  assert.equal(A.dateValue('2028-02').precision, 'month'); assert.equal(A.dateValue('2028-02').day, null);
});

// 原始日期字段的中文空白和单独年份保留来源精度，不从描述或年龄推算。
test('年月原文允许中文单位空白和年份后缀，不提取描述中的日期', () => {
  for (const value of ['2000年 6月','2000 年 06 月','2000 / 06']) { assert.equal(A.dateValue(value).iso, '2000-06'); assert.equal(A.dateValue(value).day, null); }
  assert.equal(A.dateValue('2000年').iso, '2000'); assert.equal(A.dateValue('2000年').precision, 'year');
  for (const value of ['26岁','出生于2000年6月','2000年6月（26岁）','2000年 13月','2000年2月30日']) assert.equal(A.dateValue(value), null);
  assert.equal(A.plan({ el: input('month') }, '2000年 6月').value, '2000-06');
  assert.equal(A.plan({ el: input('date') }, '2000年 6月').error.status, 'needs_confirmation');
});

test('原生日期、月份、日期时间和文本格式按真实精度生成计划', () => {
  assert.equal(A.plan({ el: input('date') }, '2028-02').error.status, 'needs_confirmation');
  assert.equal(A.plan({ el: input('month') }, '2028-02-29').value, '2028-02');
  assert.equal(A.plan({ el: input('datetime-local') }, '2028-02-29').error.status, 'needs_confirmation');
  assert.equal(A.plan({ el: input('datetime-local') }, '2028-02-29T12:34').value, '2028-02-29T12:34');
  assert.equal(A.plan({ el: input('text','YYYY/MM/DD') }, '2028-02-29').value, '2028/02/29');
  assert.equal(A.plan({ el: input('text','YYYY/MM/DD') }, '2028-02').error.status, 'needs_confirmation');
  assert.equal(A.plan({ el: input('text','YYYY/MM') }, '2028-02-29').value, '2028/02');
});

// 日期规范化不能忽略 datetime-local 的时间差，否则会把未写入的时间误报为成功。
test('日期回读保留时间与精度，不把相同日期的其他时间判为已接受', () => {
  const el = { ...input('datetime-local'), value: '2028-02-29T11:00' };
  assert.equal(A.accepted({ el }, '2028-02-29T12:00'), false);
  assert.equal(A.accepted({ el }, '2028-02-29T11:00'), true);
  const calendar = { ...input('text'), readOnly: true, value: '2000年6月' };
  assert.equal(A.accepted({ el: calendar }, '2000-06'), true);
  assert.equal(A.accepted({ el: calendar }, '2000-06-01'), false);
});

test('日期范围与拆分控件不会把缺失日自动改成一日', () => {
  assert.equal(A.plan({ el: { ...input('date'), min: '2028-03-01' } }, '2028-02-29').error.status, 'failed');
  const item = { el: input(), compound: { kind: 'date', parts: { year: {}, month: {}, day: {} } } };
  assert.equal(A.plan(item, '2028-06').error.status, 'needs_confirmation');
  assert.equal(A.plan(item, '2028-06-30').parts.day, '30');
});

test('电话国码和号码只拆分一次，缺失国际区号或错误号码不猜测', () => {
  const item = { el: input('tel'), compound: { kind: 'phone', parts: { country: { options: [{ value: 'cn', textContent: '中国 (+86)' }, { value: 'gb', textContent: '英国 (+44)' }] } } } };
  for (const value of ['13800000000', '+86 13800000000', '0086-13800000000']) { const next = A.plan(item, value); assert.equal(next.parts.country, 'cn'); assert.equal(next.parts.number, '13800000000'); }
  assert.equal(A.plan(item, '+44 2070000000').parts.number, '2070000000');
  for (const value of ['2070000000', '+81 9012345678', '+86+8613800000000']) assert.equal(A.plan(item, value).error.status, 'needs_confirmation');
});

test('分级地址只接受明确边界，不从地址正文猜省市区', () => {
  const item = { el: input(), compound: { kind: 'address', parts: { province: {}, city: {}, district: {} } } };
  assert.equal(A.plan(item, '合成省 / 合成市 / 合成区').parts.city, '合成市');
  assert.equal(A.plan(item, '合成省合成市合成区合成街道').error.status, 'needs_confirmation');
});

test('独立城市字段不被当成单字地址子控件', () => {
  const el={getAttribute:(key)=>key==='aria-label'?'城市':null}; assert.equal(A.slot(el),'');
});

// 半填日期只补缺少部分，任何已有不同子项都必须阻止无确认写入。
test('复合日期逐项比较已有值，保留年份并允许补月份，不覆盖不同年月', () => {
  const item={el:input(),compound:{kind:'date',parts:{year:{value:'2020'},month:{value:''}}}};
  assert.equal(A.hasConflict(item,'2020-09'),false);assert.equal(A.hasConflict(item,'2024-09'),true);
  item.compound.parts.month.value='09月';assert.equal(A.hasConflict(item,'2020-09'),false);assert.equal(A.hasConflict(item,'2020-06'),true);
});

// 默认区号不代表用户已填电话，已有号码才需要保留国码和号码的一致性。
test('空号码可选择明确的国际国码，非空电话的任一不同子项均受保护', () => {
  const item={el:input('tel'),compound:{kind:'phone',parts:{country:{value:'cn',options:[{value:'cn',textContent:'中国 (+86)'},{value:'gb',textContent:'英国 (+44)'}]},number:{value:''}}}};
  assert.equal(A.hasConflict(item,'+44 2070000000'),false);
  item.compound.parts.number.value='13800000000';assert.equal(A.hasConflict(item,'+44 2070000000'),true);assert.equal(A.hasConflict(item,'13800000000'),false);
  assert.equal(A.hasConflict(item,'13800000001'),true);
});

// 非标准防补全属性不能吞掉姓名等普通字段，真实密码/认证名称仍需排除。
test('Moka new_password 文本提示不等于密码，标准认证属性仍被拦截', () => {
  // 构造适配器过滤所需的最小 DOM 接口，不读取任何控件实际值。
  const control = (attrs) => ({ getAttribute: (key) => attrs[key] || '', closest: () => null, matches: () => false });
  assert.equal(A.exclusion(control({ type: 'text', autocomplete: 'new_password' }), '姓名'), null);
  for (const attrs of [{ type: 'password', autocomplete: 'new_password' }, { type: 'text', name: 'password' }, { type: 'text', autocomplete: 'new-password' }, { type: 'text', autocomplete: 'one-time-code' }]) assert.equal(A.exclusion(control(attrs), '姓名').category, 'security_control');
});
