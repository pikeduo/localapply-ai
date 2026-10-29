// 从本仓库空白模板生成两项自主公共别名包，只输出JSON，不读用户存储或网络。
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
// 复用生产定义和摘要校验，不复制第三方词典或夹带空白档案的随机标识。
async function build() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, URL, TextEncoder, TextDecoder, btoa, atob });
  for (const name of ['templates', 'key-vault', 'resume', 'resume-catalog', 'field-matching', 'applications', 'local-store', 'rule-packages']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', name + '.js'), 'utf8'), context, { timeout: 1000 });
  const db = context.LocalApplyStore.migrate(context.WangshenTemplates.defaultState()).db;
  return context.LocalApplyRulePackages.create({ kind: 'localapply-rule-package', formatVersion: 1, packageId: 'localapply.core-aliases', release: 1,
    compatibility: { minSchema: 5, maxSchema: 5, fillContract: 1 }, source: { name: 'LocalApply 自主整理公共别名', reference: '' },
    fields: db.fieldDefinitions.filter((def) => ['builtin.workExperience', 'builtin.educationStartDate'].includes(def.fieldId)) });
}
module.exports = { build };
if (require.main === module) build().then((pack) => process.stdout.write(JSON.stringify(pack, null, 2) + '\n')).catch(() => { process.stderr.write('公共规则包生成失败，请检查仓库模板。\n'); process.exitCode = 1; });
