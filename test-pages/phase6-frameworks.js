// 仅 loopback 测试打包：真实 React 状态、异步 ARIA 查询与分步表单，不包含用户资料或外部 API。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
const h = React.createElement; const mode = new URLSearchParams(location.search).get('mode');
globalThis.__phase6 = { adds: 0, steps: 0, submissions: 0, choices: 0 };

// 受控学校搜索只在真实候选点选后确认，搜索文本本身不能作为成功依据。
function School({ id, initial = '' }) {
  const [query, setQuery] = useState(initial); const [selected, setSelected] = useState(initial); const [open, setOpen] = useState(false); const [ready, setReady] = useState(false);
  const menu = 'school-menu-' + id; const values = ['合成本科大学', '合成硕士大学'];
  globalThis.__phase6['school-' + id] = selected;
  return h('div', { className: 'form-item' }, h('label', { htmlFor: 'school-' + id }, '学校名称'),
    h('div', { role: 'combobox', 'aria-controls': menu }, h('input', { id: 'school-' + id, role: 'combobox', 'aria-controls': menu, 'aria-expanded': open, 'aria-autocomplete': 'list', value: query,
      onClick: () => setOpen(true), onChange: (event) => { setQuery(event.target.value); setReady(false); setTimeout(() => setReady(true), mode === 'slow' ? 2400 : 90); } })),
    createPortal(h('div', { id: menu, role: 'listbox', hidden: !open, 'aria-busy': !ready }, ready && values.filter((value) => value === query || value === selected).flatMap((value) => (mode === 'duplicate' ? [0, 1] : [0]).map((variant) => h('div', { key: value + variant, role: 'option', 'data-value': value + variant, 'aria-selected': selected === value,
      onClick: () => { globalThis.__phase6.choices++; if (mode !== 'reject') setSelected(value); setOpen(false); } }, value)))), document.body));
}

// 同条记录共享字段模板，起始年月由 React 接受后才启用结束年月。
function Education({ id, hidden = false }) {
  const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [degree, setDegree] = useState(''); const [major, setMajor] = useState('');
  globalThis.__phase6['education-' + id] = { start, end, degree, major };
  return h('div', { className: 'education-item', 'aria-hidden': hidden || undefined }, h('h3', null, '教育经历'), h(School, { id, initial: mode === 'prefilled' && id === 0 ? '网页合成学校' : '' }),
    h('div', { className: 'form-item' }, h('label', { htmlFor: 'degree-' + id }, '学历'), h('select', { id: 'degree-' + id, role: 'combobox', value: degree, onChange: (event) => setDegree(event.target.value) }, h('option', { value: '' }, '请选择'), h('option', { value: 'bachelor' }, '本科'), h('option', { value: 'master' }, '硕士'))),
    h('div', { className: 'form-item' }, h('label', { htmlFor: 'major-' + id }, '专业名称'), h('input', { id: 'major-' + id, value: major, onChange: (event) => setMajor(event.target.value) })),
    h('div', { className: 'form-item' }, h('label', { htmlFor: 'start-' + id }, '开始日期'), h('input', { id: 'start-' + id, type: 'month', value: start, onChange: (event) => setStart(event.target.value) })),
    h('div', { className: 'form-item' }, h('label', { htmlFor: 'end-' + id }, '结束日期'), h('input', { id: 'end-' + id, type: 'month', value: end, disabled: !start, onChange: (event) => setEnd(event.target.value) })));
}

