// 日期和电话计划纯函数测试：没有浏览器、真实个人资料或网络请求。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({ Date, setTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/value-resolver.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/field-adapters.js'), 'utf8'), context);
const A = context.LocalApplyFieldAdapters;

// 仅提供 Sugar 的确认结构；若错误读取搜索框值，测试立即失败。
test('Moka 选中证据只取唯一独立显示节点，不回退搜索词', () => {
  let rows = []; const owner = { querySelectorAll: () => rows };
  const el = { matches: () => true, closest: () => owner, get value() { throw new Error('不应读取查询值'); } };
  const selectedText = context.LocalApplyDropdownDOM.selectedText;
  assert.equal(selectedText(el), null);
  rows = [{ textContent: '' }]; assert.equal(selectedText(el), '');
  rows = [{ textContent: '  合成大学  ' }]; assert.equal(selectedText(el), '合成大学');
  rows.push({ textContent: '另一个显示节点' }); assert.equal(selectedText(el), null);
});

// 复合日期也只能复用已确认的年/月，不能因查询文字恰好等于来源而跳过点选。
test('Moka 年月回读要求每个下拉均有真实选中显示', () => {
  // 用独立确认节点与查询值表示同一个子项的两种状态，不读取其他字段。
  function part(text, query) {
    const row = { textContent: text }; const owner = { querySelector: () => row, querySelectorAll: () => [row] };
    return { el: { tagName: 'INPUT', isConnected: true, value: query, getAttribute: () => null, matches: () => true, closest: () => owner }, row };
  }
  const year = part('', '2020'); const month = part('9', '');
  const item = { el: year.el, compound: { kind: 'date', parts: { year: year.el, month: month.el } } };
  assert.equal(A.accepted(item, '2020-09'), false);
  year.row.textContent = '2020'; assert.equal(A.accepted(item, '2020-09'), true);
  month.row.textContent = ''; month.el.value = '9'; assert.equal(A.accepted(item, '2020-09'), false);
});

// 显式 ID 也不能跳过可见性和唯一性，隐藏旧菜单不得阻止本次主动重开。
test('Moka 弹层关联拒绝隐藏、重复 ID 及多目标 ARIA', () => {
  const node = { isConnected: true, getClientRects: () => [{}], visibility: 'visible' }; let count = 1; let linked = 'menu';
  const root = { getElementById: () => node, querySelectorAll: () => Array(count).fill(node) };
  const el = { getAttribute: () => linked, getRootNode: () => root };
  const env = vm.createContext({ setTimeout, getComputedStyle: (menu) => ({ visibility: menu.visibility }), CSS: { escape: (key) => key } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/field-adapters.js'), 'utf8'), env);
  const popupFor = env.LocalApplyDropdownDOM.popupFor;
  assert.equal(popupFor(el), node); node.visibility = 'hidden'; assert.equal(popupFor(el), null);
  node.visibility = 'visible'; count = 2; assert.equal(popupFor(el), null);
  count = 1; linked = 'menu another'; assert.equal(popupFor(el), null);
  linked = 'menu'; node.isConnected = false; assert.equal(popupFor(el), null);
});

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

// 复现网页“1 年以下”的排版空白；只兼容明确的年单位，不扩大经验区间或修改学校文本。
test('工作经验兼容数字与年之间的显示空白，保留区间边界', () => {
  for (const label of ['1 年以下', '１　年以下', '1\u00a0年以下', '一 年以下经验', '不足 1 年', '少于 一 年']) {
    assert.equal(A.optionEqual(label, '1年以下', '工作经验'), true, label);
    assert.equal(A.optionEqual('1年以下', label, '工作经验'), true, label);
  }
  for (const label of ['1 年', '1 年以上', '1 年以内', '2 年以下', '11 年以下', '在校生', '应届毕业生']) assert.equal(A.optionEqual(label, '1年以下', '工作经验'), false, label);
  assert.equal(A.optionEqual('1 年以下', '1年以下', '学校名称'), false);
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

// 年龄只作为 Moka 只读出生日期的末尾显示说明；来源解析仍严格，不推算日期或跨精度比较。
test('Moka 出生日期回读识别年龄说明，其他字段及本地来源不放宽', () => {
  // 仅模拟真实出生日期容器，不让普通文本框或其他日历借用此例外。
  const item = (value, readOnly = true, birth = true, label = '出生日期 (年龄)') => ({ field: { label }, el: { ...input('text'), value, readOnly, closest: () => birth ? {} : null } });
  for (const [display, source] of [['2000-06 (26岁)', '2000-06'], ['2000年6月（26岁）', '2000-06'], ['2000/06/15 (26岁)', '2000-06-15'], ['2000 (26岁)', '2000']]) {
    assert.equal(A.accepted(item(display), source), true, display);
    assert.equal(A.dateValue(display), null, '年龄格式不得进入来源解析');
  }
  for (const display of ['26岁', '2000-13 (26岁)', '2000-02-30 (26岁)', '出生于2000-06 (26岁)', '2000-06 (26岁左右)', '2000-06 (26岁)<script>', '2000-06 (26岁) (26岁)']) assert.equal(A.accepted(item(display), '2000-06'), false, display);
  assert.equal(A.accepted(item('2000-06 (26岁)'), '2000-06-15'), false);
  assert.equal(A.accepted(item('2000-06 (26岁)'), '2000-07'), false);
  assert.equal(A.accepted(item('2000-06 (26岁)', false), '2000-06'), false);
  assert.equal(A.accepted(item('2000-06 (26岁)', true, false), '2000-06'), false);
  assert.equal(A.accepted(item('2000-06 (26岁)', true, true, '毕业日期'), '2000-06'), false);
  assert.ok(A.plan(item(''), '2000-06 (26岁)').error);
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
