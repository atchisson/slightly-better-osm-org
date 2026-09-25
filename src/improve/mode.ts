import { cibleSous, type Cible } from './target';
import type { OsmWay } from '../merge';
import type { LonLat } from '../geometry/types';

export interface ImproveHooks {
  /** la sélection courante d'iD, relue à chaque survol */
  selectedWays(): OsmWay[];
  project(p: LonLat): [number, number];
  showTarget(loc: LonLat, kind: 'noeud' | 'segment', partage: boolean): void;
  hideTarget(): void;
  moveNode(nodeId: string, loc: LonLat): void;
  insertNodeOnEdge(edge: [string, string], loc: LonLat): void;
  /** `null` quand on ne peut pas le savoir — jamais confondu avec « non » */
  nodeIsShared(nodeId: string): boolean | null;
  /** conversion écran -> géographique, pour poser le nœud SOUS le curseur */
  invert(ecran: [number, number]): LonLat;
}

export interface ImproveMode {
  isEnabled(): boolean;
  enable(): void;
  disable(): void;
  /** @param ecran position du curseur, relative à la surface de carte */
  hoverAt(ecran: [number, number]): void;
  hoverEnd(): void;
  /** ce que le prochain clic viserait — null si rien n'est visé */
  cible(): Cible | null;
  /**
   * Agit sur la cible courante. Rend `true` si quelque chose a été fait, de sorte que
   * l'appelant sache s'il doit empêcher iD de traiter le même clic.
   */
  clickAt(ecran: [number, number]): boolean;
}

/**
 * Mode d'amélioration de tracé : viser, puis déplacer ou ajouter un nœud.
 *
 * Pensé pour les routes. La cible décide du geste — un sommet se déplace, un segment
 * reçoit un nœud — de sorte qu'aucun second modificateur ne soit à mémoriser. La
 * suppression, elle, n'est pas fournie : elle demande une règle de sûreté (refuser un
 * nœud partagé ou tagué) qui repose sur des primitives d'iD non vérifiées, et elle
 * n'a pas été demandée.
 *
 * **Aucune confirmation, par décision explicite.** Ce qui tient lieu de garde-fou :
 * l'aperçu, permanent et obligatoire, et une action par clic — donc un `Ctrl+Z` par
 * geste. C'est le contrat de JOSM.
 *
 * **La sélection est relue à chaque survol**, jamais mémorisée à l'armement :
 * l'utilisateur peut changer de voie sans relâcher Ctrl, et une sélection figée
 * viserait alors une voie qu'il ne regarde plus.
 *
 * Il ne vise que si **exactement une** voie est sélectionnée. À plusieurs, « le nœud
 * le plus proche » devient ambigu, et un clic mal placé toucherait un objet que
 * l'utilisateur ne croyait pas viser.
 */
export function createImproveMode(hooks: ImproveHooks): ImproveMode {
  let actif = false;
  let courante: Cible | null = null;

  const oublier = (): void => {
    if (courante === null) return;
    courante = null;
    hooks.hideTarget();
  };

  // Fonction nommée plutôt que méthode : `clickAt` la réutilise, et passer par `this`
  // casserait dès qu'un appelant déstructure le mode.
  const survoler = (ecran: [number, number]): void => {
    if (!actif) return;
    const voies = hooks.selectedWays();
    if (voies.length !== 1) { oublier(); return; }

    const c = cibleSous(ecran, voies[0]!, hooks.project);
    if (!c) { oublier(); return; }
    courante = c;
    // Sur une route, les jonctions sont partout : déplacer un nœud de jonction
    // déplace la jonction pour toutes les voies qui s'y rejoignent. C'est souvent ce
    // qu'on veut, mais ça doit se voir AVANT le clic. `null` (indéterminable) est
    // traité comme « non partagé » pour l'affichage : on ne crie pas au loup sans
    // savoir, et aucune action n'en dépend.
    const partage = c.kind === 'noeud' && hooks.nodeIsShared(c.nodeId) === true;
    hooks.showTarget(c.loc, c.kind, partage);
  };

  return {
    isEnabled: () => actif,
    enable() { actif = true; },
    disable() { actif = false; oublier(); },
    cible: () => courante,
    hoverAt: survoler,
    hoverEnd: oublier,

    clickAt(ecran) {
      if (!actif) return false;
      // La cible est RECALCULÉE au clic, jamais reprise du dernier survol : entre les
      // deux, la carte a pu bouger sous le curseur.
      survoler(ecran);
      const c = courante;
      if (!c) return false;

      // Le nœud va SOUS LE CURSEUR, pas sur la cible affichée : celle-ci marque le
      // sommet à déplacer, pas sa destination.
      if (c.kind === 'noeud') hooks.moveNode(c.nodeId, hooks.invert(ecran));
      else hooks.insertNodeOnEdge(c.edge, c.loc);

      oublier();
      return true;
    },
  };
}
