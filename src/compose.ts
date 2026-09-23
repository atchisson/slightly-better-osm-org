import { dropCollinear, isDegenerate, simplify } from './geometry/clean';
import { pointInRing, topologicalUnion } from './geometry/union';
import type { LonLat, Poly, Ring } from './geometry/types';

export interface ComposeInput {
  polys: Poly[];
  absorption: Map<number, number[]>;
  /** id -> polygone ; construit une fois par commune, jamais par appel */
  byId: Map<number, Poly>;
  /** id d'un léger -> sa composante entière et son propriétaire éventuel */
  lightIndex: Map<number, { ownerId: number | null; members: number[] }>;
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

/**
 * Ancre d'un polygone : lui-même s'il est porteur, sinon le propriétaire de sa
 * composante légère. Sans propriétaire — composante orpheline, spec §5 étape 2 :
 * « l'ancre est la composante elle-même » —, l'ancre canonique est le plus petit
 * identifiant de la composante, jamais le polygone cliqué : lightComponents() trie déjà
 * `members` par id croissant, donc entry.members[0] est stable quel que soit le membre
 * par lequel on est entré. C'est ce qui rend composeAt symétrique sur une composante
 * orpheline à plusieurs membres, pas seulement sur le cas dur+léger : cliquer n'importe
 * lequel des 19 membres d'un même groupe doit résoudre à la même ancre.
 */
function anchorOf(poly: Poly, input: ComposeInput): number {
  if (isHard(poly)) return poly.id;
  const entry = input.lightIndex.get(poly.id);
  if (!entry) return poly.id;            // absent de l'index : replié sur lui-même
  if (entry.ownerId !== null) return entry.ownerId;
  return entry.members[0]!;              // orpheline : ancre canonique = plus petit id
}

/**
 * Membres absorbés par une ancre : le reste de sa composante légère (dur, via
 * `absorption`) ou, pour une composante légère orpheline dont l'ancre canonique est
 * l'anchorId reçu, le reste de cette composante — c'est la traduction directe de
 * « sans propriétaire, l'ancre est la composante elle-même » : tous les membres
 * orphelins doivent être unis, pas seulement celui qui a été visé.
 */
function absorbedBy(anchor: Poly, anchorId: number, input: ComposeInput): number[] {
  if (isHard(anchor)) return input.absorption.get(anchorId) ?? [];
  const entry = input.lightIndex.get(anchorId);
  if (entry?.ownerId !== null) return [];
  return entry.members.filter(id => id !== anchorId);
}

export function composeFor(anchorId: number, input: ComposeInput): Composition {
  const anchor = input.byId.get(anchorId);
  if (!anchor) return { ok: false, reason: 'aucun-batiment' };

  const absorbed = absorbedBy(anchor, anchorId, input);
  const members = [anchor, ...absorbed.map(id => input.byId.get(id)!).filter(Boolean)];

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
