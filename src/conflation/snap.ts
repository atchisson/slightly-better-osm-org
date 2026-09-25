import { dilatedExtent, segmentLength, surSegment } from '../geometry/edges';
import type { ExistingBuilding } from './overlap';
import type { LonLat, Ring } from '../geometry/types';

export interface ExistingNode { id: string; loc: LonLat; }
export interface SnapResult {
  ring: Ring;
  /** pour chaque sommet ouvert de l'anneau : l'id du nœud OSM réutilisé, ou null */
  reused: (string | null)[];
}

export const DEFAULT_SNAP_TOLERANCE_M = 0.2;

interface Candidate { vertexIndex: number; node: ExistingNode; dist: number; }

const compareIds = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

export function snapToExistingNodes(
  ring: Ring,
  nodes: ExistingNode[],
  toleranceM: number = DEFAULT_SNAP_TOLERANCE_M,
): SnapResult {
  const open = ring.slice(0, -1);

  // Borne sur la liste de nœuds — la revue l'avait différée, et elle comptait peu tant
  // que le bridge n'interrogeait qu'une boîte de 2,7 m autour du clic (correctif C1 :
  // il interroge maintenant l'emprise du bâtiment). L'appariement est en
  // O(sommets x nœuds) ; ce préfiltre le ramène aux seuls nœuds qui peuvent
  // physiquement produire un candidat.
  //
  // Il est EXACT, pas approché : un nœud hors du rectangle englobant de l'anneau dilaté
  // de `toleranceM` est à plus de `toleranceM` de TOUS les sommets — il n'aurait produit
  // aucun candidat. Le retirer ne change donc aucun résultat, seulement le coût. La
  // dilatation n'est pas un détail : un nœud voisin situé juste à l'extérieur d'un coin
  // est hors du rectangle BRUT tout en étant à portée, et c'est précisément le cas que
  // ce module existe pour traiter (un coin de bâtiment mitoyen déjà importé).
  //
  // Aucun plafond en nombre par-dessus, délibérément : tronquer une liste déjà réduite
  // aux seuls nœuds à portée reviendrait à laisser tomber en silence une réutilisation
  // légitime — le mode d'échec exact que ce correctif existe pour supprimer. Le
  // préfiltre borne déjà le coût par une quantité géographique (les nœuds OSM à 20 cm du
  // contour d'un bâtiment), pas par un compteur arbitraire.
  const [[minLon, minLat], [maxLon, maxLat]] = dilatedExtent(ring, toleranceM);
  const bounded = nodes.filter(n =>
    n.loc[0] >= minLon && n.loc[0] <= maxLon && n.loc[1] >= minLat && n.loc[1] <= maxLat);

  // Attribution globale au plus proche, et non gloutonne dans l'ordre de l'anneau : un
  // sommet rencontré en premier ne doit pas pouvoir s'approprier un nœud sur lequel un
  // sommet plus tardif tombe exactement. On forme donc tous les couples (sommet, nœud) à
  // portée, on les trie par distance croissante, puis on les attribue dans cet ordre en
  // ne retenant un couple que si ni son sommet ni son nœud n'est déjà pris. Le
  // départage — par index de sommet puis par id de nœud — rend le résultat indépendant
  // de tout ordre d'itération (celui des nœuds fournis en entrée compris).
  const candidates: Candidate[] = [];
  for (let i = 0; i < open.length; i++) {
    const vertex = open[i]!;
    for (const node of bounded) {
      const dist = segmentLength(vertex, node.loc);
      if (dist <= toleranceM) candidates.push({ vertexIndex: i, node, dist });
    }
  }
  candidates.sort((a, b) =>
    a.dist - b.dist ||
    a.vertexIndex - b.vertexIndex ||
    compareIds(a.node.id, b.node.id),
  );

  const assigned = new Array<ExistingNode | null>(open.length).fill(null);
  const takenNodeIds = new Set<string>();
  for (const c of candidates) {
    if (assigned[c.vertexIndex] !== null) continue;
    if (takenNodeIds.has(c.node.id)) continue;
    assigned[c.vertexIndex] = c.node;
    takenNodeIds.add(c.node.id);
  }

  const reused: (string | null)[] = [];
  const snapped: LonLat[] = [];
  for (let i = 0; i < open.length; i++) {
    const node = assigned[i];
    if (node) {
      reused.push(node.id);
      // copie : le sommet cadastre cède, le nœud existant ne bouge pas — et le tableau
      // renvoyé ne doit jamais partager sa référence avec `node.loc`, sous peine qu'une
      // édition ultérieure de l'anneau déplace silencieusement le nœud existant.
      snapped.push([node.loc[0], node.loc[1]]);
    } else {
      reused.push(null);
      snapped.push(open[i]!);
    }
  }

  return { ring: [...snapped, snapped[0]!], reused };
}

