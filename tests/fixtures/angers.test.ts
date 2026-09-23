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

// Vérification d'adjacence indépendante de toute logique de production : deux polygones
// sont mitoyens quand une paire de sommets consécutifs de l'un apparaît, dans un sens ou
// l'autre, comme paire de sommets consécutifs de l'autre. Partager un simple sommet isolé
// ne compte pas. Volontairement dupliqué ici plutôt qu'importé de src/ — ce test doit
// rester un contrôle indépendant des données, pas un test qui échoue et réussit avec la
// même logique que le code qu'il est censé garder honnête.
const pointKey = (p: any): string => `${p[0]},${p[1]}`;
const edgeKey = (a: any, b: any): string => {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};
const edgesOf = (ring: any[]): Set<string> => {
  const edges = new Set<string>();
  for (let k = 0; k < ring.length - 1; k++) edges.add(edgeKey(ring[k], ring[k + 1]));
  return edges;
};
const sharesEdge = (a: any, b: any): boolean => {
  const edgesA = edgesOf(a.outer);
  for (let k = 0; k < b.outer.length - 1; k++) {
    if (edgesA.has(edgeKey(b.outer[k], b.outer[k + 1]))) return true;
  }
  return false;
};

// Aire de Gauss (shoelace) sur l'anneau brut, en degrés², convertie en m² approximatifs par
// un facteur plat (111 320 m/degré, corrigé par cos(latitude) pour la longitude). Suffisant
// pour distinguer « minuscule mais réel » de « dégénéré » ou de « pas si petit que ça » —
// pas pour un calcul topographique précis.
const shoelaceAreaDeg2 = (ring: any[]): number => {
  let s = 0;
  for (let k = 0; k < ring.length - 1; k++) s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
  return Math.abs(s / 2);
};
const approxAreaM2 = (ring: any[]): number => {
  const metresParDegre = 111_320;
  const lat = ring[0][1];
  return shoelaceAreaDeg2(ring) * metresParDegre * metresParDegre * Math.cos((lat * Math.PI) / 180);
};

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

  it('porchePartage contient un léger relié par arête à deux durs distincts', () => {
    const f = (fixtures as any).porchePartage;
    const legers = f.polys.filter((p: any) => p.type === '02');
    const durs = f.polys.filter((p: any) => p.type === '01');
    const ok = legers.some((leger: any) => durs.filter((dur: any) => sharesEdge(leger, dur)).length >= 2);
    expect(ok).toBe(true);
  });

  it('rangeeMitoyenne contient deux durs distincts reliés par une arête complète', () => {
    const f = (fixtures as any).rangeeMitoyenne;
    const durs = f.polys.filter((p: any) => p.type === '01');
    let ok = false;
    for (let i = 0; i < durs.length && !ok; i++) {
      for (let j = i + 1; j < durs.length; j++) {
        if (sharesEdge(durs[i], durs[j])) { ok = true; break; }
      }
    }
    expect(ok).toBe(true);
  });

  it('chaineLegers contient deux légers distincts reliés par une arête complète', () => {
    const f = (fixtures as any).chaineLegers;
    const legers = f.polys.filter((p: any) => p.type === '02');
    let ok = false;
    for (let i = 0; i < legers.length && !ok; i++) {
      for (let j = i + 1; j < legers.length; j++) {
        if (sharesEdge(legers[i], legers[j])) { ok = true; break; }
      }
    }
    expect(ok).toBe(true);
  });

  it('avecTrou contient un anneau intérieur réel et fermé', () => {
    const f = (fixtures as any).avecTrou;
    const avecHole = f.polys.find((p: any) => p.holes.length > 0);
    expect(avecHole).toBeDefined();
    for (const trou of avecHole.holes) {
      expect(trou.length).toBeGreaterThanOrEqual(4);
      expect(trou[0]).toEqual(trou[trou.length - 1]);
    }
  });

  it('legerIsole est un unique polygone léger sans voisin', () => {
    const f = (fixtures as any).legerIsole;
    expect(f.polys).toHaveLength(1);
    expect(f.polys[0].type).toBe('02');
  });

  it('minuscule est une géométrie valide et non dégénérée sous 1 m²', () => {
    const f = (fixtures as any).minuscule;
    expect(f.polys).toHaveLength(1);
    const aire = approxAreaM2(f.polys[0].outer);
    expect(aire).toBeGreaterThan(0);
    expect(aire).toBeLessThan(1);
  });
});
