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

function addAdjacency(adjacency: Map<string, string[]>, from: string, to: string): void {
  const neighbours = adjacency.get(from);
  if (neighbours) {
    neighbours.push(to);
  } else {
    adjacency.set(from, [to]);
  }
}

/**
 * Union topologique exacte d'un ensemble de polygones cadastraux.
 *
 * Contrat : n'opère que sur les anneaux extérieurs (`Poly.outer`) ; `Poly.holes`
 * n'est jamais lu. L'appelant ne doit jamais transmettre un membre porteur d'un
 * trou existant — un tel trou serait silencieusement perdu du résultat. Le
 * refus de composer dès qu'un membre a un trou est la responsabilité de
 * l'appelant (voir la sélection des composantes, en amont), pas de cette
 * fonction.
 */
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
      addAdjacency(adjacency, ka, kb);
      addAdjacency(adjacency, kb, ka);
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

  // Limite connue : pointInRing() repose sur le ray casting, non défini pour un point
  // situé exactement sur une arête du plus grand anneau (un T proche mais non un sommet
  // partagé). Le pire effet possible est un mauvais choix entre 'trou' et
  // 'parties-multiples' — jamais une géométrie erronée, l'union restant de toute façon
  // refusée. Non observé sur les 37 848 bâtiments durs d'Angers ; non corrigé
  // délibérément, le coût d'un point-in-polygon robuste aux bords dépassant la valeur
  // d'un libellé de refus parfois erroné.
  const largest = rings.reduce((a, b) => (Math.abs(ringArea(a)) >= Math.abs(ringArea(b)) ? a : b));
  const nested = rings.every(r => r === largest || pointInRing(r[0]!, largest));
  return { ok: false, reason: nested ? 'trou' : 'parties-multiples' };
}
