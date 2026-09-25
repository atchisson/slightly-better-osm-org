import { buildEdgeIndex } from '../geometry/edges';
import { absorptionMap, lightComponents } from '../geometry/components';
import type { LightComponent } from '../geometry/components';
import { pointInPoly } from '../geometry/union';
import type { BatType, LonLat, Poly, Ring } from '../geometry/types';

const CELL = 0.002;   // ~150 m : quelques polygones par case

export interface Dataset {
  insee: string;
  millesime: string;
  polys: Poly[];
  absorption: Map<number, number[]>;
  /** id -> polygone ; construit ici, une fois par commune */
  byId: Map<number, Poly>;
  /** id d'un léger -> sa composante entière et son propriétaire éventuel */
  lightIndex: Map<number, { ownerId: number | null; members: number[] }>;
  polyAt(pt: LonLat): Poly | null;
  /**
   * Polygones dont la case de grille rencontre l'étendue demandée — un sur-ensemble,
   * jamais un résultat exact. Sert à trouver les VOISINS d'un contour composé sans
   * balayer la commune entière (compose.ts, protection des sommets partagés).
   */
  polysNear(extent: [LonLat, LonLat]): Poly[];
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

/**
 * Polygones de piscines, lus dans la couche `tsurf` déjà filtrée sur le code symbole.
 *
 * `offset` continue la numérotation des bâtiments : un identifiant de polygone doit
 * rester unique dans tout le jeu, puisque `byId`, la grille et l'index des légers les
 * mélangent.
 */
export function toPiscines(features: unknown[], offset: number): Poly[] {
  const polys: Poly[] = [];
  for (const f of features) {
    const feat = f as { geometry?: { coordinates?: unknown } };
    const coords = feat.geometry?.coordinates as Ring[] | undefined;
    const outer = coords?.[0];
    if (!outer || outer.length < 4) continue;
    // `tsurf` est une couche de polygones simples, pas de multipolygones : un seul
    // niveau de tableau de moins que la couche bâtiments.
    polys.push({ id: offset + polys.length, type: 'piscine', outer, holes: coords!.slice(1) });
  }
  return polys;
}

/**
 * Table id-de-léger -> composante entière (orpheline ou non) et son propriétaire.
 * Construite une seule fois par commune, depuis lightComponents() — voir la revue de la
 * Task 8 : composeFor() reconstruisait auparavant cette table à chaque appel (donc à
 * chaque survol) par balayage linéaire, ce qui a aussi laissé passer une composante
 * orpheline tronquée à son seul polygone cliqué.
 *
 * lightComponents() garantit que `members` est trié par id croissant (voir son propre
 * tri explicite) : c'est ce qui permet à compose.ts:anchorOf() de résoudre à la même
 * ancre canonique (`members[0]`) quel que soit le membre cliqué d'une composante
 * orpheline. On ne retrie pas ici : on relaie tel quel ce que lightComponents() rend.
 */
export function buildLightIndex(
  components: LightComponent[],
): Map<number, { ownerId: number | null; members: number[] }> {
  const index = new Map<number, { ownerId: number | null; members: number[] }>();
  for (const c of components) {
    for (const id of c.members) index.set(id, { ownerId: c.ownerId, members: c.members });
  }
  return index;
}

const cellKey = (x: number, y: number): string => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

export function buildDataset(
  insee: string,
  millesime: string,
  features: unknown[],
  piscines: unknown[] = [],
): Dataset {
  const batiments = toPolys(features);
  // Les piscines rejoignent le même tableau : elles partagent le survol, la grille et
  // le recalage. Elles ne participent en revanche à aucune composante légère —
  // `lightComponents` ne retient que le type `02`, et `isHard` ne les reconnaît pas,
  // donc une piscine ne peut ni absorber ni être absorbée.
  const polys = [...batiments, ...toPiscines(piscines, batiments.length)];
  // edgeIndex n'est nécessaire que pour calculer les composantes légères : il n'est lu
  // par aucun code après buildDataset (composeFor le déclarait sans jamais le consulter).
  // Mesuré à 82,6 Mo sur Angers — 95 % du coût de polys+index — c'est délibérément une
  // variable locale, jamais un champ de Dataset, pour qu'il soit collecté ici.
  const edgeIndex = buildEdgeIndex(polys);
  const components = lightComponents(polys, edgeIndex);
  const absorption = absorptionMap(components);
  const byId = new Map(polys.map(p => [p.id, p]));
  const lightIndex = buildLightIndex(components);

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
    absorption,
    byId,
    lightIndex,
    polyAt(pt: LonLat): Poly | null {
      for (const id of grid.get(cellKey(pt[0], pt[1])) ?? []) {
        const p = polys[id]!;
        if (pointInPoly(pt, p)) return p;
      }
      return null;
    },

    polysNear([[minX, minY], [maxX, maxY]]: [LonLat, LonLat]): Poly[] {
      const vus = new Set<number>();
      const out: Poly[] = [];
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
          for (const id of grid.get(`${cx}:${cy}`) ?? []) {
            if (vus.has(id)) continue;
            vus.add(id);
            out.push(polys[id]!);
          }
        }
      }
      return out;
    },
  };
}
