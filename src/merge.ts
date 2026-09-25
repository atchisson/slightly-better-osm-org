import { topologicalUnion, ringArea } from './geometry/union';
import type { LonLat, Poly, Ring } from './geometry/types';

/**
 * Une voie OSM telle que le bridge la rend.
 *
 * Nommée `OsmWay` et non `OsmBuilding` : la fusion ne s'intéresse qu'aux bâtiments,
 * mais l'amélioration de tracé vise n'importe quelle voie, et les deux lisent la
 * sélection par le même chemin. Un anneau fermé répète son premier sommet ; une ligne
 * ouverte, non.
 */
export interface OsmWay {
  id: string;
  /** anneau fermé : premier sommet === dernier */
  ring: Ring;
  /** nœuds dans l'ordre de `ring`, donc même longueur */
  nodeIds: string[];
  tags: Record<string, string>;
}

export type MergeRefusal =
  | 'pas-deux'          // il n'y a pas exactement deux bâtiments sélectionnés
  | 'geometrie-illisible'
  | 'pas-mitoyens'      // ils ne partagent aucun mur : l'union ne serait pas connexe
  | 'union-impossible'; // pincement, trou, chevauchement… (raison détaillée à part)

export type MergePlan =
  | {
      ok: true;
      /** la voie CONSERVÉE : son id, son historique et ses relations survivent */
      keepId: string;
      /** la voie supprimée, avec ses nœuds devenus inutiles */
      dropId: string;
      /** nouvelle liste de nœuds de la voie conservée, fermée */
      nodeIds: string[];
      tags: Record<string, string>;
      /** clés dont les deux valeurs différaient : celle du plus grand a été retenue */
      tagsEnConflit: string[];
    }
  | { ok: false; reason: MergeRefusal; detail?: string };

const vertexKey = (p: LonLat): string => `${p[0]},${p[1]}`;

const enPoly = (b: OsmWay, id: number): Poly =>
  ({ id, type: '01', outer: b.ring, holes: [] });

/**
 * Fusionne deux bâtiments OSM adjacents en une seule voie.
 *
 * **Pourquoi ce besoin existe.** Un bâtiment à cheval sur deux parcelles est découpé
 * par le cadastre en deux polygones, alors que c'est un seul bâtiment — visible d'un
 * coup d'œil sur une photo aérienne, un seul toit traversé par une limite de
 * propriété. iD ne sait pas les réunir : son opération « Combiner » produit un
 * multipolygone, pas une voie unique.
 *
 * **On CONSERVE une des deux voies** au lieu d'en créer une troisième. Son identifiant,
 * son historique et ses appartenances à des relations survivent ainsi à la fusion — ce
 * qu'une création suivie de deux suppressions détruirait. La voie conservée est la plus
 * grande : c'est celle dont les tags et l'historique ont le plus de chances d'être les
 * plus riches.
 *
 * **Les nœuds du mur devenu intérieur ne sont pas listés ici** : la suppression de la
 * seconde voie les emporte, et c'est iD qui décide lesquels survivent — un nœud encore
 * utilisé par une autre voie, ou porteur de tags, reste. Réimplémenter cette règle
 * serait la dupliquer, et mal.
 *
 * **Les extrémités du mur commun restent dans l'anneau**, comme sommets colinéaires
 * des bords extérieurs. Elles pourraient être supprimées pour faire plus propre, mais
 * rien ici ne permet d'affirmer qu'aucun autre objet ne s'y accroche — une clôture,
 * une adresse, un autre bâtiment. Les retirer sur cette seule présomption casserait
 * ce qui s'y rattache ; un sommet de trop ne casse rien.
 *
 * La géométrie passe par la même union topologique exacte que la composition depuis le
 * cadastre : découpe préalable aux sommets intermédiaires, annulation des arêtes
 * internes, refus si les intérieurs se chevauchent. Tous les sommets de l'anneau uni
 * proviennent des entrées, donc chacun a déjà son nœud OSM — la fusion ne crée aucun
 * nœud et n'en déplace aucun.
 */
export function planMerge(batiments: OsmWay[]): MergePlan {
  if (batiments.length !== 2) return { ok: false, reason: 'pas-deux' };

  for (const b of batiments) {
    if (b.ring.length < 4 || b.nodeIds.length !== b.ring.length) {
      return { ok: false, reason: 'geometrie-illisible', detail: b.id };
    }
  }

  const [a, b] = batiments as [OsmWay, OsmWay];

  // La plus grande est conservée ; en cas d'égalité stricte, la première, pour que le
  // résultat ne dépende pas de l'ordre de sélection.
  const aireA = Math.abs(ringArea(a.ring));
  const aireB = Math.abs(ringArea(b.ring));
  const [garde, jete] = aireB > aireA ? [b, a] : [a, b];

  const united = topologicalUnion([enPoly(a, 1), enPoly(b, 2)]);
  if (!united.ok) {
    // `parties-multiples` a un sens précis ici : les deux bâtiments ne se touchent pas.
    // C'est le cas d'erreur le plus probable, et il mérite son propre message.
    if (united.reason === 'parties-multiples') return { ok: false, reason: 'pas-mitoyens' };
    return { ok: false, reason: 'union-impossible', detail: united.reason };
  }

  // Chaque sommet de l'union vient de l'une des deux entrées : on retrouve son nœud.
  const parSommet = new Map<string, string>();
  for (const src of [a, b]) {
    for (let i = 0; i + 1 < src.ring.length; i++) parSommet.set(vertexKey(src.ring[i]!), src.nodeIds[i]!);
  }

  const nodeIds: string[] = [];
  for (let i = 0; i + 1 < united.ring.length; i++) {
    const id = parSommet.get(vertexKey(united.ring[i]!));
    // Ne peut pas arriver — l'union n'invente aucune coordonnée — mais un sommet sans
    // nœud produirait une voie incohérente, et mieux vaut refuser que la construire.
    if (!id) return { ok: false, reason: 'geometrie-illisible', detail: 'sommet sans nœud' };
    nodeIds.push(id);
  }
  nodeIds.push(nodeIds[0]!);

  // Tags : union des deux. Sur une clé dont les valeurs diffèrent, celle du bâtiment
  // conservé — le plus grand — l'emporte, et la clé est signalée à l'appelant plutôt
  // qu'écrasée en silence.
  const tags: Record<string, string> = { ...jete.tags, ...garde.tags };
  const tagsEnConflit = Object.keys(garde.tags)
    .filter(k => k in jete.tags && jete.tags[k] !== garde.tags[k])
    .sort();

  return { ok: true, keepId: garde.id, dropId: jete.id, nodeIds, tags, tagsEnConflit };
}
