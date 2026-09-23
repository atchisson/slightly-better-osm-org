import { describe, it, expect } from 'vitest';
import fixtures from './angers.json';

const CAS = [
  'porchePartage',      // léger touchant deux durs distincts
  'rangeeMitoyenne',    // durs mitoyens, ne doivent jamais fusionner
  'chaineLegers',       // composante de plusieurs légers
  'avecTrou',           // géométrie source à trou
  'minuscule',          // le plus petit bâtiment réel du fichier (~0,02 m²)
  'legerIsole',         // léger sans dur adjacent
] as const;

describe('fixtures Angers', () => {
  it('contient les six cas', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...CAS].sort());
  });

  for (const cas of CAS) {
    it(`${cas} porte des polygones exploitables`, () => {
      const f = (fixtures as any)[cas];
      expect(f.polys.length).toBeGreaterThan(0);
      for (const p of f.polys) {
        expect(['01', '02', '03']).toContain(p.type);
        expect(p.outer.length).toBeGreaterThanOrEqual(4);
        expect(p.outer[0]).toEqual(p.outer[p.outer.length - 1]);
      }
    });
  }

  it('porchePartage contient bien un léger adjacent à deux durs', () => {
    const f = (fixtures as any).porchePartage;
    expect(f.polys.filter((p: any) => p.type === '02').length).toBeGreaterThanOrEqual(1);
    expect(f.polys.filter((p: any) => p.type === '01').length).toBeGreaterThanOrEqual(2);
  });
});
