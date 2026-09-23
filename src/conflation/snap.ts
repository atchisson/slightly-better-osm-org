import { segmentLength } from '../geometry/edges';
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
    for (const node of nodes) {
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
