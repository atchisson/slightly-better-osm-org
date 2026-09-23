import { describe, it, expect } from 'vitest';
import { snapToExistingNodes } from '../../src/conflation/snap';
import type { Ring } from '../../src/geometry/types';

const carre: Ring = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];

describe('snapToExistingNodes', () => {
  it('ne touche à rien sans nœud voisin', () => {
    const r = snapToExistingNodes(carre, []);
    expect(r.ring).toEqual(carre);
    expect(r.reused.every(x => x === null)).toBe(true);
  });

  it('réutilise un nœud situé à moins de la tolérance', () => {
    // ~11 cm à l'est du premier sommet
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.reused[0]).toBe('n1');
  });

  it('déplace le sommet cadastre vers le nœud, jamais l’inverse', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual([0.000001, 0]);
    expect(nodes[0]!.loc).toEqual([0.000001, 0]);   // le nœud existant est intact
    expect(r.ring[0]).not.toBe(nodes[0]!.loc);      // et sans partager sa référence
  });

  it('ignore un nœud au-delà de la tolérance', () => {
    // ~1,1 m
    const nodes = [{ id: 'n1', loc: [0.00001, 0] as [number, number] }];
    expect(snapToExistingNodes(carre, nodes, 0.2).reused[0]).toBeNull();
  });

  it('n’attribue jamais deux fois le même nœud', () => {
    const nodes = [{ id: 'n1', loc: [0, 0] as [number, number] }];
    const ringProche: Ring = [[0, 0], [0.0000005, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
    const r = snapToExistingNodes(ringProche, nodes, 0.5);
    expect(r.reused.filter(x => x === 'n1')).toHaveLength(1);
  });

  it('attribue le nœud au sommet le plus proche, pas au premier venu dans l’ordre de l’anneau', () => {
    // vA (indice 0) est à ~0,13 m du nœud ; vB (indice 1) tombe exactement dessus.
    // Une attribution gloutonne dans l'ordre de l'anneau donnerait le nœud à vA,
    // rencontré en premier, au lieu de vB, le seul sommet qui coïncide vraiment.
    const ring: Ring = [[0, 0], [0.0000012, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
    const nodes = [{ id: 'n1', loc: [0.0000012, 0] as [number, number] }];
    const r = snapToExistingNodes(ring, nodes, 0.2);
    expect(r.reused[1]).toBe('n1');
    expect(r.reused[0]).toBeNull();
  });

  it('garde l’anneau fermé après recalage', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual(r.ring[r.ring.length - 1]);
  });
});

describe('snapToExistingNodes — borne sur la liste de nœuds', () => {
  // Le préfiltre d'emprise (borne de coût, C1) doit dilater le rectangle englobant de
  // la tolérance. Sans dilatation il serait faux et pas seulement moins rapide : un
  // nœud voisin situé juste À L'EXTÉRIEUR d'un coin est hors du rectangle brut tout en
  // étant à portée — et c'est exactement le cas que ce module existe pour traiter.
  it('réutilise un nœud à portée mais hors du rectangle englobant brut', () => {
    // ~11 cm au sud-ouest du coin [0,0] : dehors sur les DEUX axes.
    const dehors = { id: 'n1', loc: [-0.0000005, -0.000001] as [number, number] };
    const r = snapToExistingNodes(carre, [dehors], 0.2);
    expect(r.reused[0]).toBe('n1');
  });

  it('un grand nombre de nœuds lointains ne change pas le résultat', () => {
    const proche = { id: 'n1', loc: [0, 0] as [number, number] };
    const lointains = Array.from({ length: 5000 }, (_, i) => ({
      id: `loin${i}`, loc: [1 + i * 0.001, 1] as [number, number],
    }));
    const attendu = snapToExistingNodes(carre, [proche], 0.2);
    const avecBruit = snapToExistingNodes(carre, [proche, ...lointains], 0.2);
    expect(avecBruit).toEqual(attendu);
  });
});
