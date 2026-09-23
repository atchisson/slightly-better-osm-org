// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureContext, makeBridge } from '../../src/bridge/capture';

describe('captureContext', () => {
  beforeEach(() => {
    delete (globalThis as any).iD;
    vi.resetModules();
  });

  it('capture le contexte quand coreContext est appelé après l’installation du piège', async () => {
    const promise = captureContext();
    const faux = { marker: 'ctx' };
    (globalThis as any).iD = { coreContext: () => faux };
    const produit = (globalThis as any).iD.coreContext();
    expect(produit).toBe(faux);
    await expect(promise).resolves.toBe(faux);
  });

  it('laisse le namespace lisible et intact pour la page', async () => {
    captureContext();
    const ns = { coreContext: () => ({}), version: '2.30.0' };
    (globalThis as any).iD = ns;
    expect((globalThis as any).iD.version).toBe('2.30.0');
  });

  // Reproduit précisément la condition qui a cassé l'éditeur au premier passage du
  // spike : coreContext est un accesseur SANS setter (ce que produisent les bundlers).
  // La première sonde faisait `v.coreContext = wrapper`, ce qui lève une TypeError en
  // mode strict — et cette levée remontait depuis le setter de window.iD. Ce test
  // affecte ce namespace exact à window.iD et exige que l'affectation elle-même ne
  // lève jamais.
  it('n’écrit jamais sur coreContext, même quand il est un accesseur sans setter', () => {
    captureContext();
    const ns: any = {};
    Object.defineProperty(ns, 'coreContext', {
      configurable: true,
      enumerable: true,
      get: () => () => ({ ok: true }),
      // pas de `set` : toute écriture directe lève TypeError en mode strict (ESM).
    });
    expect(() => { (globalThis as any).iD = ns; }).not.toThrow();
  });

  // Le Proxy ne doit ni avaler ni amplifier une erreur préexistante ailleurs dans le
  // namespace : l'affectation à window.iD doit rester silencieuse, mais lire ensuite
  // la propriété fautive doit se comporter exactement comme sans piège.
  it('une propriété qui lève à la lecture ne lève jamais à l’affectation de window.iD', () => {
    captureContext();
    const ns = {
      coreContext: () => ({}),
      get piege(): unknown { throw new Error('propriété défaillante'); },
    };
    expect(() => { (globalThis as any).iD = ns; }).not.toThrow();
    expect(() => (globalThis as any).iD.piege).toThrow(/propriété défaillante/);
  });
});

describe('makeBridge', () => {
  const ctxComplet = () => {
    const projection: any = (p: unknown) => p;
    projection.invert = (p: [number, number]) => [p[0] / 100, p[1] / 100];
    return {
      map: () => ({ extent: () => ({ rectangle: () => [0, 0, 1, 1] }), on: () => {}, off: () => {} }),
      history: () => ({ intersects: () => [] }),
      graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
      projection,
      perform: () => {},
      enter: () => {},
      storage: () => {},
      container: () => ({ node: () => document.createElement('div') }),
    };
  };

  it('jette si une primitive attendue manque', () => {
    const incomplet: any = ctxComplet();
    delete incomplet.perform;
    expect(() => makeBridge(incomplet)).toThrow(/perform/);
  });

  it('jette si le graphe est absent', () => {
    const incomplet: any = ctxComplet();
    delete incomplet.graph;
    expect(() => makeBridge(incomplet)).toThrow(/graph/);
  });

  it('accepte un contexte complet', () => {
    expect(() => makeBridge(ctxComplet())).not.toThrow();
  });

  it('expose l’inversion écran vers coordonnées', () => {
    expect(makeBridge(ctxComplet()).invert([250, 400])).toEqual([2.5, 4]);
  });
});

