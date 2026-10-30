import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const modules = [
  ['lib/timestamp.mjs', 'timestamp'],
  ['lib/providers/openhands.mjs', 'readOpenHands'],
  ['apps/openhands/src/client.mjs', 'createClient'],
  ['apps/openhands/src/style.mjs', 'styles'],
  ['apps/openhands/src/view.mjs', 'mountPage'],
];
const readSource = async path => (await readFile(new URL(path, root), 'utf8')).replace(/\r\n/g, '\n');

// Assemble this fixed, dependency-free module graph into the host's single ESM entrypoint.
const body = source => source.replace(/^import [^\n]+;\r?\n/gm, '').replace(/^export (?=(?:const|function)\b)/gm, '').trim();
const sections = [];
for (const [path, symbol] of modules) {
  const source = await readSource(path);
  sections.push(`const { ${symbol} } = (() => {\n${body(source)}\nreturn { ${symbol} };\n})();`);
}
const entry = await readSource('apps/openhands/src/entry.mjs');
const bundle = `// Built from Runward's shared reader and Canvas sources. Rebuild with npm run build:canvas.\n${sections.join('\n\n')}\n\n${entry.replace(/^import [^\n]+;\r?\n/gm, '').trim()}\n`;
const output = new URL('apps/openhands/extension.js', root);
if (process.argv.includes('--check')) {
  if (await readSource('apps/openhands/extension.js') !== bundle) throw new Error('Canvas bundle is out of date. Run npm run build:canvas and commit the rebuilt extension.js.');
} else {
  await writeFile(output, bundle);
}
