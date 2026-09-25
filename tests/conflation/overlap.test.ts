import { describe, it, expect } from 'vitest';
import { overlapsExisting } from '../../src/conflation/overlap';
import type { Ring } from '../../src/geometry/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

describe('overlapsExisting', () => {
  it('ne voit aucun conflit sur un terrain vierge', () => {
    expect(overlapsExisting(rect(0, 0, 0.001, 0.001), [])).toBeNull();
  });

  it('détecte un bâtiment existant au même endroit', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.001, 0.001) }];
    expect(overlapsExisting(rect(0.0002, 0.0002, 0.0008, 0.0008), existing)?.id).toBe('w1');
  });

  it('ignore un bâtiment simplement mitoyen', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.001, 0.001) }];
    expect(overlapsExisting(rect(0.001, 0, 0.002, 0.001), existing)).toBeNull();
  });

  it('détecte un existant qui englobe le nouveau', () => {
    const existing = [{ id: 'w1', ring: rect(0, 0, 0.01, 0.01) }];
    expect(overlapsExisting(rect(0.004, 0.004, 0.005, 0.005), existing)?.id).toBe('w1');
  });

  it('détecte un recouvrement par croisement d\'arêtes, sans qu\'aucun sommet ni centre ne tombe dans l\'autre', () => {
    // Bande horizontale x∈[0,20], y∈[0,2] (centre (10,1)) et bande verticale
    // x∈[3,5], y∈[-100,4] (centre (4,-48), délibérément loin de la première) :
    // elles se recouvrent réellement sur x∈[3,5], y∈[0,2], mais aucun sommet de
    // l'une ne tombe dans l'autre et aucun des deux centres n'est dans l'autre
    // anneau — seul un test de croisement d'arêtes détecte ce cas.
    // Croix : 6 unités de large sur 20, soit 30 % de recouvrement — franchement
    // au-dessus du seuil, pour que ce test porte sur la détection et non sur la
    // valeur exacte du seuil, qu'un échantillonnage ne peut pas trancher au dixième.
    const bandeHorizontale: Ring = [[0, 0], [20, 0], [20, 2], [0, 2], [0, 0]];
    const bandeVerticale: Ring = [[3, -100], [9, -100], [9, 4], [3, 4], [3, -100]];
    const existing = [{ id: 'croix', ring: bandeVerticale }];
    expect(overlapsExisting(bandeHorizontale, existing)?.id).toBe('croix');
  });

  it('ne signale pas de recouvrement pour un mur mitoyen même quand les boîtes englobantes se chevauchent', () => {
    // `existing` est un bâtiment en U dont l'échancrure touche `ring` sur une
    // sous-portion de son mur droit (x=0.002, y∈[0.001,0.0015] — strictement à
    // l'intérieur du mur y∈[0,0.003], donc sans sommet partagé) : les boîtes
    // englobantes se chevauchent réellement (contrairement au test « simplement
    // mitoyen » ci-dessus, où deux rectangles simples ont des boîtes qui ne font
    // que se toucher et sont filtrées avant même d'atteindre le test de
    // croisement). Ce cas exerce donc bien le test de croisement d'arêtes, et
    // les arêtes colinéaires-confondues du mur partagé ne doivent pas être
    // signalées comme un croisement.
    const ring: Ring = [[0, 0], [0.002, 0], [0.002, 0.003], [0, 0.003], [0, 0]];
    const existingEnU: Ring = [
      [0.002, 0.001], [0.002, 0.0015], [0.0025, 0.0015], [0.0025, 0.0035],
      [0.0005, 0.0035], [0.0005, 0.004], [0.004, 0.004], [0.004, -0.001],
      [0.0025, -0.001], [0.0025, 0.001], [0.002, 0.001],
    ];
    const existing = [{ id: 'voisin-en-u', ring: existingEnU }];
    expect(overlapsExisting(ring, existing)).toBeNull();
  });
});

describe('overlapsExisting — couverture, et non contact', () => {
  // Constaté en session réelle, à Chargé (37060) : la création était refusée à cause
  // d'un bâtiment de 334 m² dont le centroïde est à 23 m, parce qu'UN seul de ses
  // quinze sommets mordait le contour. Couverture réelle : 0,1 %.
  const carre = (x0: number, y0: number, x1: number, y1: number): Ring =>
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

  const empreinte = carre(0, 0, 10, 10);

  it('laisse passer un voisin qui ne mord qu’un coin', () => {
    // 1 unité sur 100, soit 1 % : c'est un voisin, pas un doublon.
    const voisin = { id: 'w1', ring: carre(9, 9, 30, 30) };

    expect(overlapsExisting(empreinte, [voisin])).toBeNull();
  });

  it('refuse quand le bâtiment est déjà cartographié', () => {
    const memeBatiment = { id: 'w1', ring: carre(-0.2, -0.2, 10.2, 10.2) };

    expect(overlapsExisting(empreinte, [memeBatiment])?.id).toBe('w1');
  });

  it('refuse quand plusieurs fragments couvrent ensemble le bâtiment', () => {
    // Le cas qui a motivé ce correctif dans l'autre sens : un import de 2011 avait
    // découpé ce bâtiment en cinq morceaux, qu'un cadastre plus récent a refondus en
    // un seul. Chaque fragment ne couvre qu'une part — c'est leur SOMME qui dit que
    // le bâtiment est déjà là. Un test « ce bâtiment-ci me recouvre-t-il ? » posé
    // bâtiment par bâtiment ne peut pas voir ça.
    const fragments = [
      { id: 'w1', ring: carre(0, 0, 10, 3) },
      { id: 'w2', ring: carre(0, 3, 10, 6) },
      { id: 'w3', ring: carre(0, 6, 10, 10) },
    ];

    expect(overlapsExisting(empreinte, fragments)).not.toBeNull();
  });

  it('nomme le bâtiment qui couvre le plus', () => {
    const fragments = [
      { id: 'petit', ring: carre(0, 0, 10, 2) },
      { id: 'gros', ring: carre(0, 2, 10, 10) },
    ];

    expect(overlapsExisting(empreinte, fragments)?.id).toBe('gros');
  });

  it('rend la même réponse deux fois : la grille est déterministe', () => {
    const voisin = { id: 'w1', ring: carre(4, 4, 30, 30) };

    expect(overlapsExisting(empreinte, [voisin])?.id)
      .toBe(overlapsExisting(empreinte, [voisin])?.id);
  });
});
