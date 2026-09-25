/**
 * 编码体检：找出**非法 UTF-8** 的源文件。
 *
 * 为什么单独一个脚本：这类损坏不会被 `node --check` 抓到（它照样 "通过"），
 * 但 `import` 会直接炸 —— 本项目的 `lib/write-tools.js` 就这么坏过一次
 * （中文字符串被写成了 GBK 乱码，还吞掉了一个收尾引号）。放在这里当门禁。
 *
 * 跑法：`node scripts/check-encoding.mjs`
 */

import { globSync, readFileSync } from 'node:fs';

const targets = globSync('{lib,test,scripts}/**/*.{js,mjs}').concat(['index.js', 'client.js']);
let bad = 0;

for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  const replacements = (text.match(/\uFFFD/gu) ?? []).length;
  if (replacements === 0) continue;
  bad += 1;
  console.log(`BAD  ${file}  →  ${replacements} 处非法 UTF-8（文件不是 UTF-8 编码，或写坏了）`);
}

if (bad === 0) {
  console.log(`OK   ${targets.length} 个文件都是合法 UTF-8`);
} else {
  console.log(`\n共 ${bad} 个文件损坏：请用 write/edit 工具重写（不要经 PowerShell 的 Set-Content / 重定向写文件，那会按系统代码页编码）。`);
}
process.exit(bad === 0 ? 0 : 1);
