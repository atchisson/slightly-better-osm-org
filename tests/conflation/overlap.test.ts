import { describe, it, expect } from 'vitest';
import { overlapsExisting } from '../../src/conflation/overlap';
import type { Ring } from '../../src/geometry/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

describe('overlapsExisting', () => {
  it('ne voit aucun conflit sur un terrain vierge', () => {
    expect(overlapsExisting(rect(0, 0, 0.001, 0.001), [])).toBeNull();
  });

  it('détecte un bâtiment existant au même endroit', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.001, 0.001) }];
    expect(overlapsExisting(rect(0.0002, 0.0002, 0.0008, 0.0008), existing)?.id).toBe('w1');
  });

  it('ignore un bâtiment simplement mitoyen', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.001, 0.001) }];
    expect(overlapsExisting(rect(0.001, 0, 0.002, 0.001), existing)).toBeNull();
  });

  it('détecte un existant qui englobe le nouveau', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.01, 0.01) }];
    expect(overlapsExisting(rect(0.004, 0.004, 0.005, 0.005), existing)?.id).toBe('w1');
  });
});
