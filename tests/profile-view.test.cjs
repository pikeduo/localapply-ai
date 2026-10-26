// 阶段四界面投影使用合成资料，检查稳定分组和显示类型而不启动浏览器。
'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
// 直接执行发行模块，避免复制实现逻辑到测试。
function view() { const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, '../data/profile-view.js'), 'utf8'), context); return context.LocalApplyProfileView; }
test('预览保留 false/0，空数组和空值可以隐藏，中文显示不改变类型', () => { const api = view(); assert.equal(api.hasValue(false), true); assert.equal(api.hasValue(0), true); assert.equal(api.hasValue([]), false); assert.equal(api.text(false), '否'); assert.equal(api.text(['甲','乙']), '甲、乙'); });
test('同名重复经历按稳定 ID 分开，空经历可显示且不混入其他档案', () => { const api = view(); const db = { fieldDefinitions: [{ fieldId: 'school', label: '院校', group: '教育', aliases: [] }], bindings: [], entries: [{ entryId: 'e1', profileId: 'p1', kind: 'education', title: '同名', order: 1 }, { entryId: 'e2', profileId: 'p1', kind: 'education', title: '同名', order: 0 }, { entryId: 'empty', profileId: 'p1', kind: 'project', title: '', order: 0 }], fieldValues: [{ profileId: 'p1', fieldId: 'school', entryId: 'e1', value: '合成甲' }, { profileId: 'p1', fieldId: 'school', entryId: 'e2', value: '合成乙' }, { profileId: 'p2', fieldId: 'school', entryId: null, value: '其他档案' }] }; const sections = api.sections(db, 'p1'); assert.equal(sections.length, 2); assert.equal(sections[0].entryId, 'e2'); assert.equal(sections[1].entryId, 'e1'); assert.equal(api.sections(db, 'p1', true).length, 3); });
test('敏感字段包含未绑定的生日地址和联系方式，普通技能不误遮挡', () => { const api = view(); for (const label of ['出生日期','联系电话','电子邮箱','现居地址','家庭成员']) assert.equal(api.sensitive({ label }), true); assert.equal(api.sensitive({ label: '技能' }), false); assert.equal(api.sensitive({ label: '技能' }, { sensitive: true }), true); });

// 最新界面只编辑基础字段，不从旧经历猜测平面值；旧数据投影仍由前面的兼容测试覆盖。
test('简历编辑保留全部基础字段和动态分类，不生成旧经历或空模块', () => {
  const api = view(); const db = {
    fieldDefinitions: [
      { fieldId: 'school', label: '院校', group: '教育背景' }, { fieldId: 'custom.education', label: '辅修', group: '教育经历' },
      { fieldId: 'custom.empty', label: '空白', group: '基本资料' }, { fieldId: 'custom.portfolio', label: '作品集', group: '研究成果' },
      { fieldId: 'custom.prototype', label: '原型名称', group: '__proto__' },
    ], bindings: [{ profileId: 'p1', fieldId: 'school' }, { profileId: 'p1', fieldId: 'custom.empty' }],
    entries: [{ entryId: 'e1', profileId: 'p1', kind: 'education', title: '同名学校', order: 0 }, { entryId: 'e2', profileId: 'p1', kind: 'education', title: '同名学校', order: 1 }],
    fieldValues: [
      { profileId: 'p1', fieldId: 'school', entryId: null, value: null },
      { profileId: 'p1', fieldId: 'school', entryId: 'e1', value: '合成本科' }, { profileId: 'p1', fieldId: 'custom.education', entryId: 'e1', value: '合成辅修' },
      { profileId: 'p1', fieldId: 'school', entryId: 'e2', value: '合成硕士' }, { profileId: 'p1', fieldId: 'custom.education', entryId: null, value: false },
      { profileId: 'p1', fieldId: 'custom.portfolio', entryId: null, value: 0 }, { profileId: 'p1', fieldId: 'custom.prototype', entryId: null, value: '合成字段' },
      { profileId: 'p2', fieldId: 'custom.portfolio', entryId: null, value: '其他档案' },
    ],
  };
  const before = structuredClone(db); const groups = api.editorSections(db, 'p1');
  assert.equal(groups.filter((group) => group.group === '教育背景').length, 1); assert.ok(!groups.some((group) => group.group === '教育经历'));
  const education = groups.find((group) => group.group === '教育背景');
  assert.equal(education.items.length, 2); assert.equal(education.entries, undefined);
  assert.ok(!groups.some((group) => ['实习经历', '工作经历', '项目经历'].includes(group.group)));
  assert.equal(groups.find((group) => group.group === '研究成果').items[0].row.value, 0);
  assert.equal(groups.find((group) => group.group === '基本信息').items[0].row, null);
  assert.equal(groups.find((group) => group.group === '__proto__').items.length, 1);
  const rows = groups.flatMap((group) => group.items).filter((item) => item.row);
  assert.equal(rows.length, 4); assert.ok(rows.every((item) => item.row.profileId === 'p1' && item.row.entryId === null)); assert.deepEqual(db, before);
});
