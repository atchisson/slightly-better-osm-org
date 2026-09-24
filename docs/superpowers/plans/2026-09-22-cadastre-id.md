# Plan d'implémentation — cadastre-id

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un userscript qui, dans l'éditeur iD sur openstreetmap.org, crée un bâtiment OSM tagué à partir du cadastre français en un clic.

**Architecture:** Un module `bridge/` isole toute connaissance des entrailles de iD ; le reste — géométrie, composition, conflation, tags — est du code pur sans dépendance au navigateur, donc testable intégralement. Les données viennent des fichiers bâtiments Etalab par commune, téléchargés une fois et mis en cache. L'union des bâtiments légers dans leur bâtiment porteur est **topologique et exacte** : on retire les arêtes internes puis on recoud le bord, sans arithmétique flottante.

**Tech Stack:** TypeScript, esbuild (bundle unique `.user.js`), Vitest. **Aucune dépendance de production.** Décision de plan, réversible : TypeScript est retenu parce que ce code manipule des tableaux de coordonnées où une inversion lat/lon est un bug silencieux ; esbuild et Vitest le gèrent nativement, sans coût d'outillage.

**Spec:** [docs/superpowers/specs/2026-09-22-cadastre-id-design.md](../specs/2026-09-22-cadastre-id-design.md)

## Global Constraints

Ces contraintes s'appliquent à toutes les tâches.

- **Tag source, verbatim :** `cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : {millésime}` — le millésime est lu sur le jeu Etalab téléchargé, **jamais codé en dur**.
- **`wall=no`** va sur une construction légère isolée **uniquement**, jamais sur une union maison + porche.
- **`building=yes`** sur tout bâtiment créé.
- **Un nœud OSM existant est réutilisé en place, jamais déplacé.** Tolérance de recalage par défaut **0,20 m**.
- **La v1 ne modifie aucun objet OSM existant.**
- **Jamais de fusion entre deux bâtiments en dur** (`01` ou `03`). Un `03` est un bâtiment à part entière, jamais un appendice.
- **Propriétaire d'une composante légère :** le bâtiment en dur adjacent avec lequel la **somme** des longueurs de frontière partagée est la plus grande ; égalité départagée par le plus petit index de polygone.
- **Source des données :** `https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/{dep}/{insee}/cadastre-{insee}-batiments.json.gz`
- **Résolution INSEE :** `https://geo.api.gouv.fr/communes?lat={lat}&lon={lon}&fields=code`
- **Codes de type cadastre :** `01` bâtiment en dur, `02` construction légère, `03` bâtiment « FI, vu du ciel » (traité comme `01`).
- **Refus explicites**, chacun avec son message, sans jamais laisser de géométrie à moitié créée : géométrie source à trou, polygone dégénéré, union produisant un trou ou plusieurs parties, échec de recousage, bâtiment OSM déjà présent, commune introuvable ou fichier indisponible, réseau coupé, contexte iD non capturé.
- **Aperçu et clic appellent la même fonction de composition.** C'est le seul garde-fou contre une annexion erronée ; il serait sans valeur s'il pouvait diverger.
- **Types partagés**, définis en Task 4 et utilisés partout ensuite :

```ts
export type LonLat = [number, number];
export type Ring = LonLat[];              // fermé : premier sommet === dernier
export type BatType = '01' | '02' | '03';
export interface Poly {
  id: number;                             // index stable dans le fichier commune
  type: BatType;
  outer: Ring;
  holes: Ring[];
}
```

## Chiffres de référence

Mesurés sur Angers (`49007`, 50 740 bâtiments) pendant la conception. Ils servent de budget et d'oracle.

| | |
|---|---|
| Fichier | 2,6 Mo gzippés / 19,6 Mo décompressés |
| `JSON.parse` | 301 ms |
| Précalcul complet (index arêtes + composantes + propriétaires + 37 848 unions) | 3,9 s |
| Ancres (`01`+`03`) | 37 848 |
| Union propre à un anneau | 37 547 (**99,20 %**) |
| dont absorbant au moins un léger | 6 778 |
| Union → trou | 55 |
| Union → parties multiples | **0** |
| Échec de recousage (pincement) | 76 |
| Ancre déjà à trou | 170 |
| Composantes légères | 11 854, dont 2 822 sans propriétaire et 2 070 ambiguës |

---

## Task 1: Spike — capture du contexte iD

**Tâche bloquante.** Toute la forme « userscript » repose sur une hypothèse non vérifiée en navigateur. Si elle tombe, **arrêter le plan** et revenir à la conception : c'est le choix de la forme de livraison qui est à refaire, pas un détail d'implémentation.

**Cette tâche demande une manipulation humaine dans un navigateur.** Un agent ne peut pas la conclure seul : il prépare le script, la personne l'installe et colle les résultats.

**Files:**
- Create: `docs/superpowers/spikes/2026-09-22-capture-contexte-id.md`
- Create (jetable, non commité) : `spike/probe.user.js`

**Interfaces:**
- Consumes: rien
- Produces: les réponses qui paramètrent Task 14 (`bridge/`) — noms exacts des exports du namespace `iD`, façon d'accéder au graphe, à la projection, aux événements de carte et au commentaire de changeset.

- [ ] **Step 1: Écrire le script sonde**

Créer `spike/probe.user.js` :

```js
// ==UserScript==
// @name         cadastre-id spike
// @namespace    cadastre-id
// @match        https://www.openstreetmap.org/*
// @run-at       document-start
// @grant        none
// @version      0.0.1
// ==/UserScript==

(function () {
  'use strict';
  const log = (...a) => console.log('[spike]', ...a);
  log('injecté à', document.readyState, location.pathname);

  let captured = null;
  let real = undefined;

  Object.defineProperty(window, 'iD', {
    configurable: true,
    get() { return real; },
    set(v) {
      log('window.iD affecté');
      if (v && typeof v.coreContext === 'function') {
        const orig = v.coreContext;
        v.coreContext = function (...args) {
          const ctx = orig.apply(this, args);
          captured = ctx;
          window.__spikeContext = ctx;
          log('contexte capturé', ctx);
          return ctx;
        };
      }
      real = v;
    },
  });

  window.__spikeReport = function () {
    const iD = window.iD;
    const ctx = captured;
    const has = (o, k) => (o && k in o ? typeof o[k] : 'ABSENT');
    console.log('--- exports du namespace iD ---');
    for (const k of ['osmNode', 'osmWay', 'osmEntity', 'actionAddEntity', 'actionChangeTags',
                     'coreGraph', 'geoSphericalDistance', 'osmIsInterestingTag']) {
      console.log(' ', k, '=', has(iD, k));
    }
    console.log('--- contexte ---');
    for (const k of ['graph', 'history', 'map', 'perform', 'enter', 'projection',
                     'storage', 'entity', 'intersects']) {
      console.log(' ', k, '=', has(ctx, k));
    }
    if (ctx && ctx.map) {
      const m = ctx.map();
      console.log('  map.extent =', typeof m.extent, '| map.on =', typeof m.on,
                  '| map.projection =', typeof m.projection);
      try { console.log('  extent() ->', m.extent().rectangle()); } catch (e) { console.log('  extent() a jeté', e.message); }
    }
    if (ctx && ctx.history) {
      const h = ctx.history();
      console.log('  history.intersects =', typeof h.intersects);
      try {
        const ents = h.intersects(ctx.map().extent());
        console.log('  entités dans la vue :', ents.length,
                    '| exemple :', ents.find(e => e.tags && e.tags.building));
      } catch (e) { console.log('  intersects a jeté', e.message); }
    }
    return 'fin du rapport';
  };
})();
```

- [ ] **Step 2: Vérifier l'injection en chargement direct**

La personne installe le script dans Violentmonkey, ouvre directement
`https://www.openstreetmap.org/edit?editor=id#map=18/47.4784/-0.5632`
puis, une fois iD chargé, tape `__spikeReport()` dans la console.

Attendu : `[spike] injecté à loading /edit`, puis `[spike] contexte capturé`, puis le rapport.

Consigner la sortie complète dans le document de spike.

- [ ] **Step 3: Vérifier l'injection après navigation interne**

**Le piège le plus probable.** osm.org navigue en partie sans rechargement de page. Depuis la carte `https://www.openstreetmap.org/#map=18/47.4784/-0.5632`, cliquer « Modifier » pour entrer dans l'éditeur, puis retaper `__spikeReport()`.

Si le contexte n'est pas capturé dans ce cas, le `@match` sur `/*` combiné à `document-start` ne suffit pas : noter précisément le symptôme. Une piste à tester alors : poser le piège sur toutes les pages osm.org et non seulement sur `/edit`, ce que fait déjà ce script — s'il échoue quand même, documenter et remonter le problème avant de continuer.

- [ ] **Step 4: Répondre aux six inconnues de la spec §10**

Consigner dans le document de spike, avec la sortie console qui l'étaye :

1. L'interception fonctionne-t-elle, en chargement direct **et** après navigation interne ?
2. `iD.osmNode`, `iD.osmWay`, `iD.actionAddEntity` existent-ils ? Sinon, quels sont les noms réels ?
3. Comment lister les bâtiments chargés et les nœuds proches ? `context.history().intersects(extent)` renvoie-t-il des entités exploitables ?
4. Comment obtenir la projection et s'abonner aux déplacements de carte ?
5. Comment préremplir le commentaire de changeset ? Essayer `context.storage('comment', '...')` et inspecter le champ du panneau de sauvegarde.
6. Quelle est la version de iD servie (`iD.version`) ?

- [ ] **Step 5: Écrire le compte rendu et décider**

Rédiger `docs/superpowers/spikes/2026-09-22-capture-contexte-id.md` : ce qui a été testé, la sortie obtenue, les réponses aux six points, et **la conclusion — on continue ou on revient à la conception**.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/spikes/2026-09-22-capture-contexte-id.md
git commit -m "spike: verifier la capture du contexte iD depuis un userscript"
```

---

## Task 2: Échafaudage et chaîne de build

**Deliverable :** `npm run build` produit un `.user.js` installable qui, sur osm.org, journalise la capture du contexte. `npm test` passe.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `.gitignore`
- Create: `src/meta.ts`, `src/main.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: Task 1 (confirmation que l'approche tient)
- Produces: `npm run build` → `dist/cadastre-id.user.js` ; `npm test` → Vitest

- [ ] **Step 1: Écrire le test de fumée**

`tests/smoke.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { USERSCRIPT_META } from '../src/meta';

describe('meta userscript', () => {
  it('déclare run-at document-start et grant none', () => {
    expect(USERSCRIPT_META).toContain('@run-at       document-start');
    expect(USERSCRIPT_META).toContain('@grant        none');
  });

  it('cible les pages osm.org', () => {
    expect(USERSCRIPT_META).toContain('@match        https://www.openstreetmap.org/*');
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL — `vitest` n'est pas installé, ou `Cannot find module '../src/meta'`.

- [ ] **Step 3: Créer `package.json`**

```json
{
  "name": "cadastre-id",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^26.0.0"
  }
}
```

Puis : `npm install`

- [ ] **Step 4: Créer `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests", "esbuild.config.mjs"]
}
```

- [ ] **Step 5: Créer `vitest.config.ts` et `.gitignore`**

`vitest.config.ts` :

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

`.gitignore` — le fichier existe déjà et contient `.superpowers/` (espace de travail du processus d'exécution). **Compléter, ne pas écraser** :

```
.superpowers/
node_modules/
dist/
spike/
*.log
```

- [ ] **Step 6: Créer `src/meta.ts`**

```ts
export const USERSCRIPT_META = `// ==UserScript==
// @name         cadastre-id
// @namespace    https://github.com/alenoir/cadastre-id
// @description  Crée un bâtiment OSM depuis le cadastre français, en un clic, dans iD
// @match        https://www.openstreetmap.org/*
// @run-at       document-start
// @grant        none
// @version      0.1.0
// ==/UserScript==
`;
```

- [ ] **Step 7: Lancer le test pour le voir passer**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS, 2 tests.

> **Correction post-revue (2026-09-23).** Les deux blocs de code ci-dessous — `tsconfig.json` au Step 4 et `esbuild.config.mjs` au Step 8 — contenaient deux défauts que la revue de tâche a rattrapés. Le code réellement livré diffère, et c'est lui qui fait foi :
>
> 1. L'extraction du bandeau par expression régulière indexait `.match(...)[1]` sans vérifier que la capture est bien un bandeau, ni même qu'il y a eu correspondance. Un `meta.ts` réorganisé aurait produit un userscript silencieusement invalide. La version livrée valide la forme du bandeau et vérifie le fichier produit, en jetant bruyamment sinon — ce qui recycle au passage le `readFileSync`/`writeFileSync` inutile du Step 8.
> 2. `tsconfig.json` listait `esbuild.config.mjs` dans `include` sans `allowJs`, si bien que le fichier n'était **jamais** typé. `npm run typecheck` donnait une fausse assurance sur le seul fichier fragile de la chaîne. La version livrée ajoute `allowJs`, `checkJs` et `@types/node`.

- [ ] **Step 8: Créer `esbuild.config.mjs`**

```js
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
```

- [ ] **Step 9: Créer `src/main.ts` minimal**

```ts
const log = (...a: unknown[]) => console.log('[cadastre-id]', ...a);

let realID: unknown = undefined;

Object.defineProperty(window, 'iD', {
  configurable: true,
  get: () => realID,
  set(v: any) {
    if (v && typeof v.coreContext === 'function') {
      const orig = v.coreContext;
      v.coreContext = function (this: unknown, ...args: unknown[]) {
        const ctx = orig.apply(this, args);
        log('contexte iD capturé');
        return ctx;
      };
    }
    realID = v;
  },
});

log('chargé');
```

- [ ] **Step 10: Construire et vérifier à la main**

Run: `npm run build`
Expected: `dist/cadastre-id.user.js` existe et commence par le bandeau `// ==UserScript==`.

