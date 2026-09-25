import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createImproveMode } from '../../src/improve/mode';
import type { ImproveHooks } from '../../src/improve/mode';
import type { OsmWay } from '../../src/merge';
import type { LonLat } from '../../src/geometry/types';

const carre: OsmWay = {
  id: 'w1',
  ring: [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]],
  nodeIds: ['nA', 'nB', 'nC', 'nD', 'nA'],
  tags: { building: 'yes' },
};

let selection: OsmWay[];
let montres: { loc: LonLat; kind: string }[];
let caches: number;

const hooks = (): ImproveHooks => ({
  selectedWays: () => selection,
  project: (p) => [p[0] * 1000, -p[1] * 1000],
  showTarget: (loc, kind) => { montres.push({ loc, kind }); },
  hideTarget: () => { caches++; },
});

beforeEach(() => {
  selection = [carre];
  montres = [];
  caches = 0;
});

describe('createImproveMode', () => {
  it('ne vise rien tant qu’il n’est pas armé', () => {
    const m = createImproveMode(hooks());

    m.hoverAt([0, 0]);

    expect(montres).toEqual([]);
    expect(m.cible()).toBeNull();
  });

  it('montre le sommet visé une fois armé', () => {
    const m = createImproveMode(hooks());
    m.enable();

    m.hoverAt([100, 0]);

    expect(montres).toHaveLength(1);
    expect(montres[0]!.kind).toBe('noeud');
    expect(m.cible()?.kind).toBe('noeud');
  });

  it('montre le point d’insertion sur un segment', () => {
    const m = createImproveMode(hooks());
    m.enable();

    m.hoverAt([50, 2]);

    expect(montres[0]!.kind).toBe('segment');
  });

  it('relit la sélection à chaque survol, sans la figer à l’armement', () => {
    // L'utilisateur peut changer de voie sans relâcher Ctrl ; une sélection mémorisée
    // viserait alors une voie qu'il ne regarde plus.
    const m = createImproveMode(hooks());
    m.enable();
    m.hoverAt([100, 0]);

    selection = [];
    m.hoverAt([100, 0]);

    expect(m.cible()).toBeNull();
    expect(caches).toBe(1);
  });

  it('ne vise rien quand plusieurs voies sont sélectionnées', () => {
    // « Le nœud le plus proche » devient ambigu, et un clic toucherait un objet que
    // l'utilisateur ne croyait pas viser.
    selection = [carre, { ...carre, id: 'w2' }];
    const m = createImproveMode(hooks());
    m.enable();

    m.hoverAt([100, 0]);

    expect(m.cible()).toBeNull();
    expect(montres).toEqual([]);
  });

  it('oublie sa cible quand le curseur s’éloigne', () => {
    const m = createImproveMode(hooks());
    m.enable();
    m.hoverAt([100, 0]);

    m.hoverAt([500, 500]);

    expect(m.cible()).toBeNull();
    expect(caches).toBe(1);
  });

  it('n’efface pas deux fois de suite', () => {
    // `hideTarget` redessine : l'appeler à chaque mouvement hors de portée ferait
    // travailler l'overlay pour rien, soixante fois par seconde.
    const m = createImproveMode(hooks());
    m.enable();

    m.hoverAt([500, 500]);
    m.hoverAt([600, 600]);

    expect(caches).toBe(0);
  });

  it('efface en se désarmant', () => {
    const m = createImproveMode(hooks());
    m.enable();
    m.hoverAt([100, 0]);

    m.disable();

    expect(m.isEnabled()).toBe(false);
    expect(caches).toBe(1);
    expect(m.cible()).toBeNull();
  });
});