describe('buildingsNear', () => {
  const nodes: Record<string, { loc: [number, number] }> = {
    a: { loc: [0, 0] }, b: { loc: [1, 0] }, c: { loc: [1, 1] }, d: { loc: [0, 1] },
    e: { loc: [10, 10] }, f: { loc: [11, 10] }, g: { loc: [11, 11] }, h: { loc: [10, 11] },
  };

  const ctxAvec = (entities: any[]) => ({
    // La vue courante est large ; c'est le paramètre extent de buildingsNear, pas la
    // vue, qui doit restreindre le résultat.
    map: () => ({ extent: () => ({ rectangle: () => [-90, -90, 90, 90] }), on: () => {}, off: () => {} }),
    history: () => ({ intersects: () => entities }),
    graph: () => ({ entity: (id: string) => nodes[id] }),
    projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
    perform: () => {},
    enter: () => {},
    container: () => ({}),
  });

  it('filtre au rectangle demandé plutôt que de rendre toute la vue', () => {
    const proche = { type: 'way', id: 'w1', tags: { building: 'yes' }, nodes: ['a', 'b', 'c', 'd', 'a'] };
    const loin = { type: 'way', id: 'w2', tags: { building: 'yes' }, nodes: ['e', 'f', 'g', 'h', 'e'] };
    const bridge = makeBridge(ctxAvec([proche, loin]));

    const result = bridge.buildingsNear([[-1, -1], [2, 2]]);

    expect(result.map(b => b.id)).toEqual(['w1']);
  });
});

