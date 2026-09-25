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
let montres: { loc: LonLat; kind: string; partage: boolean }[];
let caches: number;
let deplaces: { id: string; loc: LonLat }[];
let inseres: { edge: [string, string]; loc: LonLat }[];
let partageRendu: boolean | null;

const hooks = (): ImproveHooks => ({
  selectedWays: () => selection,
  project: (p) => [p[0] * 1000, -p[1] * 1000],
  invert: (e) => [e[0] / 1000, -e[1] / 1000],
  showTarget: (loc, kind, partage) => { montres.push({ loc, kind, partage }); },
  hideTarget: () => { caches++; },
  moveNode: (id, loc) => { deplaces.push({ id, loc }); },
  insertNodeOnEdge: (edge, loc) => { inseres.push({ edge, loc }); },
  nodeIsShared: () => partageRendu,
});

beforeEach(() => {
  selection = [carre];
  montres = [];
  caches = 0;
  deplaces = [];
  inseres = [];
  partageRendu = null;
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

  it('déplace le sommet visé SOUS le curseur', () => {
    const m = createImproveMode(hooks());
    m.enable();

    // Curseur à 8 px du coin B : la cible est B, mais la destination est le curseur.
    expect(m.clickAt([108, 0])).toBe(true);

    expect(deplaces).toHaveLength(1);
    expect(deplaces[0]!.id).toBe('nB');
    expect(deplaces[0]!.loc[0]).toBeCloseTo(0.108, 12);
    expect(inseres).toEqual([]);
  });

  it('insère un nœud sur le segment visé', () => {
    const m = createImproveMode(hooks());
    m.enable();

    expect(m.clickAt([50, 2])).toBe(true);

    expect(inseres).toHaveLength(1);
    expect(inseres[0]!.edge).toEqual(['nA', 'nB']);
    // Le nœud inséré tombe SUR l'arête, pas sous le curseur : ailleurs, il
    // déformerait la voie au lieu de la préciser.
    expect(inseres[0]!.loc[1]).toBeCloseTo(0, 12);
    expect(deplaces).toEqual([]);
  });

  it('ne fait rien, et le dit, quand rien n’est visé', () => {
    const m = createImproveMode(hooks());
    m.enable();

    // Le retour `false` laisse l'appelant rendre le clic à iD.
    expect(m.clickAt([500, 500])).toBe(false);
    expect(deplaces).toEqual([]);
    expect(inseres).toEqual([]);
  });

  it('ne fait rien tant qu’il n’est pas armé', () => {
    const m = createImproveMode(hooks());

    expect(m.clickAt([108, 0])).toBe(false);
    expect(deplaces).toEqual([]);
  });

  it('recalcule la cible au clic plutôt que de reprendre celle du survol', () => {
    // Entre le dernier survol et le clic, la carte a pu bouger sous le curseur.
    const m = createImproveMode(hooks());
    m.enable();
    m.hoverAt([100, 0]);          // vise nB

    m.clickAt([0, 0]);            // mais le clic tombe sur nA

    expect(deplaces[0]!.id).toBe('nA');
  });

  it('signale un nœud partagé, et ne suppose rien quand c’est indéterminable', () => {
    // Sur une route, les jonctions sont partout : déplacer l'une d'elles déplace la
    // jonction pour toutes les voies qui s'y rejoignent.
    partageRendu = true;
    const m = createImproveMode(hooks());
    m.enable();
    m.hoverAt([100, 0]);
    expect(montres.at(-1)!.partage).toBe(true);

    // `null` signifie « je ne sais pas » : on n'alarme pas sans savoir, et aucune
    // action n'en dépend.
    partageRendu = null;
    m.hoverAt([0, 0]);
    expect(montres.at(-1)!.partage).toBe(false);
  });
});
