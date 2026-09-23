// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMode } from '../src/mode';
import type { IdBridge } from '../src/bridge/types';
import { buildDataset, type Dataset } from '../src/cadastre/dataset';
import type { LonLat } from '../src/geometry/types';

const feature = (type: string, ring: number[][]) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
  properties: { type, commune: '49007' },
});
const carre = (x0: number, y0: number, d = 0.001) =>
  [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];

describe('mode cadastre', () => {
  let container: HTMLElement;
  let bridge: IdBridge;
  let created: { ring: unknown; tags: Record<string, string> }[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    created = [];
    bridge = {
      mapExtent: () => [[0, 0], [0.01, 0.01]],
      project: p => [p[0] * 1000, p[1] * 1000],
      invert: p => [p[0] / 1000, p[1] / 1000],
      onMapMove: () => () => {},
      buildingsNear: () => [],
      nodesNear: () => [],
      createBuilding: (ring, tags) => { created.push({ ring, tags }); },
      prefillChangeset: vi.fn(),
      containerNode: () => container,
    };
  });

  const deps = () => ({
    loadDataset: async () => buildDataset('49007', '2026',
      [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]),
    communeName: async () => 'Angers',
    notify: vi.fn(),
  });

  it('démarre désactivé', () => {
    expect(createMode(bridge, deps()).isEnabled()).toBe(false);
  });

  it('crée le bâtiment fusionné au clic, avec ses tags', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);

    expect(created).toHaveLength(1);
    expect(created[0]!.tags.building).toBe('yes');
    expect(created[0]!.tags.source).toContain('Mise à jour : 2026');
    expect(created[0]!.tags.wall).toBeUndefined();
  });

  it('refuse et notifie quand un bâtiment OSM existe déjà', async () => {
    bridge.buildingsNear = () => [{ id: 'w1', ring: carre(0, 0) as any }];
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);

    expect(created).toHaveLength(0);
    expect(d.notify).toHaveBeenCalledWith(expect.stringMatching(/existe déjà/i));
  });

  it('préremplit le commentaire de changeset avec la commune', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);
    expect(bridge.prefillChangeset).toHaveBeenCalledWith(expect.stringContaining('Angers'));
  });

  it('pose wall=no sur une construction légère isolée', async () => {
    const d = {
      ...deps(),
      loadDataset: async () => buildDataset('49007', '2026', [feature('02', carre(0, 0))]),
    };
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);
    expect(created[0]!.tags.wall).toBe('no');
  });

  it('désactivé, ne crée rien', async () => {
    const mode = createMode(bridge, deps());
    await mode.clickAt([0.0005, 0.0005]);
    expect(created).toHaveLength(0);
  });

  // --- Chemins de sortie de l'overlay (tâche 15 : show/hide/destroy, rien d'autre) ---
  //
  // Quatre sorties recensées : mode désactivé, curseur qui quitte la carte, refus en
  // cours de survol (composeAt ok:false — jamais de ring à dessiner), et composition
  // qui ne renvoie rien du tout (jeu de données pas encore chargé). Les quatre sont
  // couvertes ci-dessous en lisant directement le <path> du calque dans le DOM, comme
  // tests/ui/overlay.test.ts le fait pour l'overlay seul.

  it('affiche un aperçu au survol, puis l’efface quand le curseur quitte la carte', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();

    mode.hoverAt([0.0005, 0.0005]);
    expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

    mode.hoverEnd();
    expect(container.querySelector('path')!.getAttribute('d')).toBe('');
  });

  it('efface l’aperçu quand le survol retombe sur un refus (composeAt ok:false)', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();

    mode.hoverAt([0.0005, 0.0005]); // sur le bâtiment fusionné : aperçu affiché
    expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

    mode.hoverAt([5, 5]); // hors de tout polygone cadastre : aucun-batiment, ok:false
    expect(container.querySelector('path')!.getAttribute('d')).toBe('');
  });

  it('ne plante pas et n’affiche rien au survol tant que le jeu de données n’est pas encore chargé', () => {
    let resolveDataset!: (d: Dataset) => void;
    const pending = new Promise<Dataset>(resolve => { resolveDataset = resolve; });
    const d = { ...deps(), loadDataset: () => pending };
    const mode = createMode(bridge, d);

    mode.enable(); // déclenche le chargement, mais la promesse n'est pas encore résolue
    expect(() => mode.hoverAt([0.0005, 0.0005])).not.toThrow();
    expect(container.querySelector('path')!.getAttribute('d')).toBe('');

    resolveDataset(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
  });

  it('désactiver le mode retire complètement le calque du DOM, pas seulement son contenu', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    mode.hoverAt([0.0005, 0.0005]);
    expect(container.querySelector('svg')).not.toBeNull();

    mode.disable();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('un hoverAt après disable() ne rallume pas l’aperçu', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    mode.disable();

    expect(() => mode.hoverAt([0.0005, 0.0005])).not.toThrow();
    expect(container.querySelector('svg')).toBeNull();
  });

  // --- Le survol et le clic ne doivent jamais pouvoir diverger ---
  //
  // Les deux appellent la même fonction de composition (compose(pt), fermée sur le
  // même dataset). Ce test compare le contour effectivement dessiné par le survol
  // (recalculé via bridge.project, comme le fait l'overlay) au contour effectivement
  // transmis à createBuilding par le clic, pour le MÊME point : ils doivent coïncider
  // exactement, pas seulement se ressembler.
  it('le survol et le clic composent exactement le même contour pour le même point', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();

    mode.hoverAt([0.0005, 0.0005]);
    const dAvantClic = container.querySelector('path')!.getAttribute('d');

    await mode.clickAt([0.0005, 0.0005]);
    const ringCree = created[0]!.ring as LonLat[];
    const dAttendu = ringCree
      .map((p, i) => {
        const [x, y] = bridge.project(p);
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ') + ' Z';

    expect(dAvantClic).toBe(dAttendu);
  });
});

