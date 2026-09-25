import { describe, it, expect } from 'vitest';
import { cibleSous, SEUIL_PX } from '../../src/improve/target';
import type { VoieVisee } from '../../src/improve/target';
import type { LonLat } from '../../src/geometry/types';

/** Projection d'essai : 1000 pixels par degré, y vers le bas. */
const project = (p: LonLat): [number, number] => [p[0] * 1000, -p[1] * 1000];

/** Un carré de 100 px de côté, fermé : le nœud A est répété en fin d'anneau. */
const carre: VoieVisee = {
  ring: [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]],
  nodeIds: ['nA', 'nB', 'nC', 'nD', 'nA'],
};

describe('cibleSous', () => {
  it('ne vise rien quand le curseur est loin', () => {
    expect(cibleSous([500, 500], carre, project)).toBeNull();
  });

  it('vise le sommet sous le curseur', () => {
    const c = cibleSous([102, -3], carre, project);

    expect(c?.kind).toBe('noeud');
    if (c?.kind !== 'noeud') return;
    expect(c.nodeId).toBe('nB');
    expect(c.index).toBe(1);
  });

  it('préfère un sommet à un segment, même à portée égale', () => {
    // Un sommet est à distance nulle des deux segments qui s'y rejoignent : sans cette
    // préférence, un segment gagnerait toujours et aucun sommet ne serait déplaçable.
    const c = cibleSous([100, 0], carre, project);

    expect(c?.kind).toBe('noeud');
  });

  it('vise le segment quand aucun sommet n’est à portée', () => {
    // Milieu du bord bas, à 50 px de chaque coin.
    const c = cibleSous([50, 2], carre, project);

    expect(c?.kind).toBe('segment');
    if (c?.kind !== 'segment') return;
    expect(c.edge).toEqual(['nA', 'nB']);
  });

  it('place le point d’insertion EXACTEMENT sur le segment', () => {
    // Un point seulement « proche » déformerait la voie au lieu de la préciser :
    // insérer un nœud dans une arête suppose qu'il soit sur cette arête.
    const c = cibleSous([30, 5], carre, project);

    expect(c?.kind).toBe('segment');
    if (c?.kind !== 'segment') return;
    expect(c.loc[1]).toBeCloseTo(0, 12);       // le bord bas est à y = 0
    expect(c.loc[0]).toBeCloseTo(0.03, 12);    // 30 px = 0,03°
  });

  it('borne le point d’insertion aux extrémités du segment', () => {
    // Curseur au-delà du coin, dans l'axe du bord : la projection sort du segment et
    // doit être ramenée sur lui, sans quoi le nœud atterrirait hors de la voie.
    const c = cibleSous([-5, 3], carre, project);

    if (c?.kind !== 'segment') return;
    expect(c.loc[0]).toBeGreaterThanOrEqual(0);
  });

  it('ne rend pas deux fois le sommet répété d’un anneau fermé', () => {
    // `ring` répète son premier sommet ; le viser ne doit pas produire une cible
    // concurrente portant le même nœud à un autre rang.
    const c = cibleSous([1, -1], carre, project);

    expect(c?.kind).toBe('noeud');
    if (c?.kind !== 'noeud') return;
    expect(c.index).toBe(0);
  });

  it('gère une voie ouverte, dont le dernier sommet est un vrai sommet', () => {
    const ligne: VoieVisee = { ring: [[0, 0], [0.1, 0]], nodeIds: ['nA', 'nB'] };

    const c = cibleSous([100, 0], ligne, project);

    expect(c?.kind).toBe('noeud');
    if (c?.kind !== 'noeud') return;
    expect(c.nodeId).toBe('nB');
  });

  it('respecte le seuil de capture', () => {
    // À l'EXTÉRIEUR du carré, dans l'axe du coin A : une sonde posée le long d'un bord
    // serait capturée comme segment à distance nulle, et ne mesurerait rien.
    const juste = cibleSous([-(SEUIL_PX - 1), 0], carre, project);
    const trop = cibleSous([-(SEUIL_PX + 1), 0], carre, project);

    expect(juste?.kind).toBe('noeud');
    expect(trop).toBeNull();
  });

  it('refuse une voie dont les nœuds ne suivent pas l’anneau', () => {
    expect(cibleSous([0, 0], { ring: carre.ring, nodeIds: ['nA'] }, project)).toBeNull();
  });
});
