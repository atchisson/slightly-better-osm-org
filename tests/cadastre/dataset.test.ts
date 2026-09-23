import { describe, it, expect } from 'vitest';
import { toPolys, buildDataset, buildLightIndex } from '../../src/cadastre/dataset';
import { buildEdgeIndex } from '../../src/geometry/edges';
import { lightComponents } from '../../src/geometry/components';
import type { Poly } from '../../src/geometry/types';

const feature = (type: string, ring: number[][], holes: number[][][] = []) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[ring, ...holes]] },
  properties: { type, nom: null, commune: '49007', created: '2002-10-07', updated: '2018-06-27' },
});

const carre = (x0: number, y0: number, d = 0.001) =>
  [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];

describe('toPolys', () => {
  it('aplatit les MultiPolygon à une partie et numérote les polygones', () => {
    const polys = toPolys([feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(polys.map(p => p.id)).toEqual([0, 1]);
    expect(polys.map(p => p.type)).toEqual(['01', '02']);
  });

  it('conserve les trous', () => {
    const polys = toPolys([feature('01', carre(0, 0, 0.01), [carre(0.002, 0.002)])]);
    expect(polys[0]!.holes).toHaveLength(1);
  });

  it('ignore une feature sans géométrie exploitable', () => {
    expect(toPolys([{ type: 'Feature', geometry: null, properties: { type: '01' } }])).toHaveLength(0);
  });
});

describe('buildDataset', () => {
  it('précalcule l’absorption du léger dans son dur', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(ds.absorption.get(0)).toEqual([1]);
  });

  it('retrouve le polygone sous un point', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
    expect(ds.polyAt([0.0005, 0.0005])!.id).toBe(0);
    expect(ds.polyAt([5, 5])).toBeNull();
  });

  it('porte le millésime et le code commune', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
    expect(ds.millesime).toBe('2026');
    expect(ds.insee).toBe('49007');
  });

  it('indexe chaque polygone par id dans byId', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(ds.byId.size).toBe(2);
    expect(ds.byId.get(0)!.type).toBe('01');
    expect(ds.byId.get(1)!.type).toBe('02');
    // même référence que dans ds.polys, pas une copie
    expect(ds.byId.get(0)).toBe(ds.polys[0]);
  });

  it('associe un léger absorbé à son propriétaire et à sa composante dans lightIndex', () => {
    const ds = buildDataset('49007', '2026', [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(ds.lightIndex.get(1)).toEqual({ ownerId: 0, members: [1] });
    // le dur porteur n'est pas un léger : absent de lightIndex
    expect(ds.lightIndex.has(0)).toBe(false);
  });

  it('associe une composante légère orpheline à tous ses membres, sans propriétaire', () => {
    const ds = buildDataset('49007', '2026', [feature('02', carre(0, 0)), feature('02', carre(0.001, 0))]);
    expect(ds.lightIndex.get(0)).toEqual({ ownerId: null, members: [0, 1] });
    expect(ds.lightIndex.get(1)).toEqual({ ownerId: null, members: [0, 1] });
  });
});

describe('buildDataset — polyAt et une cour (bâtiment dans le trou d’un autre)', () => {
  // Bâtiment troué (enregistré en premier, donc id 0 — le plus petit) et, dans sa cour,
  // un second bâtiment sans trou (id 1). Le compartiment de grille qui couvre le centre
  // du bâtiment intérieur contient les deux id, et buildDataset() les y insère dans
  // l'ordre de `polys` (ascendant) : le polygone troué est donc bien testé EN PREMIER
  // par polyAt. Un simple pointInRing(pt, p.outer), qui ignore p.holes, l'accepterait à
  // tort dès ce premier essai et ne regarderait jamais le bâtiment intérieur — c'est
  // exactement le défaut mesuré sur les données réelles d'Angers (19 bâtiments sur 29
  // mal attribués). Ordonner les polygones ainsi (enveloppe d'abord) est ce qui rend ce
  // test capable d'échouer : un ordre inverse aurait laissé la grille trouver le bon
  // polygone par simple chance d'itération.
  const troue = feature('01', carre(0, 0, 0.01), [carre(0.003, 0.003, 0.004)]);
  const dansLaCour = feature('01', carre(0.0045, 0.0045, 0.001));
  const centreDuBatimentInterieur: [number, number] = [0.005, 0.005];
  const dansLeTrouMaisHorsBati: [number, number] = [0.0035, 0.0035];

  it('renvoie le bâtiment intérieur (id 1), pas l’enveloppe trouée (id 0), au centre du bâtiment intérieur', () => {
    const ds = buildDataset('49007', '2026', [troue, dansLaCour]);
    expect(ds.polys.map(p => p.id)).toEqual([0, 1]); // vérifie l'hypothèse d'ordre du test
    expect(ds.polyAt(centreDuBatimentInterieur)?.id).toBe(1);
  });

  it('renvoie null pour un point dans le trou mais hors de tout bâtiment', () => {
    const ds = buildDataset('49007', '2026', [troue, dansLaCour]);
    expect(ds.polyAt(dansLeTrouMaisHorsBati)).toBeNull();
  });
});

describe('buildLightIndex — invariant de tri (revue Task 8)', () => {
  // compose.ts:anchorOf résout l'ancre canonique d'une composante orpheline à
  // `members[0]`, en s'appuyant sur le fait que lightComponents() trie déjà `members`
  // par id croissant. Ce tri n'est aujourd'hui garanti par aucun test : toutes les
  // fixtures existantes construisent leurs polygones en ordre croissant, si bien que le
  // tableau ressortirait trié même sans le tri explicite. Ici les trois membres d'une
  // même composante orpheline sont fournis dans un ordre qui n'est ni croissant ni
  // décroissant (8, 3, 5) : si le tri de lightComponents() disparaissait, `members`
  // ressortirait [8, 3, 5] et cette assertion échouerait.
  const rect = (id: number, x0: number): Poly => ({
    id,
    type: '02',
    holes: [],
    outer: [[x0, 0], [x0 + 0.001, 0], [x0 + 0.001, 0.001], [x0, 0.001], [x0, 0]],
  });

  it('garde members trié par id croissant même fourni en ordre décroissant/désordonné', () => {
    // trois légers mitoyens bout à bout (3 touche 5, 5 touche 8), fournis dans le désordre
    const polys = [rect(8, 0.002), rect(3, 0), rect(5, 0.001)];
    const edgeIndex = buildEdgeIndex(polys);
    const components = lightComponents(polys, edgeIndex);
    expect(components).toHaveLength(1);
    expect(components[0]!.ownerId).toBeNull();

    const lightIndex = buildLightIndex(components);
    expect(lightIndex.get(3)!.members).toEqual([3, 5, 8]);
    expect(lightIndex.get(5)!.members).toEqual([3, 5, 8]);
    expect(lightIndex.get(8)!.members).toEqual([3, 5, 8]);
  });
});