La personne l'installe et vérifie que `[cadastre-id] contexte iD capturé` apparaît sur `/edit`.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts esbuild.config.mjs .gitignore src tests
git commit -m "build: echafaudage TypeScript, esbuild et Vitest"
```

---

## Task 3: Fixtures extraites du cadastre réel

Les tests de géométrie doivent porter sur des cas réels, pas inventés. On extrait six cas nommés du fichier d'Angers, une fois pour toutes, et on les commite.

**Files:**
- Create: `tools/extract-fixtures.mjs`
- Create: `tests/fixtures/angers.json`
- Test: `tests/fixtures/angers.test.ts`

**Interfaces:**
- Produces: `tests/fixtures/angers.json`, objet dont les clés sont les six cas nommés, chacun `{ label: string, polys: Poly[], anchorId: number }`.

> **Correction post-revue (2026-09-23).** Le test ci-dessous ne vérifie que la validité générique des anneaux : il passerait encore si une ré-extraction perdait le trou de `avecTrou` ou remplaçait la rangée mitoyenne par des bâtiments non adjacents. Or ce fichier est le filet de sécurité des Tasks 5 et 8. La version livrée assortit chaque cas d'une assertion sur la propriété qui le justifie — trou réel, adjacence par arête pour la rangée, la chaîne et le porche, aire strictement positive et inférieure à 1 m² pour le minuscule — au moyen d'un helper d'arête partagée **écrit localement dans le test**. Ne pas l'importer depuis `src/` : le test cesserait alors de détecter une fixture cassée de la même façon que le code de production.

- [ ] **Step 1: Écrire le test qui décrit les fixtures attendues**

`tests/fixtures/angers.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import fixtures from './angers.json';

const CAS = [
  'porchePartage',      // léger touchant deux durs distincts
  'rangeeMitoyenne',    // durs mitoyens, ne doivent jamais fusionner
  'chaineLegers',       // composante de plusieurs légers
  'avecTrou',           // géométrie source à trou
  'minuscule',          // le plus petit bâtiment réel du fichier (~0,02 m²)
  'legerIsole',         // léger sans dur adjacent
] as const;

