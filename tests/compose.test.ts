import { describe, it, expect, vi } from 'vitest';
import { buildEdgeIndex } from '../src/geometry/edges';
import { lightComponents, absorptionMap } from '../src/geometry/components';
import { composeAt, composeFor } from '../src/compose';
import type { ComposeInput } from '../src/compose';
import type { LonLat, Poly } from '../src/geometry/types';
import fixtures from './fixtures/angers.json';

const rect = (id: number, type: Poly['type'], x0: number, y0: number, x1: number, y1: number): Poly =>
  ({ id, type, holes: [], outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });

// byId et lightIndex sont, en production, construits une fois par commune (voir la revue
// de tâche 8) — ici on les recalcule à chaque prepare() par simplicité de test, ce qui
// reste largement acceptable au vu de la taille des fixtures. edgeIndex ne sert qu'à
// calculer les composantes légères (lightComponents) : ComposeInput ne le porte plus
// (mesure Task 12 — 82,6 Mo sur Angers, lu par aucun code après ce calcul), donc il
// reste une variable locale ici aussi, jamais renvoyée.
const prepare = (polys: Poly[]): ComposeInput => {
  const edgeIndex = buildEdgeIndex(polys);
  const components = lightComponents(polys, edgeIndex);
  const lightIndex = new Map<number, { ownerId: number | null; members: number[] }>();
  for (const c of components) {
    for (const id of c.members) lightIndex.set(id, { ownerId: c.ownerId, members: c.members });
  }
  return {
    polys,
    absorption: absorptionMap(components),
    byId: new Map(polys.map(p => [p.id, p])),
    lightIndex,
  };
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
    // Le point visé est délibérément hors de tout polygone réel : le balayage linéaire de
    // secours ne trouverait rien ici. Si le résultat est néanmoins ok:true, c'est la preuve
    // que composeAt a vraiment consommé le retour de polyAt plutôt que de retomber sur le
    // balayage en l'ignorant — un mutant qui appellerait polyAt puis balaierait quand même
    // aurait échoué ici (l'ancien point, à l'intérieur du seul polygone, ne le distinguait pas).
    const polys = [rect(0, '01', 0, 0, 0.001, 0.001)];
    const dehors: LonLat = [5, 5];
    const polyAt = vi.fn().mockReturnValue(polys[0]);
    const r = composeAt(dehors, { ...prepare(polys), polyAt });
    expect(polyAt).toHaveBeenCalledWith(dehors);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.anchorId).toBe(0);
  });
});

describe('composantes légères orphelines (aucun dur adjacent, spec §5 étape 2)', () => {
  it('fusionne une composante orpheline à deux membres, quel que soit le membre cliqué', () => {
    const polys = [
      rect(0, '02', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    const input = prepare(polys);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isolatedLight).toBe(true);
      expect(r.anchorId).toBe(0);
      expect(r.absorbed).toEqual([1]);
      const xs = r.ring.map(p => p[0]);
      expect(Math.min(...xs)).toBeCloseTo(0, 10);
      expect(Math.max(...xs)).toBeCloseTo(0.002, 10);
    }
  });

  it('résout à la même ancre qu’on clique le premier ou le second membre de la composante', () => {
    const polys = [
      rect(0, '02', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
    ];
    const input = prepare(polys);
    const parPremier = composeAt([0.0005, 0.0005], input);
    const parSecond = composeAt([0.0015, 0.0005], input);
    expect(parSecond).toEqual(parPremier);
  });

  it('fusionne une chaîne orpheline de trois légers en une seule composition (pas pairwise)', () => {
    // Cliquer le troisième membre doit résoudre à l'ancre canonique (le plus petit id, 0)
    // et absorber les DEUX autres — une implémentation qui ne fusionnerait que des paires
    // adjacentes laisserait échapper le membre 0 ou renverrait une ancre différente d'un
    // membre à l'autre.
    const polys = [
      rect(0, '02', 0, 0, 0.001, 0.001),
      rect(1, '02', 0.001, 0, 0.002, 0.001),
      rect(2, '02', 0.002, 0, 0.003, 0.001),
    ];
    const input = prepare(polys);
    const r = composeAt([0.0025, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.anchorId).toBe(0);
      expect(r.absorbed).toEqual([1, 2]);
      expect(r.isolatedLight).toBe(true);
      expect(Math.max(...r.ring.map(p => p[0]))).toBeCloseTo(0.003, 10);
    }
  });

  it('une composante orpheline à un seul membre reste une construction légère isolée', () => {
    const input = prepare([rect(0, '02', 0, 0, 0.001, 0.001)]);
    const r = composeAt([0.0005, 0.0005], input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isolatedLight).toBe(true);
      expect(r.anchorId).toBe(0);
      expect(r.absorbed).toEqual([]);
    }
  });
});