// 日期与地区均为明确原生控件；下级候选通过父路径属性和禁用状态证明加载完成。
function Address() {
  const [province, setProvince] = useState(''); const [city, setCity] = useState(''); const [district, setDistrict] = useState(''); const [cityReady, setCityReady] = useState(false); const [districtReady, setDistrictReady] = useState(false);
  globalThis.__phase6.address = { province, city, district };
  return h('div', { className: 'form-item' }, h('label', null, '现居住地址'),
    h('select', { 'aria-label': '省', 'data-part': 'province', value: province, onChange: (event) => { setProvince(event.target.value); setCity(''); setDistrict(''); setCityReady(false); setTimeout(() => setCityReady(true), 90); } }, h('option', { value: '' }, '请选择'), h('option', { value: 'synthetic-p' }, '合成省')),
    h('select', { 'aria-label': '市', 'data-part': 'city', 'data-parent-value': province, disabled: !cityReady, value: city, onChange: (event) => { setCity(event.target.value); setDistrict(''); setDistrictReady(false); setTimeout(() => setDistrictReady(true), 90); } }, h('option', { value: '' }, '请选择'), cityReady && h('option', { value: 'synthetic-c' }, '合成市')),
    h('select', { 'aria-label': '区', 'data-part': 'district', 'data-parent-value': city, disabled: !districtReady, value: district, onChange: (event) => setDistrict(event.target.value) }, h('option', { value: '' }, '请选择'), districtReady && h('option', { value: 'synthetic-d' }, '合成区')));
}

// 用户亲自切换步骤；隐藏步骤和惯性保留的 React 状态不能被插件当作可写控件。
function Application() {
  const [step, setStep] = useState(0); const [name, setName] = useState(''); const [gender, setGender] = useState(''); const [intro, setIntro] = useState(''); const [records, setRecords] = useState(mode === 'hidden-record' ? [0, 1] : [0]); const [epoch, setEpoch] = useState(0);
  globalThis.__phase6.personal = { name, gender, intro }; globalThis.__phase6.step = step;
  // 一次添加只产生一条新空白记录；故障模式模拟站点同时重建旧记录。
  const add = () => { globalThis.__phase6.adds++; setRecords((rows) => [...rows, rows.length]); if (mode === 'replace-record-on-add') setEpoch((value) => value + 1); };
  return h('form', { onSubmit: (event) => { event.preventDefault(); globalThis.__phase6.submissions++; } },
    h('p', { id: 'step-current' }, '第 ' + (step + 1) + ' 步'),
    h('section', { hidden: step !== 0 }, h('fieldset', null, h('legend', null, '个人信息'),
      h('label', { htmlFor: 'applicant' }, '姓名'), h('input', { id: 'applicant', value: name, onChange: (event) => setName(event.target.value) }),
      h('label', { htmlFor: 'gender' }, '性别'), h('select', { id: 'gender', role: 'combobox', value: gender, onChange: (event) => setGender(event.target.value) }, h('option', { value: '' }, '请选择'), h('option', { value: 'M' }, '男'), h('option', { value: 'F' }, '女')),
      h('label', { htmlFor: 'intro' }, '自我介绍'), h('textarea', { id: 'intro', value: intro, onChange: (event) => setIntro(event.target.value) }))),
    h('section', { hidden: step !== 1 }, h('fieldset', { id: 'educations' }, h('legend', null, '教育经历'), records.map((id) => h(Education, { key: id + '-' + epoch, id, hidden: mode === 'hidden-record' && id === 1 })), h('button', { type: 'button', onClick: add }, '添加教育经历'), mode === 'ambiguous-add' && h('button', { type: 'button', onClick: add }, '添加教育经历'))),
    h('section', { hidden: step !== 2 }, h('fieldset', null, h('legend', null, '联系信息'), h(Address)), h('label', { htmlFor: 'extra' }, '附加问题（自行回答）'), h('textarea', { id: 'extra' })),
    h('div', { 'aria-hidden': 'true', style: { position: 'absolute', left: '-9999px' } }, h('label', { htmlFor: 'inactive' }, '联系电话'), h('input', { id: 'inactive', defaultValue: '合成隐藏资料' })),
    h('div', { inert: true }, h('input', { 'aria-label': '电子邮箱', defaultValue: 'synthetic-inactive@example.test' })),
    h('button', { id: 'previous', type: 'button', disabled: step === 0, onClick: () => { globalThis.__phase6.steps++; setStep((value) => value - 1); } }, '上一步'),
    h('button', { id: 'next', type: 'button', disabled: step === 2, onClick: () => { globalThis.__phase6.steps++; setStep((value) => value + 1); } }, '下一步'),
    h('button', { type: 'submit' }, '提交申请'));
}
createRoot(document.getElementById('phase6-root')).render(h(Application));
