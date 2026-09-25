// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createOverlay } from '../../src/ui/overlay';
import type { IdBridge } from '../../src/bridge/types';
import type { Ring } from '../../src/geometry/types';

const carre: Ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

const fauxBridge = (container: HTMLElement): IdBridge => ({
  mapExtent: () => [[0, 0], [1, 1]],
  project: (p) => [p[0] * 100, p[1] * 100],
  invert: (p) => [p[0] / 100, p[1] / 100],
  onMapMove: () => () => {},
  buildingsNear: () => [],
  nodesIn: () => [],
  createBuilding: () => {},
  prefillChangeset: () => {},
  containerNode: () => container,
  whenSurfaceReady: () => Promise.resolve(true),
  surfaceNode: () => container,
  cadastreVisible: () => true,
  selectedBuildings: () => [],
  selectedWays: () => [],
  moveNode: () => {},
  insertNodeOnEdge: () => {},
  nodeIsShared: () => null,
  mergeBuildings: () => {},
  onEditMenu: () => () => {},
});

// Bridge qui capture réellement le callback d'onMapMove (au lieu du no-op ci-dessus) :
// `declencherDeplacement` simule un déplacement de carte en l'appelant, et le
// désabonnement rendu par onMapMove retire réellement le callback de `listeners` — ce
// qui permet de vérifier qu'un overlay détruit s'y désabonne pour de vrai, pas
// seulement en le lisant à côté de l'implémentation.
const fauxBridgeAvecDeplacements = (container: HTMLElement) => {
  const listeners = new Set<() => void>();
  let scale = 100;
  const bridge: IdBridge = {
    mapExtent: () => [[0, 0], [1, 1]],
    project: (p) => [p[0] * scale, p[1] * scale],
    invert: (p) => [p[0] / scale, p[1] / scale],
    onMapMove: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    buildingsNear: () => [],
    nodesIn: () => [],
    createBuilding: () => {},
    prefillChangeset: () => {},
    containerNode: () => container,
    whenSurfaceReady: () => Promise.resolve(true),
    surfaceNode: () => container,
    cadastreVisible: () => true,
    selectedBuildings: () => [],
    selectedWays: () => [],
    moveNode: () => {},
    insertNodeOnEdge: () => {},
    nodeIsShared: () => null,
    mergeBuildings: () => {},
    onEditMenu: () => () => {},
  };
  return {
    bridge,
    setScale: (s: number) => { scale = s; },
    declencherDeplacement: () => { for (const cb of listeners) cb(); },
  };
};