describe('fixtures Angers', () => {
  it('contient les six cas', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...CAS].sort());
  });

  for (const cas of CAS) {
    it(`${cas} porte des polygones exploitables`, () => {
      const f = (fixtures as any)[cas];
      expect(f.polys.length).toBeGreaterThan(0);
      for (const p of f.polys) {
        expect(['01', '02', '03']).toContain(p.type);
        expect(p.outer.length).toBeGreaterThanOrEqual(4);
        expect(p.outer[0]).toEqual(p.outer[p.outer.length - 1]);
      }
    });
  }

  it('porchePartage contient bien un léger adjacent à deux durs', () => {
    const f = (fixtures as any).porchePartage;
    expect(f.polys.filter((p: any) => p.type === '02').length).toBeGreaterThanOrEqual(1);
    expect(f.polys.filter((p: any) => p.type === '01').length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

Run: `npx vitest run tests/fixtures/angers.test.ts`
Expected: FAIL — `Cannot find module './angers.json'`.

- [ ] **Step 3: Écrire l'extracteur**

`tools/extract-fixtures.mjs` — prend en argument le chemin du fichier `cadastre-49007-batiments.json` décompressé, écrit `tests/fixtures/angers.json`.

```js
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
```

- [ ] **Step 4: Récupérer les données et lancer l'extraction**

```bash
curl -sL -o /tmp/angers.json.gz \
  "https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/49/49007/cadastre-49007-batiments.json.gz"
gunzip -c /tmp/angers.json.gz > /tmp/angers.json
mkdir -p tests/fixtures
node tools/extract-fixtures.mjs /tmp/angers.json
```

Ne pas commiter `/tmp/angers.json` : seul le fichier de fixtures entre au dépôt.

- [ ] **Step 5: Lancer le test pour le voir passer**

Run: `npx vitest run tests/fixtures/angers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/extract-fixtures.mjs tests/fixtures
git commit -m "test: fixtures geometriques extraites du cadastre reel d'Angers"
```

---

## Task 4: Arêtes partagées

**Files:**
- Create: `src/geometry/types.ts`, `src/geometry/edges.ts`
- Test: `tests/geometry/edges.test.ts`

**Interfaces:**
- Produces:
```ts
// src/geometry/types.ts
export type LonLat = [number, number];
export type Ring = LonLat[];
export type BatType = '01' | '02' | '03';
export interface Poly { id: number; type: BatType; outer: Ring; holes: Ring[]; }

// src/geometry/edges.ts
export function edgeKey(a: LonLat, b: LonLat): string;
export function segmentLength(a: LonLat, b: LonLat): number;   // mètres
export function buildEdgeIndex(polys: Poly[]): Map<string, number[]>;  // clé -> ids
```

L'accumulation des longueurs de frontière se fait dans `lightComponents` (Task 5), à partir de l'index : une composante légère borde plusieurs durs, ce qui n'est pas une relation entre deux polygones. Pas de helper `sharedLength` ici — il n'aurait aucun appelant.

- [ ] **Step 1: Écrire les tests**

`tests/geometry/edges.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { edgeKey, segmentLength, buildEdgeIndex } from '../../src/geometry/edges';
import type { Poly } from '../../src/geometry/types';

const carre = (id: number, x0: number, y0: number, type: Poly['type'] = '01'): Poly => ({
  id, type, holes: [],
  outer: [[x0, y0], [x0 + 0.001, y0], [x0 + 0.001, y0 + 0.001], [x0, y0 + 0.001], [x0, y0]],
});

describe('edgeKey', () => {
  it('est indépendante du sens de parcours', () => {
    expect(edgeKey([1, 2], [3, 4])).toBe(edgeKey([3, 4], [1, 2]));
  });

  it('distingue deux arêtes différentes', () => {
    expect(edgeKey([1, 2], [3, 4])).not.toBe(edgeKey([1, 2], [3, 5]));
  });
});

describe('segmentLength', () => {
  it('mesure un degré de latitude à environ 111 km', () => {
    expect(segmentLength([0, 0], [0, 1])).toBeCloseTo(111320, -2);
  });

  it('rétrécit un degré de longitude avec la latitude', () => {
    const equateur = segmentLength([0, 0], [1, 0]);
    const nord = segmentLength([0, 60], [1, 60]);
    expect(nord).toBeLessThan(equateur * 0.55);
  });
});

describe('buildEdgeIndex', () => {
  it('rattache une arête partagée à ses deux polygones', () => {
    const a = carre(0, 0, 0);
    const b = carre(1, 0.001, 0);           // accolé à droite de a
    const idx = buildEdgeIndex([a, b]);
    const partagee = edgeKey([0.001, 0], [0.001, 0.001]);
    expect(idx.get(partagee)).toEqual([0, 1]);
  });

  it('laisse les arêtes de bord avec un seul propriétaire', () => {
    const idx = buildEdgeIndex([carre(0, 0, 0)]);
    for (const owners of idx.values()) expect(owners).toHaveLength(1);
  });

  it('n’associe pas deux polygones qui ne se touchent que par un coin', () => {
    // un contact ponctuel ne partage aucune arête : chaque clé garde un seul propriétaire
    const idx = buildEdgeIndex([carre(0, 0, 0), carre(1, 0.001, 0.001)]);
    for (const owners of idx.values()) expect(owners).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/geometry/edges.test.ts`
Expected: FAIL — `Cannot find module '../../src/geometry/edges'`.

- [ ] **Step 3: Implémenter**

`src/geometry/types.ts` : le bloc de types donné dans les Global Constraints.

`src/geometry/edges.ts` :

```ts
import type { LonLat, Poly } from './types';

const METRES_PAR_DEGRE_LAT = 111320;

const vertexKey = (p: LonLat): string => `${p[0]},${p[1]}`;

export function edgeKey(a: LonLat, b: LonLat): string {
  const p = vertexKey(a);
  const q = vertexKey(b);
  return p < q ? `${p}/${q}` : `${q}/${p}`;
}

export function segmentLength(a: LonLat, b: LonLat): number {
  const dx = (b[0] - a[0]) * METRES_PAR_DEGRE_LAT * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * METRES_PAR_DEGRE_LAT;
  return Math.hypot(dx, dy);
}

function* edges(poly: Poly): Generator<[LonLat, LonLat]> {
  const r = poly.outer;
  for (let i = 0; i < r.length - 1; i++) yield [r[i]!, r[i + 1]!];
}

export function buildEdgeIndex(polys: Poly[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const poly of polys) {
    for (const [a, b] of edges(poly)) {
      const key = edgeKey(a, b);
      const owners = index.get(key);
      if (owners) owners.push(poly.id);
      else index.set(key, [poly.id]);
    }
  }
  return index;
}

```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/geometry/edges.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/types.ts src/geometry/edges.ts tests/geometry/edges.test.ts
git commit -m "feat(geometry): index des aretes partagees et longueur de frontiere"
```

---

## Task 5: Composantes légères et propriétaires

**Files:**
- Create: `src/geometry/components.ts`
- Test: `tests/geometry/components.test.ts`

**Interfaces:**
- Consumes: `edgeKey`, `segmentLength`, `buildEdgeIndex` (Task 4) ; `Poly` (Task 4)
- Produces:
```ts
export interface LightComponent { members: number[]; ownerId: number | null; contacts: Map<number, number>; }
export function lightComponents(polys: Poly[], index: Map<string, number[]>): LightComponent[];
export function absorptionMap(components: LightComponent[]): Map<number, number[]>;  // ancre -> légers absorbés
```

- [ ] **Step 1: Écrire les tests**

`tests/geometry/components.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { buildEdgeIndex } from '../../src/geometry/edges';
import { lightComponents, absorptionMap } from '../../src/geometry/components';
import type { Poly } from '../../src/geometry/types';
import fixtures from '../fixtures/angers.json';

// rectangle allant de x0 à x1, de y0 à y1
const rect = (id: number, type: Poly['type'], x0: number, y0: number, x1: number, y1: number): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

const analyse = (polys: Poly[]) => lightComponents(polys, buildEdgeIndex(polys));

describe('lightComponents', () => {
  it('regroupe deux légers accolés dans une seule composante', () => {
    const polys = [
      rect(0, '02', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    const comps = analyse(polys);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.members.sort()).toEqual([0, 1]);
  });

  it('laisse un léger isolé sans propriétaire', () => {
    const comps = analyse([rect(0, '02', 0, 0, 0.001, 0.001)]);
    expect(comps[0]!.ownerId).toBeNull();
  });

  it('attribue un léger au seul dur adjacent', () => {
    const polys = [
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    expect(analyse(polys)[0]!.ownerId).toBe(0);
  });

  it('attribue au dur avec la plus longue frontière partagée', () => {
    // Le PCI est topologiquement propre : deux polygones adjacents partagent des
    // segments identiques. Le léger porte donc un sommet intermédiaire en (0.002, 0.0004)
    // pour que son bord droit corresponde exactement à celui du petit dur.
    const leger: Poly = {
      id: 1, type: '02', holes: [],
      outer: [[0.001, 0], [0.002, 0], [0.002, 0.0004], [0.002, 0.001],
              [0.001, 0.001], [0.001, 0]],
    };
    const polys = [
      rect(0, '01', 0, 0, 0.001, 0.001),          // borde le léger sur 0.001° (~111 m)
      leger,
      rect(2, '01', 0.002, 0, 0.003, 0.0004),     // ne le borde que sur 0.0004° (~44 m)
    ];
    const comp = analyse(polys)[0]!;
    expect(comp.contacts.size).toBe(2);
    expect(comp.ownerId).toBe(0);
  });

  it('départage une égalité par le plus petit identifiant', () => {
    const polys = [
      rect(5, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
      rect(3, '01', 0.002, 0, 0.003, 0.001),
    ];
    expect(analyse(polys)[0]!.ownerId).toBe(3);
  });

  it('traite un 03 comme un bâtiment porteur, jamais comme un appendice', () => {
    const polys = [
      rect(0, '03', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    const comps = analyse(polys);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.members).toEqual([1]);
    expect(comps[0]!.ownerId).toBe(0);
  });

  it('ne fusionne jamais deux durs mitoyens', () => {
    const polys = fixtures.rangeeMitoyenne.polys as Poly[];
    const comps = analyse(polys);
    for (const c of comps) {
      for (const m of c.members) {
        expect(polys.find(p => p.id === m)!.type).toBe('02');
      }
    }
  });

  it('attribue le porche partagé à un seul dur, en signalant deux contacts', () => {
    const polys = fixtures.porchePartage.polys as Poly[];
    const comps = analyse(polys);
    const ambigue = comps.find(c => c.contacts.size >= 2);
    expect(ambigue).toBeDefined();
    expect(ambigue!.ownerId).not.toBeNull();
  });
});

describe('absorptionMap', () => {
  it('range les légers sous leur ancre et ignore les orphelins', () => {
    const polys = [
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
      rect(2, '02', 1, 1, 1.001, 1.001),
    ];
    const map = absorptionMap(analyse(polys));
    expect(map.get(0)).toEqual([1]);
    expect([...map.keys()]).toEqual([0]);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/geometry/components.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/geometry/components.ts` :

```ts
import { edgeKey, segmentLength } from './edges';
import type { Poly } from './types';

export interface LightComponent {
  members: number[];
  ownerId: number | null;
  contacts: Map<number, number>;   // id du dur -> longueur cumulée partagée
}

const isHard = (p: Poly): boolean => p.type === '01' || p.type === '03';

export function lightComponents(polys: Poly[], index: Map<string, number[]>): LightComponent[] {
  const byId = new Map(polys.map(p => [p.id, p]));
  const light = polys.filter(p => p.type === '02');

  // union-find sur les légers reliés par une arête partagée
  const parent = new Map<number, number>(light.map(p => [p.id, p.id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const owners of index.values()) {
    const legers = owners.filter(id => byId.get(id)?.type === '02');
    for (let i = 1; i < legers.length; i++) unite(legers[0]!, legers[i]!);
  }

  const groups = new Map<number, number[]>();
  for (const p of light) {
    const root = find(p.id);
    const g = groups.get(root);
    if (g) g.push(p.id);
    else groups.set(root, [p.id]);
  }

  const components: LightComponent[] = [];
  for (const members of groups.values()) {
    const inComponent = new Set(members);
    const contacts = new Map<number, number>();
    for (const id of members) {
      const poly = byId.get(id)!;
      const r = poly.outer;
      for (let k = 0; k < r.length - 1; k++) {
        const a = r[k]!, b = r[k + 1]!;
        for (const other of index.get(edgeKey(a, b)) ?? []) {
          if (inComponent.has(other)) continue;
          const op = byId.get(other);
          if (!op || !isHard(op)) continue;
          contacts.set(other, (contacts.get(other) ?? 0) + segmentLength(a, b));
        }
      }
    }
    let ownerId: number | null = null;
    let best = -1;
    for (const id of [...contacts.keys()].sort((x, y) => x - y)) {
      const len = contacts.get(id)!;
      if (len > best) { best = len; ownerId = id; }
    }
    components.push({ members: members.sort((a, b) => a - b), ownerId, contacts });
  }
  return components;
}

export function absorptionMap(components: LightComponent[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const c of components) {
    if (c.ownerId === null) continue;
    const list = map.get(c.ownerId);
    if (list) list.push(...c.members);
    else map.set(c.ownerId, [...c.members]);
  }
  return map;
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/geometry/components.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/components.ts tests/geometry/components.test.ts
git commit -m "feat(geometry): composantes legeres et attribution par plus longue frontiere"
```

---

## Task 6: Union topologique

Le cœur du produit. Mesuré sur Angers : 99,20 % d'unions propres, 0 partie multiple, 76 pincements, 55 trous.

**Files:**
- Create: `src/geometry/union.ts`
- Test: `tests/geometry/union.test.ts`

**Interfaces:**
- Consumes: `edgeKey` (Task 4), `Poly`, `Ring`
- Produces:
```ts
export type UnionResult =
  | { ok: true; ring: Ring }
  | { ok: false; reason: 'pincement' | 'trou' | 'parties-multiples' | 'vide' };
export function topologicalUnion(polys: Poly[]): UnionResult;
export function ringArea(ring: Ring): number;              // aire signée, degrés²
export function pointInRing(pt: LonLat, ring: Ring): boolean;
```

- [ ] **Step 1: Écrire les tests**

`tests/geometry/union.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { topologicalUnion, ringArea, pointInRing } from '../../src/geometry/union';
import type { Poly, Ring } from '../../src/geometry/types';

const rect = (id: number, x0: number, y0: number, x1: number, y1: number, type: Poly['type'] = '01'): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

const bbox = (ring: Ring) => {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe('pointInRing', () => {
  it('reconnaît un point intérieur et un point extérieur', () => {
    const r = rect(0, 0, 0, 2, 2).outer;
    expect(pointInRing([1, 1], r)).toBe(true);
    expect(pointInRing([3, 1], r)).toBe(false);
  });
});

describe('ringArea', () => {
  it('mesure l’aire d’un carré unité', () => {
    expect(Math.abs(ringArea(rect(0, 0, 0, 1, 1).outer))).toBeCloseTo(1, 10);
  });
});

describe('topologicalUnion', () => {
  it('rend un polygone seul inchangé', () => {
    const p = rect(0, 0, 0, 1, 1);
    const u = topologicalUnion([p]);
    expect(u.ok).toBe(true);
    if (u.ok) expect(bbox(u.ring)).toEqual([0, 0, 1, 1]);
  });

  it('fusionne deux rectangles accolés en un seul anneau', () => {
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 1, 0, 2, 1)]);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(bbox(u.ring)).toEqual([0, 0, 2, 1]);
      // l’arête interne a disparu : plus aucun sommet en x=1 à l’intérieur du bord supérieur
      expect(u.ring.filter(p => p[0] === 1)).toHaveLength(2);
    }
  });

  it('ferme l’anneau produit', () => {
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 1, 0, 2, 1)]);
    if (u.ok) expect(u.ring[0]).toEqual(u.ring[u.ring.length - 1]);
  });

  it('refuse deux polygones disjoints', () => {
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 5, 5, 6, 6)]);
    expect(u).toEqual({ ok: false, reason: 'parties-multiples' });
  });

  it('refuse une union qui enferme une cour', () => {
    // Les huit cellules unité entourant un vide central. Des cellules unité garantissent
    // des arêtes exactement partagées — condition de l'union topologique, et propriété
    // réelle du PCI. Quatre barres larges ne conviendraient pas : leurs longs côtés ne
    // correspondraient pas segment pour segment aux petits côtés voisins.
    const cellules = [];
    let id = 0;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        if (!(i === 1 && j === 1)) cellules.push(rect(id++, i, j, i + 1, j + 1));

    const u = topologicalUnion(cellules);
    expect(u).toEqual({ ok: false, reason: 'trou' });
  });

  it('refuse un pincement', () => {
    // deux carrés ne se touchant que par un sommet : le sommet commun porte 4 arêtes de bord
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 1, 1, 2, 2)]);
    expect(u).toEqual({ ok: false, reason: 'pincement' });
  });

  it('refuse un ensemble vide', () => {
    expect(topologicalUnion([])).toEqual({ ok: false, reason: 'vide' });
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/geometry/union.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/geometry/union.ts` :

```ts
import { edgeKey } from './edges';
import type { LonLat, Poly, Ring } from './types';

export type UnionResult =
  | { ok: true; ring: Ring }
  | { ok: false; reason: 'pincement' | 'trou' | 'parties-multiples' | 'vide' };

const vertexKey = (p: LonLat): string => `${p[0]},${p[1]}`;

export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export function pointInRing(pt: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function topologicalUnion(polys: Poly[]): UnionResult {
  if (polys.length === 0) return { ok: false, reason: 'vide' };

  // une arête présente deux fois dans l'ensemble est interne : elle disparaît
  const count = new Map<string, number>();
  for (const poly of polys) {
    const r = poly.outer;
    for (let i = 0; i < r.length - 1; i++) {
      const k = edgeKey(r[i]!, r[i + 1]!);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }

  const adjacency = new Map<string, string[]>();
  const coords = new Map<string, LonLat>();
  for (const poly of polys) {
    const r = poly.outer;
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i]!, b = r[i + 1]!;
      if (count.get(edgeKey(a, b)) !== 1) continue;
      const ka = vertexKey(a), kb = vertexKey(b);
      coords.set(ka, a); coords.set(kb, b);
      (adjacency.get(ka) ?? adjacency.set(ka, []).get(ka)!).push(kb);
      (adjacency.get(kb) ?? adjacency.set(kb, []).get(kb)!).push(ka);
    }
  }

  if (adjacency.size === 0) return { ok: false, reason: 'vide' };
  for (const neighbours of adjacency.values()) {
    if (neighbours.length !== 2) return { ok: false, reason: 'pincement' };
  }

  // recoudre les arêtes de bord en anneaux
  const rings: Ring[] = [];
  const seen = new Set<string>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const keys = [start];
    seen.add(start);
    let previous: string | null = null;
    let current = start;
    for (;;) {
      const [a, b] = adjacency.get(current)! as [string, string];
      const next = a === previous ? b : a;
      if (next === start) break;
      if (seen.has(next)) return { ok: false, reason: 'pincement' };
      seen.add(next);
      keys.push(next);
      previous = current;
      current = next;
    }
    const ring = keys.map(k => coords.get(k)!);
    ring.push(ring[0]!);
    rings.push(ring);
  }

  if (rings.length === 1) return { ok: true, ring: rings[0]! };

  const largest = rings.reduce((a, b) => (Math.abs(ringArea(a)) >= Math.abs(ringArea(b)) ? a : b));
  const nested = rings.every(r => r === largest || pointInRing(r[0]!, largest));
  return { ok: false, reason: nested ? 'trou' : 'parties-multiples' };
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/geometry/union.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/union.ts tests/geometry/union.test.ts
git commit -m "feat(geometry): union topologique exacte des batiments cadastre"
```

---

## Task 7: Nettoyage et simplification

**Files:**
- Create: `src/geometry/clean.ts`
- Test: `tests/geometry/clean.test.ts`

**Interfaces:**
- Consumes: `segmentLength` (Task 4), `ringArea` (Task 6)
- Produces:
```ts
export function isDegenerate(ring: Ring): boolean;
export function dropCollinear(ring: Ring, toleranceM?: number): Ring;   // défaut 0.02 m
export function simplify(ring: Ring, toleranceM?: number): Ring;        // Douglas-Peucker, défaut 0.20 m
```

**Choix des valeurs par défaut.** `dropCollinear` à 2 cm supprime les sommets réellement alignés, apparus aux coutures, sans toucher à un vrai décrochement. `simplify` à 20 cm reste bien en deçà de la précision du cadastre. Les deux sont réglables ; ces défauts sont à confirmer à l'usage (spec §10.6).

> **Correction post-revue (2026-09-23) — défaut sérieux.** L'implémentation de `dropCollinear` donnée au Step 3 est **fausse**, et le code livré en diffère. Elle compare chaque sommet au segment joignant ses voisins, mais prend comme voisin précédent le dernier sommet *conservé* et comme suivant le sommet *original* : la ligne de référence dérive donc à mesure que des sommets disparaissent, et l'erreur se compose au lieu de rester bornée par la tolérance.
>
> Ce n'est pas théorique. Exécutée sur les 50 989 anneaux réels d'Angers, cette version modifie 44,5 % des anneaux et déplace le contour de **727 cm au maximum**, avec 22 anneaux au-delà de 20 cm — donc au-delà de ce que la simplification en aval s'autorise, qui ne les masque pas. Une fonction à tolérance 2 cm déplaçait des bâtiments de sept mètres.
>
> Le code livré délègue à la même routine Douglas-Peucker que `simplify`, avec sa propre tolérance. Douglas-Peucker garantit **par construction** ce que le test local ne pouvait pas : tout sommet supprimé reste à moins de la tolérance du contour retenu. Les deux fonctions exportées, leurs signatures et leurs tolérances restent distinctes — elles servent des usages distincts, `dropCollinear` tournant même si la simplification est désactivée.
>
> Leçon pour le reste du plan : un test de proximité local ne borne pas l'erreur globale d'une suppression en cascade. Partout où le plan supprime des points par un critère local, la même question se pose.

- [ ] **Step 1: Écrire les tests**

`tests/geometry/clean.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { isDegenerate, dropCollinear, simplify } from '../../src/geometry/clean';
import type { Ring } from '../../src/geometry/types';

const ferme = (pts: Ring): Ring => [...pts, pts[0]!];

describe('isDegenerate', () => {
  it('rejette un anneau de moins de trois sommets distincts', () => {
    expect(isDegenerate(ferme([[0, 0], [1, 0]]))).toBe(true);
  });

  it('rejette un anneau d’aire nulle', () => {
    expect(isDegenerate(ferme([[0, 0], [1, 0], [2, 0]]))).toBe(true);
  });

  it('accepte un triangle', () => {
    expect(isDegenerate(ferme([[0, 0], [0.001, 0], [0, 0.001]]))).toBe(false);
  });
});

describe('dropCollinear', () => {
  it('supprime un sommet aligné au milieu d’un côté', () => {
    const avec = ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(dropCollinear(avec)).toHaveLength(5);   // 4 sommets + fermeture
  });

  it('conserve un décrochement réel', () => {
    const marche = ferme([[0, 0], [0.001, 0], [0.001, 0.0005], [0.002, 0.0005], [0.002, 0.001], [0, 0.001]]);
    expect(dropCollinear(marche)).toHaveLength(marche.length);
  });

  it('rend un anneau toujours fermé', () => {
    const r = dropCollinear(ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]));
    expect(r[0]).toEqual(r[r.length - 1]);
  });
});

describe('simplify', () => {
  it('efface une déviation inférieure à la tolérance', () => {
    // sommet médian dévié d’environ 5 cm
    const r = ferme([[0, 0], [0.0005, 0.0000004], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(simplify(r, 0.2).length).toBeLessThan(r.length);
  });

  it('conserve une déviation supérieure à la tolérance', () => {
    // sommet médian dévié d’environ 2 m
    const r = ferme([[0, 0], [0.0005, 0.000018], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(simplify(r, 0.2)).toHaveLength(r.length);
  });

  it('ne descend jamais sous un triangle', () => {
    const r = ferme([[0, 0], [0.000001, 0], [0.0000005, 0.0000005]]);
    expect(simplify(r, 100).length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/geometry/clean.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/geometry/clean.ts` :

```ts
import { segmentLength } from './edges';
import { ringArea } from './union';
import type { LonLat, Ring } from './types';

/** distance du point p au segment [a,b], en mètres */
function distanceToSegment(p: LonLat, a: LonLat, b: LonLat): number {
  const len = segmentLength(a, b);
  if (len === 0) return segmentLength(p, a);
  const lat = (a[1] * Math.PI) / 180;
  const sx = Math.cos(lat);
  const ax = a[0] * sx, bx = b[0] * sx, px = p[0] * sx;
  const t = ((px - ax) * (bx - ax) + (p[1] - a[1]) * (b[1] - a[1])) /
            ((bx - ax) ** 2 + (b[1] - a[1]) ** 2);
  const clamped = Math.max(0, Math.min(1, t));
  const proj: LonLat = [a[0] + clamped * (b[0] - a[0]), a[1] + clamped * (b[1] - a[1])];
  return segmentLength(p, proj);
}

export function isDegenerate(ring: Ring): boolean {
  const distinct = new Set(ring.slice(0, -1).map(p => `${p[0]},${p[1]}`));
  if (distinct.size < 3) return true;
  return Math.abs(ringArea(ring)) === 0;
}

export function dropCollinear(ring: Ring, toleranceM = 0.02): Ring {
  const open = ring.slice(0, -1);
  const kept: LonLat[] = [];
  for (let i = 0; i < open.length; i++) {
    const prev = kept.length > 0 ? kept[kept.length - 1]! : open[(i - 1 + open.length) % open.length]!;
    const next = open[(i + 1) % open.length]!;
    if (distanceToSegment(open[i]!, prev, next) > toleranceM) kept.push(open[i]!);
  }
  if (kept.length < 3) return ring;
  return [...kept, kept[0]!];
}

export function simplify(ring: Ring, toleranceM = 0.2): Ring {
  const open = ring.slice(0, -1);
  if (open.length <= 3) return ring;

  const keep = new Set<number>([0]);
  const recurse = (first: number, last: number): void => {
    let worst = -1;
    let worstDist = toleranceM;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(open[i]!, open[first]!, open[last]!);
      if (d > worstDist) { worstDist = d; worst = i; }
    }
    if (worst === -1) return;
    keep.add(worst);
    recurse(first, worst);
    recurse(worst, last);
  };
  // anneau fermé : on le coupe en deux chaînes autour du sommet le plus éloigné du départ
  let far = 1;
  let farDist = -1;
  for (let i = 1; i < open.length; i++) {
    const d = segmentLength(open[0]!, open[i]!);
    if (d > farDist) { farDist = d; far = i; }
  }
  keep.add(far);
  recurse(0, far);
  recurse(far, open.length - 1);
  keep.add(open.length - 1);

  const kept = [...keep].sort((a, b) => a - b).map(i => open[i]!);
  if (kept.length < 3) return ring;
  return [...kept, kept[0]!];
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/geometry/clean.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/clean.ts tests/geometry/clean.test.ts
git commit -m "feat(geometry): degenerescence, sommets colineaires et simplification"
```

---

## Task 8: Règle de composition

Assemble les étapes 1 à 6 de la spec §5. **C'est la fonction unique qu'appellent l'aperçu et le clic.**

**Files:**
- Create: `src/compose.ts`
- Test: `tests/compose.test.ts`

**Interfaces:**
- Consumes: Tasks 4-7
- Produces:
```ts
export interface ComposeInput {
  polys: Poly[];
  edgeIndex: Map<string, number[]>;
  absorption: Map<number, number[]>;
  /** test d'appartenance indexé ; à défaut, balayage linéaire (acceptable en test seulement) */
  polyAt?: (pt: LonLat) => Poly | null;
  simplifyToleranceM?: number;
}
export type RefusalReason =
  | 'aucun-batiment' | 'trou-source' | 'degenere'
  | 'pincement' | 'trou' | 'parties-multiples' | 'vide';
export type Composition =
  | { ok: true; ring: Ring; anchorId: number; absorbed: number[]; isolatedLight: boolean }
  | { ok: false; reason: RefusalReason };
export function composeAt(pt: LonLat, input: ComposeInput): Composition;
export function composeFor(anchorId: number, input: ComposeInput): Composition;
```

- [ ] **Step 1: Écrire les tests**

`tests/compose.test.ts` :

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildEdgeIndex } from '../src/geometry/edges';
import { lightComponents, absorptionMap } from '../src/geometry/components';
import { composeAt, composeFor } from '../src/compose';
import type { Poly } from '../src/geometry/types';
import fixtures from './fixtures/angers.json';

const rect = (id: number, type: Poly['type'], x0: number, y0: number, x1: number, y1: number): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

const prepare = (polys: Poly[]) => {
  const edgeIndex = buildEdgeIndex(polys);
  return { polys, edgeIndex, absorption: absorptionMap(lightComponents(polys, edgeIndex)) };
};

describe('composeAt', () => {
  it('ne rend rien hors de tout bâtiment', () => {
    const input = prepare([rect(0, '01', 0, 0, 0.001, 0.001)]);
    expect(composeAt([5, 5], input)).toEqual({ ok: false, reason: 'aucun-batiment' });
  });

  it('absorbe le porche quand on clique la maison', () => {
    const input = prepare([
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.anchorId).toBe(0);
      expect(r.absorbed).toEqual([1]);
      expect(Math.max(...r.ring.map(p => p[0]))).toBeCloseTo(0.002, 10);
    }
  });

  it('donne le même bâtiment qu’on clique la maison ou le porche', () => {
    const input = prepare([
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ]);
    const parMaison = composeAt([0.0005, 0.0005], input);
    const parPorche = composeAt([0.0015, 0.0005], input);
    expect(parPorche).toEqual(parMaison);
  });

  it('crée seule une construction légère isolée et la signale comme telle', () => {
    const input = prepare([rect(0, '02', 0, 0, 0.001, 0.001)]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isolatedLight).toBe(true);
      expect(r.absorbed).toEqual([]);
    }
  });

  it('ne fusionne jamais deux durs mitoyens', () => {
    const input = prepare([
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '01', 0.001, 0, 0.002, 0.001),
    ]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absorbed).toEqual([]);
      expect(Math.max(...r.ring.map(p => p[0]))).toBeCloseTo(0.001, 10);
    }
  });

  it('refuse une géométrie source à trou', () => {
    // On vise l'ancre par son identifiant : partir d'un point serait indéterminé
    // (un sommet n'est ni franchement dedans ni franchement dehors).
    const polys = fixtures.avecTrou.polys as Poly[];
    const troue = polys.find(p => p.holes.length > 0)!;
    expect(composeFor(troue.id, prepare(polys))).toEqual({ ok: false, reason: 'trou-source' });
  });

  it('refuse un anneau dégénéré', () => {
    // Anneau synthétique : il n'existe aucun polygone d'aire nulle dans les données
    // réelles. La garde protège contre les autres communes et contre une sortie
    // d'union ou de simplification dégradée.
    const plat: Poly = { id: 0, type: '01', holes: [], outer: [[0, 0], [0.001, 0], [0.002, 0], [0, 0]] };
    expect(composeFor(0, prepare([plat]))).toEqual({ ok: false, reason: 'degenere' });
  });

  it('accepte le plus petit bâtiment réel du fichier', () => {
    // ~0,02 m² : absurde comme bâtiment, mais géométriquement valide. La garde de
    // dégénérescence ne doit pas le rejeter — sinon elle rejetterait du bâti réel.
    const polys = fixtures.minuscule.polys as Poly[];
    expect(composeFor(polys[0]!.id, prepare(polys)).ok).toBe(true);
  });

  it('utilise l’index spatial quand on le lui fournit', () => {
    const polys = [rect(0, '01', 0, 0, 0.001, 0.001)];
    const polyAt = vi.fn().mockReturnValue(polys[0]);
    const r = composeAt([0.0005, 0.0005], { ...prepare(polys), polyAt });
    expect(polyAt).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/compose.test.ts`
Expected: FAIL — module introuvable.

> **Corrections post-revue (2026-09-23).** Deux défauts du bloc ci-dessous, rattrapés à l'implémentation :
>
> 1. `ComposeInput` omettait `polyAt` dans ce bloc alors qu'il figurait dans les interfaces de la tâche et que `hit()` le lit — le code ne compilait pas sous `strict`. Corrigé ci-dessous.
> 2. Les tests du Step 1 n'exerçaient `trou-source` que par un polygone qui est lui-même l'ancre trouée. Le cas que la tâche réclame explicitement — un **membre absorbé** troué alors que l'ancre est saine — n'était couvert par aucun test, alors que c'est précisément lui qui honore le contrat de `union.ts`. Un test a été ajouté et vérifié par mutation : une garde qui ne regarderait que `anchor.holes` passe les tests du plan et échoue sur celui-là.

- [ ] **Step 3: Implémenter**

`src/compose.ts` :

```ts
import { dropCollinear, isDegenerate, simplify } from './geometry/clean';
import { pointInRing, topologicalUnion } from './geometry/union';
import type { LonLat, Poly, Ring } from './geometry/types';

export interface ComposeInput {
  polys: Poly[];
  edgeIndex: Map<string, number[]>;
  absorption: Map<number, number[]>;
  /** test d'appartenance indexé ; à défaut, balayage linéaire (acceptable en test seulement) */
  polyAt?: (pt: LonLat) => Poly | null;
  simplifyToleranceM?: number;
}

export type RefusalReason =
  | 'aucun-batiment' | 'trou-source' | 'degenere'
  | 'pincement' | 'trou' | 'parties-multiples' | 'vide';

export type Composition =
  | { ok: true; ring: Ring; anchorId: number; absorbed: number[]; isolatedLight: boolean }
  | { ok: false; reason: RefusalReason };

const isHard = (p: Poly): boolean => p.type === '01' || p.type === '03';

function hit(pt: LonLat, input: ComposeInput): Poly | null {
  if (input.polyAt) return input.polyAt(pt);
  for (const p of input.polys) if (pointInRing(pt, p.outer)) return p;
  return null;
}

/** ancre d'un polygone : lui-même s'il est porteur, sinon le propriétaire de sa composante */
function anchorOf(poly: Poly, input: ComposeInput): number {
  if (isHard(poly)) return poly.id;
  for (const [ownerId, members] of input.absorption) {
    if (members.includes(poly.id)) return ownerId;
  }
  return poly.id;      // léger isolé : il est sa propre ancre
}

export function composeFor(anchorId: number, input: ComposeInput): Composition {
  const byId = new Map(input.polys.map(p => [p.id, p]));
  const anchor = byId.get(anchorId);
  if (!anchor) return { ok: false, reason: 'aucun-batiment' };

  const absorbed = input.absorption.get(anchorId) ?? [];
  const members = [anchor, ...absorbed.map(id => byId.get(id)!).filter(Boolean)];

  if (members.some(p => p.holes.length > 0)) return { ok: false, reason: 'trou-source' };
  if (members.some(p => isDegenerate(p.outer))) return { ok: false, reason: 'degenere' };

  const united = topologicalUnion(members);
  if (!united.ok) return { ok: false, reason: united.reason };

  const cleaned = simplify(dropCollinear(united.ring), input.simplifyToleranceM);
  if (isDegenerate(cleaned)) return { ok: false, reason: 'degenere' };

  return {
    ok: true,
    ring: cleaned,
    anchorId,
    absorbed: [...absorbed].sort((a, b) => a - b),
    isolatedLight: !isHard(anchor),
  };
}

export function composeAt(pt: LonLat, input: ComposeInput): Composition {
  const poly = hit(pt, input);
  if (!poly) return { ok: false, reason: 'aucun-batiment' };
  if (poly.holes.length > 0) return { ok: false, reason: 'trou-source' };
  return composeFor(anchorOf(poly, input), input);
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/compose.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compose.ts tests/compose.test.ts
git commit -m "feat: regle de composition du batiment, partagee par l'apercu et le clic"
```

---

## Task 9: Tags

**Files:**
- Create: `src/tagging/tags.ts`
- Test: `tests/tagging/tags.test.ts`

**Interfaces:**
- Consumes: `Composition` (Task 8)
- Produces:
```ts
export interface TagInput { isolatedLight: boolean; millesime: string; }
export function buildingTags(input: TagInput): Record<string, string>;
export function changesetComment(commune: string): string;
```

- [ ] **Step 1: Écrire les tests**

`tests/tagging/tags.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { buildingTags, changesetComment } from '../../src/tagging/tags';

describe('buildingTags', () => {
  it('pose building=yes et la source verbatim avec le millésime', () => {
    expect(buildingTags({ isolatedLight: false, millesime: '2026' })).toEqual({
      building: 'yes',
      source: 'cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : 2026',
    });
  });

  it('ajoute wall=no sur une construction légère isolée', () => {
    const tags = buildingTags({ isolatedLight: true, millesime: '2026' });
    expect(tags.wall).toBe('no');
    expect(tags.building).toBe('yes');
  });

  it('n’ajoute jamais wall=no sur une union maison + porche', () => {
    expect(buildingTags({ isolatedLight: false, millesime: '2026' }).wall).toBeUndefined();
  });

  it('refuse un millésime absent plutôt que d’en inventer un', () => {
    expect(() => buildingTags({ isolatedLight: false, millesime: '' })).toThrow(/millésime/i);
  });
});

describe('changesetComment', () => {
  it('nomme la commune et le cadastre', () => {
    const c = changesetComment('Angers');
    expect(c).toContain('cadastre');
    expect(c).toContain('Angers');
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/tagging/tags.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/tagging/tags.ts` :

```ts
export interface TagInput {
  isolatedLight: boolean;
  millesime: string;
}

const SOURCE_PREFIX =
  'cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : ';

export function buildingTags(input: TagInput): Record<string, string> {
  if (!input.millesime) {
    throw new Error('millésime absent : il doit venir du jeu Etalab téléchargé');
  }
  const tags: Record<string, string> = {
    building: 'yes',
    source: SOURCE_PREFIX + input.millesime,
  };
  if (input.isolatedLight) tags.wall = 'no';
  return tags;
}

export function changesetComment(commune: string): string {
  return `Bâtiments depuis le cadastre (${commune})`;
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/tagging/tags.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tagging/tags.ts tests/tagging/tags.test.ts
git commit -m "feat(tagging): tags de batiment conformes a la Licence Ouverte"
```

---

## Task 10: Résolution du code INSEE

**Files:**
- Create: `src/cadastre/insee.ts`
- Test: `tests/cadastre/insee.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Commune { code: string; nom: string; }
export function departementOf(insee: string): string;         // gère la Corse et l'outre-mer
export function arrondissementCodes(insee: string): string[]; // Paris, Lyon, Marseille
export async function communeAt(lat: number, lon: number, fetchFn?: typeof fetch): Promise<Commune | null>;
```

- [ ] **Step 1: Écrire les tests**

`tests/cadastre/insee.test.ts` :

```ts
import { describe, it, expect, vi } from 'vitest';
import { departementOf, arrondissementCodes, communeAt } from '../../src/cadastre/insee';

describe('departementOf', () => {
  it('prend les deux premiers chiffres en métropole', () => {
    expect(departementOf('49007')).toBe('49');
  });

  it('gère la Corse', () => {
    expect(departementOf('2A004')).toBe('2A');
    expect(departementOf('2B033')).toBe('2B');
  });

  it('prend trois caractères en outre-mer', () => {
    expect(departementOf('97411')).toBe('974');
  });
});

describe('arrondissementCodes', () => {
  it('éclate Paris en vingt arrondissements', () => {
    const codes = arrondissementCodes('75056');
    expect(codes).toHaveLength(20);
    expect(codes[0]).toBe('75101');
    expect(codes[19]).toBe('75120');
  });

  it('éclate Lyon en neuf et Marseille en seize', () => {
    expect(arrondissementCodes('69123')).toHaveLength(9);
    expect(arrondissementCodes('13055')).toHaveLength(16);
  });

  it('rend le code tel quel pour une commune ordinaire', () => {
    expect(arrondissementCodes('49007')).toEqual(['49007']);
  });
});

describe('communeAt', () => {
  it('rend la commune trouvée', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ code: '49007', nom: 'Angers' }],
    }) as unknown as typeof fetch;
    await expect(communeAt(47.4784, -0.5632, fetchFn)).resolves.toEqual({ code: '49007', nom: 'Angers' });
  });

  it('rend null hors couverture', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as unknown as typeof fetch;
    await expect(communeAt(0, 0, fetchFn)).resolves.toBeNull();
  });

  it('propage une panne réseau plutôt que de la masquer', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    await expect(communeAt(47, -0.5, fetchFn)).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/cadastre/insee.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/cadastre/insee.ts` :

```ts
export interface Commune { code: string; nom: string; }

// Codes vérifiés contre le jeu Etalab vivant le 2026-09-23.
// Piège : les arrondissements de Lyon ne sont PAS contigus à son code commune.
const ARRONDISSEMENTS: Record<string, { first: number; count: number }> = {
  '75056': { first: 75101, count: 20 },   // Paris
  '69123': { first: 69381, count: 9 },    // Lyon
  '13055': { first: 13201, count: 16 },   // Marseille
};

export function departementOf(insee: string): string {
  if (insee.startsWith('2A') || insee.startsWith('2B')) return insee.slice(0, 2);
  if (insee.startsWith('97') || insee.startsWith('98')) return insee.slice(0, 3);
  return insee.slice(0, 2);
}

export function arrondissementCodes(insee: string): string[] {
  const split = ARRONDISSEMENTS[insee];
  if (!split) return [insee];
  return Array.from({ length: split.count }, (_, i) => String(split.first + i));
}

export async function communeAt(
  lat: number,
  lon: number,
  fetchFn: typeof fetch = fetch,
): Promise<Commune | null> {
  const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=code,nom`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`geo.api.gouv.fr a répondu ${res.status}`);
  const list = (await res.json()) as Commune[];
  return list[0] ?? null;
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/cadastre/insee.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cadastre/insee.ts tests/cadastre/insee.test.ts
git commit -m "feat(cadastre): resolution du code INSEE et des arrondissements"
```

---

## Task 11: Téléchargement, millésime et cache

Le fichier est servi en `.gz` **sans** `Content-Encoding`, donc le navigateur ne le décompresse pas : c'est `DecompressionStream('gzip')` qui s'en charge. Le millésime se lit sur l'URL finale après redirection (`/etalab-cadastre/2026-06-01/`).

**Files:**
- Create: `src/cadastre/download.ts`, `src/cadastre/store.ts`
- Test: `tests/cadastre/download.test.ts`, `tests/cadastre/store.test.ts`

**Interfaces:**
- Consumes: `departementOf`, `arrondissementCodes` (Task 10)
- Produces:
```ts
// download.ts
export function datasetUrl(insee: string): string;
export function millesimeFromUrl(url: string): string;        // '2026-06-01' -> '2026'
export async function downloadCommune(insee: string, fetchFn?: typeof fetch):
  Promise<{ features: unknown[]; millesime: string }>;

// store.ts
export interface CachedCommune { insee: string; millesime: string; fetchedAt: number; features: unknown[]; }
export async function readCache(insee: string): Promise<CachedCommune | null>;
export async function writeCache(entry: CachedCommune): Promise<void>;
```

- [ ] **Step 1: Écrire les tests de téléchargement**

`tests/cadastre/download.test.ts` :

```ts
import { describe, it, expect, vi } from 'vitest';
import { datasetUrl, millesimeFromUrl, downloadCommune } from '../../src/cadastre/download';

describe('datasetUrl', () => {
  it('construit l’URL Etalab depuis le code INSEE', () => {
    expect(datasetUrl('49007')).toBe(
      'https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/49/49007/cadastre-49007-batiments.json.gz');
  });

  it('gère un code corse', () => {
    expect(datasetUrl('2A004')).toContain('/communes/2A/2A004/');
  });
});

describe('millesimeFromUrl', () => {
  it('extrait l’année du chemin daté', () => {
    expect(millesimeFromUrl('https://x/etalab-cadastre/2026-06-01/geojson/communes/49/…')).toBe('2026');
  });

  it('jette plutôt que d’inventer un millésime', () => {
    expect(() => millesimeFromUrl('https://x/etalab-cadastre/latest/geojson/…')).toThrow(/millésime/i);
  });
});

describe('downloadCommune', () => {
  const gzip = async (text: string): Promise<Uint8Array> => {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([text]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  it('décompresse le flux et rend features et millésime', async () => {
    const body = await gzip(JSON.stringify({ features: [{ a: 1 }, { a: 2 }] }));
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://cadastre.data.gouv.fr/data/etalab-cadastre/2026-06-01/geojson/communes/49/49007/x.json.gz',
      body: new Blob([body]).stream(),
    }) as unknown as typeof fetch;

    const r = await downloadCommune('49007', fetchFn);
    expect(r.features).toHaveLength(2);
    expect(r.millesime).toBe('2026');
  });

  it('signale une commune absente du jeu', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404, url: '' }) as unknown as typeof fetch;
    await expect(downloadCommune('49999', fetchFn)).rejects.toThrow(/404/);
  });

  it('recolle les vingt arrondissements pour Paris', async () => {
    const body = await gzip(JSON.stringify({ features: [{ a: 1 }] }));
    const fetchFn = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      url: url.replace('/latest/', '/2026-06-01/'),
      body: new Blob([body]).stream(),
    })) as unknown as typeof fetch;

    const r = await downloadCommune('75056', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(20);
    expect(r.features).toHaveLength(20);
    expect(r.millesime).toBe('2026');
    // c'est bien le code arrondissement qui est demandé, jamais 75056
    for (const [url] of (fetchFn as unknown as { mock: { calls: string[][] } }).mock.calls) {
      expect(url).not.toContain('75056');
    }
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/cadastre/download.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter `download.ts`**

```ts
import { arrondissementCodes, departementOf } from './insee';

const BASE = 'https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes';

export function datasetUrl(insee: string): string {
  const dep = departementOf(insee);
  return `${BASE}/${dep}/${insee}/cadastre-${insee}-batiments.json.gz`;
}

export function millesimeFromUrl(url: string): string {
  const m = /etalab-cadastre\/(\d{4})-\d{2}-\d{2}\//.exec(url);
  if (!m) throw new Error(`millésime illisible dans l'URL : ${url}`);
  return m[1]!;
}

async function downloadOne(
  insee: string,
  fetchFn: typeof fetch,
): Promise<{ features: unknown[]; millesime: string }> {
  const res = await fetchFn(datasetUrl(insee));
  if (!res.ok) throw new Error(`cadastre.data.gouv.fr a répondu ${res.status} pour ${insee}`);
  if (!res.body) throw new Error('réponse sans corps');

  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const parsed = JSON.parse(text) as { features?: unknown[] };

  return {
    features: parsed.features ?? [],
    millesime: millesimeFromUrl(res.url),
  };
}

export async function downloadCommune(
  insee: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ features: unknown[]; millesime: string }> {
  // Paris, Lyon et Marseille n'existent pas sous leur code commune dans le jeu Etalab :
  // les données sont découpées par arrondissement, et il faut donc les recoller.
  const codes = arrondissementCodes(insee);
  if (codes.length === 1) return downloadOne(insee, fetchFn);

  const parts = await Promise.all(codes.map(code => downloadOne(code, fetchFn)));
  return {
    features: parts.flatMap(part => part.features),
    millesime: parts[0]!.millesime,
  };
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/cadastre/download.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Écrire les tests de cache**

`tests/cadastre/store.test.ts` :

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readCache, writeCache } from '../../src/cadastre/store';

describe('cache des communes', () => {
  beforeEach(async () => {
    indexedDB.deleteDatabase('cadastre-id');
  });

  it('rend null pour une commune jamais téléchargée', async () => {
    await expect(readCache('49007')).resolves.toBeNull();
  });

  it('relit ce qui a été écrit', async () => {
    const entry = { insee: '49007', millesime: '2026', fetchedAt: 1, features: [{ a: 1 }] };
    await writeCache(entry);
    await expect(readCache('49007')).resolves.toEqual(entry);
  });

  it('remplace une entrée existante', async () => {
    await writeCache({ insee: '49007', millesime: '2025', fetchedAt: 1, features: [] });
    await writeCache({ insee: '49007', millesime: '2026', fetchedAt: 2, features: [{ a: 1 }] });
    const got = await readCache('49007');
    expect(got!.millesime).toBe('2026');
  });
});
```

Ajouter `fake-indexeddb` en `devDependencies` s'il n'y est pas encore (Task 2 l'a prévu).

- [ ] **Step 6: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/cadastre/store.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 7: Implémenter `store.ts`**

```ts
export interface CachedCommune {
  insee: string;
  millesime: string;
  fetchedAt: number;
  features: unknown[];
}

const DB = 'cadastre-id';
const STORE = 'communes';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'insee' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

export async function readCache(insee: string): Promise<CachedCommune | null> {
  const got = await run<CachedCommune | undefined>('readonly', s => s.get(insee));
  return got ?? null;
}

export async function writeCache(entry: CachedCommune): Promise<void> {
  await run('readwrite', s => s.put(entry));
}
```

- [ ] **Step 8: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/cadastre/store.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Commit**

```bash
git add src/cadastre/download.ts src/cadastre/store.ts tests/cadastre
git commit -m "feat(cadastre): telechargement, millesime et cache IndexedDB"
```

---

## Task 12: Jeu de données prêt à l'emploi

Transforme les features brutes en `Poly[]`, précalcule l'index des arêtes, les composantes et la table d'absorption, et fournit un index spatial pour le test au survol. Budget mesuré sur Angers : ~2 s pour le précalcul, le survol devant rester sous une frame.

**Files:**
- Create: `src/cadastre/dataset.ts`
- Test: `tests/cadastre/dataset.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 8
- Produces:
```ts
export interface Dataset {
  insee: string;
  millesime: string;
  polys: Poly[];
  edgeIndex: Map<string, number[]>;
  absorption: Map<number, number[]>;
  /** id -> polygone ; construit ici, une fois par commune */
  byId: Map<number, Poly>;
  /** id d'un léger -> sa composante entière et son propriétaire éventuel */
  lightIndex: Map<number, { ownerId: number | null; members: number[] }>;
  polyAt(pt: LonLat): Poly | null;
}
export function toPolys(features: unknown[]): Poly[];
export function buildDataset(insee: string, millesime: string, features: unknown[]): Dataset;
```

> **Ajout post-revue de la Task 8 (2026-09-23).** `byId` et `lightIndex` viennent d'un correctif de la Task 8 et **doivent être construits ici**, pas dans `composeFor`. Trois défauts s'y ramenaient : `composeFor` reconstruisait une `Map` de toute la commune à chaque appel alors que le survol l'appelle à chaque frame ; `anchorOf` balayait linéairement la table d'absorption sur le même chemin chaud ; et surtout, une composante légère orpheline à plusieurs membres était tronquée à son seul polygone cliqué — 167 composantes et 376 polygones concernés sur Angers, dont un ensemble de 19 abris.
>
> `lightIndex` associe **tout** polygone léger à sa composante, orpheline ou non, ce qui règle les trois d'un coup. Le construire depuis le retour de `lightComponents`, qui porte déjà `members` et `ownerId`.

- [ ] **Step 1: Écrire les tests**

`tests/cadastre/dataset.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { toPolys, buildDataset } from '../../src/cadastre/dataset';

const feature = (type: string, ring: number[][], holes: number[][][] = []) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[ring, ...holes]] },
  properties: { type, nom: null, commune: '49007', created: '2002-10-07', updated: '2018-06-27' },
});

const carre = (x0: number, y0: number, d = 0.001) =>
  [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];

describe('toPolys', () => {
  it('aplatit les MultiPolygon à une partie et numérote les polygones', () => {
    const polys = toPolys([feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(polys.map(p => p.id)).toEqual([0, 1]);
    expect(polys.map(p => p.type)).toEqual(['01', '02']);
  });

  it('conserve les trous', () => {
    const polys = toPolys([feature('01', carre(0, 0, 0.01), [carre(0.002, 0.002)])]);
    expect(polys[0]!.holes).toHaveLength(1);
  });

  it('ignore une feature sans géométrie exploitable', () => {
    expect(toPolys([{ type: 'Feature', geometry: null, properties: { type: '01' } }])).toHaveLength(0);
  });
});

describe('buildDataset', () => {
  it('précalcule l’absorption du léger dans son dur', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(ds.absorption.get(0)).toEqual([1]);
  });

  it('retrouve le polygone sous un point', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
    expect(ds.polyAt([0.0005, 0.0005])!.id).toBe(0);
    expect(ds.polyAt([5, 5])).toBeNull();
  });

  it('porte le millésime et le code commune', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
    expect(ds.millesime).toBe('2026');
    expect(ds.insee).toBe('49007');
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `npx vitest run tests/cadastre/dataset.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/cadastre/dataset.ts` :

```ts
import { buildEdgeIndex } from '../geometry/edges';
import { absorptionMap, lightComponents } from '../geometry/components';
import { pointInRing } from '../geometry/union';
import type { BatType, LonLat, Poly, Ring } from '../geometry/types';

const CELL = 0.002;   // ~150 m : quelques polygones par case

export interface Dataset {
  insee: string;
  millesime: string;
  polys: Poly[];
  edgeIndex: Map<string, number[]>;
  absorption: Map<number, number[]>;
  polyAt(pt: LonLat): Poly | null;
}

export function toPolys(features: unknown[]): Poly[] {
  const polys: Poly[] = [];
  for (const f of features) {
    const feat = f as { geometry?: { type?: string; coordinates?: unknown }; properties?: { type?: string } };
    const coords = feat.geometry?.coordinates as Ring[][] | undefined;
    const part = coords?.[0];
    const outer = part?.[0];
    const type = feat.properties?.type as BatType | undefined;
    if (!outer || outer.length < 4 || (type !== '01' && type !== '02' && type !== '03')) continue;
    polys.push({ id: polys.length, type, outer, holes: part!.slice(1) });
  }
  return polys;
}

const cellKey = (x: number, y: number): string => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

export function buildDataset(insee: string, millesime: string, features: unknown[]): Dataset {
  const polys = toPolys(features);
  const edgeIndex = buildEdgeIndex(polys);
  const absorption = absorptionMap(lightComponents(polys, edgeIndex));

  // grille uniforme : chaque polygone est inscrit dans toutes les cases que sa bbox recouvre
  const grid = new Map<string, number[]>();
  for (const p of polys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of p.outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const k = `${cx}:${cy}`;
        const bucket = grid.get(k);
        if (bucket) bucket.push(p.id);
        else grid.set(k, [p.id]);
      }
    }
  }

  return {
    insee,
    millesime,
    polys,
    edgeIndex,
    absorption,
    polyAt(pt: LonLat): Poly | null {
      for (const id of grid.get(cellKey(pt[0], pt[1])) ?? []) {
        const p = polys[id]!;
        if (pointInRing(pt, p.outer)) return p;
      }
      return null;
    },
  };
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `npx vitest run tests/cadastre/dataset.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mesurer l'empreinte mémoire et décider**

La spec §3.3 prévoyait une représentation compacte (bbox + `Float64Array`) pour ne pas retenir 50 000 polygones sous forme d'objets issus de `JSON.parse`. Ce plan garde volontairement `Ring = LonLat[]`, parce que ce type traverse tous les modules purs et qu'un changement de représentation les complique tous. **On vérifie donc par la mesure au lieu d'optimiser à l'aveugle.**

```bash
node --expose-gc -e "
const { readFileSync } = require('node:fs');
const raw = readFileSync('/tmp/angers.json', 'utf8');
global.gc();
const avant = process.memoryUsage().heapUsed;
const features = JSON.parse(raw).features;
global.gc();
console.log('features parsées :', ((process.memoryUsage().heapUsed - avant) / 1e6).toFixed(0), 'Mo');
"
```

Budget : **150 Mo retenus au total** pour une commune de la taille d'Angers, iD tournant déjà dans l'onglet.

- Sous le budget : ne rien changer, et noter la mesure ici même. Ne pas retenir `features` après `buildDataset` — c'est la copie brute, elle ne sert plus une fois `polys` construit ; s'assurer qu'aucune référence ne la garde en vie.
- Au-dessus : introduire la forme compacte de la spec dans `dataset.ts` seul, en convertissant vers `Ring` à la volée dans `polyAt` et `composeFor`, sans toucher aux signatures des modules purs.

Consigner la valeur obtenue dans le message de commit.

- [ ] **Step 6: Commit**

```bash
git add src/cadastre/dataset.ts tests/cadastre/dataset.test.ts
git commit -m "feat(cadastre): jeu de donnees precalcule et index spatial"
```

---

## Task 13: Conflation — recouvrement et recalage

**Files:**
- Create: `src/conflation/overlap.ts`, `src/conflation/snap.ts`
- Test: `tests/conflation/overlap.test.ts`, `tests/conflation/snap.test.ts`

**Interfaces:**
- Consumes: `pointInRing`, `ringArea` (Task 6) ; `segmentLength` (Task 4)
- Produces:
```ts
// overlap.ts
export interface ExistingBuilding { id: string; ring: Ring; }
export function overlapsExisting(ring: Ring, existing: ExistingBuilding[]): ExistingBuilding | null;

// snap.ts
export interface ExistingNode { id: string; loc: LonLat; }
export interface SnapResult { ring: Ring; reused: (string | null)[]; }
export const DEFAULT_SNAP_TOLERANCE_M: number;   // 0.2
export function snapToExistingNodes(ring: Ring, nodes: ExistingNode[], toleranceM?: number): SnapResult;
```

- [ ] **Step 1: Écrire les tests de recouvrement**

`tests/conflation/overlap.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { overlapsExisting } from '../../src/conflation/overlap';
import type { Ring } from '../../src/geometry/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

describe('overlapsExisting', () => {
  it('ne voit aucun conflit sur un terrain vierge', () => {
    expect(overlapsExisting(rect(0, 0, 0.001, 0.001), [])).toBeNull();
  });

  it('détecte un bâtiment existant au même endroit', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.001, 0.001) }];
    expect(overlapsExisting(rect(0.0002, 0.0002, 0.0008, 0.0008), existing)?.id).toBe('w1');
  });

  it('ignore un bâtiment simplement mitoyen', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.001, 0.001) }];
    expect(overlapsExisting(rect(0.001, 0, 0.002, 0.001), existing)).toBeNull();
  });

  it('détecte un existant qui englobe le nouveau', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.01, 0.01) }];
    expect(overlapsExisting(rect(0.004, 0.004, 0.005, 0.005), existing)?.id).toBe('w1');
  });
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `npx vitest run tests/conflation/overlap.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter `overlap.ts`**

```ts
import { pointInRing } from '../geometry/union';
import type { LonLat, Ring } from '../geometry/types';

