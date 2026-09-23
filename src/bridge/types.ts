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
  /**
   * Nœuds OSM existants, éligibles au recalage, dans l'étendue demandée.
   *
   * Prend une ÉTENDUE et non un point + rayon : les sommets à recoudre sont les COINS
   * de l'anneau composé, pas le point cliqué. Un rayon centré sur le clic ne les
   * atteint pas — sur une maison médiane d'Angers (83 m², ~9,1 m de côté), ses coins
   * sont à 4,56 m du centre sur chaque axe, hors de portée de l'ancienne boîte
   * (±4,00 m en latitude, ±2,70 m en longitude à 47,5° N). La réutilisation de nœuds,
   * décision validée de la spec §2 (70 % du bâti est mitoyen), ne se déclenchait donc
   * quasiment jamais, en silence.
   */
  nodesIn(extent: [LonLat, LonLat]): ExistingNode[];
  createBuilding(ring: Ring, tags: Record<string, string>, reused: (string | null)[]): void;
  prefillChangeset(comment: string): void;
  containerNode(): HTMLElement;
}
