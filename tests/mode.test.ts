// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMode } from '../src/mode';
import type { IdBridge } from '../src/bridge/types';
import { buildDataset, type Dataset } from '../src/cadastre/dataset';
import { composeAt } from '../src/compose';
import { segmentLength } from '../src/geometry/edges';
import { DEFAULT_SNAP_TOLERANCE_M, type ExistingNode } from '../src/conflation/snap';
import type { LonLat } from '../src/geometry/types';

const feature = (type: string, ring: number[][]) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
  properties: { type, commune: '49007' },
});
const carre = (x0: number, y0: number, d = 0.001) =>
  [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];

/**
 * Fait de bridge.onMapMove un vrai registre à plusieurs abonnés (un Set), comme le
 * fait déjà tests/ui/overlay.test.ts pour ses propres tests (fauxBridgeAvecDeplacements)
 * — et comme src/bridge/capture.ts le fait réellement depuis la revue de la tâche 16.
 *
 * Revue : la version précédente de ce fichier utilisait un slot unique
 * (`let onMove; bridge.onMapMove = cb => { onMove = cb; ... }`), qui reproduisait
 * silencieusement exactement le bug que cette revue a trouvé dans le bridge réel
 * (« deux abonnements sur le même bridge s'écrasent ») — sauf que dans le mode, il n'y a
 * QU'UN SEUL abonné (scheduleReload), donc le bug du bridge ne se voyait pas ici. Un
 * Set est correct dans les deux cas : un seul abonné ou plusieurs.
 */
