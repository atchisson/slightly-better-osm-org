import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const BANNER_START = '// ==UserScript==';
const BANNER_END = '// ==/UserScript==';

const metaSource = readFileSync('src/meta.ts', 'utf8');
const match = metaSource.match(/`([\s\S]*?)`/);
if (match === null) {
  throw new Error(
    "esbuild.config.mjs : aucun littéral de gabarit (backticks) trouvé dans src/meta.ts. " +
      'Attendu : USERSCRIPT_META défini comme `...`.'
  );
}

const meta = match[1];
if (meta === undefined) {
  throw new Error(
    'esbuild.config.mjs : le littéral de gabarit trouvé dans src/meta.ts ne contient pas de groupe capturé.'
  );
}

if (!meta.startsWith(BANNER_START) || !meta.includes(BANNER_END)) {
  throw new Error(
    'esbuild.config.mjs : le bandeau extrait de src/meta.ts est invalide. ' +
      `Attendu : une chaîne commençant par ${JSON.stringify(BANNER_START)} et contenant ${JSON.stringify(
        BANNER_END
      )}. ` +
      `Obtenu (80 premiers caractères) : ${JSON.stringify(meta.slice(0, 80))}`
  );
}

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
if (!out.startsWith(BANNER_START)) {
  throw new Error(
    `esbuild.config.mjs : dist/cadastre-id.user.js ne commence pas par le bandeau ${JSON.stringify(
      BANNER_START
    )} attendu. La construction a produit un artefact invalide.`
  );
}

console.log('dist/cadastre-id.user.js écrit');
