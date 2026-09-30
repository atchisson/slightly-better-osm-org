# Clic différé, bâtiments à trous, surfaces du fond cadastre — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** signaler le délai de chargement et y différer le clic ; créer les bâtiments à cour intérieure en multipolygones ; rendre cliquables toutes les surfaces du fond cadastre (`area=yes`).

**Architecture :** le jeu de données charge toutes les surfaces de `tsurf` (type `surface`, ou `piscine` pour le code 65). `composeFor` laisse passer les polygones seuls à trou et rend `holes` + `nature`. Le pont crée une relation multipolygone quand `holes` est non vide. `mode.ts` mémorise un clic pendant le chargement et le rejoue.

**Tech Stack :** TypeScript, vitest (jsdom pour l'UI), esbuild. Commande de test : `npx vitest run <fichier>` ; suite entière : `npx vitest run`.

**Spec :** `docs/superpowers/specs/2026-09-30-chargement-trous-surfaces-design.md`

## Global Constraints

- Français dans les commentaires, messages et noms de tests, comme le reste du dépôt.
- Aucune dépendance de production ajoutée.
- Attribution : chaque objet créé porte `source` avec le millésime (`requireMillesime` dans `src/tagging/tags.ts`) — y compris `area=yes`.
- Tout ce qui touche aux internes d'iD reste dans `src/bridge/` (spec initiale §4).
- Un objet ne fait doublon qu'avec un objet de même nature (bâtiment / piscine / surface).
- Un commit par tâche, message en français, terminé par la ligne `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Clic mis en attente puis Ctrl relâché avant la fin du chargement : la création a quand même lieu.
- Chargement qui échoue avec un clic en attente : pas de création, une seule notification réseau, pas de clic rejoué plus tard.
- Deux clics pendant le même chargement : seul le dernier est rejoué (pas de double création).
- Anneau intérieur dégénéré ou dont un sommet est partagé avec un bâtiment de la cour : écarté, respectivement conservé.
- Bâtiment OSM entièrement dans la cour : n'est pas un doublon ; bâtiment OSM à cheval sur la cour et le bâti : reste un doublon.
- Entrée de cache écrite avant les surfaces (`piscines` seul, ou ni l'un ni l'autre) : complétée une fois, sans casser le chargement si le complément échoue.
- Survol et clic donnent le même verdict de doublon.

---

### Task 1: Toutes les surfaces `tsurf` dans le jeu de données

**Files:**
- Modify: `src/geometry/types.ts`
- Modify: `src/cadastre/download.ts`, `src/cadastre/dataset.ts`, `src/cadastre/store.ts`, `src/mode.ts` (fonction `defaultLoadDataset`)
- Modify: `src/tagging/tags.ts`
- Test: `tests/cadastre/dataset.test.ts`, `tests/cadastre/download.test.ts`, `tests/tagging/tags.test.ts`

**Interfaces:**
- Produces : `BatType` inclut `'surface'` ; `SYM_PISCINE` (export de `download.ts`) ; `toSurfaces(features, offset): Poly[]` (remplace `toPiscines`) ; `buildDataset(insee, millesime, features, surfaces = [])` ; `downloadCommune()` rend `{ features, surfaces, millesime }` ; `downloadSurfacesForYear(insee, annee, fetchFn?)` (remplace `downloadPiscinesForYear`) ; `CachedCommune.surfaces?: unknown[]` ; `surfaceTags(millesime): Record<string,string>`.

- [ ] **Step 1 : tests qui échouent**

Dans `tests/tagging/tags.test.ts`, importer `surfaceTags` et ajouter :

```ts
describe('surfaceTags', () => {
  it('ne pose que area=yes et la source, aucune sémantique inventée', () => {
    const t = surfaceTags('2026');
    expect(Object.keys(t).sort()).toEqual(['area', 'source']);
    expect(t['area']).toBe('yes');
    expect(t['source']).toContain('Mise à jour : 2026');
  });

  it('refuse un millésime qui n’est pas une année', () => {
    expect(() => surfaceTags('latest')).toThrow(/millésime/i);
  });
});
```

Dans `tests/cadastre/dataset.test.ts`, importer `toSurfaces` et ajouter (les helpers `feature` et `carre` du fichier servent) :

```ts
const surf = (sym: string, ring: number[][], holes: number[][][] = []) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring, ...holes] },
  properties: { SYM: sym },
});

describe('surfaces', () => {
  it('type piscine pour le code 65, surface pour tout autre code', () => {
    const polys = toSurfaces([surf('65', carre(0, 0)), surf('34', carre(0.01, 0))], 5);
    expect(polys.map(p => p.type)).toEqual(['piscine', 'surface']);
    expect(polys.map(p => p.id)).toEqual([5, 6]);
  });

  it('conserve les trous d’une surface', () => {
    const polys = toSurfaces([surf('34', carre(0, 0, 0.01), [carre(0.002, 0.002)])], 0);
    expect(polys[0]!.holes).toHaveLength(1);
  });

  it('buildDataset les numérote à la suite des bâtiments et les rend survolables', () => {
    const ds = buildDataset('49007', '2026',
      [feature('01', carre(0, 0))],
      [surf('65', carre(0.01, 0)), surf('34', carre(0.02, 0))]);
    expect(ds.polys.map(p => p.type)).toEqual(['01', 'piscine', 'surface']);
    expect(ds.polys.map(p => p.id)).toEqual([0, 1, 2]);
    expect(ds.polyAt([0.0205, 0.0005])?.type).toBe('surface');
  });
});
```

Dans `tests/cadastre/download.test.ts` : renommer l'import `downloadPiscinesForYear` en `downloadSurfacesForYear` (et ses usages) ; remplacer le test « ne retient que le code symbole des piscines » par :

```ts
  it('garde toutes les surfaces topographiques, pas seulement les piscines', async () => {
    const bat = await gzip(JSON.stringify({ features: [] }));
    const sur = await gzip(JSON.stringify(tsurf(['65', '34', '33', '65'])));
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === LISTING_URL) return { ok: true, status: 200, text: async () => listing('2026-06-01') };
      return { ok: true, status: 200,
        body: new Blob([url.includes('tsurf') ? sur : bat]).stream() };
    }) as unknown as typeof fetch;

    const r = await downloadCommune('49007', fetchFn);

    expect(r.surfaces).toHaveLength(4);
  });
