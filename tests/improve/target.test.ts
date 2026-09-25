import { describe, it, expect } from 'vitest';
import { cibleSous, anneauApres } from '../../src/improve/target';
import type { VoieVisee } from '../../src/improve/target';
import type { LonLat } from '../../src/geometry/types';

/** Projection d'essai : 1000 pixels par degré, y vers le bas. */
const project = (p: LonLat): [number, number] => [p[0] * 1000, -p[1] * 1000];

/** Un carré de 100 px de côté, fermé : le nœud A est répété en fin d'anneau. */
const carre: VoieVisee = {
  ring: [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]],
  nodeIds: ['nA', 'nB', 'nC', 'nD', 'nA'],
};

/** Une ligne, comme une route : deux segments, trois sommets. */
const ligne: VoieVisee = {
  ring: [[0, 0], [0.1, 0], [0.2, 0]],
  nodeIds: ['n1', 'n2', 'n3'],
};

describe('cibleSous — déplacer', () => {
  it('vise le sommet le plus proche, SANS seuil de distance', () => {
    // Le cas qui a fait refaire ce module : corriger une route décalée de dix mètres.
    // Le clic sert aussi de destination, donc un seuil de capture bornerait le
    // déplacement à ce même seuil — moins d'un mètre aux zooms d'édition.
    const c = cibleSous([100, -400], ligne, project);

    expect(c?.kind).toBe('noeud');
    if (c?.kind !== 'noeud') return;
    expect(c.nodeId).toBe('n2');
    expect(c.distancePx).toBeCloseTo(400, 6);
  });

  it('ne rend pas deux fois le sommet répété d’un anneau fermé', () => {
    const c = cibleSous([1, -1], carre, project);

    expect(c?.kind).toBe('noeud');
    if (c?.kind !== 'noeud') return;
    expect(c.index).toBe(0);
  });

  it('départage à égalité par le rang, pour un résultat stable', () => {
    // À mi-chemin exact entre n1 et n2.
    const c = cibleSous([50, 0], ligne, project);

    if (c?.kind !== 'noeud') return;
    expect(c.nodeId).toBe('n1');
  });

  it('gère une voie ouverte, dont le dernier sommet est un vrai sommet', () => {
    const c = cibleSous([200, 0], ligne, project);

    if (c?.kind !== 'noeud') return;
    expect(c.nodeId).toBe('n3');
  });
});

describe('cibleSous — insérer', () => {
  it('vise le segment le plus proche', () => {
    const c = cibleSous([150, 5], ligne, project, 'inserer');

    expect(c?.kind).toBe('segment');
    if (c?.kind !== 'segment') return;
    expect(c.edge).toEqual(['n2', 'n3']);
  });

  it('insère près d’un sommet existant, ce que la proximité interdisait', () => {
    // L'intention se déclare : un sommet est toujours à portée, donc une règle de
    // proximité rendait l'insertion inatteignable près d'un coin.
    const c = cibleSous([101, 0], ligne, project, 'inserer');

    expect(c?.kind).toBe('segment');
  });

  it('place le point d’insertion EXACTEMENT sur le segment', () => {
    const c = cibleSous([30, 50], ligne, project, 'inserer');

    if (c?.kind !== 'segment') return;
    expect(c.loc[1]).toBeCloseTo(0, 12);
    expect(c.loc[0]).toBeCloseTo(0.03, 12);
  });

  it('borne le point d’insertion aux extrémités du segment', () => {
    const c = cibleSous([-500, 3], ligne, project, 'inserer');

    if (c?.kind !== 'segment') return;
    expect(c.loc[0]).toBeCloseTo(0, 12);
  });
});

describe('cibleSous — garde', () => {
  it('refuse une voie dont les nœuds ne suivent pas l’anneau', () => {
    expect(cibleSous([0, 0], { ring: carre.ring, nodeIds: ['nA'] }, project)).toBeNull();
  });
});

describe('anneauApres', () => {
  it('montre le tracé après déplacement, pas la position de départ', () => {
    const c = cibleSous([100, -400], ligne, project)!;

    const apres = anneauApres(ligne, c, [0.1, 0.4]);

    expect(apres).toEqual([[0, 0], [0.1, 0.4], [0.2, 0]]);
  });

  it('déplace les deux occurrences du sommet répété d’un anneau fermé', () => {
    // Déplacer l'une sans l'autre ouvrirait la surface.
    const c = cibleSous([1, -1], carre, project)!;

    const apres = anneauApres(carre, c, [0.05, 0.05]);

    expect(apres[0]).toEqual([0.05, 0.05]);
    expect(apres[apres.length - 1]).toEqual([0.05, 0.05]);
  });

  it('insère le nouveau sommet à sa place dans l’anneau', () => {
    const c = cibleSous([150, 5], ligne, project, 'inserer')!;

    const apres = anneauApres(ligne, c, [9, 9]);

    expect(apres).toHaveLength(4);
    // Entre n2 et n3, et sur le segment — la destination du curseur est ignorée.
    expect(apres[2]![1]).toBeCloseTo(0, 12);
    expect(apres[2]![0]).toBeCloseTo(0.15, 12);
  });

  it('ne modifie pas l’anneau d’origine', () => {
    const c = cibleSous([100, -400], ligne, project)!;

    anneauApres(ligne, c, [9, 9]);

    expect(ligne.ring[1]).toEqual([0.1, 0]);
  });
});