export interface ExistingBuilding { id: string; ring: Ring; }

const bbox = (r: Ring): [number, number, number, number] => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
};

const disjoint = (a: Ring, b: Ring): boolean => {
  const [ax0, ay0, ax1, ay1] = bbox(a);
  const [bx0, by0, bx1, by1] = bbox(b);
  return ax1 <= bx0 || bx1 <= ax0 || ay1 <= by0 || by1 <= ay0;
};

const centroid = (r: Ring): LonLat => {
  let x = 0, y = 0;
  for (let i = 0; i < r.length - 1; i++) { x += r[i]![0]; y += r[i]![1]; }
  const n = r.length - 1;
  return [x / n, y / n];
};

export function overlapsExisting(ring: Ring, existing: ExistingBuilding[]): ExistingBuilding | null {
  for (const candidate of existing) {
    if (disjoint(ring, candidate.ring)) continue;
    // recouvrement si un sommet ou le centre de l'un tombe à l'intérieur de l'autre
    const hit =
      ring.slice(0, -1).some(p => pointInRing(p, candidate.ring)) ||
      candidate.ring.slice(0, -1).some(p => pointInRing(p, ring)) ||
      pointInRing(centroid(ring), candidate.ring) ||
      pointInRing(centroid(candidate.ring), ring);
    if (hit) return candidate;
  }
  return null;
}
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `npx vitest run tests/conflation/overlap.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Écrire les tests de recalage**

`tests/conflation/snap.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { snapToExistingNodes } from '../../src/conflation/snap';
import type { Ring } from '../../src/geometry/types';

