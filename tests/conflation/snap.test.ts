import { describe, it, expect } from 'vitest';
import { snapToExistingNodes, planInsertions } from '../../src/conflation/snap';
import type { ExistingBuilding } from '../../src/conflation/overlap';
import type { Ring } from '../../src/geometry/types';

const carre: Ring = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];

describe('snapToExistingNodes', () => {
  it('ne touche à rien sans nœud voisin', () => {
    const r = snapToExistingNodes(carre, []);
    expect(r.ring).toEqual(carre);
    expect(r.reused.every(x => x === null)).toBe(true);
  });

  it('réutilise un nœud situé à moins de la tolérance', () => {
    // ~11 cm à l'est du premier sommet
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.reused[0]).toBe('n1');
  });

  it('déplace le sommet cadastre vers le nœud, jamais l’inverse', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual([0.000001, 0]);
    expect(nodes[0]!.loc).toEqual([0.000001, 0]);   // le nœud existant est intact
    expect(r.ring[0]).not.toBe(nodes[0]!.loc);      // et sans partager sa référence
  });

  it('ignore un nœud au-delà de la tolérance', () => {
    // ~1,1 m
    const nodes = [{ id: 'n1', loc: [0.00001, 0] as [number, number] }];
    expect(snapToExistingNodes(carre, nodes, 0.2).reused[0]).toBeNull();
  });

  it('n’attribue jamais deux fois le même nœud', () => {
    const nodes = [{ id: 'n1', loc: [0, 0] as [number, number] }];
    const ringProche: Ring = [[0, 0], [0.0000005, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
    const r = snapToExistingNodes(ringProche, nodes, 0.5);
    expect(r.reused.filter(x => x === 'n1')).toHaveLength(1);
  });

  it('attribue le nœud au sommet le plus proche, pas au premier venu dans l’ordre de l’anneau', () => {
    // vA (indice 0) est à ~0,13 m du nœud ; vB (indice 1) tombe exactement dessus.
    // Une attribution gloutonne dans l'ordre de l'anneau donnerait le nœud à vA,
    // rencontré en premier, au lieu de vB, le seul sommet qui coïncide vraiment.
    const ring: Ring = [[0, 0], [0.0000012, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
    const nodes = [{ id: 'n1', loc: [0.0000012, 0] as [number, number] }];
    const r = snapToExistingNodes(ring, nodes, 0.2);
    expect(r.reused[1]).toBe('n1');
    expect(r.reused[0]).toBeNull();
  });

  it('garde l’anneau fermé après recalage', () => {
    const nodes = [{ id: 'n1', loc: [0.000001, 0] as [number, number] }];
    const r = snapToExistingNodes(carre, nodes, 0.2);
    expect(r.ring[0]).toEqual(r.ring[r.ring.length - 1]);
  });
});

describe('snapToExistingNodes — borne sur la liste de nœuds', () => {
  // Le préfiltre d'emprise (borne de coût, C1) doit dilater le rectangle englobant de
  // la tolérance. Sans dilatation il serait faux et pas seulement moins rapide : un
  // nœud voisin situé juste À L'EXTÉRIEUR d'un coin est hors du rectangle brut tout en
  // étant à portée — et c'est exactement le cas que ce module existe pour traiter.
  it('réutilise un nœud à portée mais hors du rectangle englobant brut', () => {
    // ~11 cm au sud-ouest du coin [0,0] : dehors sur les DEUX axes.
    const dehors = { id: 'n1', loc: [-0.0000005, -0.000001] as [number, number] };
    const r = snapToExistingNodes(carre, [dehors], 0.2);
    expect(r.reused[0]).toBe('n1');
  });

  it('un grand nombre de nœuds lointains ne change pas le résultat', () => {
    const proche = { id: 'n1', loc: [0, 0] as [number, number] };
    const lointains = Array.from({ length: 5000 }, (_, i) => ({
      id: `loin${i}`, loc: [1 + i * 0.001, 1] as [number, number],
    }));
    const attendu = snapToExistingNodes(carre, [proche], 0.2);
    const avecBruit = snapToExistingNodes(carre, [proche, ...lointains], 0.2);
    expect(avecBruit).toEqual(attendu);
  });
});

describe('planInsertions — coudre le mur d’un bâtiment OSM existant', () => {
  // Le cas visé : le voisin a DÉJÀ été importé depuis le cadastre, les géométries
  // s'accordent au centimètre, mais notre coin tombe au MILIEU de son mur, là où il
  // n'existe aucun nœud à réutiliser. Sans insertion, deux murs se superposent sans
  // partager un seul nœud.
  const M = 1 / 111320;                      // ~1 m en latitude

  /** Un mur OSM de 10 m, porté par deux nœuds, longeant l'axe des x. */
  const voisin = (): ExistingBuilding => ({
    id: 'w100',
    ring: [[0, 0], [10 * M, 0], [10 * M, -5 * M], [0, -5 * M], [0, 0]],
    nodeIds: ['n1', 'n2', 'n3', 'n4', 'n1'],
  });

  /** Un contour dont le premier sommet tombe au milieu du mur du voisin. */
  const contour = (ecartM = 0): Ring => [
    [5 * M, ecartM * M], [8 * M, 5 * M], [2 * M, 5 * M], [5 * M, ecartM * M],
  ];

  it('désigne l’arête à couper, par ses deux nœuds', () => {
    const plan = planInsertions(contour(), [null, null, null], [voisin()]);

    expect(plan[0]).toEqual({ wayId: 'w100', edge: ['n1', 'n2'] });
    expect(plan[1]).toBeNull();
    expect(plan[2]).toBeNull();
  });

  it('laisse tranquille un sommet déjà recalé sur un nœud existant', () => {
    // Il partage déjà ce nœud : insérer en plus créerait un doublon.
    const plan = planInsertions(contour(), ['n1', null, null], [voisin()]);

    expect(plan[0]).toBeNull();
  });

  it('n’insère pas à l’extrémité d’une arête, où un nœud existe déjà', () => {
    const surLeCoin: Ring = [[0, 0], [8 * M, 5 * M], [2 * M, 5 * M], [0, 0]];

    expect(planInsertions(surLeCoin, [null, null, null], [voisin()])[0]).toBeNull();
  });

  it('refuse au-delà de la tolérance : on recoud un mur, on ne déforme pas', () => {
    // 50 cm du mur avec une tolérance de 20 cm. Insérer là ferait passer le mur du
    // voisin par notre point et déplacerait sa géométrie d'un demi-mètre.
    expect(planInsertions(contour(-0.5), [null, null, null], [voisin()])[0]).toBeNull();
    expect(planInsertions(contour(-0.1), [null, null, null], [voisin()])[0]).not.toBeNull();
  });

  it('ne fait rien si le contexte iD n’expose pas les nœuds du voisin', () => {
    const sansIds = { ...voisin(), nodeIds: undefined };

    // Dégradation, pas panne : on retombe sur le comportement d'avant, deux murs
    // superposés sans nœud commun.
    expect(planInsertions(contour(), [null, null, null], [sansIds])[0]).toBeNull();
  });
});