describe('cache de buildingsNear', () => {
  // Mesuré sur un contexte synthétique dimensionné comme la vue réelle du spike
  // (24 611 entités, ~2 000 bâtiments) : buildingsNear() sans cache atteint
  // ponctuellement ~14 ms sur un budget de 16 ms par frame (rAF depuis hoverAt).
  // Ces tests verrouillent le mécanisme de cache qui évite de reconstruire la liste
  // des bâtiments à chaque appel.
  const nodes: Record<string, { loc: [number, number] }> = {
    a: { loc: [0, 0] }, b: { loc: [1, 0] }, c: { loc: [1, 1] }, d: { loc: [0, 1] },
  };

  // `avecHistoryOn` simule les deux formes de contexte réel possibles : celle où
  // history() est un émetteur d'événements (probable mais jamais vérifié par le spike)
  // et celle où il ne l'est pas (l'hypothèse la plus prudente, et celle que tous les
  // autres tests de ce describe utilisent par défaut).
  const ctxAvecCompteur = (entities: any[], avecHistoryOn = false) => {
    const ecouteursCarte: Record<string, () => void> = {};
    const ecouteursHistory: Record<string, () => void> = {};
    let appelsIntersects = 0;
    const history: any = { intersects: () => { appelsIntersects++; return entities; } };
    if (avecHistoryOn) {
      history.on = (type: string, cb: () => void) => { ecouteursHistory[type] = cb; };
      history.off = (type: string) => { delete ecouteursHistory[type]; };
    }
    const ctx = {
      map: () => ({
        extent: () => ({ rectangle: () => [-90, -90, 90, 90] }),
        on: (type: string, cb: () => void) => { ecouteursCarte[type] = cb; },
        off: (type: string) => { delete ecouteursCarte[type]; },
      }),
      history: () => history,
      graph: () => ({ entity: (id: string) => nodes[id] }),
      projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
      perform: () => {},
      enter: () => {},
      container: () => ({}),
    };
    return {
      ctx,
      appels: () => appelsIntersects,
      declencherDeplacement: () => { for (const k of Object.keys(ecouteursCarte)) if (k.startsWith('move')) ecouteursCarte[k]!(); },
      declencherChangementGraphe: () => { for (const k of Object.keys(ecouteursHistory)) if (k.startsWith('change')) ecouteursHistory[k]!(); },
    };
  };

  const batiment = { type: 'way', id: 'w1', tags: { building: 'yes' }, nodes: ['a', 'b', 'c', 'd', 'a'] };
  const vueEntiere: [[number, number], [number, number]] = [[-1, -1], [2, 2]];

  it('ne réinterroge pas history().intersects() à chaque appel tant que la vue ne bouge pas', () => {
    const { ctx, appels } = ctxAvecCompteur([batiment]);
    const bridge = makeBridge(ctx);

    bridge.buildingsNear(vueEntiere);
    bridge.buildingsNear(vueEntiere);
    bridge.buildingsNear(vueEntiere);

    expect(appels()).toBe(1);
  });

  it('reconstruit le cache quand la carte se déplace', () => {
    const { ctx, appels, declencherDeplacement } = ctxAvecCompteur([batiment]);
    const bridge = makeBridge(ctx);

    bridge.buildingsNear(vueEntiere);
    declencherDeplacement();
    bridge.buildingsNear(vueEntiere);

    expect(appels()).toBe(2);
  });

  it('reconstruit le cache après createBuilding, pour voir le bâtiment qu’il vient de créer', () => {
    const { ctx, appels } = ctxAvecCompteur([batiment]);
    const bridge = makeBridge(ctx);
    (globalThis as any).iD = {
      osmNode: (props: any) => ({ id: 'n_nouveau', ...props }),
      osmWay: (props: any) => ({ id: 'w_nouveau', ...props }),
      actionAddEntity: (e: any) => e,
      modeSelect: () => ({}),
    };

    try {
      bridge.buildingsNear(vueEntiere);
      bridge.createBuilding(
        [[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]],
        { building: 'yes' },
        [null, null, null, null],
      );
      bridge.buildingsNear(vueEntiere);

      expect(appels()).toBe(2);
    } finally {
      delete (globalThis as any).iD;
    }
  });

  // Le spike a vérifié que history() existe et que history().intersects() fonctionne,
  // jamais ce que l'objet renvoyé expose par ailleurs. Les deux tests suivants couvrent
  // les deux formes de contexte réel possibles.

  it('invalide aussi le cache quand history() expose on() et émet un changement', () => {
    const { ctx, appels, declencherChangementGraphe } = ctxAvecCompteur([batiment], true);
    const bridge = makeBridge(ctx);

    bridge.buildingsNear(vueEntiere);
    declencherChangementGraphe();
    bridge.buildingsNear(vueEntiere);

    expect(appels()).toBe(2);
  });

  it('se limite au déplacement de carte, sans jamais lever, quand history() n’expose pas on()', () => {
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { ctx, appels, declencherDeplacement } = ctxAvecCompteur([batiment], false);

      let bridge: ReturnType<typeof makeBridge> | undefined;
      expect(() => { bridge = makeBridge(ctx); }).not.toThrow();

      bridge!.buildingsNear(vueEntiere);
      declencherDeplacement();
      bridge!.buildingsNear(vueEntiere);
      expect(appels()).toBe(2);

      // La limitation est dite une fois en console, pas seulement dans un commentaire.
      expect(espion).toHaveBeenCalledWith(expect.stringContaining('history'));
    } finally {
      espion.mockRestore();
    }
  });

  // Preuve plus dure que la précédente : ici .on() EXISTE (ce n'est pas juste une
  // méthode absente) mais lève à l'appel — la même famille de risque que celle qui a
  // cassé l'éditeur au premier passage du spike (une exception non prévue au démarrage
  // du greffon), mais par une autre porte. La construction du bridge ne doit toujours
  // jamais lever.
  it('ne lève jamais même si history().on() existe mais échoue à l’appel', () => {
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ctx = {
        map: () => ({ extent: () => ({ rectangle: () => [-90, -90, 90, 90] }), on: () => {}, off: () => {} }),
        history: () => ({ intersects: () => [], on: () => { throw new Error('history().on indisponible'); } }),
        graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
        projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
        perform: () => {},
        enter: () => {},
        container: () => ({}),
      };

      expect(() => makeBridge(ctx)).not.toThrow();
      expect(espion).toHaveBeenCalledWith(expect.stringContaining('history'));
    } finally {
      espion.mockRestore();
    }
  });
});
