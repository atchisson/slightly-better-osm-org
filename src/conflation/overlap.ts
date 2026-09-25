import { pointInRing } from '../geometry/union';
import type { LonLat, Ring } from '../geometry/types';

export interface ExistingBuilding {
  id: string;
  ring: Ring;
  /**
   * Bâtiment ou piscine.
   *
   * Un objet ne fait doublon qu'avec un objet de même nature : une maison qui borde
   * une piscine ne couvre rien de la piscine, et une piscine déjà cartographiée ne
   * serait jamais vue si l'on ne cherchait que des bâtiments. Absent = bâtiment, pour
   * qu'un appelant qui n'a pas à s'en soucier n'ait rien à écrire.
   */
  kind?: 'batiment' | 'piscine';
  /**
   * Les nœuds OSM de ce contour, dans l'ordre de `ring` (donc même longueur, premier
   * et dernier identiques). Ils sont requis pour insérer un sommet DANS le mur de ce
   * bâtiment : une insertion se désigne par l'arête `[idA, idB]` qu'elle coupe, pas
   * par des coordonnées.
   *
   * Optionnels : un contexte iD qui ne les exposerait pas laisse simplement
   * l'insertion de côté, sans rien casser.
   */
  nodeIds?: string[];
}

const bbox = (r: Ring): [number, number, number, number] => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
};

const disjoint = (a: Ring, b: Ring): boolean => {
  const [ax0, ay0, ax1, ay1] = bbox(a);
  const [bx0, by0, bx1, by1] = bbox(b);
  return ax1 <= bx0 || bx1 <= ax0 || ay1 <= by0 || by1 <= ay0;
};

/** Résolution de l'échantillonnage : 60 x 60 sur le rectangle englobant. */
const ECHANTILLONS = 60;

/**
 * Part de l'empreinte à créer déjà couverte, au-delà de laquelle on refuse : 10 %.
 *
 * **Mesurée.** Sur la commune entière de Chargé (37060), confrontée à ses 1 348
 * bâtiments OSM réels, la couverture des 1 422 refus actuels se répartit ainsi :
 *
 * | couverture | refus | ce que c'est |
 * |------------|-------|--------------|
 * | ≤ 10 %     |    22 | un voisin mordille le contour — refus abusif |
 * | 10 à 50 %  |    25 | bâtiment partiellement cartographié — ambigu |
 * | ≥ 50 %     | 1 371 | déjà cartographié — refus justifié |
 *
 * Un premier relevé, sur le seul centre-bourg, montrait un creux vide entre 10 % et
 * 50 % et invitait à poser le seuil au milieu, à 25 %. L'échantillon élargi le dément :
 * ce creux n'existe pas à l'échelle de la commune. Le seuil se choisit donc sur le
 * fond, pas sur la forme de l'histogramme — et le fond, c'est que ce greffon promet de
 * ne jamais dupliquer un bâtiment existant. Au-delà d'un dixième d'empreinte déjà
 * couverte, on refuse ; en dessous, c'est le coin d'un voisin.
 */
export const COUVERTURE_REFUS = 0.10;

/**
 * Le bâtiment OSM qui couvre le plus l'empreinte proposée, si l'ensemble du bâti
 * existant en couvre au moins `seuil` — sinon `null`.
 *
 * **La question n'est pas « quelque chose touche-t-il ? » mais « quelle part est déjà
 * cartographiée ? »** La version précédente refusait dès qu'un sommet, un centre ou
 * une arête de l'un rencontrait l'autre. Constaté en session réelle : un bâtiment de
 * 334 m² dont le centroïde est à **23 m** faisait refuser la création, parce qu'un
 * seul de ses quinze sommets mordait le contour. Couverture réelle : 0,1 %.
 *
 * La couverture est estimée par échantillonnage régulier — pas de découpage de
 * polygones, donc pas d'arithmétique d'intersection, conformément au parti pris du
 * projet. 60 x 60 points sur le rectangle englobant donnent quelques centaines à
 * quelques milliers de points intérieurs, soit une précision de l'ordre du pour cent :
 * très au-delà de ce qu'exige un seuil posé dans un creux large de quarante points.
 * La grille est déterministe, jamais aléatoire : deux clics identiques donnent la même
 * réponse.
 *
 * Cette formulation fait disparaître une limite connue de la précédente, documentée
 * et laissée en l'état : le chevauchement exactement colinéaire, que ni les tests de
 * sommet ni le croisement strict d'arêtes ne voyaient. Une mesure de surface s'en
 * moque.
 *
 * Le coût n'est engagé qu'au CLIC, jamais au survol.
 */
export function overlapsExisting(
  ring: Ring,
  existing: ExistingBuilding[],
  seuil: number = COUVERTURE_REFUS,
): ExistingBuilding | null {
  const candidats = existing.filter(b => !disjoint(ring, b.ring));
  if (candidats.length === 0) return null;

  const [x0, y0, x1, y1] = bbox(ring);
  const parBatiment = new Map<ExistingBuilding, number>();
  let dedans = 0, couverts = 0;

  for (let i = 0; i < ECHANTILLONS; i++) {
    for (let j = 0; j < ECHANTILLONS; j++) {
      const p: LonLat = [
        x0 + ((i + 0.5) / ECHANTILLONS) * (x1 - x0),
        y0 + ((j + 0.5) / ECHANTILLONS) * (y1 - y0),
      ];
      if (!pointInRing(p, ring)) continue;
      dedans++;
      // Le premier candidat qui couvre ce point suffit pour la couverture globale ;
      // on retient lequel, seulement pour pouvoir nommer le principal responsable.
      const couvrant = candidats.find(b => pointInRing(p, b.ring));
      if (!couvrant) continue;
      couverts++;
      parBatiment.set(couvrant, (parBatiment.get(couvrant) ?? 0) + 1);
    }
  }

  if (dedans === 0 || couverts / dedans < seuil) return null;

  let principal: ExistingBuilding | null = null, max = -1;
  for (const [b, n] of parBatiment) {
    if (n > max) { max = n; principal = b; }
  }
  return principal;
}
