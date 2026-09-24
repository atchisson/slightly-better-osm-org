import { describe, it, expect } from 'vitest';
import { edgeKey, segmentLength, buildEdgeIndex } from '../../src/geometry/edges';
import type { Poly } from '../../src/geometry/types';

const carre = (id: number, x0: number, y0: number, type: Poly['type'] = '01'): Poly => ({
  id, type, holes: [],
  outer: [[x0, y0], [x0 + 0.001, y0], [x0 + 0.001, y0 + 0.001], [x0, y0 + 0.001], [x0, y0]],
});

describe('edgeKey', () => {
  it('est indépendante du sens de parcours', () => {
    expect(edgeKey([1, 2], [3, 4])).toBe(edgeKey([3, 4], [1, 2]));
  });

  it('distingue deux arêtes différentes', () => {
    expect(edgeKey([1, 2], [3, 4])).not.toBe(edgeKey([1, 2], [3, 5]));
  });
});

describe('segmentLength', () => {
  it('mesure un degré de latitude à environ 111 km', () => {
    expect(segmentLength([0, 0], [0, 1])).toBeCloseTo(111320, -2);
  });

  it('rétrécit un degré de longitude avec la latitude', () => {
    const equateur = segmentLength([0, 0], [1, 0]);
    const nord = segmentLength([0, 60], [1, 60]);
    expect(nord).toBeLessThan(equateur * 0.55);
  });
});

describe('buildEdgeIndex', () => {
  it('rattache une arête partagée à ses deux polygones', () => {
    const a = carre(0, 0, 0);
    const b = carre(1, 0.001, 0);           // accolé à droite de a
    const idx = buildEdgeIndex([a, b]);
    const partagee = edgeKey([0.001, 0], [0.001, 0.001]);
    expect(idx.get(partagee)).toEqual([0, 1]);
  });

  it('laisse les arêtes de bord avec un seul propriétaire', () => {
    const idx = buildEdgeIndex([carre(0, 0, 0)]);
    for (const owners of idx.values()) expect(owners).toHaveLength(1);
  });

  it('n\'associe pas deux polygones qui ne se touchent que par un coin', () => {
    // un contact ponctuel ne partage aucune arete : chaque cle garde un seul proprietaire
    const idx = buildEdgeIndex([carre(0, 0, 0), carre(1, 0.001, 0.001)]);
    for (const owners of idx.values()) expect(owners).toHaveLength(1);
  });
});