/** Une arête d'un bâtiment OSM existant, dans laquelle insérer un nœud créé. */
export interface Insertion { wayId: string; edge: [string, string]; }

/**
 * Pour chaque sommet non recalé, l'arête d'un bâtiment OSM existant sur laquelle il
 * tombe — afin que le nœud créé y soit INSÉRÉ et que le mur devienne réellement
 * partagé, au lieu de deux murs superposés sans nœud commun.
 *
 * **Ceci modifie un objet existant**, et c'est un choix assumé (voir le README). Un
 * sommet inséré fait passer le mur du voisin par notre point : sa géométrie change,
 * d'au plus `toleranceM`. C'est pourquoi la tolérance reste celle du recalage — 20 cm
 * — et non une valeur confortable : au-delà, on ne recoudrait plus un mur commun, on
 * déformerait le bâtiment de quelqu'un d'autre.
 *
 * Le cas visé est celui du bâti mitoyen déjà importé depuis le cadastre : les
 * géométries s'accordent alors au centimètre, mais notre coin tombe au MILIEU du mur
 * du voisin, où il n'y a aucun nœud à réutiliser. C'est exactement la T-jonction que
 * l'union règle entre polygones cadastraux, transposée à la frontière avec OSM.
 *
 * Un bâtiment tracé sur imagerie et décalé d'un mètre reste hors de portée, et c'est
 * voulu : le souder reviendrait à propager une erreur de calage.
 *
 * @param reused résultat de `snapToExistingNodes` : un sommet déjà recalé sur un nœud
 *               existant n'a rien à faire ici, il partage déjà ce nœud.
 */
export function planInsertions(
  ring: Ring,
  reused: (string | null)[],
  buildings: ExistingBuilding[],
  toleranceM: number = DEFAULT_SNAP_TOLERANCE_M,
): (Insertion | null)[] {
  const open = ring.slice(0, -1);
  const plan: (Insertion | null)[] = new Array(open.length).fill(null);

  for (let i = 0; i < open.length; i++) {
    if (reused[i]) continue;
    const vertex = open[i]!;

    let meilleur: { ins: Insertion; ecart: number } | null = null;
    for (const b of buildings) {
      const ids = b.nodeIds;
      if (!ids || ids.length !== b.ring.length) continue;
      for (let j = 0; j + 1 < b.ring.length; j++) {
        const a = b.ring[j]!, c = b.ring[j + 1]!;
        const { t, ecart } = surSegment(vertex, a, c);
        // Strictement À L'INTÉRIEUR de l'arête : aux extrémités il y a déjà un nœud,
        // que `snapToExistingNodes` a eu sa chance de réutiliser. Y insérer un second
        // nœud créerait un doublon au même endroit.
        if (t <= 0 || t >= 1 || ecart > toleranceM) continue;
        const idA = ids[j]!, idB = ids[j + 1]!;
        if (meilleur === null || ecart < meilleur.ecart) {
          meilleur = { ins: { wayId: b.id, edge: [idA, idB] }, ecart };
        }
      }
    }
    if (meilleur) plan[i] = meilleur.ins;
  }

  return plan;
}
