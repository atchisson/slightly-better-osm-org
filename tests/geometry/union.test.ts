import { describe, it, expect } from 'vitest';
import { topologicalUnion, ringArea, pointInRing, pointInPoly } from '../../src/geometry/union';
import type { Poly, Ring } from '../../src/geometry/types';

const rect = (id: number, x0: number, y0: number, x1: number, y1: number, type: Poly['type'] = '01'): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

const bbox = (ring: Ring) => {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe('pointInRing', () => {
  it('reconnaît un point intérieur et un point extérieur', () => {
    const r = rect(0, 0, 0, 2, 2).outer;
    expect(pointInRing([1, 1], r)).toBe(true);
    expect(pointInRing([3, 1], r)).toBe(false);
  });
});

describe('pointInPoly', () => {
  it('accepte un point dans l’anneau extérieur quand le polygone n’a pas de trou', () => {
    expect(pointInPoly([1, 1], rect(0, 0, 0, 2, 2))).toBe(true);
  });

  it('refuse un point posé dans un trou, même si l’anneau extérieur le contient', () => {
    const troue: Poly = { ...rect(0, 0, 0, 2, 2), holes: [rect(0, 0.5, 0.5, 1.5, 1.5).outer] };
    expect(pointInPoly([1, 1], troue)).toBe(false);
  });

  it('refuse un point hors de l’anneau extérieur, trou ou pas', () => {
    expect(pointInPoly([3, 3], rect(0, 0, 0, 2, 2))).toBe(false);
  });
});

describe('ringArea', () => {
  it('mesure l’aire d’un carré unité', () => {
    expect(Math.abs(ringArea(rect(0, 0, 0, 1, 1).outer))).toBeCloseTo(1, 10);
  });
});

describe('topologicalUnion', () => {
  it('rend un polygone seul inchangé', () => {
    const p = rect(0, 0, 0, 1, 1);
    const u = topologicalUnion([p]);
    expect(u.ok).toBe(true);
    if (u.ok) expect(bbox(u.ring)).toEqual([0, 0, 1, 1]);
  });

  it('fusionne deux rectangles accolés en un seul anneau', () => {
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 1, 0, 2, 1)]);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(bbox(u.ring)).toEqual([0, 0, 2, 1]);
      // l’arête interne a disparu : plus aucun sommet en x=1 à l’intérieur du bord supérieur
      expect(u.ring.filter(p => p[0] === 1)).toHaveLength(2);
    }
  });

  it('ferme l’anneau produit', () => {
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 1, 0, 2, 1)]);
    if (u.ok) expect(u.ring[0]).toEqual(u.ring[u.ring.length - 1]);
  });

  it('refuse deux polygones disjoints', () => {
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 5, 5, 6, 6)]);
    expect(u).toEqual({ ok: false, reason: 'parties-multiples' });
  });

  it('refuse une union qui enferme une cour', () => {
    // Les huit cellules unité entourant un vide central. Des cellules unité garantissent
    // des arêtes exactement partagées — condition de l'union topologique, et propriété
    // réelle du PCI. Quatre barres larges ne conviendraient pas : leurs longs côtés ne
    // correspondraient pas segment pour segment aux petits côtés voisins.
    const cellules = [];
    let id = 0;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        if (!(i === 1 && j === 1)) cellules.push(rect(id++, i, j, i + 1, j + 1));

    const u = topologicalUnion(cellules);
    expect(u).toEqual({ ok: false, reason: 'trou' });
  });

  it('refuse un pincement', () => {
    // deux carrés ne se touchant que par un sommet : le sommet commun porte 4 arêtes de bord
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 1, 1, 2, 2)]);
    expect(u).toEqual({ ok: false, reason: 'pincement' });
  });

  it('refuse un ensemble vide', () => {
    expect(topologicalUnion([])).toEqual({ ok: false, reason: 'vide' });
  });

  it('refuse un ensemble non vide dont toutes les arêtes s’annulent', () => {
    // Un polygone et son doublon exact : chaque arête est comptée deux fois et
    // disparaît entièrement, laissant une adjacence vide — pas de sommet de
    // départ pour reduce(). Ce cas ne passe jamais par le garde `polys.length === 0`.
    const u = topologicalUnion([rect(0, 0, 0, 1, 1), rect(1, 0, 0, 1, 1)]);
    expect(u).toEqual({ ok: false, reason: 'vide' });
  });
});

