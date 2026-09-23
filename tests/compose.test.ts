import { describe, it, expect, vi } from 'vitest';
import { buildEdgeIndex } from '../src/geometry/edges';
import { lightComponents, absorptionMap } from '../src/geometry/components';
import { composeAt, composeFor } from '../src/compose';
import type { Poly } from '../src/geometry/types';
import fixtures from './fixtures/angers.json';

const rect = (id: number, type: Poly['type'], x0: number, y0: number, x1: number, y1: number): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

const prepare = (polys: Poly[]) => {
  const edgeIndex = buildEdgeIndex(polys);
  return { polys, edgeIndex, absorption: absorptionMap(lightComponents(polys, edgeIndex)) };
};

describe('composeAt', () => {
  it('ne rend rien hors de tout bâtiment', () => {
    const input = prepare([rect(0, '01', 0, 0, 0.001, 0.001)]);
    expect(composeAt([5, 5], input)).toEqual({ ok: false, reason: 'aucun-batiment' });
  });

  it('absorbe le porche quand on clique la maison', () => {
    const input = prepare([
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.anchorId).toBe(0);
      expect(r.absorbed).toEqual([1]);
      expect(Math.max(...r.ring.map(p => p[0]))).toBeCloseTo(0.002, 10);
    }
  });

  it('donne le même bâtiment qu’on clique la maison ou le porche', () => {
    const input = prepare([
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ]);
    const parMaison = composeAt([0.0005, 0.0005], input);
    const parPorche = composeAt([0.0015, 0.0005], input);
    expect(parPorche).toEqual(parMaison);
  });

  it('crée seule une construction légère isolée et la signale comme telle', () => {
    const input = prepare([rect(0, '02', 0, 0, 0.001, 0.001)]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isolatedLight).toBe(true);
      expect(r.absorbed).toEqual([]);
    }
  });

  it('ne fusionne jamais deux durs mitoyens', () => {
    const input = prepare([
      rect(0, '01', 0, 0, 0.001, 0.001),
      rect(1, '01', 0.001, 0, 0.002, 0.001),
    ]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absorbed).toEqual([]);
      expect(Math.max(...r.ring.map(p => p[0]))).toBeCloseTo(0.001, 10);
    }
  });

  it('refuse une géométrie source à trou', () => {
    // On vise l'ancre par son identifiant : partir d'un point serait indéterminé
    // (un sommet n'est ni franchement dedans ni franchement dehors).
    const polys = fixtures.avecTrou.polys as unknown as Poly[];
    const troue = polys.find(p => p.holes.length > 0)!;
    expect(composeFor(troue.id, prepare(polys))).toEqual({ ok: false, reason: 'trou-source' });
  });

  it('refuse aussi quand seul un membre absorbé (et non l’ancre) porte un trou', () => {
    // Le contrat de topologicalUnion (n'opère que sur les anneaux extérieurs, jamais sur
    // Poly.holes) impose que composeFor refuse dès qu'UN SEUL membre de la composante a un
    // trou — pas seulement le polygone visé. Ici l'ancre (le dur) n'a pas de trou : seul le
    // porche léger qu'elle va absorber en a un.
    const dur = rect(0, '01', 0, 0, 0.001, 0.001);
    const porcheTroue: Poly = {
      id: 1,
      type: '02',
      outer: [[0.001, 0], [0.002, 0], [0.002, 0.001], [0.001, 0.001], [0.001, 0]],
      holes: [[[0.0013, 0.0003], [0.0017, 0.0003], [0.0017, 0.0007], [0.0013, 0.0007], [0.0013, 0.0003]]],
    };
    const input = prepare([dur, porcheTroue]);
    // Vérifie l'hypothèse du test : le porche doit bien être absorbé par le dur, sinon le
    // refus ne prouverait rien sur la composition multi-membres.
    expect(input.absorption.get(0)).toEqual([1]);
    expect(composeFor(0, input)).toEqual({ ok: false, reason: 'trou-source' });
  });

  it('refuse un anneau dégénéré', () => {
    // Anneau synthétique : il n'existe aucun polygone d'aire nulle dans les données
    // réelles. La garde protège contre les autres communes et contre une sortie
    // d'union ou de simplification dégradée.
    const plat: Poly = { id: 0, type: '01', holes: [], outer: [[0, 0], [0.001, 0], [0.002, 0], [0, 0]] };
    expect(composeFor(0, prepare([plat]))).toEqual({ ok: false, reason: 'degenere' });
  });

  it('accepte le plus petit bâtiment réel du fichier', () => {
    // ~0,02 m² : absurde comme bâtiment, mais géométriquement valide. La garde de
    // dégénérescence ne doit pas le rejeter — sinon elle rejetterait du bâti réel.
    const polys = fixtures.minuscule.polys as unknown as Poly[];
    expect(composeFor(polys[0]!.id, prepare(polys)).ok).toBe(true);
  });

  it('utilise l’index spatial quand on le lui fournit', () => {
    const polys = [rect(0, '01', 0, 0, 0.001, 0.001)];
    const polyAt = vi.fn().mockReturnValue(polys[0]);
    const r = composeAt([0.0005, 0.0005], { ...prepare(polys), polyAt });
    expect(polyAt).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });
});
