// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachMergeMenu, fusionnerSelection, LIBELLE } from '../../src/ui/merge-menu';
import type { IdBridge } from '../../src/bridge/types';
import type { OsmBuilding } from '../../src/merge';

const M = 1 / 111320;

const gauche: OsmBuilding = {
  id: 'w1',
  ring: [[0, 0], [10 * M, 0], [10 * M, 8 * M], [0, 8 * M], [0, 0]],
  nodeIds: ['nA', 'nB', 'nC', 'nD', 'nA'],
  tags: { building: 'yes' },
};
const droite: OsmBuilding = {
  id: 'w2',
  ring: [[10 * M, 0], [20 * M, 0], [20 * M, 8 * M], [10 * M, 8 * M], [10 * M, 0]],
  nodeIds: ['nB', 'nE', 'nF', 'nC', 'nB'],
  tags: { building: 'yes' },
};

let selection: OsmBuilding[];
let fusions: unknown[];
let menuCb: ((slot: { menu: Element; modele: Element }) => void) | null;

const fauxBridge = (): IdBridge => ({
  mapExtent: () => [[0, 0], [1, 1]],
  project: (p) => p,
  invert: (p) => p,
  onMapMove: () => () => {},
  buildingsNear: () => [],
  nodesIn: () => [],
  createBuilding: () => {},
  prefillChangeset: () => {},
  containerNode: () => document.body,
  whenSurfaceReady: () => Promise.resolve(true),
  surfaceNode: () => document.body,
  cadastreVisible: () => true,
  selectedBuildings: () => selection,
  mergeBuildings: (plan) => { fusions.push(plan); },
  onEditMenu: (cb) => { menuCb = cb; return () => { menuCb = null; }; },
});

beforeEach(() => {
  document.body.innerHTML = '';
  selection = [];
  fusions = [];
  menuCb = null;
});

describe('fusionnerSelection', () => {
  it('fusionne et ne dit rien quand tout va bien', () => {
    selection = [gauche, droite];

    expect(fusionnerSelection(fauxBridge())).toBeNull();
    expect(fusions).toHaveLength(1);
  });

  it('prévient quand un tag a été écrasé', () => {
    // Une perte d'information invisible est pire qu'un message de trop.
    selection = [{ ...gauche, tags: { building: 'house' } }, droite];

    const m = fusionnerSelection(fauxBridge());

    expect(m).toMatch(/building/);
    expect(fusions).toHaveLength(1);
  });

  it('ne fusionne rien et explique quand ils ne se touchent pas', () => {
    selection = [gauche, { ...droite, ring: [
      [50 * M, 0], [60 * M, 0], [60 * M, 8 * M], [50 * M, 8 * M], [50 * M, 0]] }];

    expect(fusionnerSelection(fauxBridge())).toMatch(/ne se touchent pas/i);
    expect(fusions).toHaveLength(0);
  });

  it('ne fusionne rien sans exactement deux bâtiments', () => {
    selection = [gauche];

    expect(fusionnerSelection(fauxBridge())).toMatch(/deux bâtiments/i);
    expect(fusions).toHaveLength(0);
  });
});

describe('attachMergeMenu', () => {
  /** Un menu contextuel d'iD : des boutons à icône, sans libellé. */
  const ouvrirMenu = () => {
    const menu = document.createElement('div');
    menu.className = 'edit-menu';
    const modele = document.createElement('button');
    modele.className = 'edit-menu-item';
    modele.id = 'un-id-d-iD';
    modele.innerHTML =
      '<svg class="icon"><use id="autre-id" href="#iD-operation-delete"></use></svg>';
    menu.appendChild(modele);
    document.body.appendChild(menu);
    menuCb?.({ menu, modele });
    return menu;
  };

  it('clone un voisin plutôt que de se dessiner lui-même', () => {
    selection = [gauche, droite];
    attachMergeMenu(fauxBridge(), { notify: () => {} });

    const menu = ouvrirMenu();

    const ajoute = menu.lastElementChild as HTMLElement;
    expect(ajoute.tagName).toBe('BUTTON');
    expect(ajoute.className).toBe('edit-menu-item');
    // Aucun id dupliqué, ni sur l'élément ni dans sa descendance : ils casseraient
    // le getElementById d'iD sur ses propres éléments.
    expect(ajoute.id).toBe('');
    expect(ajoute.querySelectorAll('[id]')).toHaveLength(0);
  });

  it('garde une icône et met le libellé en infobulle', () => {
    // Le menu contextuel d'iD est une colonne d'icônes. Un premier essai y posait du
    // texte : l'entrée débordait de la colonne et se faisait couper.
    selection = [gauche, droite];
    attachMergeMenu(fauxBridge(), { notify: () => {} });

    const ajoute = ouvrirMenu().lastElementChild as HTMLElement;

    expect(ajoute.textContent?.trim()).toBe('');
    expect(ajoute.title).toBe(LIBELLE);
    expect(ajoute.getAttribute('aria-label')).toBe(LIBELLE);
    const use = ajoute.querySelector('use');
    expect(use?.getAttribute('href')).toBe('#iD-operation-merge');
  });

  it('n’hérite pas d’un voisin désactivé', () => {
    selection = [gauche, droite];
    attachMergeMenu(fauxBridge(), { notify: () => {} });
    const menu = document.createElement('div');
    menu.className = 'edit-menu';
    const modele = document.createElement('button');
    modele.className = 'edit-menu-item disabled';
    modele.innerHTML = '<svg><use href="#x"></use></svg>';
    menu.appendChild(modele);
    document.body.appendChild(menu);
    menuCb?.({ menu, modele });

    expect((menu.lastElementChild as HTMLElement).classList.contains('disabled')).toBe(false);
  });

  it('ne s’ajoute pas quand la sélection n’est pas deux bâtiments', () => {
    selection = [gauche];
    attachMergeMenu(fauxBridge(), { notify: () => {} });

    const menu = ouvrirMenu();

    // Le menu contextuel d'iD sert à bien d'autres choses : ne pas l'encombrer.
    expect(menu.children).toHaveLength(1);
  });

  it('fusionne au clic, et remonte un message le cas échéant', () => {
    selection = [{ ...gauche, tags: { building: 'house' } }, droite];
    const notify = vi.fn();
    attachMergeMenu(fauxBridge(), { notify });

    const menu = ouvrirMenu();
    (menu.lastElementChild as HTMLElement).click();

    expect(fusions).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/building/));
  });
});
