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

  it('garde l’anneau fermé après recalage', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual(r.ring[r.ring.length - 1]);
  });
});
