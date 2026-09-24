import { segmentLength } from './edges';
import { ringArea } from './union';
import type { LonLat, Ring } from './types';

/** distance du point p au segment [a,b], en mètres */
function distanceToSegment(p: LonLat, a: LonLat, b: LonLat): number {
  const len = segmentLength(a, b);
  if (len === 0) return segmentLength(p, a);
  const lat = (a[1] * Math.PI) / 180;
  const sx = Math.cos(lat);
  const ax = a[0] * sx, bx = b[0] * sx, px = p[0] * sx;
  const t = ((px - ax) * (bx - ax) + (p[1] - a[1]) * (b[1] - a[1])) /
            ((bx - ax) ** 2 + (b[1] - a[1]) ** 2);
  const clamped = Math.max(0, Math.min(1, t));
  const proj: LonLat = [a[0] + clamped * (b[0] - a[0]), a[1] + clamped * (b[1] - a[1])];
  return segmentLength(p, proj);
}

export function isDegenerate(ring: Ring): boolean {
  const distinct = new Set(ring.slice(0, -1).map(p => `${p[0]},${p[1]}`));
  if (distinct.size < 3) return true;
  return Math.abs(ringArea(ring)) === 0;
}

/**
 * Douglas-Peucker sur un anneau fermé : on l'ouvre, on l'ancre au sommet 0 et
 * à celui le plus éloigné de 0 (le découpage en deux chaînes propre à un
 * anneau qui n'a pas d'extrémité naturelle), puis on récurse normalement sur
 * chaque chaîne. Garde-fou : ne redescend jamais sous un triangle, que ce
 * soit avant même d'entrer en récursion (anneau déjà à 3 sommets) ou après
 * (la récursion elle-même a fait tomber le nombre de sommets conservés
 * sous 3).
 *
 * Implémentation unique, partagée par dropCollinear et simplify : les deux
 * fonctions exportées ne diffèrent que par la tolérance qu'elles lui passent.
 * Douglas-Peucker garantit par construction qu'aucun sommet supprimé ne se
 * trouve jamais à plus de toleranceM de la ligne brisée conservée — une
 * garantie qu'un test de colinéarité sommet-par-sommet ne peut pas offrir sur
 * un anneau : une version antérieure de dropCollinear comparait chaque
 * sommet à un repère (le dernier sommet conservé) qui dérivait au fil des
 * suppressions, et pouvait ainsi laisser passer une bosse réelle de plusieurs
 * mètres sans jamais la mesurer contre la vraie corde. Voir les tests de
 * régression dans clean.test.ts.
 */
function douglasPeuckerRing(
  ring: Ring,
  toleranceM: number,
  keepVertex?: (p: LonLat) => boolean,
): Ring {
  const open = ring.slice(0, -1);
  if (open.length <= 3) return ring;

  const keep = new Set<number>();
  const recurse = (first: number, last: number): void => {
    let worst = -1;
    let worstDist = toleranceM;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(open[i]!, open[first]!, open[last]!);
      if (d > worstDist) { worstDist = d; worst = i; }
    }
    if (worst === -1) return;
    keep.add(worst);
    recurse(first, worst);
    recurse(worst, last);
  };

  // anneau fermé : on le coupe en deux chaînes autour du sommet le plus éloigné du départ
  let far = 1;
  let farDist = -1;
  for (let i = 1; i < open.length; i++) {
    const d = segmentLength(open[0]!, open[i]!);
    if (d > farDist) { farDist = d; far = i; }
  }

  // Ancres : les deux extrémités naturelles des chaînes (0, le plus éloigné, le
  // dernier) PLUS tout sommet déclaré inamovible par l'appelant. Découper en davantage
  // de chaînes ne peut que réduire l'erreur — la garantie de Douglas-Peucker (aucun
  // sommet supprimé à plus de `toleranceM` de la ligne brisée conservée) tient donc
  // toujours, chaîne par chaîne, et donc sur l'anneau entier.
  const ancres = new Set<number>([0, far, open.length - 1]);
  if (keepVertex) {
    for (let i = 0; i < open.length; i++) if (keepVertex(open[i]!)) ancres.add(i);
  }
  const bornes = [...ancres].sort((a, b) => a - b);
  for (const i of bornes) keep.add(i);
  for (let k = 0; k + 1 < bornes.length; k++) recurse(bornes[k]!, bornes[k + 1]!);

  const kept = [...keep].sort((a, b) => a - b).map(i => open[i]!);
  if (kept.length < 3) return ring;
  return [...kept, kept[0]!];
}

/**
 * Supprime les sommets laissés (quasi-)colinéaires par la couture de l'union
 * topologique, à une tolérance volontairement petite (2 cm par défaut).
 *
 * Distincte de simplify, délibérément : dropCollinear nettoie un artefact de
 * construction et doit s'exécuter même si l'appelant désactive la
 * simplification proprement dite ; ne pas les fusionner en une seule
 * fonction sous prétexte qu'elles appellent maintenant la même récursion.
 *
 * `keepVertex` déclare des sommets inamovibles : voir la note de
 * douglasPeuckerRing et src/compose.ts. C'est ce qui empêche de supprimer un
 * sommet partagé avec un bâtiment voisin, même parfaitement colinéaire.
 */
export function dropCollinear(
  ring: Ring,
  toleranceM = 0.02,
  keepVertex?: (p: LonLat) => boolean,
): Ring {
  return douglasPeuckerRing(ring, toleranceM, keepVertex);
}

/**
 * Réduit la précision excessive du cadastre par un Douglas-Peucker classique,
 * à une tolérance bien en deçà de la précision cadastrale (20 cm par défaut).
 *
 * Distincte de dropCollinear, délibérément : simplify est une passe de
 * simplification à part entière (perte de précision assumée), pas un
 * nettoyage de couture ; ne pas les fusionner en une seule fonction sous
 * prétexte qu'elles appellent maintenant la même récursion.
 */
export function simplify(
  ring: Ring,
  toleranceM = 0.2,
  keepVertex?: (p: LonLat) => boolean,
): Ring {
  return douglasPeuckerRing(ring, toleranceM, keepVertex);
}