describe('T-jonctions et chevauchements — la précondition du PCI est fausse', () => {
  // Constaté à l'écran le 2026-09-25 : « il ne devrait pas y avoir de ligne en haut
  // du bâtiment clair ». L'annulation d'arêtes suppose que deux membres partagent des
  // arêtes IDENTIQUES. Le PCI ne le garantit pas.
  const DEG = 1 / 111320;                    // ~1 m en latitude
  const poly = (id: number, pts: [number, number][], type: Poly['type'] = '01'): Poly =>
    ({ id, type, holes: [], outer: [...pts, pts[0]!] as Ring });

  it('soude un léger adossé au MILIEU du mur d’un dur', () => {
    // Le mur du dur va de 0 à 10 ; le léger s'y adosse entre 3 et 6. Aucune arête
    // n'est commune : sans découpe préalable, le mur survit dans le contour.
    const dur = poly(1, [[0, 0], [10 * DEG, 0], [10 * DEG, 5 * DEG], [0, 5 * DEG]]);
    const leger = poly(2, [[3 * DEG, 0], [3 * DEG, -2 * DEG], [6 * DEG, -2 * DEG], [6 * DEG, 0]], '02');

    const u = topologicalUnion([dur, leger]);

    expect(u.ok).toBe(true);
    if (!u.ok) return;
    // Le contour fait le tour des deux : 8 sommets distincts, et aucun ne manque.
    expect(u.ring.length - 1).toBe(8);
    // L'aire vaut la somme : rien n'a été perdu ni compté deux fois.
    expect(Math.abs(ringArea(u.ring))).toBeCloseTo(
      Math.abs(ringArea(dur.outer)) + Math.abs(ringArea(leger.outer)), 12);
  });

  it('soude malgré un sommet à quelques millimètres du mur', () => {
    // Le cas réel qui a motivé le correctif (polygones 268 et 365 de la commune
    // 28404) a son sommet à 4,4 mm du mur, pas dessus. Une tolérance de 1 mm, posée
    // « par prudence », passait juste à côté.
    const dur = poly(1, [[0, 0], [10 * DEG, 0], [10 * DEG, 5 * DEG], [0, 5 * DEG]]);
    const leger = poly(2, [
      [3 * DEG, 0.004 * DEG], [3 * DEG, -2 * DEG], [6 * DEG, -2 * DEG], [6 * DEG, 0.004 * DEG],
    ], '02');

    expect(topologicalUnion([dur, leger]).ok).toBe(true);
  });

  it('refuse un chevauchement réel plutôt que de rendre un contour faux', () => {
    // Coordonnées RÉELLES des polygones 941 et 1015 de la commune 28404, celles-là
    // mêmes qui ont servi au diagnostic. Un sommet du léger tombe 4,6 m à l'intérieur
    // du dur : ce n'est plus du bruit de représentation, c'est une source incohérente,
    // et l'annulation d'arêtes n'a rien à y répondre. Sans garde, elle rendait un
    // contour qui retraçait un mur au lieu de le border.
    const dur = poly(941, [
      [1.3271725, 48.7282636], [1.3268561, 48.7281695],
      [1.3269414, 48.7280424], [1.3272617, 48.7281364],
    ]);
    const leger = poly(1015, [
      [1.3272617, 48.7281364], [1.32732, 48.7281542], [1.3272613, 48.7282384],
      [1.3272145, 48.728224], [1.3271774, 48.728277], [1.3271083, 48.7282558],
      [1.3271152, 48.728246], [1.3271725, 48.7282636],
    ], '02');

    const u = topologicalUnion([dur, leger]);

    expect(u.ok).toBe(false);
    if (u.ok) return;
    expect(u.reason).toBe('chevauchement');
  });

  it('refuse aussi un chevauchement franc, sous un motif ou un autre', () => {
    // Un léger qui traverse le mur de part en part ne produit même pas un anneau
    // unique : il est refusé en amont de la garde. Le motif dépend de la forme du
    // chevauchement ; ce qui compte est qu'aucun contour ne soit rendu.
    const dur = poly(1, [[0, 0], [10 * DEG, 0], [10 * DEG, 5 * DEG], [0, 5 * DEG]]);
    const leger = poly(2, [
      [3 * DEG, 2 * DEG], [3 * DEG, -2 * DEG], [6 * DEG, -2 * DEG], [6 * DEG, 2 * DEG],
    ], '02');

    expect(topologicalUnion([dur, leger]).ok).toBe(false);
  });

  it('ne node jamais un anneau contre ses propres sommets', () => {
    // Le plus petit bâtiment réel d'Angers est un éclat de 137 cm², large de 2 cm :
    // son troisième sommet tombe à moins de la tolérance de sa propre base. Nodé
    // contre lui-même, il voyait toutes ses arêtes s'annuler deux à deux et l'union
    // rendait « vide » — un bâtiment réel devenu incréable.
    const eclat = poly(1, [
      [-0.5097147, 47.4492092], [-0.5097446, 47.4491352], [-0.509733, 47.4491638],
    ]);

    const u = topologicalUnion([eclat]);

    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.ring.length - 1).toBe(3);
  });
});
