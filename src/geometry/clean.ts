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
