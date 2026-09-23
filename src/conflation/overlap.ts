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
