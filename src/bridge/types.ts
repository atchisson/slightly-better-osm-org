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
  /**
   * Préremplit le commentaire ET le champ source du panneau de sauvegarde d'iD.
   *
   * `source` n'est pas décoratif : le README l'annonce sous « Règles de contribution
   * françaises » comme preuve de conformité au code de conduite des éditions
   * automatisées, et la Licence Ouverte exige que l'origine et le millésime des données
   * soient portés. La spec §4 déclarait bien `prefillChangeset(comment, source)` ; le
   * paramètre avait disparu à l'implémentation, sans arbitrage.
   */
  prefillChangeset(comment: string, source: string): void;
  containerNode(): HTMLElement;
  /**
   * L'élément dont le coin supérieur gauche **est** l'origine de `project()`.
   *
   * Source de vérité unique de la projection. Le conteneur d'iD (`containerNode`) est la
   * racine de l'éditeur — barre d'outils et panneau latéral compris — et son coin ne
   * coïncide pas avec celui de la surface de carte : le panneau latéral s'ouvre
   * justement à chaque création, puisqu'on appelle `modeSelect`. Un consommateur qui
   * mesurerait la projection contre l'un et dessinerait contre l'autre serait décalé de
   * plusieurs centaines de pixels — et le calque de survol, seul garde-fou contre une
   * annexion erronée (spec §5), serait alors pire qu'absent : il aurait l'air de
   * fonctionner.
   */
  surfaceNode(): Element;
}
