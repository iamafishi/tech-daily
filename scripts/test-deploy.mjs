/**
 * 部署配置校验
 *
 *   node scripts/test-deploy.mjs
 *
 * 环境里没有 YAML 解析库（也不该为此引入依赖），因此这里按行校验
 * .github/workflows 的结构与关键约定。它能拦住真正会导致部署失败的改动：
 * 制表符、缩进错乱、cron 非法、权限缺失、产物目录与打包目录不一致、
 * 部署任务缺少 needs/environment、归档数据没有回写等。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const files = (await readdir(WF_DIR)).filter((f) => /\.ya?ml$/.test(f));
check('存在工作流文件', files.length > 0, files.join(', '));

const raw = await readFile(path.join(WF_DIR, 'daily.yml'), 'utf8');
const lines = raw.split(/\r?\n/);

console.log('\n— 基础语法 —');
check('未使用制表符（YAML 禁止）', !/\t/.test(raw));
check('以换行结尾', raw.endsWith('\n'));
check('没有行尾多余空格', !/[ \t]+\n/.test(raw));
check('文件非空', raw.trim().length > 200, `${raw.length} 字符`);

const indentError = lines
  .map((l, i) => ({ l, i }))
  .filter(({ l }) => /^ +/.test(l) && (l.match(/^ +/)[0].length % 2 !== 0) && l.trim())
  .filter(({ l }) => !/^\s+-\s/.test(l)); // 列表项缩进可以更灵活
check('缩进均为偶数空格', indentError.length === 0, indentError.slice(0, 2).map((e) => `第${e.i + 1}行`).join(', '));

console.log('\n— 触发与权限 —');
const cronMatch = raw.match(/cron:\s*'([^']+)'/);
check('配置了定时触发', Boolean(cronMatch), cronMatch?.[1] || '');
{
  const cron = cronMatch?.[1] || '';
  const parts = cron.split(/\s+/);
  const valid = parts.length === 5 &&
    parts.every((p) => /^(\*|\d+|\d+-\d+|\*\/\d+)(,(\d+|\d+-\d+|\*\/\d+))*$/.test(p)) &&
    Number(parts[0]) >= 0 && Number(parts[0]) <= 59 &&
    Number(parts[1]) >= 0 && Number(parts[1]) <= 23;
  check('cron 表达式合法（5 段且数值在范围内）', valid, cron);
  const hourUtc = Number(parts[1]);
  const bjHour = (hourUtc + 8) % 24;
  check('定时时间落在北京时间清晨（0-9 点）', bjHour >= 0 && bjHour <= 9, `UTC ${hourUtc} 点 = 北京时间 ${bjHour} 点`);
}
check('支持手动触发', /workflow_dispatch:/.test(raw));
check('手动触发提供 force_summary 布尔开关', /force_summary:/.test(raw) && /type:\s*boolean/.test(raw));
check('force_summary 默认 false（避免定时任务误重算）', /force_summary:[\s\S]{0,200}?default:\s*false/.test(raw));
check('force_summary 经 env 传递而非直接插值进脚本', /FORCE_SUMMARY:\s*\$\{\{\s*inputs\.force_summary\s*\}\}/.test(raw) && /"\$FORCE_SUMMARY"\s*=/.test(raw));
check('开启开关时调用 build:summary', /npm run build:summary/.test(raw));
check('声明 contents: write（需回写归档）', /contents:\s*write/.test(raw));
check('声明 pages: write', /pages:\s*write/.test(raw));
check('声明 id-token: write', /id-token:\s*write/.test(raw));
check('配置了 concurrency 避免构建重叠', /concurrency:/.test(raw) && /group:/.test(raw));

console.log('\n— 构建任务 —');
check('存在 build 任务', /^\s{2}build:/m.test(raw));
check('使用 ubuntu-latest', /runs-on:\s*ubuntu-latest/.test(raw));
check('设置了任务超时', /timeout-minutes:/.test(raw));
check('检出仓库使用 actions/checkout', /uses:\s*actions\/checkout@v4/.test(raw));
check('固定 Node 主版本', /node-version:\s*'?(2[0-9]|1[89])'?/.test(raw), (raw.match(/node-version:\s*'?[\d.]+'?/) || [])[0] || '');
check('执行构建脚本（含强制重算分支）', /npm run build:summary/.test(raw) && /npm run build\b/.test(raw));
check('构建后执行数据自检', /run:\s*npm run check/.test(raw));
check('使用 configure-pages', /uses:\s*actions\/configure-pages@/.test(raw));
check('使用 upload-pages-artifact', /uses:\s*actions\/upload-pages-artifact@/.test(raw));
check('打包路径不是整个仓库', !/path:\s*'\.'\s*$/m.test(raw));

console.log('\n— 站点打包 —');
const uploadPath = raw.match(/uses:\s*actions\/upload-pages-artifact@[\s\S]{0,200}?path:\s*'([^']+)'/)?.[1];
check('上传目录与打包目录一致', uploadPath === '_site', `upload=${uploadPath}`);
check('打包时复制首页', /cp index\.html/.test(raw));
check('打包时复制 app.js 与样式', /cp index\.html app\.js styles\.css _site\//.test(raw) || (/app\.js/.test(raw) && /styles\.css/.test(raw)));
check('打包时复制 data 目录', /cp -r data _site\/data/.test(raw));
check('生成 .nojekyll', /touch _site\/\.nojekyll/.test(raw));
check('打包目录不会被 git 误提交风险影响', !/git add _site/.test(raw));

console.log('\n— 归档回写 —');
check('配置了 git 身份', /git config user\.name/.test(raw) && /git config user\.email/.test(raw));
check('只提交 data 目录', /git add data\//.test(raw));
check('无变更时跳过提交', /diff --staged --quiet/.test(raw));

// 回归：checkout 之后远程可能前进，直接 push 会因非快进被拒绝，
// 导致整次构建的摘要与数据全部丢失、部署被跳过。
check('推送前执行 pull --rebase（防非快进拒绝）', /git pull --rebase/.test(raw));
check('pull 带 --autostash（构建产物会挡住 rebase）', /pull --rebase --autostash/.test(raw));
check('pull 与 push 在同一条件分支内', /pull --rebase --autostash origin "\$BRANCH" && git push origin "HEAD:\$BRANCH"/.test(raw));
check('推送失败会重试而非直接放弃', /for i in 1 2 3/.test(raw) && /重试/.test(raw));
check('重试耗尽后显式报错退出', /连续 3 次无法推送/.test(raw) && /exit 1/.test(raw));
check('不再使用易被拒绝的裸 git push', !/git push origin HEAD:\$\{\{/.test(raw));
check('分支名取自环境变量而非直接插值', /BRANCH="\$\{GITHUB_REF_NAME:-main\}"/.test(raw));
check('配置 pull.rebase 避免产生 merge commit', /git config pull\.rebase true/.test(raw));

console.log('\n— 部署任务 —');
const deployIdx = raw.indexOf('\n  deploy:');
check('存在 deploy 任务', deployIdx > 0);
const deployBlock = deployIdx > 0 ? raw.slice(deployIdx) : '';
check('部署依赖构建', /needs:\s*build/.test(deployBlock));
check('使用 deploy-pages', /uses:\s*actions\/deploy-pages@/.test(deployBlock));
check('声明 github-pages 环境', /environment:/.test(deployBlock) && /name:\s*github-pages/.test(deployBlock));
check('输出站点地址', /url:\s*\$\{\{\s*steps\.\w+\.outputs\.page_url\s*\}\}/.test(deployBlock), (deployBlock.match(/url:\s*\$\{\{[^}]+\}\}/) || [])[0] || '');
check('构建任务未含部署步骤', !/deploy-pages/.test(raw.slice(0, deployIdx)));

console.log('\n— 密钥与降级 —');
check('AI Key 从 secrets 注入', /AI_API_KEY:\s*\$\{\{\s*secrets\.AI_API_KEY\s*\}\}/.test(raw));
check('API 地址与模型支持变量覆盖', /AI_BASE_URL:/.test(raw) && /AI_MODEL:/.test(raw));
check('未配置 Key 时不会中断构建', !/secrets\.AI_API_KEY\s*\}\}\s*\|\|\s*exit/.test(raw));

console.log('\n— 强制重算开关的取值语义 —');

const buildSrc = await readFile(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
// 与 build.mjs 中同一条真值规则
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
check('未设置 FORCE_SUMMARY 时为假', truthy(undefined) === false && truthy('') === false);
check('字符串 "false" 为假（workflow_dispatch 未勾选时会传它）', truthy('false') === false);
check('字符串 "true" 为真', truthy('true') === true);
check('"FALSE" 大小写不敏感仍为假', truthy('FALSE') === false);
check('"0" 为假', truthy('0') === false);
check('build.mjs 使用真值判断而非存在性判断', /truthy\(process\.env\.FORCE_SUMMARY\)/.test(buildSrc));
check('build.mjs 未用「环境变量存在即真」的写法', !/process\.env\.FORCE_SUMMARY\s*(\?|\|\||&&)/.test(buildSrc));

console.log('\n— 忽略规则 —');
const gitignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
check('.gitignore 排除 .preview', /^\.preview\/$/m.test(gitignore));
check('.gitignore 排除 node_modules', /^node_modules\/$/m.test(gitignore));
check('data 目录未被忽略（需要提交归档）', !/^data\/?$/m.test(gitignore));

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(66)}`);
console.log(`部署配置校验：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('✓ 全部通过');
