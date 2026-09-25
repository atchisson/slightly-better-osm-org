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

// Horodatage de construction, à la minute. Il sert deux fois : la ligne d'injection
// le nomme en console (savoir QUEL build s'exécute a coûté une session entière à
// analyser une pile d'appels venue de la version précédente), et il complète le
// numéro de version du bandeau pour que le gestionnaire de scripts distingue deux
// installations. Quatre composantes numériques strictement croissantes : les
// gestionnaires les comparent segment par segment.
const d = new Date();
/** @param {number} n */
const p2 = (n) => String(n).padStart(2, '0');
const stamp =
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`;

const bannerVersionne = meta.replace(
  /(\/\/ @version\s+)(\S+)/,
  (_, prefixe, version) => `${prefixe}${version}.${stamp}`
);
if (bannerVersionne === meta) {
  throw new Error("esbuild.config.mjs : aucune ligne @version trouvée dans le bandeau de src/meta.ts.");
}

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/slightly-better-osm-org.user.js',
  banner: { js: bannerVersionne },
  define: { __BUILD__: JSON.stringify(stamp) },
  legalComments: 'none',
});

const out = readFileSync('dist/slightly-better-osm-org.user.js', 'utf8');
if (!out.startsWith(BANNER_START)) {
  throw new Error(
    `esbuild.config.mjs : dist/slightly-better-osm-org.user.js ne commence pas par le bandeau ${JSON.stringify(
      BANNER_START
    )} attendu. La construction a produit un artefact invalide.`
  );
}

console.log('dist/slightly-better-osm-org.user.js écrit');
