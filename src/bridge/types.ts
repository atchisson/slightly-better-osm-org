import type { ExistingBuilding } from '../conflation/overlap';
import type { ExistingNode } from '../conflation/snap';
import type { LonLat, Ring } from '../geometry/types';

/**
 * Interface étroite entre le reste du projet et les internes d'iD. C'est le seul endroit
 * qui connaît le contexte iD ; tout le reste du projet ne dépend que de ce fichier.
 */
export interface IdBridge {
  mapExtent(): [LonLat, LonLat];
  project(p: LonLat): [number, number];
  invert(p: [number, number]): LonLat; // écran -> coordonnées
  onMapMove(cb: () => void): () => void;
  buildingsNear(extent: [LonLat, LonLat]): ExistingBuilding[];
  nodesNear(pt: LonLat, radiusM: number): ExistingNode[];
  createBuilding(ring: Ring, tags: Record<string, string>, reused: (string | null)[]): void;
  prefillChangeset(comment: string): void;
  containerNode(): HTMLElement;
}
