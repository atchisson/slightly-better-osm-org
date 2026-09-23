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

  // Contrat de topologicalUnion : elle n'opère que sur les anneaux extérieurs et ne lit
  // jamais Poly.holes. Un trou porté par N'IMPORTE QUEL membre — l'ancre ou un léger
  // absorbé — serait donc silencieusement perdu si on laissait passer l'union. D'où le
  // refus sur l'ensemble des membres, pas seulement sur le polygone visé par l'appelant.
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
