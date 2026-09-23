import { describe, it, expect } from 'vitest';
import { isDegenerate, dropCollinear, simplify } from '../../src/geometry/clean';
import type { Ring } from '../../src/geometry/types';

const ferme = (pts: Ring): Ring => [...pts, pts[0]!];

describe('isDegenerate', () => {
  it('rejette un anneau de moins de trois sommets distincts', () => {
    expect(isDegenerate(ferme([[0, 0], [1, 0]]))).toBe(true);
  });

  it('rejette un anneau d’aire nulle', () => {
    expect(isDegenerate(ferme([[0, 0], [1, 0], [2, 0]]))).toBe(true);
  });

  it('accepte un triangle', () => {
    expect(isDegenerate(ferme([[0, 0], [0.001, 0], [0, 0.001]]))).toBe(false);
  });
});

describe('dropCollinear', () => {
  it('supprime un sommet aligné au milieu d’un côté', () => {
    const avec = ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(dropCollinear(avec)).toHaveLength(5);   // 4 sommets + fermeture
  });

  it('conserve un décrochement réel', () => {
    const marche = ferme([[0, 0], [0.001, 0], [0.001, 0.0005], [0.002, 0.0005], [0.002, 0.001], [0, 0.001]]);
    expect(dropCollinear(marche)).toHaveLength(marche.length);
  });

  it('rend un anneau toujours fermé', () => {
    const r = dropCollinear(ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]));
    expect(r[0]).toEqual(r[r.length - 1]);
  });
});

describe('simplify', () => {
  it('efface une déviation inférieure à la tolérance', () => {
    // sommet médian dévié d’environ 5 cm
    const r = ferme([[0, 0], [0.0005, 0.0000004], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(simplify(r, 0.2).length).toBeLessThan(r.length);
  });

  it('conserve une déviation supérieure à la tolérance', () => {
    // sommet médian dévié d’environ 2 m
    const r = ferme([[0, 0], [0.0005, 0.000018], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(simplify(r, 0.2)).toHaveLength(r.length);
  });

  it('un triangle est renvoyé tel quel sans entrer dans la récursion', () => {
    // open.length === 3 : simplify sort par le retour anticipé du haut
    // (`if (open.length <= 3) return ring;`), avant tout appel à recurse().
    const r = ferme([[0, 0], [0.000001, 0], [0.0000005, 0.0000005]]);
    expect(simplify(r, 100).length).toBeGreaterThanOrEqual(4);
  });

  it('la récursion elle-même ne redescend jamais sous un triangle', () => {
    // 4 sommets exactement alignés sur une même droite. Le sommet le plus
    // éloigné du premier est aussi le dernier (far === open.length - 1), et
    // les deux sommets intermédiaires sont à distance nulle de la corde
    // (0)-(3) puisqu'ils sont sur cette droite : aucun n'est jamais ajouté à
    // `keep`, qui reste { 0, 3 } — 2 éléments. La récursion s'exécute donc
    // pour de vrai (open.length === 4 > 3, on dépasse le retour anticipé du
    // haut), mais c'est le garde-fou du bas (`if (kept.length < 3) return
    // ring;`) qui renvoie l'anneau initial inchangé.
    const r = ferme([[0, 0], [0.000001, 0.000001], [0.000002, 0.000002], [0.0001, 0.0001]]);
    expect(simplify(r)).toEqual(r);
  });
});
