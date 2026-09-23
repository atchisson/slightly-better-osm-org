import { segmentLength } from '../geometry/edges';
import type { LonLat, Ring } from '../geometry/types';

export interface ExistingNode { id: string; loc: LonLat; }
export interface SnapResult {
  ring: Ring;
  /** pour chaque sommet ouvert de l'anneau : l'id du nœud OSM réutilisé, ou null */
  reused: (string | null)[];
}

export const DEFAULT_SNAP_TOLERANCE_M = 0.2;

export function snapToExistingNodes(
  ring: Ring,
  nodes: ExistingNode[],
  toleranceM: number = DEFAULT_SNAP_TOLERANCE_M,
): SnapResult {
  const open = ring.slice(0, -1);
  const taken = new Set<string>();
  const reused: (string | null)[] = [];
  const snapped: LonLat[] = [];

  for (const vertex of open) {
    let best: ExistingNode | null = null;
    let bestDist = toleranceM;
    for (const node of nodes) {
      if (taken.has(node.id)) continue;
      const d = segmentLength(vertex, node.loc);
      if (d <= bestDist) { bestDist = d; best = node; }
    }
    if (best) {
      taken.add(best.id);
      reused.push(best.id);
      snapped.push(best.loc);        // le sommet cadastre cède, le nœud existant ne bouge pas
    } else {
      reused.push(null);
      snapped.push(vertex);
    }
  }

  return { ring: [...snapped, snapped[0]!], reused };
}
