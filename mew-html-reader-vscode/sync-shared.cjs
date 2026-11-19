// Copy shared sources into the standalone VSIX.
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const check = process.argv.includes('--check');
function sync(file, source) {
  const target = path.join(__dirname, file);
  if (check) {
    if (!readFileSync(target).equals(source)) throw new Error(`${file} 已过期，请运行 npm run sync。`);
  } else writeFileSync(target, source);
}
for (const file of ['tag-panel.js', 'pdfdiff/pdf-connection.js', 'pdfdiff/pdf-review-provider.js', 'pdfdiff/pdf-selection-diff.js'])
  sync(file, readFileSync(path.join(__dirname, '..', 'public', file)));
