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

// Signe de (q - p) x (r - p) : >0 à gauche, <0 à droite, 0 aligné.
const orientation = (p: LonLat, q: LonLat, r: LonLat): number => {
  const val = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (val > 0) return 1;
  if (val < 0) return -1;
  return 0;
};

/**
 * Croisement strict de deux segments : les sommets de l'un doivent tomber de part et
 * d'autre de l'autre segment, dans les deux sens. Volontairement strict (aucun signe nul
 * accepté) : un mur mitoyen donne des segments colinéaires et confondus sur une portion,
 * donc des orientations nulles — ce n'est pas un croisement, juste un contact, et il ne
 * doit pas être signalé comme un recouvrement (70,3 % des bâtiments cadastre durs sont
 * mitoyens d'un autre).
 */
const segmentsCross = (a1: LonLat, a2: LonLat, b1: LonLat, b2: LonLat): boolean => {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
};

const anyEdgeCrosses = (a: Ring, b: Ring): boolean => {
  for (let i = 0; i < a.length - 1; i++) {
    const a1 = a[i]!, a2 = a[i + 1]!;
    for (let j = 0; j < b.length - 1; j++) {
      const b1 = b[j]!, b2 = b[j + 1]!;
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
};

export function overlapsExisting(ring: Ring, existing: ExistingBuilding[]): ExistingBuilding | null {
  for (const candidate of existing) {
    if (disjoint(ring, candidate.ring)) continue;
    // recouvrement si un sommet ou le centre de l'un tombe à l'intérieur de l'autre,
    // ou si une arête de l'un traverse réellement une arête de l'autre (cas non couvert
    // par les tests de sommet/centre : deux anneaux peuvent se croiser sans qu'aucun
    // sommet de l'un ne tombe dans l'autre).
    const hit =
      ring.slice(0, -1).some(p => pointInRing(p, candidate.ring)) ||
      candidate.ring.slice(0, -1).some(p => pointInRing(p, ring)) ||
      pointInRing(centroid(ring), candidate.ring) ||
      pointInRing(centroid(candidate.ring), ring) ||
      anyEdgeCrosses(ring, candidate.ring);
    if (hit) return candidate;
  }
  return null;
}