```

et dans le test suivant remplacer `expect(r.piscines).toEqual([])` par `expect(r.surfaces).toEqual([])`. Renommer aussi le `describe('piscines'` en `describe('surfaces'`.

- [ ] **Step 2 : constater l'échec**

Run : `npx vitest run tests/tagging tests/cadastre/dataset.test.ts tests/cadastre/download.test.ts`
Attendu : échecs (imports `surfaceTags`, `toSurfaces`, `downloadSurfacesForYear` absents).

- [ ] **Step 3 : implémenter**

`src/geometry/types.ts` — élargir le type et sa documentation :

```ts
export type BatType = '01' | '02' | '03' | 'piscine' | 'surface';
```

Compléter le commentaire : `piscine` et `surface` viennent de la couche `tsurf`, ne participent jamais à une union ; `surface` regroupe tous les codes symbole autres que la piscine.

`src/cadastre/download.ts` :
- exporter `SYM_PISCINE` (`export const SYM_PISCINE = '65';`) et supprimer `estPiscine` ;
- renommer `downloadPiscines` en `downloadSurfaces`, sans filtre : `return parsed.features ?? [];` ; adapter son commentaire (elle rend toutes les surfaces ; les codes sont triés à la construction du jeu) ;
- renommer `downloadPiscinesForYear` en `downloadSurfacesForYear` (elle appelle `downloadSurfaces`) ;
- `downloadCommune` : variable `surfaces`, valeur de retour `{ features: parts.flat(), surfaces: surfaces.flat(), millesime: ... }`, type de retour `{ features: unknown[]; surfaces: unknown[]; millesime: string }`.

`src/cadastre/dataset.ts` : importer `SYM_PISCINE` depuis `./download` ; remplacer `toPiscines` par :

```ts
/**
 * Polygones de la couche `tsurf` (surfaces topographiques du PCI).
 *
 * Le code symbole 65 désigne les piscines (voir SYM_PISCINE, mesuré) ; tout autre code
 * devient une `surface` générique, que l'outil créera avec `area=yes` seulement — le
 * cadastre ne dit rien de plus fiable sur sa nature.
 *
 * `offset` continue la numérotation des bâtiments : un identifiant de polygone doit
 * rester unique dans tout le jeu.
 */
export function toSurfaces(features: unknown[], offset: number): Poly[] {
  const polys: Poly[] = [];
  for (const f of features) {
    const feat = f as { geometry?: { coordinates?: unknown }; properties?: { SYM?: unknown } };
    const coords = feat.geometry?.coordinates as Ring[] | undefined;
    const outer = coords?.[0];
    if (!outer || outer.length < 4) continue;
    const type = feat.properties?.SYM === SYM_PISCINE ? 'piscine' : 'surface';
    polys.push({ id: offset + polys.length, type, outer, holes: coords!.slice(1) });
  }
  return polys;
}
```

`buildDataset(insee, millesime, features, surfaces: unknown[] = [])` : `const polys = [...batiments, ...toSurfaces(surfaces, batiments.length)];` et adapter le commentaire (piscines et surfaces partagent survol/grille/recalage, aucune composante légère).

`src/cadastre/store.ts` : remplacer le champ `piscines?` par

```ts
  /**
   * Surfaces de la commune (couche `tsurf`, tous codes). Optionnelle : une entrée écrite
   * avant leur prise en charge n'en a pas et doit rester lisible.
   */
  surfaces?: unknown[];
  /** Ancien champ (piscines seules) : relu par personne, écrasé au prochain complément. */
  piscines?: unknown[];
```

`src/mode.ts` — `defaultLoadDataset` :

```ts
  if (cached) {
    // Une entrée écrite avant la prise en charge des surfaces n'en porte aucune (ou
    // seulement des piscines). Sans ce complément, la fonctionnalité n'existerait pas —
    // en silence — pour quiconque a déjà utilisé le greffon sur cette commune.
    let surfaces = cached.surfaces;
    if (surfaces === undefined) {
      surfaces = await downloadSurfacesForYear(cached.insee, cached.millesime);
      console.log(`[sb-osm] ${surfaces.length} surface(s) ajoutées au cache de ${cached.insee}.`);
      // Un complément vide est peut-être une panne : on ne l'écrit pas, pour retenter
      // au prochain chargement plutôt que de figer « aucune surface » jusqu'à expiration.
      if (surfaces.length > 0) {
        const { piscines: _ancien, ...reste } = cached;
        void writeCache({ ...reste, surfaces }).catch(() => { /* confort, jamais bloquant */ });
      }
    }
    return buildDataset(cached.insee, cached.millesime, cached.features, surfaces);
  }
  const { features, surfaces, millesime } = await downloadCommune(commune.code);
  void writeCache({ insee: commune.code, millesime, fetchedAt: Date.now(), features, surfaces })...
  return buildDataset(commune.code, millesime, features, surfaces);
```
(conserver le commentaire existant sur le cache hors du chemin de retour) ; adapter l'import (`downloadSurfacesForYear`).

`src/tagging/tags.ts` :

```ts
/**
 * Tags d'une surface topographique sans nature connue : `area=yes` seulement.
 *
 * Le code symbole cadastral ne se traduit pas de façon fiable en tag OSM, et un tag
 * inventé est pire que pas de tag. `area=yes` suffit à lever l'avertissement d'iD sur
 * une voie fermée sans tag, et laisse la personne qui édite la qualifier.
 */
export function surfaceTags(millesime: string): Record<string, string> {
  return { area: 'yes', source: SOURCE_PREFIX + requireMillesime(millesime) };
}
```

- [ ] **Step 4 : tout repasse**

Run : `npx tsc --noEmit && npx vitest run tests/tagging tests/cadastre tests/mode.cache.test.ts`
Attendu : PASS. Corriger les usages restants de `piscines` signalés par `tsc` (`grep -rn "piscines" src tests`) — `mode.ts` de l'étape suivante n'est pas encore branché sur `surfaceTags` : c'est la Task 4.

- [ ] **Step 5 : commit**

```bash
git add -A src tests && git commit -m "feat(cadastre): charger toutes les surfaces de tsurf

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Composition avec trous, nature, et contrôle de doublon qui ignore la cour

**Files:**
- Modify: `src/compose.ts`, `src/conflation/overlap.ts`
- Test: `tests/compose.test.ts`, `tests/conflation/overlap.test.ts`

**Interfaces:**
- Consumes : `BatType` avec `'surface'` (Task 1).
- Produces : `Composition` ok a en plus `holes: Ring[]` et `nature: 'batiment' | 'piscine' | 'surface'` (`isPiscine` et `isolatedLight` restent). `overlapsExisting(ring, existing, seuil?, trous: Ring[] = [])`. `ExistingBuilding.kind` devient `'batiment' | 'piscine' | 'surface'`.

- [ ] **Step 1 : tests qui échouent**

`tests/compose.test.ts` — remplacer le test « refuse une géométrie source à trou » par :

```ts
  it('compose un polygone seul à trou : anneau extérieur et anneau intérieur', () => {
    const polys = fixtures.avecTrou.polys as unknown as Poly[];
    const troue = polys.find(p => p.holes.length > 0)!;
    const r = composeFor(troue.id, prepare(polys));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.holes.length).toBeGreaterThanOrEqual(1);
    expect(r.nature).toBe('batiment');
    expect(r.absorbed).toEqual([]);
  });
```

et ajouter un `describe` (utiliser `rect` et `prepare` du fichier) :

```ts
describe('bâtiments à trous', () => {
  const trou = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const avecCour = (id = 0): Poly => ({ ...rect(id, '01', 0, 0, 0.001, 0.001),
    holes: [trou(0.0003, 0.0003, 0.0007, 0.0007)] });

  it('un clic sur le bâti autour de la cour compose le bâtiment', () => {
    const r = composeAt([0.00005, 0.0005], prepare([avecCour()]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holes).toHaveLength(1);
  });

  it('un clic dans la cour ne compose rien', () => {
    expect(composeAt([0.0005, 0.0005], prepare([avecCour()])))
      .toEqual({ ok: false, reason: 'aucun-batiment' });
  });

  it('écarte un anneau intérieur dégénéré', () => {
    const p = avecCour();
    p.holes = [[[0.0003, 0.0003], [0.0005, 0.0003], [0.0007, 0.0003], [0.0003, 0.0003]]];
    const r = composeFor(0, prepare([p]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holes).toEqual([]);
  });

  it('garde un sommet de la cour partagé avec un bâtiment qui s’y trouve', () => {
    // Le bâtiment de la cour a un sommet au milieu de son mur sud, colinéaire : sans
    // protection, dropCollinear le retirerait du trou et découdrait le mur mitoyen.
    const mur: [number, number][] = [[0.0003, 0.0003], [0.0005, 0.0003], [0.0007, 0.0003],
      [0.0007, 0.0007], [0.0003, 0.0007], [0.0003, 0.0003]];
    const cour: Poly = { id: 1, type: '01', outer: mur, holes: [] };
    const bati: Poly = { ...avecCour(0), holes: [mur] };
    const r = composeFor(0, prepare([bati, cour]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holes[0]).toContainEqual([0.0005, 0.0003]);
  });

  it('refuse toujours un trou porté par un membre d’une fusion', () => {
    const dur = avecCour(0);
    const leger = rect(1, '02', 0.001, 0, 0.002, 0.001);
    expect(composeFor(0, prepare([dur, leger]))).toEqual({ ok: false, reason: 'trou-source' });
  });
});

describe('surfaces génériques', () => {
  it('se compose seule, nature surface, ni piscine ni léger isolé', () => {
    const s = rect(1, 'surface', 0, 0, 0.001, 0.001);
    const r = composeFor(1, prepare([s, rect(2, '02', 0.001, 0, 0.002, 0.001)]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nature).toBe('surface');
    expect(r.isPiscine).toBe(false);
    expect(r.isolatedLight).toBe(false);
    expect(r.absorbed).toEqual([]);
  });
});
```

Dans le test existant « se compose seule et se déclare piscine », ajouter `expect(r.nature).toBe('piscine');`.

`tests/conflation/overlap.test.ts` :

```ts
  it('ne compte pas comme doublon un bâtiment entièrement dans la cour', () => {
    const dansLaCour = [{ id: 'w1', ring: rect(0.0004, 0.0004, 0.0006, 0.0006) }];
    const cour = rect(0.0003, 0.0003, 0.0007, 0.0007);
    const anneau = rect(0, 0, 0.001, 0.001);
    expect(overlapsExisting(anneau, dansLaCour)?.id).toBe('w1');
    expect(overlapsExisting(anneau, dansLaCour, undefined, [cour])).toBeNull();
  });

  it('reste un doublon quand l’existant déborde de la cour sur le bâti', () => {
    const chevauche = [{ id: 'w1', ring: rect(0.0002, 0.0002, 0.0008, 0.0008) }];
    const cour = rect(0.0003, 0.0003, 0.0007, 0.0007);
    expect(overlapsExisting(rect(0, 0, 0.001, 0.001), chevauche, undefined, [cour])?.id).toBe('w1');
  });
```

- [ ] **Step 2 : constater l'échec**

Run : `npx vitest run tests/compose.test.ts tests/conflation/overlap.test.ts`
Attendu : échecs (`holes`/`nature` absents, refus `trou-source` encore émis).

- [ ] **Step 3 : implémenter**

`src/conflation/overlap.ts` : `kind?: 'batiment' | 'piscine' | 'surface'` (commentaire : « bâtiment, piscine ou surface générique »). Signature :

```ts
export function overlapsExisting(
  ring: Ring,
  existing: ExistingBuilding[],
  seuil: number = COUVERTURE_REFUS,
  trous: Ring[] = [],
): ExistingBuilding | null {
```
et dans la boucle d'échantillonnage, juste après `if (!pointInRing(p, ring)) continue;` :

```ts
      // Un point dans une cour n'est pas de l'empreinte à créer : un bâtiment qui s'y
      // trouve n'est pas un doublon de l'objet troué.
      if (trous.some(t => pointInRing(p, t))) continue;
```
Documenter le paramètre dans le commentaire de tête.

`src/compose.ts` :
- type `Composition` ok : ajouter `holes: Ring[];` et `nature: 'batiment' | 'piscine' | 'surface';` (commentaires courts) ; retirer le commentaire de `isPiscine` obsolète si besoin, la propriété reste ;
- `const isSurface = (p: Poly): boolean => p.type === 'surface';`
- `absorbedBy` : `if (isPiscine(anchor) || isSurface(anchor)) return [];` ;
- dans `composeFor`, remplacer le refus `trou-source` par :

```ts
  // Contrat de topologicalUnion : elle n'opère que sur les anneaux extérieurs et ne lit
  // jamais Poly.holes. Avec PLUSIEURS membres, un trou serait donc silencieusement perdu
  // par l'union : refus. Un polygone SEUL n'est pas uni à rien — son trou passe tel quel.
  if (members.length > 1 && members.some(p => p.holes.length > 0)) {
    return { ok: false, reason: 'trou-source' };
  }
```
- remplacer le bloc nettoyage/`return` final par :

```ts
  const idsMembres = new Set(members.map(m => m.id));
  // Les sommets partagés avec un bâtiment voisin sont inamovibles (voir sommetsPartages),
  // sur l'anneau extérieur comme sur chaque cour : un bâtiment bâti dans la cour partage
  // ses murs avec le trou.
  const nettoie = (ring: Ring): Ring => {
    const partages = sommetsPartages(ring, idsMembres, input);
    const inamovible = (p: LonLat): boolean => partages.has(vertexKey(p));
    return simplify(dropCollinear(ring, undefined, inamovible), input.simplifyToleranceM, inamovible);
  };
  const cleaned = nettoie(united.ring);
  if (isDegenerate(cleaned)) return { ok: false, reason: 'degenere' };
  // Une cour réduite à rien par le nettoyage n'est que du bruit : on l'écarte plutôt
  // que de refuser le bâtiment.
  const holes = members.flatMap(m => m.holes).map(nettoie).filter(h => !isDegenerate(h));

  const nature = isPiscine(anchor) ? 'piscine' : isSurface(anchor) ? 'surface' : 'batiment';
  return {
    ok: true, ring: cleaned, holes, anchorId,
    absorbed: [...absorbed].sort((a, b) => a - b),
    isolatedLight: !isHard(anchor) && !isPiscine(anchor) && !isSurface(anchor),
    isPiscine: isPiscine(anchor),
    nature,
  };
```
- `composeAt` : supprimer la ligne `if (poly.holes.length > 0) return ... 'trou-source'` (le point est déjà hors de la cour grâce à `pointInPoly`) et son éventuel commentaire.

Si `sommetsPartages` ne traite que `input.polysNear(dilatedExtent(ring, 0))` : c'est bon pour un trou aussi (son étendue est incluse dans celle du bâtiment).

- [ ] **Step 4 : tout repasse**

Run : `npx tsc --noEmit && npx vitest run tests/compose.test.ts tests/conflation tests/geometry tests/fixtures`
Attendu : PASS. Si un test existant attendait `trou-source` pour un polygone seul à trou (tests/mode.test.ts, tests/fixtures/angers.test.ts), le réécrire vers le nouveau comportement en gardant son intention (un cas multi-membres reste refusé).

- [ ] **Step 5 : commit**

```bash
git add -A src tests && git commit -m "feat(compose): composer les polygones seuls à trou, nature de l'objet

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Le pont crée des multipolygones et connaît les surfaces existantes

**Files:**
- Modify: `src/bridge/types.ts`, `src/bridge/capture.ts`
- Test: `tests/bridge/capture.test.ts`

**Interfaces:**
- Consumes : `ExistingBuilding.kind` avec `'surface'` (Task 2).
- Produces : `export interface HoleSpec { ring: Ring; reused: (string | null)[] }` (dans `src/bridge/types.ts`) ; `createBuilding(ring, tags, reused, insertions = [], holes: HoleSpec[] = [])`. Avec `holes` non vide : voie extérieure + une voie par trou (sans tags), relation `type=multipolygon` portant `tags`, tout dans un seul `perform`, sélection sur la relation. `buildingsNear` rend aussi les surfaces (`kind: 'surface'`) et les voies membres (hors `inner`) d'une relation piscine ou surface.

- [ ] **Step 1 : tests qui échouent**

Dans `tests/bridge/capture.test.ts`, dans le `describe('createBuilding — les entités d’iD sont des classes')` (qui fournit `ctxSimple` et `carre`), ajouter :

```ts
  it('avec des trous, crée une relation multipolygone en une seule transaction', () => {
    const ctx = ctxSimple();
    let n = 0;
    (globalThis as any).iD = {
      osmNode: (p: any) => ({ id: `n${++n}`, ...p }),
      osmWay: (p: any) => ({ id: `w${++n}`, ...p }),
      osmRelation: (p: any) => ({ id: `r${++n}`, ...p }),
      actionAddEntity: (e: unknown) => e,
      modeSelect: (_c: unknown, ids: string[]) => ({ ids }),
    };
    const cour: [number, number][] = [[5.2, 5.2], [5.4, 5.2], [5.4, 5.4], [5.2, 5.4], [5.2, 5.2]];
    try {
      makeBridge(ctx).createBuilding(carre, { building: 'yes', source: 's' },
        [null, null, null, null], [], [{ ring: cour, reused: [null, null, null, null] }]);

      expect(ctx.perform).toHaveBeenCalledOnce();
      const actions = (ctx.perform.mock.calls[0] as any[]).filter(a => a && typeof a === 'object');
      const voies = actions.filter(a => a.nodes);
      const relation = actions.find(a => a.members)!;
      expect(voies).toHaveLength(2);
      expect(voies.every(v => Object.keys(v.tags).length === 0)).toBe(true);
      expect(relation.tags).toEqual({ type: 'multipolygon', building: 'yes', source: 's' });
      expect(relation.members.map((m: any) => m.role)).toEqual(['outer', 'inner']);
      expect((ctx.enter.mock.calls[0] as any[])[0].ids).toEqual([relation.id]);
    } finally {
      delete (globalThis as any).iD;
    }
  });

  it('réutilise les nœuds existants d’un trou au lieu d’en créer', () => {
    const ctx = ctxSimple();
    let n = 0;
    (globalThis as any).iD = {
      osmNode: (p: any) => ({ id: `n${++n}`, ...p }),
      osmWay: (p: any) => ({ id: `w${++n}`, ...p }),
      osmRelation: (p: any) => ({ id: `r${++n}`, ...p }),
      actionAddEntity: (e: unknown) => e,
      modeSelect: () => ({}),
    };
    const cour: [number, number][] = [[5.2, 5.2], [5.4, 5.2], [5.4, 5.4], [5.2, 5.4], [5.2, 5.2]];
    try {
      makeBridge(ctx).createBuilding(carre, { building: 'yes' }, [null, null, null, null], [],
        [{ ring: cour, reused: ['nA', 'nB', null, null] }]);
      const actions = (ctx.perform.mock.calls[0] as any[]).filter(a => a && typeof a === 'object');
      const noeuds = actions.filter(a => a.loc);
      // 4 nœuds extérieurs + 2 nœuds de trou nouveaux (les deux autres sont réutilisés)
      expect(noeuds).toHaveLength(6);
      const trou = actions.filter(a => a.nodes)[1];
      expect(trou.nodes.slice(0, 2)).toEqual(['nA', 'nB']);
    } finally {
      delete (globalThis as any).iD;
    }
  });

  it('sans trou, garde une seule voie taguée et aucune relation', () => {
    const ctx = ctxSimple();
    (globalThis as any).iD = {
      osmNode: (p: any) => ({ id: 'n', ...p }),
      osmWay: (p: any) => ({ id: 'w', ...p }),
      osmRelation: () => { throw new Error('pas de relation attendue'); },
      actionAddEntity: (e: unknown) => e,
      modeSelect: () => ({}),
    };
    try {
      expect(() => makeBridge(ctx).createBuilding(carre, { building: 'yes' },
        [null, null, null, null])).not.toThrow();
    } finally {
      delete (globalThis as any).iD;
    }
  });
```

Puis, pour la lecture des existants, repérer dans le fichier le test qui couvre les relations `building` (chercher `members` ou `inner` dans `tests/bridge/capture.test.ts`) et le décalquer : deux tests avec le même montage de contexte que ce test — (a) une voie fermée taguée `area=yes` sort de `buildingsNear` avec `kind: 'surface'` ; (b) une voie membre `outer` d'une relation taguée `leisure=swimming_pool` sort avec `kind: 'piscine'`, alors que la voie `inner` de la même relation n'en sort pas.

- [ ] **Step 2 : constater l'échec**

Run : `npx vitest run tests/bridge/capture.test.ts`
Attendu : échecs sur les trois nouveaux tests de création et les deux de lecture.

- [ ] **Step 3 : implémenter**

`src/bridge/types.ts` :

```ts
/** Un anneau intérieur (cour) à créer, avec les nœuds OSM existants à y réutiliser. */
export interface HoleSpec {
  ring: Ring;
  /** par sommet ouvert : l'id d'un nœud OSM à réutiliser, ou null */
  reused: (string | null)[];
}
```
et dans `IdBridge.createBuilding` ajouter le paramètre `holes?: HoleSpec[]` avec ce commentaire : « Avec des trous, l'objet est une relation `type=multipolygon` portant `tags` ; les voies extérieure et intérieures n'en portent aucun (convention OSM). Une seule transaction, donc un seul Ctrl+Z. »

`src/bridge/capture.ts` :
- ajouter `taggedSurface(tags) { return tags?.area === 'yes'; }` et

```ts
type NatureOsm = 'batiment' | 'piscine' | 'surface';
/** La nature d'un objet OSM au sens du contrôle de doublon, ou null s'il n'en est pas un. */
function natureOf(tags: any): NatureOsm | null {
  if (taggedPool(tags)) return 'piscine';
  if (taggedBuilding(tags)) return 'batiment';
  if (taggedSurface(tags)) return 'surface';
  return null;
}

/** Nature portée par une relation, pour ses ways membres (hors rôle `inner`). */
function relationMemberNatures(entities: any[]): Map<string, NatureOsm> {
  const out = new Map<string, NatureOsm>();
  for (const e of entities) {
    if (e.type !== 'relation') continue;
    const nature = natureOf(e.tags);
    if (!nature) continue;
    for (const m of (e.members ?? []) as any[]) {
      if (m?.type === 'way' && m.role !== 'inner' && typeof m.id === 'string') out.set(m.id, nature);
    }
  }
  return out;
}
```
  Laisser `relationBuildingWayIds` tel quel (utilisé par `nodesIn`).
- `allBuildings` : remplacer `membresDeRelation` et le filtre/`kind` par

```ts
    const naturesRelation = relationMemberNatures(entities);
    const natureDe = (e: any): NatureOsm | null =>
      natureOf(e.tags) ?? naturesRelation.get(e.id as string) ?? null;
    buildingCache = entities
      .filter(e => e.type === 'way' && Array.isArray(e.nodes) && natureDe(e) !== null)
      .map(e => ({
        id: e.id as string,
        kind: natureDe(e)!,
        ring: ...inchangé,
        nodeIds: e.nodes as string[],
      }));
```
  (mettre à jour le commentaire pour dire que les relations piscine et surface sont aussi lues).
- `createBuilding` : ajouter `holes: HoleSpec[] = []` en 5ᵉ paramètre (importer `HoleSpec`) et remplacer la fin par :

```ts
      // Les cours : leurs nœuds (réutilisés ou créés) puis une voie chacune, sans tags.
      const voiesTrous = holes.map(h => {
        const ids: string[] = [];
        h.ring.slice(0, -1).forEach((loc, i) => {
          const existing = h.reused[i];
          if (existing) { ids.push(existing); return; }
          const node = instancier(iD.osmNode, { loc });
          ids.push(node.id);
          created.push(node);
        });
        return instancier(iD.osmWay, { tags: {}, nodes: [...ids, ids[0]!] });
      });

      const multipolygone = voiesTrous.length > 0;
      // Avec des cours, les tags vont sur la RELATION : les voies n'en portent aucun.
      const way = instancier(iD.osmWay,
        { tags: multipolygone ? {} : tags, nodes: [...nodeIds, nodeIds[0]!] });
      const relation = multipolygone
        ? instancier(iD.osmRelation, {
          tags: { type: 'multipolygon', ...tags },
          members: [
            { id: way.id, type: 'way', role: 'outer' },
            ...voiesTrous.map((v: any) => ({ id: v.id, type: 'way', role: 'inner' })),
          ],
        })
        : null;

      // Une seule transaction, dans cet ordre : nœuds, coutures, voies, relation — chaque
      // entité existe avant ce qui la référence. Ctrl+Z défait l'ensemble.
      const actions = [
        ...created.map(e => instancier(iD.actionAddEntity, e)),
        ...aInserer.map(({ node, edge }) =>
          instancier(iD.actionAddMidpoint, { loc: node.loc, edge }, node)),
        instancier(iD.actionAddEntity, way),
        ...voiesTrous.map((v: any) => instancier(iD.actionAddEntity, v)),
        ...(relation ? [instancier(iD.actionAddEntity, relation)] : []),
      ];
      c.perform(...actions, 'Bâtiment depuis le cadastre');
      buildingCache = null;
      c.enter(instancier(iD.modeSelect, c, [(relation ?? way).id]));
```
  Attention : les nœuds des trous doivent être créés AVANT de construire `actions` (le code ci-dessus le fait) et `created` doit déjà exister (il est déclaré en tête de la méthode, comme aujourd'hui).

- [ ] **Step 4 : tout repasse**

Run : `npx tsc --noEmit && npx vitest run tests/bridge tests/ui tests/mode.test.ts`
Attendu : PASS (les faux ponts des tests `mode`/`overlay` n'ont pas besoin du nouveau paramètre : il est optionnel).

- [ ] **Step 5 : commit**

```bash
git add -A src tests && git commit -m "feat(bridge): créer les bâtiments à trous en multipolygone

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Aperçu à trous, et mode câblé sur nature, trous et doublons

**Files:**
- Modify: `src/ui/overlay.ts`, `src/mode.ts`
- Test: `tests/ui/overlay.test.ts`, `tests/mode.test.ts`

**Interfaces:**
- Consumes : `Composition.holes/nature` (Task 2) ; `createBuilding(..., holes)`, `HoleSpec` (Task 3) ; `surfaceTags` (Task 1) ; `overlapsExisting(..., trous)` (Task 2).
- Produces : `Overlay.show(ring, state, holes?: Ring[])`.

- [ ] **Step 1 : tests qui échouent**

`tests/ui/overlay.test.ts` (reprendre le montage des tests existants de `show` : `fauxBridge`, `carre`, sélection du `path.sb-osm-preview`) :

```ts
  it('dessine les trous dans le même tracé, remplissage evenodd', () => {
    const conteneur = document.createElement('div');
    const overlay = createOverlay(fauxBridge(conteneur));
    const cour: Ring = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4], [0.2, 0.2]];

    overlay.show(carre, 'ok', [cour]);

    const path = conteneur.querySelector('path.sb-osm-preview')!;
    expect(path.getAttribute('d')!.match(/M /g)).toHaveLength(2);
    expect(path.getAttribute('fill-rule')).toBe('evenodd');
  });
```

`tests/mode.test.ts` (dans le `describe('mode cadastre')`, avec `bridge`, `created`, `carre`, `feature`) — il faut d'abord que le faux `createBuilding` enregistre aussi les trous : remplacer sa ligne par `createBuilding: (ring, tags, _r, _i, holes) => { created.push({ ring, tags, holes }); },` et le type de `created` par `{ ring: unknown; tags: Record<string,string>; holes?: unknown }[]`.

```ts
  const surface = (sym: string, ring: number[][]) => ({
    properties: { SYM: sym }, geometry: { type: 'Polygon', coordinates: [ring] },
  });

  it('crée une surface générique avec area=yes et la source, sans autre tag', async () => {
    const mode = createMode(bridge, {
      loadDataset: async () => buildDataset('49007', '2026', [], [surface('34', carre(0, 0))]),
      communeName: async () => 'Angers', notify: vi.fn(),
    });
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);
    expect(created).toHaveLength(1);
    expect(Object.keys(created[0]!.tags).sort()).toEqual(['area', 'source']);
  });

  it('crée un bâtiment à cour avec son trou', async () => {
    const mode = createMode(bridge, {
      loadDataset: async () => buildDataset('49007', '2026', [
        { ...feature('01', carre(0, 0, 0.01)),
          geometry: { type: 'MultiPolygon', coordinates: [[carre(0, 0, 0.01), carre(0.004, 0.004, 0.002)]] } },
      ]),
      communeName: async () => 'Angers', notify: vi.fn(),
    });
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.001, 0.001]);
    expect(created).toHaveLength(1);
    expect(created[0]!.holes).toHaveLength(1);
    expect(created[0]!.tags['building']).toBe('yes');
  });

  it('un bâtiment OSM déjà dans la cour n’empêche pas la création', async () => {
    bridge.buildingsNear = () => [{ id: 'w1', kind: 'batiment',
      ring: carre(0.0045, 0.0045, 0.001) as any }];
    const mode = createMode(bridge, {
      loadDataset: async () => buildDataset('49007', '2026', [
        { ...feature('01', carre(0, 0, 0.01)),
          geometry: { type: 'MultiPolygon', coordinates: [[carre(0, 0, 0.01), carre(0.004, 0.004, 0.002)]] } },
      ]),
      communeName: async () => 'Angers', notify: vi.fn(),
    });
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.001, 0.001]);
    expect(created).toHaveLength(1);
  });

  it('le survol et le clic donnent le même verdict de doublon', async () => {
    // Une piscine OSM voisine ne couvre pas une maison : ni le clic ni le survol ne
    // doivent la traiter comme un doublon.
    bridge.buildingsNear = () => [{ id: 'p', kind: 'piscine', ring: carre(0, 0) as any }];
    const mode = createMode(bridge, {
      loadDataset: async () => buildDataset('49007', '2026', [feature('01', carre(0, 0))]),
      communeName: async () => 'Angers', notify: vi.fn(),
    });
    mode.enable();
    await mode.whenReady();
    mode.hoverAt([0.0005, 0.0005]);
    expect(container.querySelector('path.sb-osm-preview')!.getAttribute('class')).toContain('sb-osm-ok');
  });
```
(Le test de survol suppose que `createOverlay(bridge)` du mode attache son `<svg>` à `container` via `surfaceNode()` — c'est le cas du montage.)

- [ ] **Step 2 : constater l'échec**

Run : `npx vitest run tests/ui/overlay.test.ts tests/mode.test.ts`
Attendu : les cinq nouveaux tests échouent.

- [ ] **Step 3 : implémenter**

`src/ui/overlay.ts` : `show(ring: Ring, state: 'ok' | 'refus', holes?: Ring[]): void;` dans l'interface ; `let currentHoles: Ring[] = [];` ; dans `show`, `currentHoles = holes ?? [];` et `path.setAttribute('fill-rule', 'evenodd');` ; dans `hide`, `currentHoles = []`. Dans `draw`, extraire le tracé d'un anneau :

```ts
  const trace = (ring: Ring, fermer: boolean): string =>
    ring.map((p, i) => {
      const [x, y] = bridge.project(p);
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    }).join(' ') + (fermer ? ' Z' : '');
```
et `const d = [trace(current, ferme), ...currentHoles.map(h => trace(h, true))].join(' ');`. Le comportement des voies ouvertes (route) est inchangé : `fill="none"` si `!ferme`.

`src/mode.ts` :
- importer `surfaceTags`, `HoleSpec` (depuis `./bridge/types`) ;
- dans `createMode`, factoriser le doublon, utilisé par le survol ET le clic :

```ts
  /**
   * Doublon éventuel d'une composition : un objet OSM de MÊME nature qui couvre déjà
   * l'empreinte (cours exclues). Partagé par le survol et le clic pour qu'ils ne
   * divergent jamais — le survol comparait auparavant à tous les objets.
   */
  const doublonDe = (r: Extract<Composition, { ok: true }>, extent: [LonLat, LonLat]) => {
    const existants = bridge.buildingsNear(extent)
      .filter(b => (b.kind ?? 'batiment') === r.nature);
    return overlapsExisting(r.ring, existants, undefined, r.holes);
  };
```
- `hoverAt` : `const conflit = doublonDe(r, bridge.mapExtent());` et `overlay.show(r.ring, conflit ? 'refus' : 'ok', r.holes);`
- `clickAt` : remplacer `memeNature`/`existants` par `if (doublonDe(r, bridge.mapExtent())) { notify(...); return; }` ; pour `planInsertions` garder le filtre par nature : `.filter(b => (b.kind ?? 'batiment') === r.nature)` ;
- recalage des trous, avant le choix des tags :

```ts
      const nodes = bridge.nodesIn(dilatedExtent(r.ring, DEFAULT_SNAP_TOLERANCE_M));
      const snapped = snapToExistingNodes(r.ring, nodes, DEFAULT_SNAP_TOLERANCE_M);
      // Les cours se recousent aux nœuds existants (le bâtiment de la cour partage ses
      // murs avec le trou) mais sans insertion dans un mur : on ne touche pas aux
      // objets voisins pour une cour.
      const trous: HoleSpec[] = r.holes.map(h => {
        const s = snapToExistingNodes(h, bridge.nodesIn(dilatedExtent(h, DEFAULT_SNAP_TOLERANCE_M)),
          DEFAULT_SNAP_TOLERANCE_M);
        return { ring: s.ring, reused: s.reused };
      });
```
  (remplacer l'appel unique existant à `snapToExistingNodes`, en gardant son commentaire) ;
- tags : 

```ts
      const tags = r.nature === 'piscine' ? poolTags(millesime)
        : r.nature === 'surface' ? surfaceTags(millesime)
        : buildingTags({ isolatedLight: r.isolatedLight, millesime });
```
- `bridge.createBuilding(snapped.ring, tags, snapped.reused, insertions, trous);`
- retirer les usages de `r.isPiscine` devenus inutiles dans `mode.ts` (le champ reste dans `Composition`).

- [ ] **Step 4 : tout repasse**

Run : `npx tsc --noEmit && npx vitest run`
Attendu : PASS sur toute la suite.

- [ ] **Step 5 : commit**

```bash
git add -A src tests && git commit -m "feat(mode): bâtiments à trous, surfaces génériques, doublon partagé survol/clic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Clic différé et bandeau de chargement

**Files:**
- Create: `src/ui/loading.ts`, `tests/ui/loading.test.ts`
- Modify: `src/mode.ts`, `src/ui/messages.ts`
- Test: `tests/mode.test.ts`, `tests/ui/messages.test.ts`

**Interfaces:**
- Produces : `createLoadingBanner(bridge: IdBridge): { show(): void; hide(): void; destroy(): void }`. Dans `mode.ts` : le clic pendant un chargement est mémorisé (un seul) et rejoué à la fin du chargement.

- [ ] **Step 1 : tests qui échouent**

`tests/ui/loading.test.ts` :

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createLoadingBanner } from '../../src/ui/loading';
import type { IdBridge } from '../../src/bridge/types';

const pont = (conteneur: HTMLElement) => ({ containerNode: () => conteneur }) as unknown as IdBridge;

describe('bandeau de chargement', () => {
  it('est caché à la création, visible après show, caché après hide', () => {
    const c = document.createElement('div');
    const b = createLoadingBanner(pont(c));
    const el = c.querySelector('.sb-osm-loading') as HTMLElement;
    expect(el.style.display).toBe('none');
    b.show();
    expect(el.style.display).not.toBe('none');
    expect(el.textContent).toMatch(/chargement du cadastre/i);
    b.hide();
    expect(el.style.display).toBe('none');
  });

  it('destroy retire l’élément', () => {
    const c = document.createElement('div');
    createLoadingBanner(pont(c)).destroy();
    expect(c.querySelector('.sb-osm-loading')).toBeNull();
  });
});
```

`tests/ui/messages.test.ts` : retirer `'chargement-en-cours'` de la liste `TOUS`.

`tests/mode.test.ts` — dans le `describe('mode cadastre')` :
1. Repérer le test qui attend `notify` avec `/chargement/i` (chercher `stringMatching(/chargement/i)`, autour de la ligne 640) et le remplacer par :

```ts
  it('un clic pendant le chargement est différé puis rejoué, sans message', async () => {
    const attente = deferred<Dataset>();
    const notify = vi.fn();
    const mode = createMode(bridge, { loadDataset: () => attente.promise, communeName: async () => 'X', notify });
    mode.enable();

    await mode.clickAt([0.0005, 0.0005]);
    expect(created).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();

    attente.resolve(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
    await mode.whenReady();
    expect(created).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });
```
2. Le test « un clic après un chargement raté relance un chargement » : après le `await mode.whenReady()` qui suit le premier `clickAt`, remplacer le second clic et l'assertion finale par `expect(created).toHaveLength(1);` (le clic relance le chargement, le mémorise, et le rejoue).
3. Ajouter :

```ts
  it('ne rejoue que le dernier de deux clics en attente', async () => {
    const attente = deferred<Dataset>();
    const mode = createMode(bridge, { loadDataset: () => attente.promise, communeName: async () => 'X', notify: vi.fn() });
    mode.enable();
    await mode.clickAt([0.0005, 0.0005]);
    await mode.clickAt([0.0015, 0.0005]);
    attente.resolve(buildDataset('49007', '2026',
      [feature('01', carre(0, 0)), feature('01', carre(0.001, 0))]));
    await mode.whenReady();
    expect(created).toHaveLength(1);
  });

  it('rejoue le clic même si Ctrl est relâché avant la fin du chargement', async () => {
    const attente = deferred<Dataset>();
    const mode = createMode(bridge, { loadDataset: () => attente.promise, communeName: async () => 'X', notify: vi.fn() });
    mode.enable();
    await mode.clickAt([0.0005, 0.0005]);
    mode.disable();
    attente.resolve(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
    await mode.whenReady();
    expect(created).toHaveLength(1);
  });

  it('abandonne le clic en attente si le chargement échoue, avec une seule notification', async () => {
    const notify = vi.fn();
    const mode = createMode(bridge, {
      loadDataset: async () => { throw new Error('panne'); }, communeName: async () => 'X', notify });
    mode.enable();
    await mode.clickAt([0.0005, 0.0005]);
    await mode.whenReady();
    expect(created).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('abandonne le clic en attente si la carte a beaucoup bougé', async () => {
    const attente = deferred<Dataset>();
    const mode = createMode(bridge, { loadDataset: () => attente.promise, communeName: async () => 'X', notify: vi.fn() });
    mode.enable();
    await mode.clickAt([0.0005, 0.0005]);
    bridge.mapExtent = () => [[0.5, 0.5], [0.51, 0.51]];
    attente.resolve(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
    await mode.whenReady();
    expect(created).toHaveLength(0);
  });

  it('abandonne le clic en attente après 60 s', async () => {
    vi.useFakeTimers();
    try {
      const attente = deferred<Dataset>();
      const mode = createMode(bridge, { loadDataset: () => attente.promise, communeName: async () => 'X', notify: vi.fn() });
      mode.enable();
      await mode.clickAt([0.0005, 0.0005]);
      vi.advanceTimersByTime(61_000);
      attente.resolve(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
      await mode.whenReady();
      expect(created).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('affiche le bandeau pendant le chargement et le retire ensuite', async () => {
    const attente = deferred<Dataset>();
    const mode = createMode(bridge, { loadDataset: () => attente.promise, communeName: async () => 'X', notify: vi.fn() });
    mode.enable();
    const bandeau = () => container.querySelector('.sb-osm-loading') as HTMLElement;
    expect(bandeau().style.display).not.toBe('none');
    attente.resolve(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
    await mode.whenReady();
    expect(bandeau().style.display).toBe('none');
  });
```
(`mapExtent` du faux pont est `[[0,0],[0.01,0.01]]` : le clic est dans cette étendue ; la nouvelle étendue en est à 50× sa taille.)

- [ ] **Step 2 : constater l'échec**

Run : `npx vitest run tests/ui tests/mode.test.ts`
Attendu : échecs (module `loading` absent, clic toujours refusé avec message).

- [ ] **Step 3 : implémenter**

`src/ui/loading.ts` :

```ts
import type { IdBridge } from '../bridge/types';

/**
 * Bandeau « Chargement du cadastre… ».
 *
 * Le premier chargement d'une commune prend plusieurs secondes (téléchargement,
 * décompression, index) : sans signe visible, le mode paraît inerte. Le bandeau vit dans
 * le conteneur d'iD, hors de ses calques, comme l'overlay ; il ne capte aucun clic.
 */
export interface LoadingBanner {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createLoadingBanner(bridge: IdBridge): LoadingBanner {
  const el = document.createElement('div');
  el.className = 'sb-osm-loading';
  el.textContent = 'Chargement du cadastre…';
  el.style.cssText =
    'position:absolute;top:60px;left:50%;transform:translateX(-50%);z-index:60;' +
    'padding:6px 14px;border-radius:4px;background:rgba(30,30,30,0.85);color:#fff;' +
    'font:13px sans-serif;pointer-events:none;display:none';
  bridge.containerNode().appendChild(el);
  return {
    show() { el.style.display = 'block'; },
    hide() { el.style.display = 'none'; },
    destroy() { el.remove(); },
  };
}
```

`src/ui/messages.ts` : retirer `'chargement-en-cours'` de `AnyRefusal` et son entrée (et son commentaire) de `MESSAGES`.

`src/mode.ts` :
- importer `createLoadingBanner, type LoadingBanner` ; constante `const ATTENTE_MAX_MS = 60_000;`
- état (près de `loading`) :

```ts
  /**
   * Le dernier clic donné pendant un chargement, rejoué à sa fin. Un seul : deux clics
   * successifs visent le même objet, et rejouer les deux créerait un doublon.
   * Il survit à disable() — le mode n'est armé que tant que Ctrl est enfoncé, et la
   * personne qui relâche Ctrl avant la fin du chargement a bien cliqué.
   */
  let attente: { pt: LonLat; etendue: [LonLat, LonLat]; depuis: number } | null = null;
  let banniere: LoadingBanner | null = null;

  const majBanniere = (): void => {
    const visible = attente !== null || (enabled && loading !== null);
    if (visible) (banniere ??= createLoadingBanner(bridge)).show();
    else banniere?.hide();
  };

  /** La carte a-t-elle quitté la zone du clic (plus d'une demi-étendue) ? */
  const carteDeplacee = (avant: [LonLat, LonLat]): boolean => {
    const [[x0, y0], [x1, y1]] = avant;
    const [cx, cy] = centreOf(bridge.mapExtent());
    const [ax, ay] = centreOf(avant);
    return Math.abs(cx - ax) > (x1 - x0) / 2 || Math.abs(cy - ay) > (y1 - y0) / 2;
  };

  const rejouerSiPret = (): void => {
    if (loading !== null || !dataset || !attente) { majBanniere(); return; }
    const a = attente;
    attente = null;
    majBanniere();
    if (Date.now() - a.depuis > ATTENTE_MAX_MS || carteDeplacee(a.etendue)) return;
    void creer(a.pt);
  };
```
  (`centreOf` est défini plus bas dans le fichier : le déplacer au-dessus de ce bloc.)
- `startLoad` : dans le `.catch`, sous la garde `if (loading !== p) return;`, ajouter `attente = null;` avant `notifyFailure` ; dans le `.finally`, remplacer par `.finally(() => { if (loading === p) loading = null; rejouerSiPret(); })` ; après `loading = p;` (avant `return p`) appeler `majBanniere();`.
- `enable()` : après `void ensureDataset(...)`, `majBanniere();`. `disable()` : à la fin, `majBanniere();` (le bandeau reste visible si un clic attend).
- `clickAt` : remplacer tout le bloc de gardes (« Jamais de création à l'aveugle ») par :

```ts
    async clickAt(pt) {
      if (!enabled) return;
      // Pendant un chargement (ou sans jeu de données après une panne), on ne crée rien
      // à l'aveugle mais on ne perd pas le clic : il est mémorisé et rejoué dès que les
      // données sont là, sans message. Une panne précédente est oubliée avant de
      // relancer, pour que sa répétition soit signalée à nouveau.
      if (loading !== null || !dataset) {
        attente = { pt, etendue: bridge.mapExtent(), depuis: Date.now() };
        if (loading === null) { lastFailureReason = null; void ensureDataset(pt); }
        majBanniere();
        return;
      }
      await creer(pt);
    },
```
  et déplacer tout le corps actuel de `clickAt` situé après les gardes (de `const r = compose(pt);` jusqu'à `prefillChangeset`) dans une fonction `const creer = async (pt: LonLat): Promise<void> => { ... }` définie au-dessus de l'objet retourné. `creer` ne teste pas `enabled` (le rejeu doit marcher mode désarmé) ; mettre à jour le grand commentaire de `clickAt` pour décrire le nouveau contrat et l'écart assumé avec « jamais de création à l'aveugle » (voir la spec §1).

- [ ] **Step 4 : tout repasse**

Run : `npx tsc --noEmit && npx vitest run`
Attendu : PASS. Si un test de rechargement de commune (tests/mode.test.ts, ~lignes 400–620) échoue parce qu'il cliquait pendant le rechargement et attendait un refus, le réécrire : le clic est maintenant différé, et rejoué contre le nouveau jeu de données.

- [ ] **Step 5 : commit**

```bash
git add -A src tests && git commit -m "feat(mode): différer le clic pendant le chargement, bandeau de chargement

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Vérification sur données réelles, documentation, contrôle manuel

**Files:**
- Modify: `README.md`, `docs/verification-manuelle.md`
- Create: `docs/superpowers/spikes/2026-09-30-objets-non-cliquables.md`

- [ ] **Step 1 : mesurer les objets encore non cliquables**

Script jetable dans le scratchpad (ne pas le versionner) qui, pour Angers (49007) et Le Lavandou (83069), télécharge `cadastre-<insee>-batiments.json.gz` et `raw/pci-<insee>-tsurf.json.gz` depuis `https://cadastre.s3.rbx.io.cloud.ovh.net/etalab-cadastre/<dernier millésime>/geojson/communes/<dép>/<insee>/`, appelle `buildDataset` puis, pour chaque polygone, `composeAt(point intérieur)` (point intérieur = milieu de la plus longue corde horizontale du polygone, par `pointInPoly`), et compte les verdicts par raison (`ok`, `degenere`, `pincement`, `trou`, `parties-multiples`, `chevauchement`, `trou-source`, `aucun-batiment`). Exécuter avec `npx tsx` (ou `npx vite-node`). Un polygone rendant `aucun-batiment` sur son propre point intérieur est un vrai « non cliquable » : le lister et chercher pourquoi (chevauchement par un voisin avec `polyAt` qui rend le premier de la case ? anneau non simple ?).

Consigner dans `docs/superpowers/spikes/2026-09-30-objets-non-cliquables.md` : les comptes par verdict pour chaque commune, et, pour chaque cause de « non cliquable » trouvée, soit le correctif fait (avec son test), soit la limite laissée. Si une cause de non-cliquable est corrigeable en moins de 30 lignes (par ex. `polyAt` qui ne teste que le premier polygone d'une case alors que deux se recouvrent), la corriger avec un test avant de continuer ; sinon la documenter seulement.

- [ ] **Step 2 : README**

Dans `README.md` : mettre à jour la section sur les piscines (l. ~103) pour dire que toutes les surfaces du fond cadastre sont désormais créables (piscine si code 65, sinon `area=yes` + `source`), passer « Géométries à trou refusées, pas converties » (l. ~328) en « converties en multipolygones quand le polygone est seul ; refusées quand elles suivent une fusion avec une construction légère », ajuster la ligne du tableau de refus `trou-source` (l. ~283–286) en conséquence, et ajouter un paragraphe court sur le clic différé et le bandeau de chargement.

- [ ] **Step 3 : liste de contrôle manuel**

Dans `docs/verification-manuelle.md`, ajouter une section « Multipolygones et surfaces » : (a) `iD.osmRelation` existe dans le contexte d'iD (lecture seule : `typeof iD.osmRelation`) ; (b) créer un bâtiment à cour sur une commune où l'on en connaît un : iD sélectionne la relation, le panneau de tags montre `type=multipolygon`, `building=yes`, `source=…`, les deux voies n'ont pas de tags, Ctrl+Z défait tout d'un coup ; (c) créer une surface générique : iD ne signale pas « voie fermée sans tag » ; (d) cliquer pendant le chargement (cache vidé) : le bandeau s'affiche, aucun message, l'objet est créé à la fin, y compris si Ctrl est relâché entre-temps.

- [ ] **Step 4 : suite complète et build**

Run : `npx tsc --noEmit && npx vitest run && npm run build`
Attendu : tout passe, le build produit le script sans erreur.

- [ ] **Step 5 : commit**

```bash
git add -A README.md docs && git commit -m "docs: multipolygones, surfaces, clic différé ; mesure des objets non cliquables

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
