import { describe, it, expect } from 'vitest';
import { buildEdgeIndex } from '../../src/geometry/edges';
import { lightComponents, absorptionMap } from '../../src/geometry/components';
import type { Poly } from '../../src/geometry/types';
import fixtures from '../fixtures/angers.json';

// rectangle allant de x0 à x1, de y0 à y1
const rect = (id: number, type: Poly['type'], x0: number, y0: number, x1: number, y1: number): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

const analyse = (polys: Poly[]) => lightComponents(polys, buildEdgeIndex(polys));

describe('lightComponents', () => {
  it('regroupe deux légers accolés dans une seule composante', () => {
    const polys = [
      rect(0, '02', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    const comps = analyse(polys);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.members.sort()).toEqual([0, 1]);
  });

  it('laisse un léger isolé sans propriétaire', () => {
    const comps = analyse([rect(0, '02', 0, 0, 0.001, 0.001)]);
    expect(comps[0]!.ownerId).toBeNull();
  });

  it('attribue un léger au seul dur adjacent', () => {
    const polys = [
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    expect(analyse(polys)[0]!.ownerId).toBe(0);
  });

  it('attribue au dur avec la plus longue frontière partagée', () => {
    // Le PCI est topologiquement propre : deux polygones adjacents partagent des
    // segments identiques. Le léger porte donc un sommet intermédiaire en (0.002, 0.0004)
    // pour que son bord droit corresponde exactement à celui du petit dur.
    const leger: Poly = {
      id: 1, type: '02', holes: [],
      outer: [[0.001, 0], [0.002, 0], [0.002, 0.0004], [0.002, 0.001],
              [0.001, 0.001], [0.001, 0]],
    };
    const polys = [
      rect(0, '01', 0, 0, 0.001, 0.001),          // borde le léger sur 0.001° (~111 m)
      leger,
      rect(2, '01', 0.002, 0, 0.003, 0.0004),     // ne le borde que sur 0.0004° (~44 m)
    ];
    const comp = analyse(polys)[0]!;
    expect(comp.contacts.size).toBe(2);
    expect(comp.ownerId).toBe(0);
  });

  it('départage une égalité par le plus petit identifiant', () => {
    const polys = [
      rect(5, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
      rect(3, '01', 0.002, 0, 0.003, 0.001),
    ];
    expect(analyse(polys)[0]!.ownerId).toBe(3);
  });

  it('traite un 03 comme un bâtiment porteur, jamais comme un appendice', () => {
    const polys = [
      rect(0, '03', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    const comps = analyse(polys);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.members).toEqual([1]);
    expect(comps[0]!.ownerId).toBe(0);
  });

  it('ne fusionne jamais deux durs mitoyens', () => {
    const polys = fixtures.rangeeMitoyenne.polys as unknown as Poly[];
    const comps = analyse(polys);
    for (const c of comps) {
      for (const m of c.members) {
        expect(polys.find(p => p.id === m)!.type).toBe('02');
      }
    }
  });

  it('attribue le porche partagé à un seul dur, en signalant deux contacts', () => {
    const polys = fixtures.porchePartage.polys as unknown as Poly[];
    const comps = analyse(polys);
    const ambigue = comps.find(c => c.contacts.size >= 2);
    expect(ambigue).toBeDefined();
    expect(ambigue!.ownerId).not.toBeNull();
  });
});

describe('absorptionMap', () => {
  it('range les légers sous leur ancre et ignore les orphelins', () => {
    const polys = [
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
      rect(2, '02', 1, 1, 1.001, 1.001),
    ];
    const map = absorptionMap(analyse(polys));
    expect(map.get(0)).toEqual([1]);
    expect([...map.keys()]).toEqual([0]);
  });
});
