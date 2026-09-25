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

/** Ce que le geste vise : déplacer un sommet, ou insérer un nœud dans un segment. */
export type Intention = 'deplacer' | 'inserer';

/**
 * Ce que le curseur vise sur une voie.
 *
 * **Sans seuil de distance, délibérément.** Une première version n'attrapait un
 * sommet qu'à moins de douze pixels — or le clic sert aussi de DESTINATION : le
 * sommet allait donc au plus à douze pixels de là où il était, moins d'un mètre aux
 * zooms d'édition. Corriger une route décalée de dix mètres était impossible. C'est
 * le modèle de JOSM qui est juste : « a standard click moves the nearest node to the
 * cursor position » — on place le curseur où le sommet doit aller, et le sommet le
 * plus proche l'y rejoint.
 *
 * Il en découle qu'une cible existe toujours, tant que la voie a des sommets. Ce
 * n'est pas gênant : `anneauApres` montre le tracé qui en résulterait, donc un
 * déplacement absurde se voit avant le clic plutôt qu'après.
 *
 * L'intention est donnée par l'appelant et non déduite de la proximité : avec un
 * sommet toujours à portée, l'insertion serait sinon inatteignable — et son inverse
 * l'était dans la version précédente, où l'on ne pouvait pas insérer un nœud près
 * d'un sommet existant.
 */
export function cibleSous(
  ecran: [number, number],
  voie: VoieVisee,
  project: (p: LonLat) => [number, number],
  intention: Intention = 'deplacer',
): Cible | null {
  const { ring, nodeIds } = voie;
  if (ring.length < 2 || nodeIds.length !== ring.length) return null;

  const px = ring.map(project);

  if (intention === 'deplacer') {
    // Un anneau fermé répète son premier sommet : le viser ne doit pas rendre deux
    // cibles concurrentes pour le même nœud.
    const ferme = nodeIds[0] === nodeIds[nodeIds.length - 1];
    const dernier = ferme ? ring.length - 1 : ring.length;

    let meilleur: Cible | null = null;
    for (let i = 0; i < dernier; i++) {
      const [x, y] = px[i]!;
      const d = Math.hypot(x - ecran[0], y - ecran[1]);
      // Strictement inférieur : à égalité, le premier rang gagne, pour que le
      // résultat ne dépende pas de l'ordre de parcours.
      if (meilleur === null || d < meilleur.distancePx) {
        meilleur = { kind: 'noeud', index: i, nodeId: nodeIds[i]!, loc: ring[i]!, distancePx: d };
      }
    }
    return meilleur;
  }

  let meilleur: Cible | null = null;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = px[i]!, b = px[i + 1]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    let t = ((ecran[0] - a[0]) * dx + (ecran[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ecran[0] - (a[0] + t * dx), ecran[1] - (a[1] + t * dy));
    if (meilleur !== null && d >= meilleur.distancePx) continue;

    const ga = ring[i]!, gb = ring[i + 1]!;
    meilleur = {
      kind: 'segment',
      index: i,
      edge: [nodeIds[i]!, nodeIds[i + 1]!],
      // Le point d'insertion est calculé en coordonnées ÉCRAN puis reporté en
      // coordonnées géographiques par la même proportion : il tombe ainsi exactement
      // sur le segment, ce qu'exige l'insertion d'un nœud dans une arête.
      loc: [ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1])],
      distancePx: d,
    };
  }
  return meilleur;
}

/**
 * Le tracé qu'aurait la voie après le geste — ce que l'aperçu doit montrer.
 *
 * Indispensable dès lors qu'un sommet peut parcourir dix mètres : à cette distance,
 * une marque posée sur le sommet de départ ne dit plus rien de la forme obtenue. JOSM
 * montre de même « dashed red line - indicates a way after moved node ».
 *
 * @param destination position du curseur, en coordonnées géographiques ; ignorée pour
 *                    une insertion, dont le point est déjà contraint sur l'arête.
 */
export function anneauApres(voie: VoieVisee, cible: Cible, destination: LonLat): Ring {
  const ring = [...voie.ring];

  if (cible.kind === 'segment') {
    ring.splice(cible.index + 1, 0, cible.loc);
    return ring;
  }

  ring[cible.index] = destination;
  // Un anneau fermé porte son premier sommet deux fois : déplacer l'un sans l'autre
  // ouvrirait la surface.
  const ferme = voie.nodeIds[0] === voie.nodeIds[voie.nodeIds.length - 1];
  if (ferme && cible.index === 0) ring[ring.length - 1] = destination;
  return ring;
}
