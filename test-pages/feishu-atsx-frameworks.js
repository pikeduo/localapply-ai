// 仅用于 loopback 的真实 React 合成夹具，独立验证查询/点选及年月范围的框架状态。
import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
const h = React.createElement; const mode = new URLSearchParams(location.search).get('mode');
globalThis.__atsx = { adds: 0, choices: 0, saves: 0, submits: 0, dates: 0 };

// 标签说明不进入字段名，故意保留外壳和输入重复 ID 的真实页面结构。
function Field({ id, name, children }) { return h('div', { className: 'atsx-row atsx-form-item' }, h('div', { className: 'atsx-form-item-label' }, h('label', { htmlFor: id }, h('div', { className: 'customResumeForm-fieldName' }, name)), h('span', null, '合成说明不属于标签')), h('div', { className: 'atsx-form-item-control-wrapper' + (mode === 'invalid-date' && name === '起止时间' ? ' has-error' : '') }, children)); }
// 查询与选中状态独立；解析模式带已有选择，用于验证确认后的覆盖仍真正点选候选。
function Choice({ id, name, values, combo = false }) {
  const initial=mode==='parsed'?values[0]:'';
  const [query, setQuery] = useState(combo?initial:''); const [value, setValue] = useState(initial); const [open, setOpen] = useState(false); const [ready, setReady] = useState(false);
  const timer = useRef(); const key = id + '-popup'; globalThis.__atsx[id] = value;
  // 查询取消旧响应；慢响应与失败模式只改变夹具，不使用真实模型。
  function search(text) { setQuery(text); setReady(false); clearTimeout(timer.current); timer.current = setTimeout(() => setReady(true), mode === 'slow' ? 2300 : 80); }
  // 选中后由 React 保留实际值；拒绝模式清空查询，不能只依赖菜单关闭判成功。
  function choose(text) { globalThis.__atsx.choices++; clearTimeout(timer.current); if (mode !== 'reject') { setValue(text); setQuery(combo ? text : ''); } else setQuery(''); setOpen(false); }
  return h(Field, { id, name }, h('div', { id, className: 'atsx-select atsx-select-enabled' + (combo ? ' atsx-select-combobox' : '') },
    h('div', { className: 'atsx-select-selection atsx-select-selection--single', role: 'combobox', tabIndex: combo ? undefined : 0, 'aria-controls': key, 'aria-expanded': open,
      onClick: () => { setOpen(true); if (!combo) setReady(true); } },
    h('div', { className: 'atsx-select-selection__rendered' }, !combo && value && h('div', { className: 'atsx-select-selection-selected-value' }, value),
      h('div', { className: 'atsx-select-search atsx-select-search--inline', hidden: !combo && !open }, h('input', { id, className: 'atsx-select-search__field', value: query, onChange: (event) => search(event.target.value), onBlur: () => { if (combo && mode !== 'query-only') setQuery(value); } }))))),
    createPortal(h('div', { id: key, className: 'atsx-select-dropdown', hidden: !open }, h('ul', { role: 'listbox', 'aria-busy': !ready }, ready && values.filter((text) => !combo || text.includes(query)).flatMap((text) => (mode === 'duplicate' ? [0, 1] : [0]).map((variant) => h('li', { key: text + variant, className: 'atsx-select-dropdown-menu-item', role: 'option', 'aria-selected': value === text, onMouseDown: (event) => event.preventDefault(), onClick: () => choose(text) }, text))))), document.body));
}
// 年月端点使用两列候选及真正焦点框；解析模式保留已有起止年月以验证显式覆盖。
function Period({ id }) {
  const [parts, setParts] = useState(mode === 'parsed' ? [{year:'2018',month:'09'},{year:'2019',month:'06'}] : mode === 'partial-date' ? [{ year: '2019', month: '' }, { year: '', month: '' }] : [{ year: '', month: '' }, { year: '', month: '' }]);
  const [open, setOpen] = useState(-1); const [focused, setFocused] = useState(false); const helper = useRef(); const [committed, setCommitted] = useState(mode==='parsed'?['2018-09','2019-06']:['', '']); globalThis.__atsx[id] = committed;
  // 点选按当前端点更新，完成起始后自动切到结束，与公开组件的交互一致。
  function pick(kind, value) {
    globalThis.__atsx.dates++; const next = parts.map((part) => ({ ...part })); next[open][kind] = value;
    if (mode === 'mutate-peer' && kind === 'year') next[1 - open] = { year: '1999', month: '1' };
    setParts(next); if (kind === 'month') setOpen(open === 0 && !next[1].month ? 1 : -1);
  }
  // 失焦把 React 当前年月提交到表单状态；拒绝模式模拟控件回退。
  function commit() { const values = parts.map((part) => part.year && part.month ? part.year + '-' + part.month.padStart(2, '0') : ''); if (mode === 'date-reject') { setParts([{ year: '', month: '' }, { year: '', month: '' }]); setCommitted(['', '']); } else setCommitted(values); setFocused(false); }
  const panel = h('div', { key: open, className: 'atsx-date-picker-dropdown', hidden: open < 0 }, h('div', { className: 'atsx-date-picker-period-month-panel' },
    [Array.from({ length: 100 }, (_, index) => String(1980 + index)), Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'))].map((values, index) => h('div', { key: index, className: 'atsx-date-picker-period-month-panel-list' }, values.flatMap((value) => (mode === 'duplicate-date' && value === '2020' ? [0, 1] : [0]).map((variant) => h('div', { key: value + variant, className: 'atsx-date-picker-period-month-panel-list-item', 'data-cy': value, onMouseDown: (event) => event.preventDefault(), onClick: () => pick(index ? 'month' : 'year', value) }, value)))))));
  return h(Field, { name: '起止时间' }, h('div', { className: 'atsx-date-picker atsx-date-picker-period-month', 'data-period': id }, parts.map((part, index) => h(React.Fragment, { key: index }, index > 0 && h('div', { className: 'atsx-date-picker-period-line' }, '—'),
    h('div', { className: 'atsx-date-picker-period-month-label' + (focused && open === index ? ' atsx-date-picker-period-month-label-focus' : ''), onClick: () => { setOpen(index); setFocused(true); helper.current.focus(); } },
      h('span', { className: 'atsx-date-picker-period-month-label-year' }, part.year || 'YYYY'), h('span', { className: 'atsx-date-picker-period-month-label-separator' }, '-'), h('span', { className: 'atsx-date-picker-period-month-label-month' }, part.month || 'MM')))),
    h('input', { className: 'atsx-date-picker-period-hidden-input', ref: helper, onBlur: commit })), createPortal(panel, document.body));
}
// 普通字段受React控制；解析模式模拟网站已有内容，框架状态作为真实写入断言。
function Text({ id, name, multiline = false }) {
  const [value, setValue] = useState(mode==='parsed'?'网站解析内容 · '+id:mode === 'prefilled' && id.endsWith('.schoolText') ? '网页合成学校' : ''); globalThis.__atsx[id] = value;
  return h(Field, { id, name }, h(multiline ? 'textarea' : 'input', { id, value, onChange: (event) => setValue(event.target.value) }));
}
// 每条记录共享模板；可显式使用学校文本框区分已填内容和未确认搜索，AI模式验证多段来源。
function Record({ kind, index, add }) {
  const prefix = { education: 'education', employment: 'career', internship: 'internship', project: 'project' }[kind]; const id = prefix + '[' + index + ']';
  return h('div', { className: 'resumeEditForm-item resumeEditForm-' + prefix },
    kind === 'education' ? h(React.Fragment, null, mode === 'prefilled' || new URLSearchParams(location.search).get('schoolControl') === 'text' ? h(Text, { id: id + '.schoolText', name: '学校名称' }) : h(Choice, { id: id + '.school', name: '学校名称', combo: true, values: ['合成本科大学', '合成硕士大学', '合成博士大学'] }),
      h(Choice, { id: id + '.degree', name: '学历', values: ['本科', '硕士', '博士'] }), h(Text, { id: id + '.fieldOfStudy', name: '专业' }))
      : kind === 'project' ? h(React.Fragment, null, h(Text, { id: id + '.name', name: '项目名称' }), h(Text, { id: id + '.role', name: mode === 'ai-roles' ? '项目角色' : '职责' }))
        : h(React.Fragment, null, h(Text, { id: id + '.company', name: '公司名称' }), h(Text, { id: id + '.title', name: '职位名称' })),
    h(Period, { id: id + '.period' }), kind !== 'education' && h(Text, { id: id + '.desc', name: '描述', multiline: true }),
    h('div', { className: 'formOperate' }, h('div', { className: 'formOperate-addBtn-container' }, h('div', { className: 'formOperate-addBtn', onClick: add }, '添加')), h('div', { className: 'formOperate-removeBtn-container' }, h('div', { className: 'formOperate-removeBtn' }, '删除'))));
}
// 解析模式预置两条项目，其余空模块及添加操作维持原结构，不隐式保存或提交。
function Section({ kind, title }) {
  const [records, setRecords] = useState(kind === 'education' ? [0] : mode==='parsed'&&kind==='project'?[0,1]:[]); const prefix = { education: 'education', employment: 'career', internship: 'internship', project: 'project' }[kind];
  // 只有明确点击结构化添加入口才新增一条，计数可验证重复填充不追加。
  function add() { globalThis.__atsx.adds++; setRecords((rows) => [...rows, rows.length]); }
  return h('div', { className: 'createFormSection-container' }, h('div', { className: 'resumeEditForm-' + prefix + ' createFormSection-repeatable' },
    h('div', { className: 'createFormSection-left' }, h('div', { className: 'createFormSection-title' }, h('p', { className: 'createFormSection-text' }, title))),
    h('div', { className: 'createFormSection-right' }, records.length ? h('div', { className: 'createFormSection-formList' }, kind === 'employment' && h('div', { className: 'noExperience-container' }, h('label', null, h('input', { type: 'checkbox' }), '没有工作经历')), records.map((index) => h(Record, { key: index, kind, index, add })))
      : h('div', { className: 'createFormSection-addBtn', onClick: add }, '添加'))));
}
// 保存/提交仅计数，测试要求始终为零；夹具没有网络或简历文件读取。
function App() { return h('form', { onSubmit: (event) => { event.preventDefault(); globalThis.__atsx.submits++; } }, ['education', 'employment', 'internship', 'project'].map((kind, index) => h(Section, { key: kind, kind, title: ['教育经历', '工作经历', '实习经历', '项目经历'][index] })), h('label', null, h('input', { type: 'checkbox' }), '我已阅读并同意隐私政策'), h('button', { type: 'button', onClick: () => { globalThis.__atsx.saves++; } }, '保存'), h('button', { type: 'submit' }, '提交申请')); }
createRoot(document.getElementById('atsx-root')).render(h(App));
