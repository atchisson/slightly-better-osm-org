import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const meta = readFileSync('src/meta.ts', 'utf8')
  .match(/`([\s\S]*?)`/)[1];

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/cadastre-id.user.js',
  banner: { js: meta },
  legalComments: 'none',
});

const out = readFileSync('dist/cadastre-id.user.js', 'utf8');
writeFileSync('dist/cadastre-id.user.js', out);
console.log('dist/cadastre-id.user.js écrit');
