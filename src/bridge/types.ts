import type { ExistingBuilding } from '../conflation/overlap';
import type { ExistingNode, Insertion } from '../conflation/snap';
import type { MergePlan, OsmWay } from '../merge';
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
  /**
   * @param reused     par sommet, l'id d'un nœud OSM existant à réutiliser, ou null.
   * @param insertions par sommet, l'arête d'un bâtiment existant dans laquelle
   *                   insérer le nœud créé — le mur devient alors réellement partagé.
   *                   **Ceci modifie un objet existant** ; voir `planInsertions`.
   *                   Tout est joué dans une seule transaction, pour que Ctrl+Z
   *                   défasse création et coutures d'un seul coup.
   */
  createBuilding(
    ring: Ring,
    tags: Record<string, string>,
    reused: (string | null)[],
    insertions?: (Insertion | null)[],
  ): void;
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
   * Attend que la carte d'iD ait fini de s'initialiser — concrètement, que la surface
   * lue par `surfaceNode()` existe réellement dans le DOM — avant de résoudre. Borné :
   * résout `false` si l'attente expire plutôt que de rester en suspens indéfiniment. Ne
   * rejette et ne lève jamais.
   *
   * Raison d'être : l'amorçage d'osm.org est
   * `iD.coreContext().containerNode(container).init()`, une seule chaîne synchrone.
   * `captureContext()` résout dès l'appel de `coreContext()` — avant `.init()`. Un
   * appelant qui utiliserait `surfaceNode()` juste après la capture, sans attendre ce
   * signal, peut donc s'exécuter avant que `init()` n'ait fini de construire la carte :
   * `surfaceNode()` retombe alors sur son repli (le conteneur entier), et tout ce qui en
   * dépend — survol, conversion écran -> coordonnées — est décalé pour toute la session,
   * en silence. Ce correctif fait suite à I1 : la fermeture précédente (`surfaceNode()`
   * qui dit son repli en console) déplaçait le symptôme, elle ne fermait pas la porte
   * par laquelle il arrivait.
   */
  whenSurfaceReady(): Promise<boolean>;
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
  /**
   * La couche cadastre est-elle affichée dans iD ? `null` quand on ne peut pas le
   * savoir — `context.background()` absent ou d'une forme inattendue.
   *
   * **Ce n'est pas une condition d'exactitude.** La géométrie vient de l'API GeoJSON
   * du cadastre (`cadastre.data.gouv.fr`), jamais de la couche affichée : le greffon
   * produirait exactement le même bâtiment sur un fond satellite. Ce que la couche
   * garantit, c'est que l'utilisatrice REGARDE la source qu'elle trace et peut
   * comparer l'aperçu au raster avant de cliquer.
   *
   * D'où son emploi : elle conditionne le raccourci Ctrl, qui n'a aucune affordance
   * visible, et lui seule. Le bouton de la barre d'outils reste un acte explicite,
   * précédé d'un aperçu — il n'a pas besoin de ce garde-fou.
   *
   * La détection se fait sur le NOM et l'identifiant de la source, pas sur un
   * identifiant en dur : l'index d'imagerie d'iD renomme ses entrées, et une
   * correspondance sur le radical « cadastr » survit à ça — elle attrape aussi
   * « Plan Cadastral Informatisé », le nom de la couche dont viennent nos données. Elle couvre le fond de carte comme
   * les calques superposés, puisque le cadastre est proposé des deux façons.
   *
   * `null` n'est jamais traité comme « oui » : un déclencheur sans affordance exige
   * un contexte vérifié, faute de quoi le raccourci reste désactivé (et le dit).
   */
  cadastreVisible(): boolean | null;
  /**
   * Les bâtiments actuellement sélectionnés dans iD, avec leurs nœuds et leurs tags.
   *
   * Rend un tableau vide si la sélection n'est pas lisible ou ne contient pas que des
   * voies fermées taguées `building` — l'appelant n'a alors rien à proposer.
   */
  selectedBuildings(): OsmWay[];
  /**
   * Toutes les voies sélectionnées, bâtiments ou non.
   *
   * Distincte de `selectedBuildings`, qui refuse tout ce qui n'est pas une voie fermée
   * taguée `building` — la fusion n'a de sens que là. L'amélioration de tracé, elle,
   * vise n'importe quelle voie : un chemin, une haie, un contour de parcelle.
   * Lecture seule, comme sa voisine.
   */
  selectedWays(): OsmWay[];
  /**
   * Déplace un nœud existant. Une transaction, donc un `Ctrl+Z`.
   *
   * **Ne passe par aucune action nommée d'iD** : `perform` accepte n'importe quelle
   * fonction de graphe, et `osmNode.move()` est déjà employé par `actionAddMidpoint`,
   * dont le fonctionnement est vérifié en session. Une primitive de moins à supposer.
   */
  moveNode(nodeId: string, loc: LonLat): void;
  /**
   * Insère un nœud au milieu d'une arête existante, désignée par ses deux nœuds.
   *
   * `actionAddMidpoint` coud le nœud dans TOUTES les voies portant cette arête : sur
   * une route, c'est le comportement voulu à une jonction.
   */
  insertNodeOnEdge(edge: [string, string], loc: LonLat): void;
  /**
   * Ce nœud appartient-il à plus d'une voie ? `null` si on ne peut pas le savoir.
   *
   * Sert à prévenir AVANT le clic : sur une route, les jonctions sont partout, et
   * déplacer un nœud de jonction déplace la jonction pour toutes les voies qui s'y
   * rejoignent. C'est souvent ce qu'on veut — mais ça doit se voir.
   */
  nodeIsShared(nodeId: string): boolean | null;
  /**
   * Applique une fusion : la voie conservée reçoit la géométrie et les tags unis, la
   * seconde est supprimée.
   *
   * **Opération destructrice** — elle supprime une voie existante. Une seule
   * transaction, donc un seul `Ctrl+Z`. Le nettoyage des nœuds devenus inutiles est
   * laissé à `actionDeleteWay` d'iD, qui sait lesquels sont encore utilisés ailleurs.
   */
  mergeBuildings(plan: Extract<MergePlan, { ok: true }>): void;
  /**
   * Appelle `cb` chaque fois que le menu contextuel d'iD s'ouvre, en lui donnant le
   * menu et un de ses éléments à imiter.
   *
   * Même parti pris que pour la barre d'outils : on ne rend pas des noms de classes
   * mais des ÉLÉMENTS À CLONER, de sorte qu'aucun sélecteur interne d'iD ne sorte de
   * `src/bridge/` (§4 de la spec) et que l'entrée ajoutée ait exactement l'allure des
   * autres. Si le menu n'a pas la forme attendue, `cb` n'est jamais appelé et la
   * console dit ce qui a été trouvé à la place.
   */
  onEditMenu(cb: (slot: { menu: Element; modele: Element }) => void): () => void;
}
