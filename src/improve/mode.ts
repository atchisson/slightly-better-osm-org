import { cibleSous, type Cible } from './target';
import type { OsmWay } from '../merge';
import type { LonLat } from '../geometry/types';

export interface ImproveHooks {
  /** la sélection courante d'iD, relue à chaque survol */
  selectedWays(): OsmWay[];
  project(p: LonLat): [number, number];
  showTarget(loc: LonLat, kind: 'noeud' | 'segment'): void;
  hideTarget(): void;
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
}

/**
 * Mode d'amélioration de tracé — étape 1 : viser et montrer, sans rien modifier.
 *
 * Il ne touche à aucun objet. C'est délibéré : le coût d'en rester là est nul, alors
 * que les étapes suivantes déplacent et suppriment des nœuds d'autrui. Cette étape
 * prouve la détection de cible et le retour visuel, qui sont de toute façon la
 * condition de sûreté des suivantes — un geste destructeur sans aperçu n'est pas
 * acceptable.
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

  return {
    isEnabled: () => actif,
    enable() { actif = true; },
    disable() { actif = false; oublier(); },
    cible: () => courante,

    hoverAt(ecran) {
      if (!actif) return;
      const voies = hooks.selectedWays();
      if (voies.length !== 1) { oublier(); return; }

      const c = cibleSous(ecran, voies[0]!, hooks.project);
      if (!c) { oublier(); return; }
      courante = c;
      hooks.showTarget(c.loc, c.kind);
    },

    hoverEnd: oublier,
  };
}
