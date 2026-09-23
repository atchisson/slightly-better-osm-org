import type { LonLat, Poly, Ring } from './types';

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

/**
 * Rectangle englobant d'un anneau, dilaté de `padM` mètres sur les quatre côtés.
 *
 * La dilatation en longitude est calculée au cosinus de la latitude la PLUS ÉLOIGNÉE de
 * l'équateur de l'anneau : c'est celle qui donne le plus grand écart en degrés, donc une
 * boîte conservatrice — jamais plus étroite que `padM` mètres où que ce soit sur
 * l'anneau. Sur un bâtiment (quelques dizaines de mètres) l'écart entre les deux bords
 * est négligeable, mais il est du bon côté.
 */
export function dilatedExtent(ring: Ring, padM: number): [LonLat, LonLat] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const padLat = padM / METRES_PAR_DEGRE_LAT;
  const latLaPlusEloignee = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const cos = Math.cos((latLaPlusEloignee * Math.PI) / 180);
  // Aux pôles cos tend vers 0 : on borne pour ne jamais produire un NaN ni une boîte
  // infinie. Le cadastre français n'y va pas, mais la fonction ne doit pas exploser.
  const padLon = padM / (METRES_PAR_DEGRE_LAT * Math.max(cos, 1e-6));
  return [[minLon - padLon, minLat - padLat], [maxLon + padLon, maxLat + padLat]];
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
