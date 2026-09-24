import { readFileSync, writeFileSync } from 'node:fs';

const feats = JSON.parse(readFileSync(process.argv[2], 'utf8')).features;

const vk = ([x, y]) => x + ',' + y;
const ek = (a, b) => { const p = vk(a), q = vk(b); return p < q ? p + '/' + q : q + '/' + p; };
const poly = i => feats[i].geometry.coordinates[0];
const toPoly = i => ({
  id: i,
  type: feats[i].properties.type,
  outer: poly(i)[0],
  holes: poly(i).slice(1),
});

// index des arêtes
const owners = new Map();
feats.forEach((f, i) => {
  const r = poly(i)[0];
  for (let k = 0; k < r.length - 1; k++) {
    const key = ek(r[k], r[k + 1]);
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(i);
  }
});

const voisins = i => {
  const s = new Set();
  const r = poly(i)[0];
  for (let k = 0; k < r.length - 1; k++)
    for (const j of owners.get(ek(r[k], r[k + 1]))) if (j !== i) s.add(j);
  return [...s];
};

const T = i => feats[i].properties.type;
const aire = r => {
  let s = 0;
  for (let k = 0; k < r.length - 1; k++) s += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
  return Math.abs(s / 2);
};

const trouve = pred => { for (let i = 0; i < feats.length; i++) if (pred(i)) return i; return -1; };
const groupe = (i, label) => ({ label, anchorId: i, polys: [i, ...voisins(i)].map(toPoly) });

const porche = trouve(i => T(i) === '02' && voisins(i).filter(j => T(j) === '01').length >= 2);
const rangee = trouve(i => T(i) === '01' && voisins(i).filter(j => T(j) === '01').length >= 2);
const chaine = trouve(i => T(i) === '02' && voisins(i).filter(j => T(j) === '02').length >= 1);
const trou   = trouve(i => poly(i).length > 1);
const isole  = trouve(i => T(i) === '02' && voisins(i).length === 0);

// Le plus petit bâtiment réel du fichier. Il n'existe AUCUN polygone d'aire exactement
// nulle ni à moins de trois sommets distincts dans ce jeu — vérifié sur les 50 740
// entités d'Angers. La dégénérescence est donc une garde défensive (autres communes,
// sortie de l'union ou de la simplification), pas un cas observable ici : elle se teste
// sur des anneaux synthétiques, en Task 7 et Task 8.
let mini = 0;
for (let i = 1; i < feats.length; i++) if (aire(poly(i)[0]) < aire(poly(mini)[0])) mini = i;

for (const [nom, i] of Object.entries({ porche, rangee, chaine, trou, isole }))
  if (i < 0) throw new Error(`cas introuvable : ${nom}`);

writeFileSync('tests/fixtures/angers.json', JSON.stringify({
  porchePartage:   groupe(porche, 'léger adjacent à deux bâtiments en dur'),
  rangeeMitoyenne: groupe(rangee, 'bâtiments en dur mitoyens'),
  chaineLegers:    groupe(chaine, 'chaîne de constructions légères'),
  avecTrou:        groupe(trou,   'géométrie source à trou'),
  minuscule:       { label: 'le plus petit bâtiment réel du fichier', anchorId: mini, polys: [toPoly(mini)] },
  legerIsole:      { label: 'construction légère isolée', anchorId: isole, polys: [toPoly(isole)] },
}, null, 1));

console.log('tests/fixtures/angers.json écrit');
