import type { LonLat, Ring } from '../geometry/types';

/** Une voie OSM telle que la vise le mode d'amélioration. */
export interface VoieVisee {
  /** anneau (fermé pour une surface, ouvert pour une ligne) */
  ring: Ring;
  /** nœuds dans l'ordre de `ring`, donc même longueur */
  nodeIds: string[];
}

export type Cible =
  | {
      kind: 'noeud';
      /** rang du sommet dans `ring` */
      index: number;
      nodeId: string;
      loc: LonLat;
      /** distance au curseur, en pixels */
      distancePx: number;
    }
  | {
      kind: 'segment';
      /** rang du segment : de `ring[index]` à `ring[index + 1]` */
      index: number;
      /** les deux nœuds qui bornent le segment, pour désigner l'arête à couper */
      edge: [string, string];
      /** point du segment le plus proche du curseur — là où un nœud serait inséré */
      loc: LonLat;
      distancePx: number;
    };

/** Seuil de capture par défaut, en pixels. */
export const SEUIL_PX = 12;

/**
 * Ce que le curseur vise sur une voie : un de ses sommets, un de ses segments, ou rien.
 *
 * **Le seuil est en PIXELS, jamais en mètres.** Viser est une tâche de pointage : un
 * seuil métrique capturerait la moitié d'un quartier au zoom 16 et deviendrait
 * inatteignable au zoom 22. C'est aussi le seul endroit du projet où une distance
 * n'est pas géographique, et c'est délibéré.
 *
 * **Un sommet l'emporte sur un segment** à portée égale : c'est la règle de JOSM, et
 * c'est ce qui rend le déplacement d'un sommet atteignable — sans elle, le segment
 * adjacent, toujours à distance nulle du sommet, gagnerait toujours.
 *
 * Le point d'insertion sur un segment est calculé en coordonnées ÉCRAN puis reporté
 * en coordonnées géographiques par la même proportion. Il tombe ainsi exactement sur
 * le segment, ce qu'exige l'insertion d'un nœud dans une arête : un point simplement
 * « proche » déformerait la voie au lieu de la préciser.
 */
export function cibleSous(
  ecran: [number, number],
  voie: VoieVisee,
  project: (p: LonLat) => [number, number],
  seuilPx: number = SEUIL_PX,
): Cible | null {
  const { ring, nodeIds } = voie;
  if (ring.length < 2 || nodeIds.length !== ring.length) return null;

  const px = ring.map(project);

  // Un anneau fermé répète son premier sommet : le viser ne doit pas rendre deux
  // cibles concurrentes pour le même nœud. On ignore donc la répétition finale.
  const ferme = nodeIds.length > 1 && nodeIds[0] === nodeIds[nodeIds.length - 1];
  const dernierSommet = ferme ? ring.length - 1 : ring.length;

  let meilleurNoeud: Cible | null = null;
  for (let i = 0; i < dernierSommet; i++) {
    const [x, y] = px[i]!;
    const d = Math.hypot(x - ecran[0], y - ecran[1]);
    // Strictement inférieur : à égalité, le premier rang gagne, pour que le résultat
    // ne dépende pas de l'ordre de parcours.
    if (d <= seuilPx && (meilleurNoeud === null || d < meilleurNoeud.distancePx)) {
      meilleurNoeud = { kind: 'noeud', index: i, nodeId: nodeIds[i]!, loc: ring[i]!, distancePx: d };
    }
  }
  if (meilleurNoeud) return meilleurNoeud;

  let meilleurSegment: Cible | null = null;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = px[i]!, b = px[i + 1]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    let t = ((ecran[0] - a[0]) * dx + (ecran[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ecran[0] - (a[0] + t * dx), ecran[1] - (a[1] + t * dy));
    if (d > seuilPx || (meilleurSegment !== null && d >= meilleurSegment.distancePx)) continue;

    const ga = ring[i]!, gb = ring[i + 1]!;
    meilleurSegment = {
      kind: 'segment',
      index: i,
      edge: [nodeIds[i]!, nodeIds[i + 1]!],
      loc: [ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1])],
      distancePx: d,
    };
  }
  return meilleurSegment;
}
