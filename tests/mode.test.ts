// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMode } from '../src/mode';
import type { IdBridge } from '../src/bridge/types';
import { buildDataset, type Dataset } from '../src/cadastre/dataset';
import { composeAt } from '../src/compose';
import { segmentLength } from '../src/geometry/edges';
import { DEFAULT_SNAP_TOLERANCE_M } from '../src/conflation/snap';
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

  // --- Le survol et le clic ne doivent jamais diverger SUR LA COMPOSITION ---
  //
  // Revue : ce test s'appelait « composent exactement le même contour » et comparait
  // le ring dessiné au survol au ring transmis à createBuilding. Mais dans TOUT ce
  // fichier, bridge.nodesNear renvoie toujours [] : snapToExistingNodes n'a donc jamais
  // aucun candidat et ne change structurellement rien. Ce test ne pouvait prouver que
  // « compose() est cohérent avec lui-même » (hoverAt et clickAt appellent la même
  // fonction fermée sur le même dataset) — jamais que le recalage aux nœuds existants
  // n'introduit pas de divergence, puisque le recalage était neutralisé par construction
  // dans ce fixture. Renommé pour dire exactement ce qu'il prouve ; le test suivant
  // couvre ce que celui-ci ne pouvait pas couvrir.
  it('le survol et le clic appellent la même composition (compose() cohérent avec lui-même, sans recalage)', async () => {
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

  // --- La propriété qui compte vraiment : même composition, recalage borné ---
  //
  // src/ui/overlay.ts est explicite (depuis la correction de cette revue) : l'overlay
  // montre le contour COMPOSÉ, avant recalage aux nœuds — jamais le ring exact que le
  // clic va créer dès que ce recalage fait quelque chose. La garantie de sécurité ne
  // porte donc pas sur « le ring dessiné == le ring créé au bit près », mais sur :
  // 1) même composition (même ancre, mêmes polygones absorbés) — c'est elle qui décide
  //    quel porche rejoint quelle maison, la décision qui compte réellement ;
  // 2) l'écart entre le ring montré et le ring créé est borné par la tolérance de
  //    recalage (0,2 m), jamais plus, et jamais un sommet en trop ou en moins (ce qui
  //    trahirait une composition différente, pas un simple recalage).
  //
  // Oracle indépendant : composeAt() est appelé ici directement sur un dataset construit
  // à l'identique de celui que deps().loadDataset produira pour mode.ts — pas une
  // relecture des internes de mode.ts, juste la même fonction pure appliquée aux mêmes
  // données, ce que hoverAt/clickAt font forcément aussi (établi par le test précédent
  // et par lecture de src/mode.ts : hoverAt et clickAt n'appellent que compose(pt),
  // aucun cache, aucun raccourci propre à l'un ou l'autre).
  it('le survol montre le contour composé ; le clic peut le recaler, sans jamais changer la composition', async () => {
    const datasetRef = buildDataset('49007', '2026',
      [feature('01', carre(0, 0)), feature('02', carre(0.001, 0))]);
    const attendu = composeAt([0.0005, 0.0005], {
      polys: datasetRef.polys,
      absorption: datasetRef.absorption,
      byId: datasetRef.byId,
      lightIndex: datasetRef.lightIndex,
      polyAt: datasetRef.polyAt,
    });
    if (!attendu.ok) throw new Error('précondition du test invalide : composition attendue en échec');
    // La composition attendue elle-même : un dur (id 0) qui absorbe le léger mitoyen
    // (id 1). Si ces valeurs changeaient, ce ne serait plus le même scénario.
    expect(attendu.anchorId).toBe(0);
    expect(attendu.absorbed).toEqual([1]);

    // Un nœud OSM existant à ~11 cm du premier sommet du contour composé : à l'intérieur
    // de la tolérance de recalage (0,2 m). snapToExistingNodes va donc déplacer CE
    // sommet-là au clic, sans toucher à la composition.
    const premierSommet = attendu.ring[0]!;
    bridge.nodesNear = () => [{ id: 'n1', loc: [premierSommet[0] + 0.000001, premierSommet[1]] as LonLat }];

    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();

    mode.hoverAt([0.0005, 0.0005]);
    const dSurvol = container.querySelector('path')!.getAttribute('d');
    const dAttenduSurvol = attendu.ring
      .map((p, i) => {
        const [x, y] = bridge.project(p);
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ') + ' Z';
    // Le survol dessine le contour composé tel quel, jamais recalé.
    expect(dSurvol).toBe(dAttenduSurvol);

    await mode.clickAt([0.0005, 0.0005]);
    const ringCree = created[0]!.ring as LonLat[];

    // Même composition : même nombre de sommets qu'un ring qui aurait subi un recalage
    // (le recalage ne fait jamais que déplacer des sommets existants, jamais n'en ajoute
    // ni n'en retire).
    expect(ringCree).toHaveLength(attendu.ring.length);
    ringCree.forEach((p, i) => {
      expect(segmentLength(p, attendu.ring[i]!)).toBeLessThanOrEqual(DEFAULT_SNAP_TOLERANCE_M);
    });
    // Et au moins un sommet a réellement bougé — sinon ce test ne prouverait rien sur le
    // recalage lui-même, seulement (à nouveau) que compose() est déterministe.
    expect(segmentLength(ringCree[0]!, attendu.ring[0]!)).toBeGreaterThan(0);
  });

  // --- Rechargement au franchissement d'une frontière de commune (spec §3.3) ---
  //
  // ensureDataset() ne charge qu'une fois : `if (dataset) return Promise.resolve();`
  // sans lui. Une fois le jeu de données d'Angers chargé, sortir de la commune (la
  // carte se déplace vers une autre commune) faisait échouer tout survol et tout clic
  // avec « aucun bâtiment » — silencieusement, exactement ce qu'un endroit vraiment vide
  // donne. Les communes françaises sont petites ; en franchir une est un cas ordinaire,
  // pas un cas limite.
  it('recharge le jeu de données quand la carte franchit une frontière de commune (survol utilise le nouveau)', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      const datasetB = buildDataset('49008', '2026', [feature('01', carre(0.5, 0.5))]);
      const loadDataset = vi.fn(async (pt: LonLat): Promise<Dataset> =>
        (pt[0] < 0.4 ? datasetA : datasetB));

      let onMove: (() => void) | null = null;
      bridge.onMapMove = (cb) => { onMove = cb; return () => { onMove = null; }; };

      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]]; // centre (0.005, 0.005) : commune A
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, { loadDataset, communeName: async () => 'X', notify: vi.fn() });
      mode.enable();
      await mode.whenReady(); // charge A

      mode.hoverAt([0.0005, 0.0005]); // dans le bâtiment de A : aperçu visible
      expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

      // La carte se recentre sur la commune B (franchissement de frontière).
      extent = [[0.495, 0.495], [0.505, 0.505]]; // centre (0.5, 0.5)
      onMove!();
      await vi.advanceTimersByTimeAsync(1000); // laisse le débounce puis le rechargement se dérouler

      expect(loadDataset).toHaveBeenLastCalledWith([0.5, 0.5]);

      mode.hoverAt([0.5, 0.5]); // dans le bâtiment de B — absent de A
      expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

      mode.hoverAt([0.0005, 0.0005]); // l'ancien point : n'existe plus dans B
      expect(container.querySelector('path')!.getAttribute('d')).toBe('');
    } finally {
      vi.useRealTimers();
    }
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
