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

// Numéro de version du script publié.
//
// En release, il vient du TAG (`SBO_VERSION`, posé par le workflow) : le script
// installé annonce alors exactement la version de la release dont il provient, ce
// qu'un horodatage de construction ne permettrait pas — deux personnes construisant
// la même release obtiendraient deux numéros différents, et le gestionnaire de
// scripts croirait à une mise à jour.
//
// En local, faute de tag, il tombe sur l'horodatage de construction à la minute.
// Celui-ci a sa propre raison d'être : savoir QUEL build s'exécute a coûté une
// session entière à analyser une pile d'appels venue de la version précédente,
// restée installée. La ligne d'injection le nomme en console.
//
// Dans les deux cas, des composantes numériques strictement croissantes : les
// gestionnaires de scripts les comparent segment par segment.
const d = new Date();
/** @param {number} n */
const p2 = (n) => String(n).padStart(2, '0');
const stamp =
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`;

const tag = (process.env.SBO_VERSION ?? '').trim().replace(/^v/, '');
if (tag && !/^\d+(\.\d+)*$/.test(tag)) {
  throw new Error(
    `esbuild.config.mjs : SBO_VERSION=${JSON.stringify(tag)} n'est pas une suite de ` +
      'nombres séparés par des points. Un gestionnaire de scripts ne saurait pas la comparer.'
  );
}

const bannerVersionne = meta.replace(
  /(\/\/ @version\s+)(\S+)/,
  (_, prefixe, version) => `${prefixe}${tag || `${version}.${stamp}`}`
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
  define: { __BUILD__: JSON.stringify(tag || `0.1.0.${stamp}`) },
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
