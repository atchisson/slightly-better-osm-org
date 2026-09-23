import { describe, it, expect } from 'vitest';
import { topologicalUnion, ringArea, pointInRing } from '../../src/geometry/union';
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
});