describe('mode cadastre — commune introuvable vs réseau (defaultLoadDataset)', () => {
  // Ces deux tests exercent le chargement par défaut (aucun deps.loadDataset fourni),
  // en substituant globalThis.fetch : c'est le seul point d'entrée de communeAt() et
  // downloadCommune(). Distinction déjà réglée en amont (cadastre/insee.ts) : communeAt
  // renvoyant null veut dire « hors couverture », une réponse HTTP en échec veut dire
  // « le réseau/l'API a échoué » — les deux doivent aboutir à des messages différents,
  // sous peine de dire à quelqu'un à Bordeaux que Bordeaux n'est pas en France.
  let container: HTMLElement;
  let bridge: IdBridge;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    originalFetch = globalThis.fetch;
    bridge = {
      mapExtent: () => [[0, 0], [0.01, 0.01]],
      project: p => [p[0] * 1000, p[1] * 1000],
      invert: p => [p[0] / 1000, p[1] / 1000],
      onMapMove: () => () => {},
      buildingsNear: () => [],
      nodesNear: () => [],
      createBuilding: () => {},
      prefillChangeset: vi.fn(),
      containerNode: () => container,
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('notifie « commune introuvable » quand communeAt ne trouve aucune commune (liste vide)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as any;
    const notify = vi.fn();
    const mode = createMode(bridge, { notify });
    mode.enable();
    await mode.whenReady();
    globalThis.fetch = originalFetch;

    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/hors couverture|introuvable/i));
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/connexion/i));
  });

  it('notifie une erreur « réseau » quand l’API répond en échec (pas « commune introuvable »)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('erreur', { status: 500 })) as any;
    const notify = vi.fn();
    const mode = createMode(bridge, { notify });
    mode.enable();
    await mode.whenReady();
    globalThis.fetch = originalFetch;

    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/connexion/i));
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/hors couverture/i));
  });
});
