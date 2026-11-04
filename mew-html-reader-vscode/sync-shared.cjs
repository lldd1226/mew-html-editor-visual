// public/tag-panel.js is the source; the VSIX carries a standalone CommonJS copy.
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '..', 'public', 'tag-panel.js'));
const target = path.join(__dirname, 'tag-panel.js');
if (process.argv.includes('--check')) {
  if (!readFileSync(target).equals(source)) throw new Error('tag-panel.js 已过期，请运行 npm run sync。');
} else writeFileSync(target, source);