function bridgeAvecDeplacements(bridge: IdBridge): { declencherDeplacement: () => void } {
  const listeners = new Set<() => void>();
  bridge.onMapMove = (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
  return { declencherDeplacement: () => { for (const cb of listeners) cb(); } };
}

/** Une promesse que le test résout à la main, pour contrôler précisément l'ordre de résolution. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

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
      nodesIn: () => [],
      createBuilding: (ring, tags) => { created.push({ ring, tags }); },
      prefillChangeset: vi.fn(),
      containerNode: () => container,
      whenSurfaceReady: () => Promise.resolve(true),
      surfaceNode: () => container,
      cadastreVisible: () => true,
      selectedBuildings: () => [],
      selectedWays: () => [],
      mergeBuildings: () => {},
      onEditMenu: () => () => {},
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
    expect(d.notify).toHaveBeenCalledWith(expect.stringMatching(/couvre déjà/i));
  });

  it('préremplit le commentaire de changeset avec la commune', async () => {
    const d = deps();
    const mode = createMode(bridge, d);
    mode.enable();
    await mode.whenReady();
    await mode.clickAt([0.0005, 0.0005]);
    expect(bridge.prefillChangeset).toHaveBeenCalledWith(
      expect.stringContaining('Angers'),
      // La source aussi, pas seulement le commentaire : le README l'annonce comme
      // preuve de conformité au code de conduite des éditions automatisées.
      expect.stringContaining('Mise à jour : 2026'),
    );
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
  // le ring dessiné au survol au ring transmis à createBuilding. Mais le double de
  // bridge de ce bloc rend toujours [] depuis nodesIn : snapToExistingNodes n'a donc jamais
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
    bridge.nodesIn = () => [{ id: 'n1', loc: [premierSommet[0] + 0.000001, premierSommet[1]] as LonLat }];

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

      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);

      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]]; // centre (0.005, 0.005) : commune A
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) => (pt[0] < 0.4 ? '49007' : '49008'),
        communeName: async () => 'X',
        notify: vi.fn(),
      });
      mode.enable();
      await mode.whenReady(); // charge A

      mode.hoverAt([0.0005, 0.0005]); // dans le bâtiment de A : aperçu visible
      expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

      // La carte se recentre sur la commune B (franchissement de frontière).
      extent = [[0.495, 0.495], [0.505, 0.505]]; // centre (0.5, 0.5)
      declencherDeplacement();
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



  // --- Revue finale (mineur 3) : lastFailureReason n'était jamais réinitialisé ---
  //
  // La déduplication des notifications (voir notifyFailure) est nécessaire — sans elle,
  // une panne près d'une frontière rouvrirait un dialogue bloquant toutes les 500 ms.
  // Mais elle ne doit pas survivre à un cycle éteint/rallumé : la personne qui rallume
  // le mode après un échec attend un diagnostic, pas un mode muet qui ne fait rien.
  it('une même panne notifie à nouveau après un cycle désactivation / réactivation', async () => {
    const notify = vi.fn();
    const loadDataset = vi.fn(async (): Promise<Dataset> => { throw new Error('panne réseau'); });
    const mode = createMode(bridge, { loadDataset, communeName: async () => 'X', notify });

    mode.enable();
    await mode.whenReady();
    expect(notify).toHaveBeenCalledTimes(1);

    mode.disable();
    mode.enable();
    await mode.whenReady();

    expect(notify).toHaveBeenCalledTimes(2);
  });

  // --- Revue finale (I2) : un déplacement ne recharge plus la commune entière ---
  //
  // `scheduleReload` lançait `loadDataset` puis ne comparait l'INSEE qu'APRÈS coup, pour
  // jeter le résultat s'il était identique. Comme il est branché sur `move` (panoramique
  // ET zoom), chaque déplacement payait une résolution réseau, ~20 Mo de
  // désérialisation IndexedDB et `buildDataset` (1 142 ms mesurés sur Angers, bien plus
  // sur Marseille) — pour presque toujours rien. Et pendant tout ce temps
  // `loading !== null`, donc `hoverAt` cachait l'aperçu : chaque déplacement éteignait
  // le survol pendant une à trois secondes.
  it('un déplacement sans changement de commune ne recharge pas le jeu de données', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      const loadDataset = vi.fn(async (): Promise<Dataset> => datasetA);
      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async () => '49007',   // la carte ne quitte jamais Angers
        communeName: async () => 'Angers',
        notify: vi.fn(),
      });
      mode.enable();
      await mode.whenReady();

      extent = [[0.001, 0.001], [0.011, 0.011]]; // un simple panoramique
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);

      expect(loadDataset).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un déplacement dans la même commune n’éteint pas le survol', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      let appels = 0;
      // Le second chargement ne se résout JAMAIS : il tient le rôle du chargement d'une
      // à trois secondes pendant lequel hoverAt cachait l'aperçu.
      const loadDataset = vi.fn((): Promise<Dataset> => {
        appels++;
        return appels === 1 ? Promise.resolve(datasetA) : new Promise<Dataset>(() => {});
      });
      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async () => '49007',
        communeName: async () => 'Angers',
        notify: vi.fn(),
      });
      mode.enable();
      await mode.whenReady();

      extent = [[0.001, 0.001], [0.011, 0.011]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);

      mode.hoverAt([0.0005, 0.0005]);
      expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('un panoramique pendant le chargement de la nouvelle commune ne le relance pas', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      let appels = 0;
      const loadDataset = vi.fn((): Promise<Dataset> => {
        appels++;
        return appels === 1 ? Promise.resolve(datasetA) : new Promise<Dataset>(() => {});
      });
      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) => (pt[0] < 0.4 ? '49007' : '49008'),
        communeName: async () => 'X',
        notify: vi.fn(),
      });
      mode.enable();
      await mode.whenReady();

      extent = [[0.495, 0.495], [0.505, 0.505]]; // on entre dans 49008 : rechargement
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);
      expect(loadDataset).toHaveBeenCalledTimes(2);

      // Encore un panoramique, toujours dans 49008, pendant que son chargement est en
      // vol : `dataset.insee` vaut encore 49007, donc sans mémoire du chargement en
      // cours on relancerait le même chargement.
      extent = [[0.5, 0.5], [0.51, 0.51]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);
      expect(loadDataset).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Revue finale (re-revue) : un rechargement en vol qu'on a quitté doit être
  // supplanté, pas laissé filer ---
  //
  // Trace : carte en A (dataset chargé) → panoramique vers B → le débounce lance
  // startLoad(B), EN VOL une à trois secondes → panoramique de retour en A, DANS cette
  // fenêtre. maybeReload résout alors `code === 'A'`. Comme `dataset.insee` vaut encore
  // 'A' (le chargement vers B n'a pas encore abouti), la garde
  // `code === dataset.insee` de la revue précédente rendait vrai et retournait tôt : AUCUN
  // chargement n'est relancé pour A, et rien ne supplante le chargement vers B en vol.
  // Quand B finit par se résoudre, `apply` compare `d.insee` ('B') à `dataset?.insee`
  // ('A', inchangé) : ils diffèrent, donc `dataset` devient B — alors que la carte est
  // revenue en A. Silencieux jusqu'au prochain déplacement : survol et clic répondent
  // « aucun bâtiment » sur le point A parce qu'ils composent contre B.
  it('un panoramique de retour dans l’ancienne commune, pendant qu’un rechargement vers une autre est en vol, ne laisse pas ce rechargement dépassé s’appliquer', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      const datasetB = buildDataset('49008', '2026', [feature('01', carre(0.5, 0.5))]);
      const { promise: chargementB, resolve: resoudreChargementB } = deferred<Dataset>();

      let appels = 0;
      const loadDataset = vi.fn((): Promise<Dataset> => {
        appels++;
        if (appels === 1) return Promise.resolve(datasetA); // chargement initial
        if (appels === 2) return chargementB;                // vers B : reste en vol
        return Promise.resolve(datasetA);                    // retour vers A, une fois supplanté
      });

      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]]; // centre (0.005, 0.005) : commune A
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) => (pt[0] < 0.4 ? '49007' : '49008'),
        communeName: async () => 'X',
        notify: vi.fn(),
      });
      mode.enable();
      await mode.whenReady(); // charge A

      // Vers B : le rechargement démarre et reste EN VOL (chargementB non résolue).
      extent = [[0.495, 0.495], [0.505, 0.505]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);

      // Retour vers A, DANS la fenêtre où le rechargement vers B est encore en vol.
      extent = [[0, 0], [0.01, 0.01]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);

      // Le rechargement dépassé vers B se résout enfin.
      resoudreChargementB(datasetB);
      await mode.whenReady();

      // La carte est en A : le survol doit montrer le bâtiment de A, pas rien (ce que
      // donnerait un dataset devenu B par erreur).
      mode.hoverAt([0.0005, 0.0005]);
      expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

      // Et surtout pas celui de B, qui n'a jamais dû s'installer.
      mode.hoverAt([0.5, 0.5]);
      expect(container.querySelector('path')!.getAttribute('d')).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Revue finale (I3) : jamais de création à l'aveugle ---
  //
  // Contrat PRÉCÉDENT, remplacé ici : « clickAt attend un rechargement de commune en
  // cours plutôt que de composer contre l'ancien dataset ». Il réglait bien le défaut
  // visé (composer contre des données périmées), mais en laissait passer un plus grave :
  // pendant toute cette attente, hoverAt cache l'aperçu (`loading !== null`), donc le
  // bâtiment finalement créé n'avait JAMAIS été prévisualisé. Or l'aperçu au survol est
  // le seul garde-fou du projet contre une annexion erronée (spec §5) ; créer sans lui,
  // c'est créer sans garde-fou. On préfère désormais perdre un clic plutôt que créer à
  // l'aveugle : le clic ne crée rien, et le dit.
  it('un clic pendant un rechargement de commune ne crée rien et le dit', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      const datasetB = buildDataset('49008', '2026', [feature('01', carre(0.5, 0.5))]);
      const { promise: chargementB, resolve: resoudreChargementB } = deferred<Dataset>();

      let appels = 0;
      const loadDataset = vi.fn(async (): Promise<Dataset> => {
        appels++;
        return appels === 1 ? datasetA : chargementB; // 1er appel : A, immédiat ; 2e : B, différé
      });

      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;
      const notify = vi.fn();

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) => (pt[0] < 0.4 ? '49007' : '49008'),
        communeName: async () => 'X',
        notify,
      });
      mode.enable();
      await mode.whenReady(); // charge A

      // Franchissement de frontière : le rechargement démarre mais reste EN VOL.
      extent = [[0.495, 0.495], [0.505, 0.505]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600);

      await mode.clickAt([0.5, 0.5]);

      // Ni création contre l'ancien dataset (A, où ce point est « aucun bâtiment »,
      // silencieux), ni création contre B sans l'avoir montré au survol.
      expect(created).toHaveLength(0);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/chargement/i));

      // Et une fois B là, le même clic crée — la donnée est sûre, l'aperçu la montre.
      resoudreChargementB(datasetB);
      await mode.whenReady();
      await mode.clickAt([0.5, 0.5]);
      expect(created).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un clic avant le tout premier chargement ne crée rien et le dit', async () => {
    const attente = deferred<Dataset>();
    const notify = vi.fn();
    const mode = createMode(bridge, {
      loadDataset: () => attente.promise,
      communeName: async () => 'Angers',
      notify,
    });
    mode.enable();

    await mode.clickAt([0.0005, 0.0005]);

    expect(created).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/chargement/i));
    attente.resolve(buildDataset('49007', '2026', [feature('01', carre(0, 0))]));
  });

  it('un clic après un chargement raté relance un chargement au lieu de rester inerte', async () => {
    let appels = 0;
    const loadDataset = vi.fn(async (): Promise<Dataset> => {
      appels++;
      if (appels === 1) throw new Error('panne réseau');
      return buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
    });
    const notify = vi.fn();
    const mode = createMode(bridge, { loadDataset, communeName: async () => 'X', notify });
    mode.enable();
    await mode.whenReady();          // le premier chargement échoue : dataset reste null

    await mode.clickAt([0.0005, 0.0005]);
    expect(created).toHaveLength(0);
    await mode.whenReady();          // le clic a relancé un chargement : il réussit

    await mode.clickAt([0.0005, 0.0005]);
    expect(created).toHaveLength(1);
  });

  // La contrepartie du refus ci-dessus : passé les gardes d'entrée, PLUS AUCUNE attente
  // ne précède createBuilding. C'est ce qui rend inutile de revérifier `enabled` après
  // un await — il n'y a plus d'await où l'état puisse changer. Ici, le nom de commune
  // ne se résout jamais : la création doit avoir eu lieu quand même.
  it('ne fait attendre aucune requête avant de créer', async () => {
    const jamais = deferred<string>();
    const mode = createMode(bridge, {
      loadDataset: async () => buildDataset('49007', '2026', [feature('01', carre(0, 0))]),
      communeName: () => jamais.promise,
      notify: vi.fn(),
    });
    mode.enable();
    await mode.whenReady();

    void mode.clickAt([0.0005, 0.0005]);
    await Promise.resolve();

    expect(created).toHaveLength(1);
    jamais.resolve('Angers');
  });

  // --- Revue (deuxième passe) : un booléen ne peut pas savoir s'il est le plus récent ---
  //
  // L'ancien drapeau `reloading` était remis à faux par CELUI QUI SE TERMINE EN
  // PREMIER, sans se soucier de savoir s'il est encore le rechargement pertinent. Pour
  // que le bug se voie, il faut que le rechargement DÉPASSÉ (le plus ancien,
  // `loading` ne pointe plus vers lui) se résolve AVANT le rechargement COURANT
  // (`loading` pointe encore vers lui) — pas l'inverse : si le courant se résout en
  // premier, remettre `reloading` à faux à ce moment-là est déjà correct, et la
  // résolution tardive du dépassé, ensuite, ne fait plus de dégâts (rien à observer).
  // Ce test place donc volontairement le dépassé (vers B) en premier à se résoudre,
  // PENDANT que le courant (vers C) est encore authentiquement en vol.
  it('un rechargement dépassé qui se résout pendant qu’un plus récent est encore en vol ne rouvre pas l’aperçu par erreur', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      const datasetB = buildDataset('49008', '2026', [feature('01', carre(0.5, 0.5))]);
      const datasetC = buildDataset('49009', '2026', [feature('01', carre(0.9, 0.9))]);
      const perime = deferred<Dataset>(); // rechargement vers B : dépassé par C avant de se résoudre
      const enVol = deferred<Dataset>();  // rechargement vers C : le plus récent, reste en vol pendant la vérification

      let appels = 0;
      const loadDataset = vi.fn(async (): Promise<Dataset> => {
        appels++;
        if (appels === 1) return datasetA;
        if (appels === 2) return perime.promise;
        return enVol.promise;
      });

      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) =>
          (pt[0] < 0.4 ? '49007' : pt[0] < 0.7 ? '49008' : '49009'),
        communeName: async () => 'X',
        notify: vi.fn(),
      });
      mode.enable();
      await mode.whenReady(); // charge A (appel 1)

      extent = [[0.495, 0.495], [0.505, 0.505]]; // vers B
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600); // démarre le rechargement vers B (appel 2), en vol

      extent = [[0.895, 0.895], [0.905, 0.905]]; // vers C, AVANT que B ne se résolve — B devient dépassé
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600); // démarre le rechargement vers C (appel 3), en vol

      // Le DÉPASSÉ (B) se résout D'ABORD, alors que le COURANT (C) est toujours en vol.
      // Son application est déjà correctement ignorée (garde `loading === p` de
      // startLoad — la partie que la revue a jugée déjà correcte) : `dataset` reste A.
      perime.resolve(datasetB);
      await vi.advanceTimersByTimeAsync(0); // laisse la chaîne de B se dérouler entièrement

      // À CET INSTANT PRÉCIS, C (le seul rechargement qui compte) est TOUJOURS en vol.
      // Un survol maintenant ne doit RIEN montrer — ni A (périmé par le déplacement vers
      // C), ni B (jamais appliqué), et surtout pas à cause d'un drapeau qui se serait
      // remis à faux par erreur au passage de B.
      mode.hoverAt([0.0005, 0.0005]); // le bâtiment de A
      expect(container.querySelector('path')!.getAttribute('d')).toBe('');

      // Puis C se résout : l'état doit enfin refléter C.
      enVol.resolve(datasetC);
      await mode.whenReady(); // whenReady() lit `loading` ici : encore celui de C

      mode.hoverAt([0.9, 0.9]); // bâtiment de C
      expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');

      mode.hoverAt([0.5, 0.5]); // bâtiment de B : jamais installé
      expect(container.querySelector('path')!.getAttribute('d')).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Revue (deuxième passe) : ne pas transformer chaque échec en fenêtre modale ---
  //
  // Chaque rechargement raté appelait notify (window.alert en production). Près d'une
  // frontière de commune, ou pendant une panne réseau, le débounce se représente toutes
  // les 500 ms : sans déduplication, un survol prolongé produirait une rafale de
  // dialogues bloquants identiques, rendant le greffon inutilisable.
  it('plusieurs échecs de rechargement consécutifs et identiques ne notifient qu’une seule fois', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      let appels = 0;
      const loadDataset = vi.fn(async (): Promise<Dataset> => {
        appels++;
        if (appels === 1) return datasetA;
        throw new Error('cadastre.data.gouv.fr a répondu 500'); // panne réseau persistante
      });

      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;
      const notify = vi.fn();

      // Chaque déplacement franchit une frontière : sinon, depuis le correctif I2,
      // aucun rechargement ne serait tenté et il n'y aurait rien à notifier.
      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) => `49${Math.round(pt[0] * 100)}`,
        communeName: async () => 'X',
        notify,
      });
      mode.enable();
      await mode.whenReady(); // charge A avec succès

      // Trois déplacements consécutifs, chacun déclenchant une tentative de
      // rechargement qui échoue EXACTEMENT de la même façon.
      for (let i = 0; i < 3; i++) {
        extent = [[0.1 * (i + 1), 0.1 * (i + 1)], [0.1 * (i + 1) + 0.01, 0.1 * (i + 1) + 0.01]];
        declencherDeplacement();
        await vi.advanceTimersByTimeAsync(600);
      }

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/connexion/i));
    } finally {
      vi.useRealTimers();
    }
  });

  it('une notification identique revient après un chargement réussi entre-temps', async () => {
    vi.useFakeTimers();
    try {
      const datasetA = buildDataset('49007', '2026', [feature('01', carre(0, 0))]);
      const datasetB = buildDataset('49008', '2026', [feature('01', carre(0.5, 0.5))]);
      let appels = 0;
      const loadDataset = vi.fn(async (): Promise<Dataset> => {
        appels++;
        if (appels === 1) return datasetA; // chargement initial
        if (appels === 2) throw new Error('panne 1'); // premier échec réseau
        if (appels === 3) return datasetB; // succès entre les deux échecs
        throw new Error('panne 2'); // second échec réseau, identique en raison au premier
      });

      const { declencherDeplacement } = bridgeAvecDeplacements(bridge);
      let extent: [LonLat, LonLat] = [[0, 0], [0.01, 0.01]];
      bridge.mapExtent = () => extent;
      const notify = vi.fn();

      const mode = createMode(bridge, {
        loadDataset,
        communeCodeAt: async (pt: LonLat) => `49${Math.round(pt[0] * 100)}`,
        communeName: async () => 'X',
        notify,
      });
      mode.enable();
      await mode.whenReady();

      extent = [[0.1, 0.1], [0.11, 0.11]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600); // échec 1 : notifie

      extent = [[0.495, 0.495], [0.505, 0.505]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600); // succès (B) : réinitialise la déduplication

      extent = [[0.2, 0.2], [0.21, 0.21]];
      declencherDeplacement();
      await vi.advanceTimersByTimeAsync(600); // échec 2, même raison : notifie À NOUVEAU

      expect(notify).toHaveBeenCalledTimes(2);
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
      nodesIn: () => [],
      createBuilding: () => {},
      prefillChangeset: vi.fn(),
      containerNode: () => container,
      whenSurfaceReady: () => Promise.resolve(true),
      surfaceNode: () => container,
      cadastreVisible: () => true,
      selectedBuildings: () => [],
      selectedWays: () => [],
      mergeBuildings: () => {},
      onEditMenu: () => () => {},
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

// --- C1 : la réutilisation des nœuds ne se déclenchait pratiquement jamais ---
//
// `nodesNear(pt, radiusM)` filtrait les candidats dans une boîte centrée sur le POINT
// CLIQUÉ, et mode.ts l'appelait avec 2 m. À 47,5° N cette boîte vaut ±4,00 m en
// latitude mais ±2,70 m en longitude, alors que les coins d'une maison médiane
// d'Angers (83 m², ~9,1 m de côté) sont à 4,56 m du centre sur chaque axe. Cliquer le
// milieu d'une maison ordinaire ne ramenait donc AUCUN candidat, et
// snapToExistingNodes ne recousait rien — en silence, sur les 70 % de bâti mitoyen que
// la spec §2 donne comme motif de cette décision.
//
// Le double de bridge ci-dessous filtre réellement sur l'étendue demandée : c'est ce
// qui rend ce test capable d'échouer. Un double qui rendrait ses nœuds quoi qu'on lui
// demande (comme tous les autres de ce fichier) ne prouverait rien sur la requête.
describe('mode cadastre — réutilisation des nœuds sur un bâtiment de taille réelle', () => {
  const LAT = 47.5;                                  // Angers
  const COS = Math.cos((LAT * Math.PI) / 180);
  const COTE_M = 9.1;                                // ~83 m², la médiane mesurée d'Angers
  const D_LAT = COTE_M / 111320;
  const D_LON = COTE_M / (111320 * COS);

  const maisonMediane = () => feature('01', [
    [0, LAT], [D_LON, LAT], [D_LON, LAT + D_LAT], [0, LAT + D_LAT], [0, LAT],
  ]);

  it('réutilise un nœud posé sur un coin, alors que le clic vise le milieu', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const cree: { reused: (string | null)[] }[] = [];

    // Un nœud OSM existant exactement sur le coin sud-ouest : le cas du mur mitoyen
    // déjà importé, celui que la spec §5 étape 8 demande de recoudre.
    const noeuds: ExistingNode[] = [{ id: 'n1', loc: [0, LAT] }];

    const bridge: IdBridge = {
      mapExtent: () => [[-1, LAT - 1], [1, LAT + 1]],
      project: p => [p[0] * 1000, p[1] * 1000],
      invert: p => [p[0] / 1000, p[1] / 1000],
      onMapMove: () => () => {},
      buildingsNear: () => [],
      // Double fidèle : ne rend QUE les nœuds réellement dans l'étendue demandée.
      nodesIn: ([[minLon, minLat], [maxLon, maxLat]]) => noeuds.filter(n =>
        n.loc[0] >= minLon && n.loc[0] <= maxLon &&
        n.loc[1] >= minLat && n.loc[1] <= maxLat),
      createBuilding: (_ring, _tags, reused) => { cree.push({ reused }); },
      prefillChangeset: vi.fn(),
      containerNode: () => container,
      whenSurfaceReady: () => Promise.resolve(true),
      surfaceNode: () => container,
      cadastreVisible: () => true,
      selectedBuildings: () => [],
      selectedWays: () => [],
      mergeBuildings: () => {},
      onEditMenu: () => () => {},
    };

    const mode = createMode(bridge, {
      loadDataset: async () => buildDataset('49007', '2026', [maisonMediane()]),
      communeName: async () => 'Angers',
      notify: vi.fn(),
    });

    mode.enable();
    await mode.whenReady();
    await mode.clickAt([D_LON / 2, LAT + D_LAT / 2]);   // le milieu de la maison

    expect(cree).toHaveLength(1);
    expect(cree[0]!.reused).toContain('n1');
  });
});