const carre: Ring = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];

describe('snapToExistingNodes', () => {
  it('ne touche à rien sans nœud voisin', () => {
    const r = snapToExistingNodes(carre, []);
    expect(r.ring).toEqual(carre);
    expect(r.reused.every(x => x === null)).toBe(true);
  });

  it('réutilise un nœud situé à moins de la tolérance', () => {
    // ~11 cm à l'est du premier sommet
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.reused[0]).toBe('n1');
  });

  it('déplace le sommet cadastre vers le nœud, jamais l’inverse', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual([0.000001, 0]);
    expect(nodes[0]!.loc).toEqual([0.000001, 0]);   // le nœud existant est intact
  });

  it('ignore un nœud au-delà de la tolérance', () => {
    // ~1,1 m
    const nodes = [{ id: 'n1', loc: [0.00001, 0] as [number, number] }];
    expect(snapToExistingNodes(carre, nodes, 0.2).reused[0]).toBeNull();
  });

  it('n’attribue jamais deux fois le même nœud', () => {
    const nodes = [{ id: 'n1', loc: [0, 0] as [number, number] }];
    const ringProche: Ring = [[0, 0], [0.0000005, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
    const r = snapToExistingNodes(ringProche, nodes, 0.5);
    expect(r.reused.filter(x => x === 'n1')).toHaveLength(1);
  });

  it('garde l’anneau fermé après recalage', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual(r.ring[r.ring.length - 1]);
  });
});
```

- [ ] **Step 6: Lancer pour voir échouer**

Run: `npx vitest run tests/conflation/snap.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 7: Implémenter `snap.ts`**

