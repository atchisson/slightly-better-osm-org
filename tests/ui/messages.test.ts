import { describe, it, expect } from 'vitest';
import { refusalMessage } from '../../src/ui/messages';

const TOUS = ['aucun-batiment', 'trou-source', 'degenere', 'pincement', 'trou',
  'parties-multiples', 'vide', 'batiment-existant', 'commune-introuvable', 'reseau'] as const;

describe('refusalMessage', () => {
  for (const raison of TOUS) {
    it(`donne un message explicite pour ${raison}`, () => {
      const m = refusalMessage(raison);
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toContain(raison);        // un message, pas un code
    });
  }

  it('dit quoi faire quand un bâtiment existe déjà', () => {
    expect(refusalMessage('batiment-existant')).toMatch(/existe déjà/i);
  });
});
