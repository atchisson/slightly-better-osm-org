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