```ts
import { segmentLength } from '../geometry/edges';
import type { LonLat, Ring } from '../geometry/types';

export interface ExistingNode { id: string; loc: LonLat; }
export interface SnapResult {
  ring: Ring;
  /** pour chaque sommet ouvert de l'anneau : l'id du nœud OSM réutilisé, ou null */
  reused: (string | null)[];
}

export const DEFAULT_SNAP_TOLERANCE_M = 0.2;

export function snapToExistingNodes(
  ring: Ring,
  nodes: ExistingNode[],
  toleranceM: number = DEFAULT_SNAP_TOLERANCE_M,
): SnapResult {
  const open = ring.slice(0, -1);
  const taken = new Set<string>();
  const reused: (string | null)[] = [];
  const snapped: LonLat[] = [];

  for (const vertex of open) {
    let best: ExistingNode | null = null;
    let bestDist = toleranceM;
    for (const node of nodes) {
      if (taken.has(node.id)) continue;
      const d = segmentLength(vertex, node.loc);
      if (d <= bestDist) { bestDist = d; best = node; }
    }
    if (best) {
      taken.add(best.id);
      reused.push(best.id);
      snapped.push(best.loc);        // le sommet cadastre cède, le nœud existant ne bouge pas
    } else {
      reused.push(null);
      snapped.push(vertex);
    }
  }

  return { ring: [...snapped, snapped[0]!], reused };
}
```

- [ ] **Step 8: Lancer pour voir passer**

Run: `npx vitest run tests/conflation/snap.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/conflation tests/conflation
git commit -m "feat(conflation): detection de recouvrement et recalage sur les noeuds existants"
```

---

## Task 14: Le bridge vers iD

**Le spike a eu lieu le 2026-09-23 et il est concluant** — voir [docs/superpowers/spikes/2026-09-22-capture-contexte-id.md](../spikes/2026-09-22-capture-contexte-id.md). Le code ci-dessous a déjà été corrigé sur ses quatre conclusions ; ce qui suit résume ce qui est **vérifié en navigateur** et ce qui reste supposé.

Vérifié présent : `iD.osmNode`, `iD.osmWay`, `iD.actionAddEntity`, `iD.actionChangeTags`, `iD.modeSelect`, `iD.coreGraph`, `iD.prefs` ; et sur le contexte `graph`, `history`, `map`, `perform`, `enter`, `projection` (avec `invert`), `container`, `entity`, `mode`. Les appels `map().extent().rectangle()`, `projection.invert` et `history().intersects(extent)` ont été exercés pour de vrai — le dernier a rendu 24 611 entités sur une vue ordinaire.

Vérifié absent : **`context.storage`**, remplacé par `iD.prefs` ; et `iD.version`, qui n'existe pas (le namespace expose `uiVersion`). L'auto-test porte sur les primitives, pas sur un numéro de version, ce qui est de toute façon plus robuste.

Trois contraintes que le spike a établies dans la douleur, la première version de la sonde ayant cassé l'éditeur :

1. **iD vit dans une iframe servie à `/id`.** Le bridge, le bouton et le calque appartiennent à ce document. Ne pas ajouter `@noframes`.
2. **On n'écrit jamais sur le namespace `iD`** — ses exports sont des getters sans setter. D'où le `Proxy`.
3. **Toute l'interception est sous `try/catch`**, setter compris : une exception levée là casse l'amorçage d'iD.

**Files:**
- Create: `src/bridge/capture.ts`, `src/bridge/types.ts`
- Test: `tests/bridge/capture.test.ts`

**Interfaces:**
- Consumes: `LonLat`, `Ring` ; `ExistingBuilding` (Task 13), `ExistingNode` (Task 13)
- Produces:
```ts
export interface IdBridge {
  mapExtent(): [LonLat, LonLat];
  project(p: LonLat): [number, number];
  invert(p: [number, number]): LonLat;          // écran -> coordonnées
  onMapMove(cb: () => void): () => void;
  buildingsNear(extent: [LonLat, LonLat]): ExistingBuilding[];
  nodesNear(pt: LonLat, radiusM: number): ExistingNode[];
  createBuilding(ring: Ring, tags: Record<string, string>, reused: (string | null)[]): void;
  prefillChangeset(comment: string): void;
  containerNode(): HTMLElement;
}
export function captureContext(): Promise<unknown>;      // résout quand iD a démarré
export function makeBridge(ctx: unknown): IdBridge;       // jette si une primitive manque
```

- [ ] **Step 1: Écrire les tests de capture**

Le contexte réel de iD n'est pas testable hors navigateur ; on teste le **mécanisme d'interception** et **l'auto-test**, avec un faux namespace.

`tests/bridge/capture.test.ts` :

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureContext, makeBridge } from '../../src/bridge/capture';

describe('captureContext', () => {
  beforeEach(() => {
    delete (globalThis as any).iD;
    vi.resetModules();
  });

  it('capture le contexte quand coreContext est appelé après l’installation du piège', async () => {
    const promise = captureContext();
    const faux = { marker: 'ctx' };
    (globalThis as any).iD = { coreContext: () => faux };
    const produit = (globalThis as any).iD.coreContext();
    expect(produit).toBe(faux);
    await expect(promise).resolves.toBe(faux);
  });

  it('laisse le namespace lisible et intact pour la page', async () => {
    captureContext();
    const ns = { coreContext: () => ({}), version: '2.30.0' };
    (globalThis as any).iD = ns;
    expect((globalThis as any).iD.version).toBe('2.30.0');
  });
});

