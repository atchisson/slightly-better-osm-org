import { buildEdgeIndex } from '../geometry/edges';
import { absorptionMap, lightComponents } from '../geometry/components';
import type { LightComponent } from '../geometry/components';
import { pointInRing } from '../geometry/union';
import type { BatType, LonLat, Poly, Ring } from '../geometry/types';

const CELL = 0.002;   // ~150 m : quelques polygones par case

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

export function buildDataset(insee: string, millesime: string, features: unknown[]): Dataset {
  const polys = toPolys(features);
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
    edgeIndex,
    absorption,
    byId,
    lightIndex,
    polyAt(pt: LonLat): Poly | null {
      for (const id of grid.get(cellKey(pt[0], pt[1])) ?? []) {
        const p = polys[id]!;
        if (pointInRing(pt, p.outer)) return p;
      }
      return null;
    },
  };
}