describe('overlay', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('n’affiche rien tant qu’on n’a rien montré', () => {
    createOverlay(fauxBridge(container));
    // Deux assertions distinctes, volontairement : le `<path>` doit exister (sinon ce
    // test passerait même si createOverlay n'en créait jamais un — un `?.` sur un
    // querySelector qui renvoie null est falsy comme un `d` vide), ET son `d` doit être
    // vide.
    const path = container.querySelector('path');
    expect(path).not.toBeNull();
    expect(path!.getAttribute('d')).toBe('');
  });

  it('trace le contour projeté', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    const d = container.querySelector('path')!.getAttribute('d')!;
    expect(d).toContain('M 0 0');
    expect(d).toContain('100 0');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('distingue visuellement un refus', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    const okClass = container.querySelector('path')!.getAttribute('class');
    o.show(carre, 'refus');
    expect(container.querySelector('path')!.getAttribute('class')).not.toBe(okClass);
  });

  // Revue de la tâche 15 : un garde sur « l'état a-t-il changé depuis le dernier show()
  // ? » laissait le tout premier show('ok') d'une session sans le suffixe de classe
  // sb-osm-ok (la classe restait au défaut posé à la construction), ce suffixe
  // n'apparaissant qu'après être passé par 'refus' au moins une fois. Ce test porte
  // spécifiquement sur le TOUT PREMIER appel, sans show('refus') préalable.
  it('porte la classe d’état dès le tout premier show(), sans refus préalable', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    expect(container.querySelector('path')!.getAttribute('class')).toContain('sb-osm-ok');
  });

  it('efface le contour', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    o.hide();
    expect(container.querySelector('path')!.getAttribute('d')).toBe('');
  });

  it('se retire proprement', () => {
    const o = createOverlay(fauxBridge(container));
    o.destroy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('redessine sur un déplacement de carte simulé tant que l’overlay est vivant', () => {
    const { bridge, setScale, declencherDeplacement } = fauxBridgeAvecDeplacements(container);
    const o = createOverlay(bridge);
    o.show(carre, 'ok');
    expect(container.querySelector('path')!.getAttribute('d')).toContain('100 0');

    setScale(200); // simule un zoom : reprojette tous les points différemment
    declencherDeplacement();

    expect(container.querySelector('path')!.getAttribute('d')).toContain('200 0');
  });

  // Reproduit précisément le risque nommé dans la tâche 15 : un overlay détruit qui
  // continue de redessiner contre un conteneur qu'il ne possède plus. Le nœud `path`
  // est capturé AVANT destroy() ; s'il redessinait encore après, cette même référence
  // porterait le nouveau `d` même si le `<svg>` a été retiré du conteneur.
  it('arrête de redessiner après destroy()', () => {
    const { bridge, setScale, declencherDeplacement } = fauxBridgeAvecDeplacements(container);
    const o = createOverlay(bridge);
    o.show(carre, 'ok');
    const path = container.querySelector('path')!;

    o.destroy();
    const dApresDestroy = path.getAttribute('d');

    setScale(200);
    declencherDeplacement(); // si le désabonnement avait échoué, ceci redessinerait

    expect(path.getAttribute('d')).toBe(dApresDestroy);
    expect(path.getAttribute('d')).not.toContain('200 0');
  });
});

describe('overlay — origine de la projection', () => {
  // I1 : le calque dessinait des coordonnées produites par `bridge.project()` (dont
  // l'origine est le coin de la SURFACE de carte) dans un SVG attaché au CONTENEUR
  // d'iD — racine de l'éditeur, barre d'outils et panneau latéral compris. Les deux
  // origines ne peuvent pas coïncider, et le panneau latéral s'ouvre précisément après
  // chaque création puisque le bridge appelle `modeSelect`. Un aperçu décalé de la
  // largeur du panneau est pire qu'un aperçu absent : il a l'air de fonctionner, alors
  // qu'il est le seul garde-fou contre une annexion erronée (spec §5).
  it('s’attache à surfaceNode(), pas à la racine du conteneur', () => {
    const conteneur = document.createElement('div');
    const panneauLateral = document.createElement('div');
    const surface = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    surface.setAttribute('class', 'surface');
    conteneur.appendChild(panneauLateral);
    conteneur.appendChild(surface);
    document.body.appendChild(conteneur);

    const bridge: IdBridge = {
      mapExtent: () => [[0, 0], [1, 1]],
      project: (p) => [p[0] * 100, p[1] * 100],
      invert: (p) => [p[0] / 100, p[1] / 100],
      onMapMove: () => () => {},
      buildingsNear: () => [],
      nodesIn: () => [],
      createBuilding: () => {},
      prefillChangeset: () => {},
      containerNode: () => conteneur,
      whenSurfaceReady: () => Promise.resolve(true),
      surfaceNode: () => surface,
      cadastreVisible: () => true,
      selectedBuildings: () => [],
      selectedWays: () => [],
      moveNode: () => {},
      insertNodeOnEdge: () => {},
      nodeIsShared: () => null,
      mergeBuildings: () => {},
      onEditMenu: () => () => {},
    };

    createOverlay(bridge);

    const svg = conteneur.querySelector('svg.sb-osm-overlay');
    expect(svg).not.toBeNull();
    expect(surface.contains(svg!)).toBe(true);
  });
});