describe('makeBridge', () => {
  const ctxComplet = () => {
    const projection: any = (p: unknown) => p;
    projection.invert = (p: [number, number]) => [p[0] / 100, p[1] / 100];
    return {
      map: () => ({ extent: () => ({ rectangle: () => [0, 0, 1, 1] }), on: () => {}, off: () => {} }),
      history: () => ({ intersects: () => [] }),
      graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
      projection,
      perform: () => {},
      enter: () => {},
      storage: () => {},
      container: () => ({ node: () => document.createElement('div') }),
    };
  };

  it('jette si une primitive attendue manque', () => {
    const incomplet: any = ctxComplet();
    delete incomplet.perform;
    expect(() => makeBridge(incomplet)).toThrow(/perform/);
  });

  it('jette si le graphe est absent', () => {
    const incomplet: any = ctxComplet();
    delete incomplet.graph;
    expect(() => makeBridge(incomplet)).toThrow(/graph/);
  });

  it('accepte un contexte complet', () => {
    expect(() => makeBridge(ctxComplet())).not.toThrow();
  });

  it('expose l’inversion écran vers coordonnées', () => {
    expect(makeBridge(ctxComplet()).invert([250, 400])).toEqual([2.5, 4]);
  });
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `npx vitest run tests/bridge/capture.test.ts`
Expected: FAIL — module introuvable.

Note : ces tests touchent au DOM. Ajouter `environment: 'jsdom'` pour ce fichier via un commentaire `// @vitest-environment jsdom` en tête, et `jsdom` en devDependency.

- [ ] **Step 3: Implémenter `capture.ts`**

```ts
import type { IdBridge } from './types';
import type { ExistingBuilding } from '../conflation/overlap';
import type { ExistingNode } from '../conflation/snap';
import type { LonLat, Ring } from '../geometry/types';

// `storage` ne figure PAS ici : il n'existe plus sur le contexte (spike du 2026-09-23).
const PRIMITIVES = ['map', 'history', 'graph', 'projection', 'perform', 'enter', 'container'] as const;

/**
 * Pose un piège sur window.iD et résout dès que coreContext() a produit une instance.
 *
 * Deux contraintes viennent du spike, et aucune n'est négociable :
 *
 * 1. On n'écrit JAMAIS sur le namespace. Ses exports sont des getters sans setter, et
 *    `value.coreContext = wrapper` lève une TypeError. Comme cette exception remonte
 *    depuis le setter de window.iD, elle casse l'amorçage d'iD. On expose donc un Proxy.
 * 2. Tout est sous try/catch. En cas d'échec on rend le namespace intact : le plugin se
 *    désactive, l'éditeur démarre.
 */
export function captureContext(): Promise<unknown> {
  return new Promise(resolve => {
    let exposed: unknown = undefined;

    const wrap = (namespace: any): any => new Proxy(namespace, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'coreContext' || typeof value !== 'function') return value;
        return function (this: unknown, ...args: unknown[]) {
          const ctx = value.apply(this, args);
          resolve(ctx);
          return ctx;
        };
      },
    });

    try {
      Object.defineProperty(globalThis, 'iD', {
        configurable: true,
        get: () => exposed,
        set(value: any) {
          try {
            exposed = wrap(value);
          } catch {
            exposed = value;   // iD doit démarrer même si on échoue
          }
        },
      });
    } catch {
      /* on ne peut pas piéger : whenReady ne résoudra pas, l'auto-test désactivera */
    }
  });
}

/** Auto-test : refuse un contexte auquel manque une primitive attendue. */
export function makeBridge(ctx: unknown): IdBridge {
  const c = ctx as Record<string, unknown>;
  for (const key of PRIMITIVES) {
    if (typeof c[key] !== 'function') {
      throw new Error(`contexte iD inutilisable : ${key} manquant`);
    }
  }
  return buildBridge(c);
}

function buildBridge(c: any): IdBridge {
  return {
    mapExtent(): [LonLat, LonLat] {
      const r = c.map().extent().rectangle() as number[];
      return [[r[0]!, r[1]!], [r[2]!, r[3]!]];
    },

    project(p: LonLat): [number, number] {
      return c.projection(p) as [number, number];
    },

    invert(p: [number, number]): LonLat {
      return c.projection.invert(p) as LonLat;
    },

    onMapMove(cb: () => void): () => void {
      c.map().on('move.cadastre-id', cb);
      return () => c.map().off('move.cadastre-id', cb);
    },

    buildingsNear(_extent: [LonLat, LonLat]): ExistingBuilding[] {
      const entities = c.history().intersects(c.map().extent()) as any[];
      const graph = c.graph();
      return entities
        .filter(e => e.type === 'way' && e.tags?.building)
        .map(e => ({
          id: e.id as string,
          ring: (e.nodes as string[]).map(id => graph.entity(id).loc as LonLat),
        }));
    },

    nodesNear(pt: LonLat, radiusM: number): ExistingNode[] {
      const d = radiusM / 111320;
      const entities = c.history().intersects(c.map().extent()) as any[];
      return entities
        .filter(e => e.type === 'node')
        .map(e => ({ id: e.id as string, loc: e.loc as LonLat }))
        .filter(n => Math.abs(n.loc[0] - pt[0]) < d * 2 && Math.abs(n.loc[1] - pt[1]) < d * 2);
    },

    createBuilding(ring: Ring, tags: Record<string, string>, reused: (string | null)[]): void {
      const iD = (globalThis as any).iD;
      const open = ring.slice(0, -1);
      const nodeIds: string[] = [];
      const created: any[] = [];

      open.forEach((loc, i) => {
        const existing = reused[i];
        if (existing) { nodeIds.push(existing); return; }
        const node = iD.osmNode({ loc });
        created.push(node);
        nodeIds.push(node.id);
      });

      const way = iD.osmWay({ tags, nodes: [...nodeIds, nodeIds[0]!] });
      const actions = [...created, way].map(entity => iD.actionAddEntity(entity));
      c.perform(...actions, 'Bâtiment depuis le cadastre');
      c.enter(iD.modeSelect(c, [way.id]));
    },

    prefillChangeset(comment: string): void {
      // `context.storage` n'existe plus (spike du 2026-09-23). iD expose `prefs` sur le
      // namespace, et le commentaire vit dans localStorage sous la clé `comment`, sans
      // préfixe. `commentDate` doit suivre : iD périme un commentaire trop ancien, et
      // l'oublier ferait ignorer le nôtre en silence.
      const iD = (globalThis as any).iD;
      const write = (k: string, v: string): void => {
        try {
          if (iD && typeof iD.prefs === 'function') iD.prefs(k, v);
          else localStorage.setItem(k, v);
        } catch { /* le préremplissage est un confort, jamais un bloquant */ }
      };
      write('comment', comment);
      write('commentDate', String(Date.now()));
    },

    containerNode(): HTMLElement {
      return c.container().node() as HTMLElement;
    },
  };
}
```

`src/bridge/types.ts` reprend l'interface `IdBridge` donnée plus haut.

- [ ] **Step 4: Lancer pour voir passer**

Run: `npx vitest run tests/bridge/capture.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge tests/bridge
git commit -m "feat(bridge): capture du contexte iD et interface etroite avec auto-test"
```

---

## Task 15: Calque d'aperçu au survol

**Files:**
- Create: `src/ui/overlay.ts`
- Test: `tests/ui/overlay.test.ts`

**Interfaces:**
- Consumes: `IdBridge` (Task 14), `Ring`
- Produces:
```ts
export interface Overlay { show(ring: Ring, state: 'ok' | 'refus'): void; hide(): void; redraw(): void; destroy(): void; }
export function createOverlay(bridge: IdBridge): Overlay;
```

- [ ] **Step 1: Écrire les tests**

`tests/ui/overlay.test.ts` :

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createOverlay } from '../../src/ui/overlay';
import type { IdBridge } from '../../src/bridge/types';
import type { Ring } from '../../src/geometry/types';

const carre: Ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

const fauxBridge = (container: HTMLElement): IdBridge => ({
  mapExtent: () => [[0, 0], [1, 1]],
  project: (p) => [p[0] * 100, p[1] * 100],
  invert: (p) => [p[0] / 100, p[1] / 100],
  onMapMove: () => () => {},
  buildingsNear: () => [],
  nodesNear: () => [],
  createBuilding: () => {},
  prefillChangeset: () => {},
  containerNode: () => container,
});

describe('overlay', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('n’affiche rien tant qu’on n’a rien montré', () => {
    createOverlay(fauxBridge(container));
    expect(container.querySelector('path')?.getAttribute('d')).toBeFalsy();
  });

  it('trace le contour projeté', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    const d = container.querySelector('path')!.getAttribute('d')!;
    expect(d).toContain('M 0 0');
    expect(d).toContain('100 0');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('distingue visuellement un refus', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    const okClass = container.querySelector('path')!.getAttribute('class');
    o.show(carre, 'refus');
    expect(container.querySelector('path')!.getAttribute('class')).not.toBe(okClass);
  });

  it('efface le contour', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    o.hide();
    expect(container.querySelector('path')!.getAttribute('d')).toBe('');
  });

  it('se retire proprement', () => {
    const o = createOverlay(fauxBridge(container));
    o.destroy();
    expect(container.querySelector('svg')).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `npx vitest run tests/ui/overlay.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/ui/overlay.ts` :

```ts
import type { IdBridge } from '../bridge/types';
import type { Ring } from '../geometry/types';

const NS = 'http://www.w3.org/2000/svg';

export interface Overlay {
  show(ring: Ring, state: 'ok' | 'refus'): void;
  hide(): void;
  redraw(): void;
  destroy(): void;
}

export function createOverlay(bridge: IdBridge): Overlay {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'cadastre-id-overlay');
  svg.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:50';

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', '');
  path.setAttribute('class', 'cadastre-id-preview');
  path.setAttribute('fill', 'rgba(64,160,255,0.25)');
  path.setAttribute('stroke', '#2e7dd7');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  bridge.containerNode().appendChild(svg);

  let current: Ring | null = null;
  let currentState: 'ok' | 'refus' = 'ok';

  const draw = (): void => {
    if (!current) { path.setAttribute('d', ''); return; }
    const d = current
      .map((p, i) => {
        const [x, y] = bridge.project(p);
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ') + ' Z';
    path.setAttribute('d', d);
  };

  const stopListening = bridge.onMapMove(draw);

  return {
    show(ring, state) {
      current = ring;
      if (state !== currentState) {
        currentState = state;
        path.setAttribute('class', `cadastre-id-preview cadastre-id-${state}`);
        path.setAttribute('fill', state === 'ok' ? 'rgba(64,160,255,0.25)' : 'rgba(224,80,80,0.25)');
        path.setAttribute('stroke', state === 'ok' ? '#2e7dd7' : '#c23b3b');
      }
      draw();
    },
    hide() { current = null; draw(); },
    redraw: draw,
    destroy() { stopListening(); svg.remove(); },
  };
}
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `npx vitest run tests/ui/overlay.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/overlay.ts tests/ui/overlay.test.ts
git commit -m "feat(ui): calque SVG d'apercu du contour au survol"
```

---

## Task 16: Câblage complet

Le mode cadastre : bouton, chargement de la commune, survol, clic, création, changeset. **Deliverable : le userscript fonctionne de bout en bout.**

**Files:**
- Create: `src/ui/messages.ts`, `src/ui/button.ts`, `src/mode.ts`
- Modify: `src/main.ts`
- Test: `tests/mode.test.ts`, `tests/ui/messages.test.ts`

**Interfaces:**
- Consumes: toutes les tâches précédentes
- Produces:
```ts
// messages.ts
export function refusalMessage(reason: RefusalReason | 'batiment-existant' | 'commune-introuvable' | 'reseau'): string;
// mode.ts
export interface ModeDeps {
  loadDataset(pt: LonLat): Promise<Dataset>;
  communeName(pt: LonLat): Promise<string>;
  notify(message: string): void;
}
export interface CadastreMode {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  whenReady(): Promise<void>;
  hoverAt(pt: LonLat): void;
  clickAt(pt: LonLat): Promise<void>;
}
export function createMode(bridge: IdBridge, deps?: Partial<ModeDeps>): CadastreMode;
```

- [ ] **Step 1: Écrire les tests des messages**

`tests/ui/messages.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { refusalMessage } from '../../src/ui/messages';

const TOUS = ['aucun-batiment', 'trou-source', 'degenere', 'pincement', 'trou',
  'parties-multiples', 'vide', 'batiment-existant', 'commune-introuvable', 'reseau'] as const;

describe('refusalMessage', () => {
  for (const raison of TOUS) {
    it(`donne un message explicite pour ${raison}`, () => {
      const m = refusalMessage(raison);
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toContain(raison);        // un message, pas un code
    });
  }

  it('dit quoi faire quand un bâtiment existe déjà', () => {
    expect(refusalMessage('batiment-existant')).toMatch(/existe déjà/i);
  });
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `npx vitest run tests/ui/messages.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter `messages.ts`**

```ts
import type { RefusalReason } from '../compose';

export type AnyRefusal = RefusalReason | 'batiment-existant' | 'commune-introuvable' | 'reseau';

const MESSAGES: Record<AnyRefusal, string> = {
  'aucun-batiment': 'Aucun bâtiment cadastre à cet endroit.',
  'trou-source': 'Ce bâtiment comporte une cour intérieure : le cadastre le décrit avec un trou, que cette version ne sait pas encore convertir. À tracer à la main.',
  'degenere': 'Le contour cadastre de ce bâtiment est dégénéré (surface nulle). Rien à créer.',
  'pincement': 'Le contour obtenu se pince sur lui-même : la fusion avec les constructions légères ne donne pas un tracé propre. À tracer à la main.',
  'trou': 'La fusion des constructions légères enferme une cour. Cette version ne crée pas de multipolygone. À tracer à la main.',
  'parties-multiples': 'La fusion donnerait plusieurs morceaux séparés. À tracer à la main.',
  'vide': 'Aucun contour exploitable à cet endroit.',
  'batiment-existant': 'Un bâtiment OSM existe déjà ici : cette version ne remplace pas la géométrie existante.',
  'commune-introuvable': 'Commune introuvable ou hors couverture du cadastre français.',
  'reseau': 'Données cadastre indisponibles : vérifiez votre connexion.',
};

export function refusalMessage(reason: AnyRefusal): string {
  return MESSAGES[reason] ?? 'Création impossible.';
}
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `npx vitest run tests/ui/messages.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Écrire les tests du mode**

`tests/mode.test.ts` :

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMode } from '../src/mode';
import type { IdBridge } from '../src/bridge/types';
import { buildDataset } from '../src/cadastre/dataset';

const feature = (type: string, ring: number[][]) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
  properties: { type, commune: '49007' },
});
const carre = (x0: number, y0: number, d = 0.001) =>
  [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];

describe('mode cadastre', () => {
  let container: HTMLElement;
  let bridge: IdBridge;
  let created: { ring: unknown; tags: Record<string, string> }[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    created = [];
    bridge = {
      mapExtent: () => [[0, 0], [0.01, 0.01]],
      project: p => [p[0] * 1000, p[1] * 1000],
      invert: p => [p[0] / 1000, p[1] / 1000],
      onMapMove: () => () => {},
      buildingsNear: () => [],
      nodesNear: () => [],
      createBuilding: (ring, tags) => { created.push({ ring, tags }); },
      prefillChangeset: vi.fn(),
      containerNode: () => container,
    };
  });

  const deps = () => ({
    loadDataset: async () => buildDataset('49007', '2026',
      [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]),
    communeName: async () => 'Angers',
    notify: vi.fn(),
  });

  it('démarre désactivé', () => {
    expect(createMode(bridge, deps()).isEnabled()).toBe(false);
  });

  it('crée le bâtiment fusionné au clic, avec ses tags', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);

    expect(created).toHaveLength(1);
    expect(created[0]!.tags.building).toBe('yes');
    expect(created[0]!.tags.source).toContain('Mise à jour : 2026');
    expect(created[0]!.tags.wall).toBeUndefined();
  });

  it('refuse et notifie quand un bâtiment OSM existe déjà', async () => {
    bridge.buildingsNear = () => [{ id: 'w1', ring: carre(0, 0) as any }];
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);

    expect(created).toHaveLength(0);
    expect(d.notify).toHaveBeenCalledWith(expect.stringMatching(/existe déjà/i));
  });

  it('préremplit le commentaire de changeset avec la commune', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);
    expect(bridge.prefillChangeset).toHaveBeenCalledWith(expect.stringContaining('Angers'));
  });

  it('pose wall=no sur une construction légère isolée', async () => {
    const d = {
      ...deps(),
      loadDataset: async () => buildDataset('49007', '2026', [feature('02', carre(0, 0))]),
    };
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);
    expect(created[0]!.tags.wall).toBe('no');
  });

  it('désactivé, ne crée rien', async () => {
    const mode = createMode(bridge, deps());
    await mode.clickAt([0.0005, 0.0005]);
    expect(created).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Lancer pour voir échouer**

Run: `npx vitest run tests/mode.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 7: Implémenter `mode.ts`**

```ts
import { composeAt } from './compose';
import type { Composition } from './compose';
import { buildDataset, type Dataset } from './cadastre/dataset';
import { downloadCommune } from './cadastre/download';
import { readCache, writeCache } from './cadastre/store';
import { communeAt } from './cadastre/insee';
import { overlapsExisting } from './conflation/overlap';
import { snapToExistingNodes, DEFAULT_SNAP_TOLERANCE_M } from './conflation/snap';
import { buildingTags, changesetComment } from './tagging/tags';
import { createOverlay, type Overlay } from './ui/overlay';
import { refusalMessage } from './ui/messages';
import type { IdBridge } from './bridge/types';
import type { LonLat } from './geometry/types';

export interface ModeDeps {
  loadDataset(pt: LonLat): Promise<Dataset>;
  communeName(pt: LonLat): Promise<string>;
  notify(message: string): void;
}

export interface CadastreMode {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  whenReady(): Promise<void>;
  hoverAt(pt: LonLat): void;
  clickAt(pt: LonLat): Promise<void>;
}

async function defaultLoadDataset(pt: LonLat): Promise<Dataset> {
  const commune = await communeAt(pt[1], pt[0]);
  if (!commune) throw new Error('commune-introuvable');
  const cached = await readCache(commune.code);
  if (cached) return buildDataset(cached.insee, cached.millesime, cached.features);
  const { features, millesime } = await downloadCommune(commune.code);
  await writeCache({ insee: commune.code, millesime, fetchedAt: Date.now(), features });
  return buildDataset(commune.code, millesime, features);
}

export function createMode(bridge: IdBridge, deps: Partial<ModeDeps> = {}): CadastreMode {
  const loadDataset = deps.loadDataset ?? defaultLoadDataset;
  const communeName = deps.communeName ?? (async (pt: LonLat) =>
    (await communeAt(pt[1], pt[0]))?.nom ?? '');
  const notify = deps.notify ?? ((m: string) => console.warn('[cadastre-id]', m));

  let enabled = false;
  let overlay: Overlay | null = null;
  let dataset: Dataset | null = null;
  let loading: Promise<void> | null = null;

  const ensureDataset = (pt: LonLat): Promise<void> => {
    if (dataset) return Promise.resolve();
    loading ??= loadDataset(pt)
      .then(d => { dataset = d; })
      .catch(err => { notify(refusalMessage(err.message === 'commune-introuvable' ? 'commune-introuvable' : 'reseau')); })
      .finally(() => { loading = null; });
    return loading;
  };

  const compose = (pt: LonLat): Composition | null => {
    if (!dataset) return null;
    return composeAt(pt, {
      polys: dataset.polys,
      absorption: dataset.absorption,
      byId: dataset.byId,              // precalcule en Task 12 ; jamais reconstruit par appel
      lightIndex: dataset.lightIndex,  // idem : sans lui, anchorOf balaie et les orphelines se tronquent
      polyAt: dataset.polyAt,          // indispensable : le survol balaierait sinon 50 000 polygones par frame
    });
  };

  return {
    isEnabled: () => enabled,

    enable() {
      if (enabled) return;
      enabled = true;
      overlay = createOverlay(bridge);
      const [[x0, y0], [x1, y1]] = bridge.mapExtent();
      const centre: LonLat = [(x0 + x1) / 2, (y0 + y1) / 2];
      void ensureDataset(centre);
    },

    disable() {
      enabled = false;
      overlay?.destroy();
      overlay = null;
    },

    whenReady: () => loading ?? Promise.resolve(),

    hoverAt(pt) {
      if (!enabled || !overlay) return;
      const r = compose(pt);
      if (!r || !r.ok) { overlay.hide(); return; }
      const conflit = overlapsExisting(r.ring, bridge.buildingsNear(bridge.mapExtent()));
      overlay.show(r.ring, conflit ? 'refus' : 'ok');
    },

    async clickAt(pt) {
      if (!enabled) return;
      await ensureDataset(pt);
      const r = compose(pt);
      if (!r) return;
      if (!r.ok) {
        if (r.reason !== 'aucun-batiment') notify(refusalMessage(r.reason));
        return;
      }
      if (overlapsExisting(r.ring, bridge.buildingsNear(bridge.mapExtent()))) {
        notify(refusalMessage('batiment-existant'));
        return;
      }
      const snapped = snapToExistingNodes(
        r.ring, bridge.nodesNear(pt, DEFAULT_SNAP_TOLERANCE_M * 10), DEFAULT_SNAP_TOLERANCE_M);
      const tags = buildingTags({ isolatedLight: r.isolatedLight, millesime: dataset!.millesime });

      bridge.createBuilding(snapped.ring, tags, snapped.reused);
      bridge.prefillChangeset(changesetComment(await communeName(pt)));
      overlay?.hide();
    },
  };
}
```

- [ ] **Step 8: Lancer pour voir passer**

Run: `npx vitest run tests/mode.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Implémenter `ui/button.ts` et câbler `main.ts`**

`src/ui/button.ts` :

```ts
export function createButton(container: HTMLElement, onToggle: (on: boolean) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'cadastre-id-toggle';
  button.type = 'button';
  button.textContent = 'Cadastre';
  button.title = 'Créer un bâtiment depuis le cadastre (un clic par bâtiment)';
  button.style.cssText =
    'position:absolute;top:10px;right:10px;z-index:100;padding:6px 10px;' +
    'background:#fff;border:1px solid #ccc;border-radius:4px;cursor:pointer';

  let on = false;
  button.addEventListener('click', () => {
    on = !on;
    button.style.background = on ? '#2e7dd7' : '#fff';
    button.style.color = on ? '#fff' : '#333';
    onToggle(on);
  });

  container.appendChild(button);
  return button;
}
```

`src/main.ts` :

```ts
import { captureContext, makeBridge } from './bridge/capture';
import { createMode } from './mode';
import { createButton } from './ui/button';
import type { LonLat } from './geometry/types';

const log = (...a: unknown[]) => console.log('[cadastre-id]', ...a);

void (async () => {
  let bridge;
  try {
    bridge = makeBridge(await captureContext());
  } catch (err) {
    console.warn('[cadastre-id] désactivé :', (err as Error).message,
      '— iD a probablement changé ; voir https://github.com/alenoir/cadastre-id');
    return;
  }

  const container = bridge.containerNode();
  const mode = createMode(bridge, { notify: m => window.alert(m) });

  const surface = container.querySelector('svg.surface') ?? container;
  const toLonLat = (e: MouseEvent): LonLat => bridge.invert([e.offsetX, e.offsetY]);

  let frame = 0;
  surface.addEventListener('mousemove', (e) => {
    if (!mode.isEnabled()) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => mode.hoverAt(toLonLat(e as MouseEvent)));
  });

  surface.addEventListener('click', (e) => {
    if (!mode.isEnabled()) return;
    void mode.clickAt(toLonLat(e as MouseEvent));
  });

  createButton(container, on => (on ? mode.enable() : mode.disable()));
  log('prêt');
})();
```

**Note pour l'implémenteur :** `bridge.invert` est implémenté en Task 14 comme `c.projection.invert(p)`. Si le compte rendu de spike (Task 1) a établi une autre primitive d'inversion, c'est lui qui fait foi : corriger l'implémentation dans `buildBridge`, **sans toucher à la signature** — `main.ts` et les tests en dépendent.

Les coordonnées de `offsetX`/`offsetY` sont relatives à la cible de l'événement. Si le survol se décale à l'usage, c'est que la surface de rendu de iD n'a pas la même origine que le conteneur : mesurer avec `getBoundingClientRect()` et corriger dans `toLonLat`, pas ailleurs.

- [ ] **Step 10: Vérifier l'ensemble et construire**

Run: `npm test && npm run typecheck && npm run build`
Expected: tous les tests passent, pas d'erreur de type, `dist/cadastre-id.user.js` produit.

La personne installe le script et vérifie à la main sur une commune : bouton présent, survol affichant le contour, clic créant le bâtiment, `Ctrl+Z` l'annulant, panneau de sauvegarde prérempli.

- [ ] **Step 11: Commit**

```bash
git add src tests
git commit -m "feat: mode cadastre complet, du survol a la creation du batiment"
```

---

## Task 17: README et conformité

**Files:**
- Create: `README.md`
- Create: `docs/verification-manuelle.md`

**Interfaces:**
- Consumes: tout

- [ ] **Step 1: Écrire le README**

Il doit contenir, sans quoi le projet ne devrait pas être diffusé :

- ce que fait le plugin, en deux phrases, et **ce qu'il ne fait pas** (pas d'import en lot, pas de modification d'objets existants) ;
- l'installation : Violentmonkey ou Tampermonkey, lien vers `dist/cadastre-id.user.js` ;
- **l'attribution** : données issues du cadastre (DGFiP) via Etalab, sous Licence Ouverte, et le tag `source` posé sur chaque objet ;
- **les règles de contribution**, avec liens explicites vers [France/Cadastre/Import semi-automatique des bâtiments](https://wiki.openstreetmap.org/wiki/France/Cadastre/Import_semi-automatique_des_b%C3%A2timents) et le code de conduite des éditions automatisées ;
- l'avertissement que le cadastre n'est pas une vérité de terrain : il contient des erreurs et peut être en retard sur la réalité ;
- la réserve sur le millésime : la couche WMS affichée dans iD peut différer du jeu Etalab téléchargé ;
- la note sur la fusion des constructions légères, **y compris le cas ambigu** : sur 16 % des légers touchant plusieurs bâtiments, l'heuristique de plus longue frontière peut se tromper, d'où l'aperçu avant clic ;
- les limites connues de la v1 : géométries à trou refusées, pas de remplacement de géométrie.

- [ ] **Step 2: Écrire la liste de vérification manuelle**

`docs/verification-manuelle.md` : ce que `bridge/` ne peut pas tester automatiquement, à repasser après chaque mise à jour de iD.

```markdown
# Vérification manuelle

À repasser après toute mise à jour de iD ou d'osm.org.

- [ ] Le script s'injecte en chargement direct de `/edit`
- [ ] Le script s'injecte après navigation interne depuis la carte
- [ ] `[cadastre-id] prêt` apparaît dans la console
- [ ] Le bouton « Cadastre » est présent
- [ ] Le survol affiche le contour, aligné sur la couche cadastre WMS
- [ ] Le contour fusionne bien un porche avec sa maison
- [ ] Deux maisons mitoyennes ne fusionnent pas
- [ ] Le clic crée le bâtiment, sélectionné, avec building=yes et source
- [ ] Ctrl+Z annule la création en une fois
- [ ] Un mur mitoyen réutilise les nœuds du bâtiment déjà présent
- [ ] Le panneau de sauvegarde est prérempli
- [ ] Un bâtiment déjà présent déclenche le refus et le message
- [ ] En cas d'échec de capture, le bouton est absent et la console explique
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/verification-manuelle.md
git commit -m "docs: README, attribution, regles de contribution et verification manuelle"
```

---

## Ordre et dépendances

Task 1 est un **verrou** : rien ne commence avant sa conclusion. Ensuite :

- Task 2 (échafaudage) puis Task 3 (fixtures) débloquent tout le reste.
- Tasks 4 → 5 → 6 → 7 → 8 sont une chaîne : chacune consomme la précédente.
- Tasks 9, 10, 11, 12, 13 sont indépendantes entre elles une fois Task 8 faite (12 consomme 4, 5, 11).
- Task 14 consomme le compte rendu de Task 1 et peut se faire en parallèle des tâches pures.
- Tasks 15, 16, 17 ferment la marche, dans cet ordre.
