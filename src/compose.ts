import { dropCollinear, isDegenerate, simplify } from './geometry/clean';
import { dilatedExtent } from './geometry/edges';
import { pointInPoly, topologicalUnion } from './geometry/union';
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
  /**
   * Voisinage indexé d'une étendue (sur-ensemble) ; à défaut, `polys` entier — acceptable
   * en test seulement. Sert à protéger les sommets partagés avec un bâtiment voisin, voir
   * `sommetsPartages`.
   */
  polysNear?: (extent: [LonLat, LonLat]) => Poly[];
  simplifyToleranceM?: number;
}

export type RefusalReason =
  | 'aucun-batiment' | 'trou-source' | 'degenere'
  | 'pincement' | 'trou' | 'parties-multiples' | 'vide' | 'chevauchement';

export type Composition =
  | {
      ok: true; ring: Ring; anchorId: number; absorbed: number[];
      isolatedLight: boolean;
      /** une piscine ne se tague pas comme un bâtiment, et ne fusionne avec rien */
      isPiscine: boolean;
    }
  | { ok: false; reason: RefusalReason };

const isHard = (p: Poly): boolean => p.type === '01' || p.type === '03';
const isPiscine = (p: Poly): boolean => p.type === 'piscine';

const vertexKey = (p: LonLat): string => `${p[0]},${p[1]}`;

/**
 * Sommets de `ring` qui appartiennent aussi à un polygone cadastre NON membre de
 * l'union — c'est-à-dire aux bâtiments voisins.
 *
 * Pourquoi c'est nécessaire (spec §5 étape 6, corrigée) : le PCI est topologiquement
 * propre, deux bâtiments mitoyens partagent des sommets exacts. Un de ces sommets
 * partagés peut être quasi colinéaire SUR NOTRE anneau sans l'être sur celui du voisin —
 * mesuré sur la fixture réelle d'Angers : le polygone 99 en porte deux, à 1,1 mm et
 * 0,6 mm de leur corde, tous deux partagés avec un voisin. `dropCollinear` (2 cm), et à
 * plus forte raison `simplify` (20 cm), les supprimaient. Deux conséquences, toutes deux
 * silencieuses :
 *
 *  - le nœud OSM déjà importé du voisin est là, mais nous n'avons plus de sommet à
 *    recaler dessus : le mur mitoyen ne peut pas être recousu, même une fois C1 corrigé ;
 *  - quand ce voisin sera créé plus tard par ce même outil, SON sommet — non colinéaire
 *    sur son propre anneau, donc conservé — tombera au milieu de notre arête, sans nœud
 *    partagé. C'est l'artefact d'import classique que la communauté FR demande d'éviter.
 *
 * Le nettoyage précédant le recalage (étapes 6 puis 8), le défaut est structurel : il se
 * corrige au nettoyage, pas au recalage.
 */
function sommetsPartages(ring: Ring, membres: Set<number>, input: ComposeInput): Set<string> {
  // Seuls les sommets DE NOTRE ANNEAU peuvent être protégés : on teste l'appartenance
  // dans ce sens-là, sur un ensemble d'une dizaine d'éléments, plutôt que d'accumuler
  // tous les sommets du voisinage.
  const surAnneau = new Set(ring.slice(0, -1).map(vertexKey));
  const voisins = input.polysNear
    ? input.polysNear(dilatedExtent(ring, 0))
    : input.polys;                       // balayage linéaire : test seulement
  const partages = new Set<string>();
  for (const p of voisins) {
    if (membres.has(p.id)) continue;
    for (const v of p.outer) {
      const k = vertexKey(v);
      if (surAnneau.has(k)) partages.add(k);
    }
    for (const trou of p.holes) {
      for (const v of trou) {
        const k = vertexKey(v);
        if (surAnneau.has(k)) partages.add(k);
      }
    }
  }
  return partages;
}

function hit(pt: LonLat, input: ComposeInput): Poly | null {
  if (input.polyAt) return input.polyAt(pt);
  for (const p of input.polys) if (pointInPoly(pt, p)) return p;
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
  // Une piscine n'absorbe rien : elle n'est pas un bâtiment, et rien ne doit jamais
  // la réunir à un abri de jardin qui la borde.
  if (isPiscine(anchor)) return [];
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

  // Les sommets partagés avec un bâtiment voisin sont inamovibles : les supprimer
  // découdrait le mur mitoyen, en silence (voir sommetsPartages).
  const partages = sommetsPartages(united.ring, new Set(members.map(m => m.id)), input);
  const inamovible = (p: LonLat): boolean => partages.has(vertexKey(p));
  const cleaned = simplify(
    dropCollinear(united.ring, undefined, inamovible),
    input.simplifyToleranceM,
    inamovible,
  );
  if (isDegenerate(cleaned)) return { ok: false, reason: 'degenere' };

  return {
    ok: true,
    ring: cleaned,
    anchorId,
    absorbed: [...absorbed].sort((a, b) => a - b),
    isolatedLight: !isHard(anchor) && !isPiscine(anchor),
    isPiscine: isPiscine(anchor),
  };
}

export function composeAt(pt: LonLat, input: ComposeInput): Composition {
  const poly = hit(pt, input);
  if (!poly) return { ok: false, reason: 'aucun-batiment' };
  if (poly.holes.length > 0) return { ok: false, reason: 'trou-source' };
  return composeFor(anchorOf(poly, input), input);
}
