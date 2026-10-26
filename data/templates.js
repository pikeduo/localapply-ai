// 预置字段模板 + 同义词表（detector 与页面共用；作为 content script 先于 detector.js 加载）
// 挂载到 globalThis.WangshenTemplates，无模块系统依赖。
(function (global) {
  'use strict';

  // 参考简历页允许重复的八个模块；所有记录共用字段定义，英语能力等单份模块不在此列。
  const RECORD_GROUPS = { education: '教育背景', internship: '实习经历', employment: '工作经历', project: '项目经历', family: '家庭成员', award: '获奖经历', certificate: '证书信息', publication: '论文期刊' };
  // 只统一已知模块别名，用户自定义分类不按文字相似度猜测为经历模块。
  function recordKind(group) {
    const aliases = { '教育经历': '教育背景', '教育': '教育背景', '工作经验': '工作经历', '实习经验': '实习经历', '项目经验': '项目经历' };
    const name = Object.hasOwn(aliases, group) ? aliases[group] : group;
    return Object.keys(RECORD_GROUPS).find((kind) => RECORD_GROUPS[kind] === name);
  }

  // ============ 工具 ============

  // label 归一化：去空格/冒号/星号/必填标记/请输入提示，转小写
  function normalizeLabel(raw) {
    if (!raw) return '';
    return String(raw)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[：:*＊·、，,。.()（）\[\]【】\-—_~]+/g, '')
      .replace(/必填|选填|请输入|请选择|please(select|input|enter)/g, '')
      .trim();
  }

  function isRegexPattern(p) {
    return p.indexOf('re:') === 0;
  }

  // 对单个字段组评分：精确=1.0，正则全匹配=0.95，前缀命中=0.9，包含=0.75，正则普通命中=0.7
  function scoreGroup(normLabel, patterns) {
    let best = 0;
    for (const p of patterns) {
      if (isRegexPattern(p)) {
        const re = new RegExp(p.slice(3), 'i');
        if (re.test(normLabel)) {
          const m = normLabel.match(re);
          const full = m && m[0] === normLabel;
          best = Math.max(best, full ? 0.95 : 0.7);
        }
      } else if (normLabel === p) {
        best = Math.max(best, 1.0);
      } else if (p.length >= 2 && normLabel.length >= 2 && (normLabel.includes(p) || p.includes(normLabel))) {
        // 前缀命中（如"出生日期（年龄）"之于"出生日期"、"现居住城市（到地级市）"）
        // 比普通包含更可信，达到自动填充阈值
        best = Math.max(best, normLabel.startsWith(p) && p.length >= 4 ? 0.9 : 0.75);
      }
    }
    return best;
  }

  // ============ 同义词表（60 组，覆盖两套模板全部字段 + 常见扩展字段） ============
  // material:true 的字段是「开放题素材」，不参与表单匹配，仅供 AI 起草引用。
  const SYNONYMS = [
    // —— 基本信息（互联网短表单） ——
    { key: 'name', patterns: ['姓名', '名字', '学生姓名', '申请人姓名', 're:(full|real)?name'] },
    { key: 'gender', patterns: ['性别', 're:gender|sex'] },
    { key: 'birthDate', patterns: ['出生日期', '出生年月', '生日', 're:date.?of.?birth|birthday'] },
    { key: 'phone', patterns: ['手机', '手机号', '手机号码', '电话', '联系电话', '联系方式', 're:(mobile|phone|tel|cell)'] },
    { key: 'email', patterns: ['邮箱', '电子邮箱', '邮箱地址', '邮件地址', '电子邮件', 're:e.?mail'] },
    { key: 'idCard', patterns: ['身份证', '身份证号', '身份证号码', '证件号码', 're:id.?card|idnumber'] },
    { key: 'currentCity', patterns: ['现居城市', '所在城市', '现居住地', '居住地', '现居住城市', '现所在地', '联系地址', 're:city|address|location'] },

    // —— 教育背景 ——
    { key: 'school', patterns: ['毕业院校', '学校', '院校', '毕业学校', '就读院校', '所在学校', 're:school|university|college'] },
    { key: 'major', patterns: ['专业', '所学专业', '专业名称', 're:major'] },
    { key: 'degree', patterns: ['学历', '最高学历', '学历层次', 're:degree|education'] },
    { key: 'graduationDate', patterns: ['毕业时间', '预计毕业时间', '毕业年月', '毕业年份', '预计毕业年份', '毕业日期', 're:graduat'] },
    { key: 'gpa', patterns: ['gpa', '绩点', '成绩排名', '平均绩点', 're:gpa|gradepoint'] },
    { key: 'englishLevel', patterns: ['英语水平', '英语能力', '外语水平', 're:english'] },

    // —— 求职意向 ——
    { key: 'expectedPosition', patterns: ['应聘岗位', '期望岗位', '求职岗位', '应聘职位', '期望职位', '意向岗位', '意向职位', 're:position|expectedjob|expectedrole'] },
    { key: 'expectedCity', patterns: ['期望工作城市', '期望城市', '意向城市', '工作城市', '期望工作地点', '意向工作地', '工作地点', '期望地点', 're:(expected|preferred).?city|preferred.?location'] },
    { key: 'expectedSalary', patterns: ['期望薪资', '薪资期望', '期望工资', '薪资要求', '待遇要求', 're:salary|compensation'] },
    { key: 'availableTime', patterns: ['可到岗时间', '到岗时间', '可入职时间', '入职时间', '最早到岗时间', 're:available|onboard|startwork'] },

    // —— 技能与其他 ——
    { key: 'skills', patterns: ['技能特长', '专业技能', '技能', '特长', '掌握技能', 're:skills?|abilities'] },
    { key: 'github', patterns: ['github', '个人主页', '个人主页/github', '个人网站', 're:github|homepage|personal.?website'] },
    { key: 'awards', patterns: ['获奖情况', '荣誉奖项', '获奖经历', '所获荣誉', '奖项', 're:awards?|honou?rs?|prizes?'] },
    { key: 'selfEvaluation', patterns: ['自我评价', '个人评价', 're:self.?evaluat'] },

    // —— 开放题素材（仅 AI 引用，不参与表单匹配） ——
    { key: 'openSelfIntro', material: true, patterns: ['自我介绍'] },
    { key: 'openProject', material: true, patterns: ['项目深挖'] },
    { key: 'openMotivation', material: true, patterns: ['求职动机'] },
    { key: 'openCityPlan', material: true, patterns: ['城市意向'] },

    // —— 央国企：政治与个人情况 ——
    { key: 'politicalStatus', patterns: ['政治面貌', '政治状态', 're:political'] },
    { key: 'joinPartyDate', patterns: ['入党时间', '入党日期', 're:join.?party|party.?date'] },
    { key: 'ethnic', patterns: ['民族', 're:ethnic'] },
    { key: 'hometown', patterns: ['籍贯', '原籍', 're:native.?place|ancestral'] },
    { key: 'birthplace', patterns: ['出生地', 're:birthplace|birth.?place'] },
    { key: 'household', patterns: ['户口所在地', '户籍所在地', '户籍', '户口', 're:household|registered.?residence'] },
    { key: 'maritalStatus', patterns: ['婚姻状况', '婚否', '婚姻情况', 're:marital|marriage'] },
    { key: 'nationality', patterns: ['国籍', 're:nationality|citizenship'] },
    { key: 'height', patterns: ['身高', 're:height'] },
    { key: 'weight', patterns: ['体重', 're:weight'] },
    { key: 'healthStatus', patterns: ['健康状况', '健康状态', '身体情况', 're:health'] },

    // —— 央国企：语言与技能证书 ——
    { key: 'cet4Score', patterns: ['四级成绩', '英语四级', 'cet-4', 'cet4', '四级', '英语四级成绩', 'cet4成绩', '英语四级cet4成绩', 're:cet.?4'] },
    { key: 'cet6Score', patterns: ['六级成绩', '英语六级', 'cet-6', 'cet6', '六级', '英语六级成绩', 'cet6成绩', '英语六级cet6成绩', 're:cet.?6'] },
    { key: 'computerLevel', patterns: ['计算机等级', '计算机水平', '计算机能力', '计算机一级', '计算机二级', '计算机三级', '计算机四级', 're:computer|ncre'] },
    { key: 'mandarinLevel', patterns: ['普通话水平', '普通话等级', '普通话', 're:mandarin|putonghua'] },
    { key: 'drivingLicense', patterns: ['驾驶证', '驾照', '机动车驾驶证', 're:driver.?license|driving.?licence|驾照'] },

    // —— 央国企：家庭与紧急联系 ——
    { key: 'familyName1', sensitive: true, patterns: ['家庭成员姓名', '成员一姓名', '家庭成员1姓名', '父亲姓名', '母亲姓名', 're:family.{0,4}1.{0,4}name|member.?1.?name'] },
    { key: 'familyRelation1', patterns: ['与本人关系', '称谓', '成员一称谓', 're:family.{0,4}1.{0,4}(relation|ship)|member.?1.?(relation)'] },
    { key: 'familyUnit1', sensitive: true, patterns: ['家庭成员工作单位', '父母工作单位', '成员一工作单位', '家庭成员1工作单位', 're:(family|成员|父母|家长).{0,6}(单位|职务|职业)'] },
    { key: 'familyName2', sensitive: true, patterns: ['成员二姓名', '家庭成员2姓名', 're:family.{0,4}2.{0,4}name|member.?2.?name'] },
    { key: 'familyRelation2', patterns: ['成员二称谓', 're:family.{0,4}2.{0,4}(relation|ship)|member.?2.?(relation)'] },
    { key: 'familyUnit2', sensitive: true, patterns: ['成员二工作单位', '家庭成员2工作单位', 're:family.{0,4}2.{0,6}(单位|职务|unit|employ)'] },
    { key: 'emergencyName', sensitive: true, patterns: ['紧急联系人', '应急联系人', 're:emergency.*(contact|person)|emergencyname'] },
    { key: 'emergencyPhone', sensitive: true, patterns: ['紧急联系电话', '紧急联系方式', '紧急联系人电话', 're:emergency.*(phone|tel|mobile|number)'] },

    // —— 央国企：补充声明 ——
    { key: 'punishment', patterns: ['奖惩情况', '奖惩', '奖励与处分', '受奖惩情况', 're:reward|punish|discipline'] },
    { key: 'medicalHistory', sensitive: true, patterns: ['体检史', '病史', '健康状况说明', '体检情况', 're:medical.?history|illness|disease'] },

    // —— 扩展同义词（模板之外，用户可按需加为自定义字段） ——
    { key: 'age', patterns: ['年龄', 're:age'] },
    { key: 'wechat', patterns: ['微信', '微信号', 're:wechat|weixin'] },
    { key: 'qq', patterns: ['qq', 'qq号', 're:qq'] },
    { key: 'blog', patterns: ['博客', 're:blog'] },
    { key: 'portfolio', patterns: ['作品集', '作品集链接', 're:portfolio'] },
    { key: 'workYears', patterns: ['工作年限', '工作经验', 're:work.?years?|workexp'] },
    { key: 'referrer', patterns: ['内推人', '推荐人', 're:refer{2}er'] },
    { key: 'idType', patterns: ['证件类型', '证件种类', 're:id.?type|idtype'] },
    { key: 'workUnit', patterns: ['工作单位', '单位名称', '实习单位', 're:(work)?unit|employer|company'] },
  ];

  // ============ 模板字段 ============
  // 字段结构：{ key, label, group, inputType: text|textarea|select|number|date|multiSelect, options?, sensitive, autoFill, patterns }；widget 仅用于编辑器投影。

  const SHORT_FORM_TEMPLATE = [
    { key: 'name', label: '姓名', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['姓名', '名字', '学生姓名', '申请人姓名', 're:(full|real)?name'] },
    { key: 'gender', label: '性别', group: '基本信息', inputType: 'select', options: ['男', '女'], sensitive: false, autoFill: true, patterns: ['性别', 're:gender|sex'] },
    { key: 'birthDate', label: '出生日期', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['出生日期', '出生年月', '生日', 're:date.?of.?birth|birthday'] },
    { key: 'phone', label: '手机号', group: '基本信息', inputType: 'text', sensitive: true, autoFill: true, patterns: ['手机', '手机号', '手机号码', '电话', '联系电话', '联系方式', 're:(mobile|phone|tel|cell)'] },
    { key: 'email', label: '邮箱', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['邮箱', '电子邮箱', '邮箱地址', '邮件地址', '电子邮件', 're:e.?mail'] },
    { key: 'idCard', label: '身份证号', group: '基本信息', inputType: 'text', sensitive: true, autoFill: true, patterns: ['身份证', '身份证号', '身份证号码', '证件号码', 're:id.?card|idnumber'] },
    { key: 'currentCity', label: '现居城市', group: '基本信息', inputType: 'text', sensitive: false, autoFill: true, patterns: ['现居城市', '所在城市', '现居住地', '居住地', '现居住城市', '现所在地', '联系地址', 're:city|address|location'] },
    { key: 'school', label: '毕业院校', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['毕业院校', '学校', '院校', '毕业学校', '就读院校', '所在学校', 're:school|university|college'] },
    { key: 'major', label: '专业', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['专业', '所学专业', '专业名称', 're:major'] },
    { key: 'degree', label: '学历', group: '教育背景', inputType: 'select', options: ['博士', '硕士', '本科', '大专', '其他'], sensitive: false, autoFill: true, patterns: ['学历', '最高学历', '学历层次', 're:degree|education'] },
    { key: 'graduationDate', label: '毕业时间', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['毕业时间', '预计毕业时间', '毕业年月', '毕业年份', '预计毕业年份', '毕业日期', 're:graduat'] },
    { key: 'gpa', label: 'GPA/成绩排名', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['gpa', '绩点', '成绩排名', '平均绩点', 're:gpa|gradepoint'] },
    { key: 'englishLevel', label: '英语水平', group: '教育背景', inputType: 'text', sensitive: false, autoFill: true, patterns: ['英语水平', '英语能力', '外语水平', 're:english'] },
    { key: 'expectedPosition', label: '应聘岗位', group: '求职意向', inputType: 'text', sensitive: false, autoFill: true, patterns: ['应聘岗位', '期望岗位', '求职岗位', '应聘职位', '期望职位', '意向岗位', '意向职位', 're:position|expectedjob|expectedrole'] },
    { key: 'expectedCity', label: '期望工作城市', group: '求职意向', inputType: 'text', sensitive: false, autoFill: true, patterns: ['期望工作城市', '期望城市', '意向城市', '工作城市', '期望工作地点', '意向工作地', '工作地点', '期望地点', 're:(expected|preferred).?city|preferred.?location'] },
    { key: 'expectedSalary', label: '期望薪资', group: '求职意向', inputType: 'text', sensitive: true, autoFill: true, patterns: ['期望薪资', '薪资期望', '期望工资', '薪资要求', '待遇要求', 're:salary|compensation'] },
    { key: 'availableTime', label: '可到岗时间', group: '求职意向', inputType: 'text', sensitive: false, autoFill: true, patterns: ['可到岗时间', '到岗时间', '可入职时间', '入职时间', '最早到岗时间', 're:available|onboard|startwork'] },
    { key: 'skills', label: '技能特长', group: '技能与其他', inputType: 'text', sensitive: false, autoFill: true, patterns: ['技能特长', '专业技能', '技能', '特长', '掌握技能', 're:skills?|abilities'] },
    { key: 'github', label: '个人主页/GitHub', group: '技能与其他', inputType: 'text', sensitive: false, autoFill: true, patterns: ['github', '个人主页', '个人主页/github', '个人网站', 're:github|homepage|personal.?website'] },
    { key: 'awards', label: '获奖情况', group: '技能与其他', inputType: 'textarea', sensitive: false, autoFill: true, patterns: ['获奖情况', '荣誉奖项', '获奖经历', '所获荣誉', '奖项', 're:awards?|honou?rs?|prizes?'] },
    { key: 'selfEvaluation', label: '自我评价', group: '技能与其他', inputType: 'textarea', sensitive: false, autoFill: true, patterns: ['自我评价', '个人评价', 're:self.?evaluat'] },
    { key: 'openSelfIntro', label: '自我介绍（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['自我介绍'] },
    { key: 'openProject', label: '项目深挖（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['项目深挖'] },
    { key: 'openMotivation', label: '求职动机（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['求职动机'] },
    { key: 'openCityPlan', label: '城市意向（素材）', group: '开放题素材', inputType: 'textarea', sensitive: false, autoFill: false, material: true, patterns: ['城市意向'] },
  ];

  const SOE_EXTRA_TEMPLATE = [
    { key: 'politicalStatus', label: '政治面貌', group: '政治与个人情况', inputType: 'select', options: ['中共党员', '中共预备党员', '共青团员', '民主党派', '群众', '其他'], sensitive: false, autoFill: true, patterns: ['政治面貌', '政治状态', 're:political'] },
    { key: 'joinPartyDate', label: '入党时间', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['入党时间', '入党日期', 're:join.?party|party.?date'] },
    { key: 'ethnic', label: '民族', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['民族', 're:ethnic'] },
    { key: 'hometown', label: '籍贯', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['籍贯', '原籍', 're:native.?place|ancestral'] },
    { key: 'birthplace', label: '出生地', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['出生地', 're:birthplace|birth.?place'] },
    { key: 'household', label: '户籍所在地', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['户口所在地', '户籍所在地', '户籍', '户口', 're:household|registered.?residence'] },
    { key: 'maritalStatus', label: '婚姻状况', group: '政治与个人情况', inputType: 'select', options: ['未婚', '已婚', '保密'], sensitive: false, autoFill: true, patterns: ['婚姻状况', '婚否', '婚姻情况', 're:marital|marriage'] },
    { key: 'nationality', label: '国籍', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['国籍', 're:nationality|citizenship'] },
    { key: 'height', label: '身高', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['身高', 're:height'] },
    { key: 'weight', label: '体重', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['体重', 're:weight'] },
    { key: 'healthStatus', label: '健康状况', group: '政治与个人情况', inputType: 'text', sensitive: false, autoFill: true, patterns: ['健康状况', '健康状态', '身体情况', 're:health'] },
    { key: 'cet4Score', label: '英语四级(CET-4)', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['四级成绩', '英语四级', 'cet-4', 'cet4', '四级', '英语四级成绩', 'cet4成绩', '英语四级cet4成绩', 're:cet.?4'] },
    { key: 'cet6Score', label: '英语六级(CET-6)', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['六级成绩', '英语六级', 'cet-6', 'cet6', '六级', '英语六级成绩', 'cet6成绩', '英语六级cet6成绩', 're:cet.?6'] },
    { key: 'computerLevel', label: '计算机等级', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['计算机等级', '计算机水平', '计算机能力', '计算机一级', '计算机二级', '计算机三级', '计算机四级', 're:computer|ncre'] },
    { key: 'mandarinLevel', label: '普通话水平', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['普通话水平', '普通话等级', '普通话', 're:mandarin|putonghua'] },
    { key: 'drivingLicense', label: '机动车驾驶证', group: '语言与技能证书', inputType: 'text', sensitive: false, autoFill: true, patterns: ['驾驶证', '驾照', '机动车驾驶证', 're:driver.?license|driving.?licence'] },
    { key: 'familyName1', label: '家庭成员一·姓名', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['家庭成员姓名', '成员一姓名', '家庭成员1姓名', '父亲姓名', '母亲姓名', 're:family.{0,4}1.{0,4}name|member.?1.?name'] },
    { key: 'familyRelation1', label: '家庭成员一·称谓', group: '家庭与紧急联系', inputType: 'text', sensitive: false, autoFill: true, patterns: ['与本人关系', '称谓', '成员一称谓', 're:family.{0,4}1.{0,4}relation|member.?1.?relation'] },
    { key: 'familyUnit1', label: '家庭成员一·工作单位', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['家庭成员工作单位', '父母工作单位', '成员一工作单位', '家庭成员1工作单位', 're:(family|成员|父母|家长).{0,6}(单位|职务|职业)'] },
    { key: 'familyName2', label: '家庭成员二·姓名', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['成员二姓名', '家庭成员2姓名', 're:family.{0,4}2.{0,4}name|member.?2.?name'] },
    { key: 'familyRelation2', label: '家庭成员二·称谓', group: '家庭与紧急联系', inputType: 'text', sensitive: false, autoFill: true, patterns: ['成员二称谓', 're:family.{0,4}2.{0,4}relation|member.?2.?relation'] },
    { key: 'familyUnit2', label: '家庭成员二·工作单位', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['成员二工作单位', '家庭成员2工作单位', 're:family.{0,4}2.{0,6}(单位|职务|unit|employ)'] },
    { key: 'emergencyName', label: '紧急联系人', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['紧急联系人', '应急联系人', 're:emergency.*(contact|person)|emergencyname'] },
    { key: 'emergencyPhone', label: '紧急联系电话', group: '家庭与紧急联系', inputType: 'text', sensitive: true, autoFill: true, patterns: ['紧急联系电话', '紧急联系方式', '紧急联系人电话', 're:emergency.*(phone|tel|mobile|number)'] },
    { key: 'punishment', label: '奖惩情况', group: '补充声明', inputType: 'textarea', sensitive: false, autoFill: true, patterns: ['奖惩情况', '奖惩', '奖励与处分', '受奖惩情况', 're:reward|punish|discipline'] },
    { key: 'medicalHistory', label: '体检史/病史', group: '补充声明', inputType: 'textarea', sensitive: true, autoFill: true, patterns: ['体检史', '病史', '健康状况说明', '体检情况', 're:medical.?history|illness|disease'] },
  ];

  const SOE_LONG_TEMPLATE = SHORT_FORM_TEMPLATE.concat(SOE_EXTRA_TEMPLATE);


  // OfferLink 参考页只迁移字段结构；不包含网页脚本、品牌素材或任何个人填写内容。
  // 行结构为 key、参考标签、基础分类、编辑控件和静态选项；地区与开放多选不猜测候选数据。
  const REFERENCE_FIELDS = [
    ["name", "姓名", "基本信息", "text", []],
    ["englishName", "英文名", "基本信息", "text", []],
    ["gender", "性别", "基本信息", "select", ["男", "女"]],
    ["birthDate", "生日", "基本信息", "date", []],
    ["phone", "手机号", "基本信息", "text", []],
    ["email", "邮箱", "基本信息", "text", []],
    ["identityType", "证件类型", "基本信息", "select", ["身份证", "护照", "其他"]],
    ["idCard", "身份证号", "基本信息", "text", []],
    ["politicalStatus", "政治面貌", "基本信息", "select", ["中共党员", "中共预备党员", "共青团员", "民主党派", "群众", "其他"]],
    ["workExperience", "工作经验", "基本信息", "select", ["应届生", "1年以下", "1-3年", "3-5年", "5-10年", "10年以上"]],
    ["homeRegion", "家庭所在地区", "基本信息", "region", []],
    ["schoolRegion", "学校所在地区", "基本信息", "region", []],
    ["homeCity", "家庭所在城市", "基本信息", "text", []],
    ["homeDistrict", "家庭所在区县", "基本信息", "text", []],
    ["schoolCity", "学校所在城市", "基本信息", "text", []],
    ["schoolDistrict", "学校所在区县", "基本信息", "text", []],
    ["address", "详细地址", "基本信息", "text", []],
    ["homeAddress", "家庭地址", "基本信息", "text", []],
    ["wechat", "微信号", "基本信息", "text", []],
    ["qq", "QQ号", "基本信息", "text", []],
    ["bloodType", "血型", "基本信息", "select", ["A型", "B型", "O型", "AB型", "不明", "其他"]],
    ["ethnic", "民族", "基本信息", "select", ["汉族", "满族", "蒙古族", "回族", "藏族", "维吾尔族", "苗族", "彝族", "壮族", "布依族", "侗族", "瑶族", "白族", "土家族", "哈尼族", "哈萨克族", "傣族", "黎族", "傈僳族", "佤族", "畲族", "高山族", "拉祜族", "水族", "东乡族", "纳西族", "景颇族", "柯尔克孜族", "土族", "达斡尔族", "仫佬族", "羌族", "布朗族", "撒拉族", "毛南族", "仡佬族", "锡伯族", "阿昌族", "普米族", "朝鲜族", "塔吉克族", "怒族", "乌孜别克族", "俄罗斯族", "鄂温克族", "德昂族", "保安族", "裕固族", "京族", "塔塔尔族", "独龙族", "鄂伦春族", "赫哲族", "门巴族", "珞巴族", "基诺族"]],
    ["hometown", "籍贯", "基本信息", "region", []],
    ["birthplace", "出生地", "基本信息", "region", []],
    ["sourceRegion", "生源地", "基本信息", "region", []],
    ["household", "户口所在地", "基本信息", "region", []],
    ["currentCity", "当前所在地", "基本信息", "region", []],
    ["postcode", "邮编", "基本信息", "text", []],
    ["joinPartyDate", "入党时间", "基本信息", "date", []],
    ["religion", "宗教信仰", "基本信息", "select", ["无", "佛教", "道教", "基督教", "天主教", "伊斯兰教", "其他"]],
    ["height", "身高", "基本信息", "text", []],
    ["weight", "体重", "基本信息", "text", []],
    ["emergencyName", "紧急联系人", "基本信息", "text", []],
    ["emergencyRelation", "紧急联系人关系", "基本信息", "text", []],
    ["emergencyPhone", "紧急联系人电话", "基本信息", "text", []],
    ["referral", "是否内推", "基本信息", "select", ["是", "否"]],
    ["positionAdjustment", "是否接受岗位调剂", "基本信息", "select", ["是", "否"]],
    ["recruitmentChannel", "了解招聘信息的渠道", "基本信息", "select", ["官方网站", "招聘网站", "校园招聘", "员工推荐", "社交媒体", "其他"]],
    ["hobbies", "兴趣爱好", "基本信息", "textarea", []],
    ["skills", "特长", "基本信息", "textarea", []],
    ["expectedPosition", "期望职位", "求职意向", "text", []],
    ["expectedIndustry", "期望行业", "求职意向", "text", []],
    ["expectedCity", "期望城市", "求职意向", "text", []],
    ["expectedSalary", "期望薪资", "求职意向", "text", []],
    ["currentSalary", "当前薪资", "求职意向", "number", []],
    ["availableTime", "到岗时间", "求职意向", "date", []],
    ["jobAdjustment", "是否接受调剂", "求职意向", "select", ["是", "否"]],
    ["jobChannel", "了解招聘信息的渠道", "求职意向", "select", ["官方网站", "招聘网站", "校园招聘", "员工推荐", "社交媒体", "其他"]],
    ["expectedMonthlySalary", "期望月薪", "求职意向", "number", []],
    ["expectedAnnualSalary", "期望年薪", "求职意向", "number", []],
    ["currentMonthlySalary", "当前月薪", "求职意向", "number", []],
    ["currentAnnualSalary", "当前年薪", "求职意向", "number", []],
    ["expectedCities", "期望城市（多选）", "求职意向", "multiSelect", []],
    ["school", "学校名称", "教育背景", "text", []],
    ["degree", "学历", "教育背景", "select", ["高中", "专科", "本科", "硕士", "博士"]],
    ["major", "专业", "教育背景", "text", []],
    ["educationStartDate", "开始日期", "教育背景", "date", []],
    ["graduationDate", "结束日期", "教育背景", "date", []],
    ["gpa", "GPA", "教育背景", "text", []],
    ["educationRanking", "排名", "教育背景", "select", ["前5%", "前10%", "前20%", "前30%", "前50%", "其他"]],
    ["college", "学院名称", "教育背景", "text", []],
    ["educationForm", "教育形式", "教育背景", "select", ["全日制", "非全日制", "海外及港澳台", "自考", "成人教育", "网络教育", "其他"]],
    ["educationRegion", "学校所在地区", "教育背景", "region", []],
    ["educationCity", "学校所在城市", "教育背景", "text", []],
    ["schoolTier", "院校类型", "教育背景", "select", ["QS100", "985", "211", "双一流", "港澳台", "国内其他", "海外其他"]],
    ["majorCategory", "专业分类", "教育背景", "select", ["专业学位硕士 / 交叉学科 / 密码", "专业学位硕士 / 交叉学科 / 文物", "专业学位硕士 / 军事学 / 作战指挥保障", "专业学位硕士 / 军事学 / 军事训练与管理", "专业学位硕士 / 军事学 / 军兵种作战指挥", "专业学位硕士 / 军事学 / 后勤与装备保障", "专业学位硕士 / 军事学 / 战时政治工作", "专业学位硕士 / 军事学 / 联合作战指挥", "专业学位硕士 / 农学 / 兽医", "专业学位硕士 / 农学 / 农业", "专业学位硕士 / 农学 / 林业", "专业学位硕士 / 农学 / 食品与营养", "专业学位硕士 / 医学 / 中医", "专业学位硕士 / 医学 / 中药", "专业学位硕士 / 医学 / 临床医学", "专业学位硕士 / 医学 / 公共卫生", "专业学位硕士 / 医学 / 医学技术", "专业学位硕士 / 医学 / 口腔医学", "专业学位硕士 / 医学 / 护理", "专业学位硕士 / 医学 / 药学", "专业学位硕士 / 医学 / 针灸", "专业学位硕士 / 历史学 / 博物馆", "专业学位硕士 / 哲学 / 应用伦理", "专业学位硕士 / 工学 / 交通运输", "专业学位硕士 / 工学 / 土木水利", "专业学位硕士 / 工学 / 城乡规划", "专业学位硕士 / 工学 / 建筑", "专业学位硕士 / 工学 / 机械", "专业学位硕士 / 工学 / 材料与化工", "专业学位硕士 / 工学 / 生物与医药", "专业学位硕士 / 工学 / 电子信息", "专业学位硕士 / 工学 / 能源动力", "专业学位硕士 / 工学 / 资源与环境", "专业学位硕士 / 工学 / 风景园林", "专业学位硕士 / 教育学 / 体育", "专业学位硕士 / 教育学 / 国际中文教育", "专业学位硕士 / 教育学 / 应用心理", "专业学位硕士 / 教育学 / 教育", "专业学位硕士 / 教育学 / 汉语国际教育", "专业学位硕士 / 文学 / 出版", "专业学位硕士 / 文学 / 新闻与传播", "专业学位硕士 / 文学 / 翻译", "专业学位硕士 / 法学 / 国际事务", "专业学位硕士 / 法学 / 法律", "专业学位硕士 / 法学 / 知识产权", "专业学位硕士 / 法学 / 社会工作", "专业学位硕士 / 法学 / 警务", "专业学位硕士 / 理学 / 气象", "专业学位硕士 / 管理学 / 会计", "专业学位硕士 / 管理学 / 公共管理", "专业学位硕士 / 管理学 / 图书情报", "专业学位硕士 / 管理学 / 审计", "专业学位硕士 / 管理学 / 工商管理", "专业学位硕士 / 管理学 / 工程管理", "专业学位硕士 / 管理学 / 旅游管理", "专业学位硕士 / 经济学 / 保险", "专业学位硕士 / 经济学 / 国际商务", "专业学位硕士 / 经济学 / 审计", "专业学位硕士 / 经济学 / 应用统计", "专业学位硕士 / 经济学 / 数字经济", "专业学位硕士 / 经济学 / 税务", "专业学位硕士 / 经济学 / 资产评估", "专业学位硕士 / 经济学 / 金融", "专业学位硕士 / 艺术学 / 戏剧与影视", "专业学位硕士 / 艺术学 / 戏曲与曲艺", "专业学位硕士 / 艺术学 / 美术与书法", "专业学位硕士 / 艺术学 / 舞蹈", "专业学位硕士 / 艺术学 / 设计", "专业学位硕士 / 艺术学 / 音乐", "学术型硕士 / 交叉学科 / 区域国别学", "学术型硕士 / 交叉学科 / 国家安全学", "学术型硕士 / 交叉学科 / 密码", "学术型硕士 / 交叉学科 / 文物", "学术型硕士 / 交叉学科 / 智能科学与技术", "学术型硕士 / 交叉学科 / 纳米科学与工程", "学术型硕士 / 交叉学科 / 设计学", "学术型硕士 / 交叉学科 / 遥感科学与技术", "学术型硕士 / 交叉学科 / 集成电路科学与工程", "学术型硕士 / 军事学 / 军事后勤学", "学术型硕士 / 军事学 / 军事思想与军事历史", "学术型硕士 / 军事学 / 军事智能", "学术型硕士 / 军事学 / 军事管理学", "学术型硕士 / 军事学 / 军事装备学", "学术型硕士 / 军事学 / 军事训练学", "学术型硕士 / 军事学 / 军兵种作战学", "学术型硕士 / 军事学 / 军队指挥学", "学术型硕士 / 军事学 / 军队政治工作学", "学术型硕士 / 军事学 / 国家安全学", "学术型硕士 / 军事学 / 战役学", "学术型硕士 / 军事学 / 战术学", "学术型硕士 / 军事学 / 战略学", "学术型硕士 / 军事学 / 联合作战学", "学术型硕士 / 农学 / 作物学", "学术型硕士 / 农学 / 兽医学", "学术型硕士 / 农学 / 农业资源与环境", "学术型硕士 / 农学 / 园艺学", "学术型硕士 / 农学 / 林学", "学术型硕士 / 农学 / 植物保护", "学术型硕士 / 农学 / 水产", "学术型硕士 / 农学 / 水土保持与荒漠化防治学", "学术型硕士 / 农学 / 环境科学与工程", "学术型硕士 / 农学 / 畜牧学", "学术型硕士 / 农学 / 科学技术史", "学术型硕士 / 农学 / 草学", "学术型硕士 / 农学 / 食品科学与工程", "学术型硕士 / 医学 / 中医学", "学术型硕士 / 医学 / 中药学", "学术型硕士 / 医学 / 中西医结合", "学术型硕士 / 医学 / 临床医学", "学术型硕士 / 医学 / 公共卫生与预防医学", "学术型硕士 / 医学 / 医学技术", "学术型硕士 / 医学 / 口腔医学", "学术型硕士 / 医学 / 基础医学", "学术型硕士 / 医学 / 护理学", "学术型硕士 / 医学 / 法医学", "学术型硕士 / 医学 / 特种医学", "学术型硕士 / 医学 / 生物医学工程", "学术型硕士 / 医学 / 科学技术史", "学术型硕士 / 医学 / 药学", "学术型硕士 / 历史学 / 专门史", "学术型硕士 / 历史学 / 世界史", "学术型硕士 / 历史学 / 中国史", "学术型硕士 / 历史学 / 区域国别学", "学术型硕士 / 历史学 / 博物馆", "学术型硕士 / 历史学 / 历史地理学", "学术型硕士 / 历史学 / 史学理论及史学史", "学术型硕士 / 历史学 / 考古学", "学术型硕士 / 哲学 / 哲学", "学术型硕士 / 工学 / 交通运输工程", "学术型硕士 / 工学 / 仪器科学与技术", "学术型硕士 / 工学 / 信息与通信工程", "学术型硕士 / 工学 / 光学工程", "学术型硕士 / 工学 / 公安技术", "学术型硕士 / 工学 / 兵器科学与技术", "学术型硕士 / 工学 / 农业工程", "学术型硕士 / 工学 / 冶金工程", "学术型硕士 / 工学 / 力学", "学术型硕士 / 工学 / 动力工程及工程热物理", "学术型硕士 / 工学 / 化学工程与技术", "学术型硕士 / 工学 / 国家安全学", "学术型硕士 / 工学 / 土木工程", "学术型硕士 / 工学 / 地质资源与地质工程", "学术型硕士 / 工学 / 城乡规划学", "学术型硕士 / 工学 / 安全科学与工程", "学术型硕士 / 工学 / 建筑学", "学术型硕士 / 工学 / 控制科学与工程", "学术型硕士 / 工学 / 智能科学与技术", "学术型硕士 / 工学 / 机械工程", "学术型硕士 / 工学 / 材料科学与工程", "学术型硕士 / 工学 / 林业工程", "学术型硕士 / 工学 / 核科学与技术", "学术型硕士 / 工学 / 水利工程", "学术型硕士 / 工学 / 测绘科学与技术", "学术型硕士 / 工学 / 环境科学与工程", "学术型硕士 / 工学 / 生物医学工程", "学术型硕士 / 工学 / 生物工程", "学术型硕士 / 工学 / 电子科学与技术", "学术型硕士 / 工学 / 电气工程", "学术型硕士 / 工学 / 石油与天然气工程", "学术型硕士 / 工学 / 矿业工程", "学术型硕士 / 工学 / 科学技术史", "学术型硕士 / 工学 / 管理科学与工程", "学术型硕士 / 工学 / 纳米科学与工程", "学术型硕士 / 工学 / 纺织科学与工程", "学术型硕士 / 工学 / 网络空间安全", "学术型硕士 / 工学 / 航空宇航科学与技术", "学术型硕士 / 工学 / 船舶与海洋工程", "学术型硕士 / 工学 / 计算机科学与技术", "学术型硕士 / 工学 / 设计学", "学术型硕士 / 工学 / 软件工程", "学术型硕士 / 工学 / 轻工技术与工程", "学术型硕士 / 工学 / 遥感科学与技术", "学术型硕士 / 工学 / 集成电路科学与工程", "学术型硕士 / 工学 / 风景园林学", "学术型硕士 / 工学 / 食品科学与工程", "学术型硕士 / 教育学 / 体育学", "学术型硕士 / 教育学 / 心理学", "学术型硕士 / 教育学 / 教育学", "学术型硕士 / 文学 / 中国语言文学", "学术型硕士 / 文学 / 区域国别学", "学术型硕士 / 文学 / 外国语言文学", "学术型硕士 / 文学 / 新闻传播学", "学术型硕士 / 法学 / 中共党史党建学", "学术型硕士 / 法学 / 公安学", "学术型硕士 / 法学 / 区域国别学", "学术型硕士 / 法学 / 国家安全学", "学术型硕士 / 法学 / 政治学", "学术型硕士 / 法学 / 民族学", "学术型硕士 / 法学 / 法学", "学术型硕士 / 法学 / 社会学", "学术型硕士 / 法学 / 纪检监察学", "学术型硕士 / 法学 / 马克思主义理论", "学术型硕士 / 理学 / 中药学", "学术型硕士 / 理学 / 公共卫生与预防医学", "学术型硕士 / 理学 / 力学", "学术型硕士 / 理学 / 化学", "学术型硕士 / 理学 / 地球物理学", "学术型硕士 / 理学 / 地理学", "学术型硕士 / 理学 / 地质学", "学术型硕士 / 理学 / 基础医学", "学术型硕士 / 理学 / 大气科学", "学术型硕士 / 理学 / 天文学", "学术型硕士 / 理学 / 心理学", "学术型硕士 / 理学 / 护理学", "学术型硕士 / 理学 / 数学", "学术型硕士 / 理学 / 智能科学与技术", "学术型硕士 / 理学 / 材料科学与工程", "学术型硕士 / 理学 / 海洋科学", "学术型硕士 / 理学 / 物理学", "学术型硕士 / 理学 / 环境科学与工程", "学术型硕士 / 理学 / 生态学", "学术型硕士 / 理学 / 生物医学工程", "学术型硕士 / 理学 / 生物学", "学术型硕士 / 理学 / 电子科学与技术", "学术型硕士 / 理学 / 科学技术史", "学术型硕士 / 理学 / 系统科学", "学术型硕士 / 理学 / 纳米科学与工程", "学术型硕士 / 理学 / 统计学", "学术型硕士 / 理学 / 药学", "学术型硕士 / 理学 / 计算机科学与技术", "学术型硕士 / 理学 / 遥感科学与技术", "学术型硕士 / 理学 / 集成电路科学与工程", "学术型硕士 / 管理学 / 信息资源管理", "学术型硕士 / 管理学 / 公共管理学", "学术型硕士 / 管理学 / 农林经济管理", "学术型硕士 / 管理学 / 国家安全学", "学术型硕士 / 管理学 / 安全科学与工程", "学术型硕士 / 管理学 / 工商管理学", "学术型硕士 / 管理学 / 管理科学与工程", "学术型硕士 / 经济学 / 区域国别学", "学术型硕士 / 经济学 / 应用经济学", "学术型硕士 / 经济学 / 理论经济学", "学术型硕士 / 经济学 / 统计学", "学术型硕士 / 艺术学 / 戏剧与影视学", "学术型硕士 / 艺术学 / 美术学", "学术型硕士 / 艺术学 / 艺术学", "学术型硕士 / 艺术学 / 设计学", "学术型硕士 / 艺术学 / 音乐与舞蹈学"]],
    ["researchDirection", "研究方向", "教育背景", "text", []],
    ["campusPosition", "在校职位", "教育背景", "text", []],
    ["supervisor", "导师姓名", "教育背景", "text", []],
    ["laboratory", "实验室", "教育背景", "text", []],
    ["gpaScale", "绩点满分", "教育背景", "text", []],
    ["academicResult", "学业成绩", "教育背景", "text", []],
    ["classRanking", "班级排名", "教育背景", "select", ["前5%", "前10%", "前20%", "前30%", "前50%", "其他"]],
    ["classSize", "班级人数", "教育背景", "text", []],
    ["thesis", "毕业论文", "教育背景", "text", []],
    ["admissionBatch", "录取批次", "教育背景", "select", ["本科提前批", "本科一批", "本科二批", "本科三批", "本科批", "专科提前批", "专科普通批", "专科批", "专升本", "艺术类提前批", "艺术类本科批", "体育类本科批", "其他"]],
    ["trainingMode", "培养方式", "教育背景", "text", []],
    ["diplomaNumber", "毕业证编号", "教育背景", "text", []],
    ["degreeCertificateNumber", "学位证编号", "教育背景", "text", []],
    ["counselor", "辅导员姓名", "教育背景", "text", []],
    ["counselorPhone", "辅导员电话", "教育背景", "text", []],
    ["overseasEducation", "是否海外/港澳台教育", "教育背景", "select", ["是", "否"]],
    ["courses", "专业主要课程", "教育背景", "text", []],
    ["majorDescription", "专业描述", "教育背景", "textarea", []],
    ["internshipCompany", "公司名称", "实习经历", "text", []],
    ["internshipPosition", "职位名称", "实习经历", "text", []],
    ["internshipIndustry", "行业类别", "实习经历", "select", ["互联网/电子商务", "计算机软件", "金融/投资/证券", "房地产", "通信/电信", "制造业", "教育/培训", "医疗/制药", "其他"]],
    ["internshipRegion", "工作地点", "实习经历", "region", []],
    ["internshipDepartment", "所在部门", "实习经历", "text", []],
    ["internshipStartDate", "开始日期", "实习经历", "date", []],
    ["internshipEndDate", "结束日期", "实习经历", "date", []],
    ["internshipDescription", "详细内容", "实习经历", "textarea", []],
    ["internshipAchievements", "实习成果", "实习经历", "textarea", []],
    ["employmentCompany", "公司名称", "工作经历", "text", []],
    ["employmentPosition", "职位名称", "工作经历", "text", []],
    ["employmentIndustry", "行业类别", "工作经历", "select", ["互联网/电子商务", "计算机软件", "金融/投资/证券", "房地产", "通信/电信", "制造业", "教育/培训", "医疗/制药", "其他"]],
    ["employmentRegion", "工作地点", "工作经历", "region", []],
    ["employmentDepartment", "所在部门", "工作经历", "text", []],
    ["employmentStartDate", "开始日期", "工作经历", "date", []],
    ["employmentEndDate", "结束日期", "工作经历", "date", []],
    ["employmentDescription", "详细内容", "工作经历", "textarea", []],
    ["employmentAchievements", "工作成果", "工作经历", "textarea", []],
    ["employmentSalary", "工资", "工作经历", "text", []],
    ["leavingReason", "离职原因", "工作经历", "text", []],
    ["employmentResponsibilities", "职责及业绩", "工作经历", "textarea", []],
    ["projectName", "项目名称", "项目经历", "text", []],
    ["projectRole", "担任角色", "项目经历", "text", []],
    ["projectStartDate", "开始日期", "项目经历", "date", []],
    ["projectEndDate", "结束日期", "项目经历", "date", []],
    ["projectDescription", "详细信息", "项目经历", "textarea", []],
    ["projectResponsibilities", "项目中职责", "项目经历", "textarea", []],
    ["projectAchievements", "项目业绩", "项目经历", "textarea", []],
    ["projectLink", "项目链接", "项目经历", "text", []],
    ["projectPerformance", "职责及业绩", "项目经历", "textarea", []],
    ["projectReference", "证明人", "项目经历", "text", []],
    ["projectReferencePhone", "证明人电话", "项目经历", "text", []],
    ["projectReferencePosition", "证明人职务", "项目经历", "text", []],
    ["projectReferenceCompany", "证明人单位", "项目经历", "text", []],
    ["familyName1", "姓名", "家庭成员", "text", []],
    ["familyRelation1", "与本人关系", "家庭成员", "text", []],
    ["familyUnit1", "工作单位", "家庭成员", "text", []],
    ["familyPhone", "联系电话", "家庭成员", "text", []],
    ["familyPosition", "职务", "家庭成员", "text", []],
    ["familyBirthDate", "出生日期", "家庭成员", "date", []],
    ["familyRegion", "家庭所在地", "家庭成员", "region", []],
    ["familyPoliticalStatus", "政治面貌", "家庭成员", "select", ["中共党员", "中共预备党员", "共青团员", "民主党派", "群众", "其他"]],
    ["awardName", "奖项名称", "获奖经历", "text", []],
    ["awardCategory", "奖项类别", "获奖经历", "select", ["竞赛获奖", "奖学金", "其他"]],
    ["awardDate", "获奖时间", "获奖经历", "date", []],
    ["awardLevel", "奖项级别", "获奖经历", "select", ["国际级", "国家级", "省级", "校级"]],
    ["awardRank", "奖项等级", "获奖经历", "text", []],
    ["awardIssuer", "颁奖机构", "获奖经历", "text", []],
    ["awardReason", "奖励原因", "获奖经历", "text", []],
    ["awardDescription", "奖项描述", "获奖经历", "textarea", []],
    ["englishLevel", "水平", "英语能力", "select", ["CET-4（四级）", "CET-6（六级）", "TEM-4（专四）", "TEM-8（专八）", "IELTS（雅思）", "TOEFL（托福）", "GRE（研究生入学考试）", "GMAT（管理学研究生入学考试）", "专业四级", "专业八级", "其他"]],
    ["englishScore", "成绩", "英语能力", "text", []],
    ["englishCertificateDate", "证书获取时间", "英语能力", "date", []],
    ["englishProficiency", "掌握程度", "英语能力", "select", ["精通", "熟练", "良好", "一般"]],
    ["englishListening", "听说能力", "英语能力", "select", ["精通", "熟练", "良好", "一般"]],
    ["englishReading", "读写能力", "英语能力", "select", ["精通", "熟练", "良好", "一般"]],
    ["certificateName", "证书名称", "证书信息", "text", []],
    ["certificateDate", "获得时间", "证书信息", "date", []],
    ["certificateLevel", "证书等级", "证书信息", "text", []],
    ["certificateNumber", "证书编号", "证书信息", "text", []],
    ["certificateIssuer", "授予单位", "证书信息", "text", []],
    ["certificateDescription", "证书描述", "证书信息", "textarea", []],
    ["paperName", "论文名称", "论文期刊", "text", []],
    ["journalName", "刊物名称", "论文期刊", "text", []],
    ["publicationDate", "发表时间", "论文期刊", "date", []],
    ["journalLevel", "刊物层级", "论文期刊", "select", ["无发表论文", "SCI一区", "SCI二区", "SCI三区", "中文核心刊物", "其他刊物"]],
    ["paperAuthor", "论文作者", "论文期刊", "select", ["无发表论文", "共同第一作者", "第一作者", "第二作者", "第三作者", "其他作者"]],
    ["impactFactor", "期刊影响因子", "论文期刊", "text", []],
    ["paperLink", "论文链接", "论文期刊", "text", []],
    ["paperDescription", "论文描述", "论文期刊", "textarea", []],
    ["selfIntroduction", "自我介绍", "自我介绍", "textarea", []],
  ];
  const CATALOG_VERSION = 2;
  // 用户指定移除的旧分类；参考目录中的同名标准字段仍保留在其现有模块。
  const REMOVED_PROFILE_GROUPS = ['技能与其他', '开放题素材', '政治与个人情况', '语言与技能证书', '家庭与紧急联系', '补充声明'];
  // 只保留参考页 12 个模块，兼容其旧 key、标签及日期文本，不再追加旧分类。
  function referenceTemplate() {
    const existing = new Map(SOE_LONG_TEMPLATE.map((field) => [field.key, field]));
    const fields = REFERENCE_FIELDS.map(([key, label, group, widget, options]) => {
      const old = existing.get(key);
      return { ...(old || {}), key, label: old?.label || label, group, widget,
        inputType: widget === 'region' || (widget === 'date' && old) ? 'text' : widget,
        options: options.length ? [...new Set([...(old?.options || []), ...options])] : undefined,
        sensitive: old?.sensitive || /家庭|电话|手机|证件|身份证|地址|薪资|工资|联系人|证书编号|出生/.test(group + label),
        autoFill: old ? old.autoFill : false,
        patterns: [...new Set([...(old?.patterns || []), label])] };
    });
    return fields;
  }
  const PROFILE_TEMPLATE = referenceTemplate();

  // 模板元信息：2026-09-06 起合并为单一全字段模板（用户要求不再分长短表单）
  const TEMPLATES = [
    { id: 'all', name: '完整基础字段', fields: PROFILE_TEMPLATE },
  ];

  // 旧模板 id → 全字段（兼容老数据，makeProfile('x','short') 也能拿到全字段）
  const LEGACY_TEMPLATE_IDS = new Set(['short', 'soe']);

  // key -> 字段定义（含扩展同义词组；扩展组不出现在任何模板里）
  const FIELD_INDEX = {};
  for (const f of PROFILE_TEMPLATE) {
    FIELD_INDEX[f.key] = f;
  }
  for (const g of SYNONYMS) {
    if (!FIELD_INDEX[g.key]) {
      FIELD_INDEX[g.key] = {
        key: g.key,
        label: g.key,
        group: '其他',
        inputType: 'text',
        sensitive: !!g.sensitive,
        autoFill: true,
        patterns: g.patterns,
        synonymOnly: true,
      };
    }
  }

  // 对 label 做最佳匹配：返回 { key, score, field } 或 null（material 字段不参与表单匹配）
  function matchLabel(rawLabel) {
    const norm = normalizeLabel(rawLabel);
    if (!norm || norm.length > 30) return null; // 过长文本（题干等）不参与匹配
    let best = null;
    for (const g of SYNONYMS) {
      if (g.material) continue;
      const s = scoreGroup(norm, g.patterns);
      if (s > 0 && (!best || s > best.score)) {
        best = { key: g.key, score: s, field: FIELD_INDEX[g.key] };
      }
    }
    return best;
  }

  // 由模板生成档案（background 与各页面共用）
  function makeId(prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function makeProfile(name, templateId, id) {
    const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
    return {
      id: id || makeId('p'),
      name,
      createdAt: Date.now(),
      templateId: tpl.id,
      fields: tpl.fields.map((f) => ({
        fid: 'f_' + f.key,
        key: f.key,
        label: f.label,
        value: '',
        group: f.group,
        inputType: f.inputType,
        options: f.options ? f.options.slice() : undefined,
        sensitive: !!f.sensitive,
        autoFill: f.autoFill !== false && !f.material,
        material: !!f.material,
        custom: false,
      })),
      materials: [],
    };
  }

  // 老档案升级：补齐全字段模板缺失的字段、统一 autoFill 策略（非素材字段都可自动填）。
  // 幂等，可重复调用；__wsaFull 标记升级完成。
  function upgradeProfile(profile) {
    if (!profile || profile.__wsaFull) return profile;
    const byKey = new Map(profile.fields.map((f) => [f.key, f]));
    for (const tf of PROFILE_TEMPLATE) {
      const cur = byKey.get(tf.key);
      if (cur) {
        if (!cur.material) cur.autoFill = true; // 新策略：有值就自动填
        continue;
      }
      const nf = {
        fid: 'f_' + tf.key,
        key: tf.key,
        label: tf.label,
        value: '',
        group: tf.group,
        inputType: tf.inputType,
        options: tf.options ? tf.options.slice() : undefined,
        sensitive: !!tf.sensitive,
        autoFill: tf.autoFill !== false && !tf.material,
        material: !!tf.material,
        custom: false,
      };
      profile.fields.push(nf);
      byKey.set(tf.key, nf);
    }
    profile.templateId = 'all';
    profile.__wsaFull = true;
    return profile;
  }

  // 默认存储状态（background 与各页面共用，保证任何一方先启动都能自愈种子）
  function defaultState() {
    const p1 = makeProfile('我的档案', 'all', 'p1');
    return {
      schemaVersion: 1,
      migratedFullFields: true,
      onboardingDone: false,
      settings: {
        apiKeys: {},
        model: '',
        visionModel: '',
        autoThreshold: 0.85,
        privacyMask: true,
        autoFloatbar: true,
        provider: 'zhipu',
      },
      activeProfileId: p1.id,
      profiles: [p1],
      ledger: [],
      drafts: {},
    };
  }

  // 设置字段补全（多服务商迁移，幂等）：老数据里的单 apiKey 迁到 apiKeys.zhipu
  function normalizeSettings(state) {
    const s = state.settings || (state.settings = {});
    let changed = false;
    if (!s.provider) { s.provider = 'zhipu'; changed = true; }
    if (!s.apiKeys) {
      s.apiKeys = {};
      if (s.apiKey) s.apiKeys.zhipu = s.apiKey;
      delete s.apiKey;
      changed = true;
    }
    if (typeof s.visionModel !== 'string') { s.visionModel = ''; changed = true; }
    return changed;
  }

  // ============ AI 服务商预设（全部 OpenAI /chat/completions 兼容） ============
  // visionDefault: 该家"主模型"默认是否带视觉（决定扫描件回退能不能直接用主模型）
  const PROVIDERS = {
    zhipu: {
      name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', visionDefault: true,
      models: ['glm-5.3-flash', 'glm-4.5-air', 'glm-4.5', 'glm-4v-plus'],
      visionModels: ['glm-4v-plus'], note: 'open.bigmodel.cn 免费注册，新用户送额度',
    },
    deepseek: {
      name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', visionDefault: false,
      models: ['deepseek-flash', 'deepseek-v4-pro'], visionModels: ['deepseek-flash'],
      note: '官方 deepseek-flash 支持图片，deepseek-v4-pro 不支持图片。PDF/DOCX 可转完整页面图片交给 Flash 识别；不把文件上传接口等同于支持原始 PDF。以当前账户实测结果为准。',
    },
    moonshot: {
      name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', visionDefault: false,
      models: ['kimi-k2-turbo-preview', 'kimi-k2-preview'], visionModels: ['moonshot-v1-8k-vision-preview'],
      note: '扫描件需把视觉模型设为 moonshot-v1-8k-vision-preview',
    },
    qwen: {
      name: 'Qwen（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', visionDefault: false,
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], visionModels: ['qwen-vl-max', 'qwen-vl-plus'],
      note: '扫描件需把视觉模型设为 qwen-vl-max / qwen-vl-plus',
    },
    openai: {
      name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', visionDefault: true,
      models: ['gpt-4o-mini', 'gpt-4o'], visionModels: ['gpt-4o-mini', 'gpt-4o'],
      note: '主模型自带视觉，扫描件可直接用',
    },
    siliconflow: {
      name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', visionDefault: false,
      models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'], visionModels: ['Qwen/Qwen2.5-VL-72B-Instruct'],
      note: '聚合平台，视觉模型选 Qwen/Qwen2.5-VL 系列',
    },
    openrouter: {
      name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', visionDefault: false,
      models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'], visionModels: ['openai/gpt-4o-mini'],
      note: '聚合平台，一个 Key 调多家模型',
    },
    custom: {
      name: '自定义（OpenAI 兼容）', baseUrl: '', visionDefault: true, models: [], visionModels: [],
      note: '填兼容 OpenAI /chat/completions 的接口地址；保存时会请求该域名的访问授权',
    },
    ollama: {
      name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', visionDefault: false, requiresKey: false,
      models: [], visionModels: [], note: '填写本机已安装的模型 ID；默认不需要 API Key。也可直接输入其他 IP 或端口创建服务商。',
    },
  };

  global.WangshenTemplates = {
    RECORD_GROUPS,
    recordKind,
    SYNONYMS,
    TEMPLATES,
    SHORT_FORM_TEMPLATE,
    SOE_LONG_TEMPLATE,
    PROFILE_TEMPLATE,
    REFERENCE_FIELDS,
    CATALOG_VERSION,
    REMOVED_PROFILE_GROUPS,
    PROVIDERS,
    FIELD_INDEX,
    normalizeLabel,
    matchLabel,
    makeId,
    makeProfile,
    upgradeProfile,
    normalizeSettings,
    defaultState,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
