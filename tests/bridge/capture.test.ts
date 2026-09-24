// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  captureContext, makeBridge, raceCaptureAgainstTimeout, waitForSurface, looksLikeIdDocument,
} from '../../src/bridge/capture';

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

  // Cas relevé en revue : le Proxy est légal aujourd'hui uniquement parce que
  // coreContext est un ACCESSEUR (get présent). Si un futur build d'iD exposait
  // coreContext comme une propriété de DONNEES non configurable et non inscriptible,
  // renvoyer autre chose que sa valeur exacte violerait l'invariant [[Get]] du spec
  // Proxy (§9.5.8) — le moteur lève lui-même une TypeError, APRES le retour du piège
  // get, donc hors de portée de tout try/catch écrit dans ce fichier. Vérifié en
  // pratique avant d'écrire ce test (pas seulement en théorie) : sans la fonction
  // hasFrozenCoreContext(), ce même scénario lève bel et bien sur V8 :
  // "TypeError: 'get' on proxy: property 'coreContext' is a read-only and
  // non-configurable data property on the proxy target but the proxy did not return
  // its actual value...". La défense ne peut donc pas être un garde ; il faut éviter
  // la situation en amont : ne pas envelopper du tout.
  it('n’installe pas de Proxy si coreContext est une propriété de données figée (non configurable, non inscriptible)', () => {
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      captureContext();
      const original = () => ({ ok: true });
      const ns: any = {};
      Object.defineProperty(ns, 'coreContext', { value: original, writable: false, configurable: false, enumerable: true });

      expect(() => { (globalThis as any).iD = ns; }).not.toThrow();

      let lu: unknown;
      expect(() => { lu = (globalThis as any).iD.coreContext; }).not.toThrow();
      // Identité exacte (pas seulement même comportement) : preuve qu'aucun wrapper
      // n'a été installé, pas juste qu'un wrapper équivalent ne lève pas.
      expect(lu).toBe(original);

      expect(espion).toHaveBeenCalledWith(expect.stringContaining('coreContext'));
    } finally {
      espion.mockRestore();
    }
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

  it('ignore une way taguée building=no : ce n’est pas un bâtiment existant', () => {
    const vrai = { type: 'way', id: 'w1', tags: { building: 'yes' }, nodes: ['a', 'b', 'c', 'd', 'a'] };
    const demoli = { type: 'way', id: 'w2', tags: { building: 'no' }, nodes: ['a', 'b', 'c', 'd', 'a'] };
    const bridge = makeBridge(ctxAvec([vrai, demoli]));

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

  // Les espaces de nom des écouteurs internes (move.*, change.*) sont des littéraux
  // fixes : sous la convention "un seul emplacement par espace de nom" de d3/iD,
  // construire un second bridge sur le MÊME contexte remplacerait silencieusement
  // l'écouteur du premier — un cache qui survit à sa propre garantie de fraîcheur,
  // sans qu'on le voie. Chaque bridge doit donc avoir un suffixe d'espace de nom qui
  // lui est propre.
  it('deux bridges construits sur le même contexte invalident chacun leur propre cache', () => {
    const { ctx, appels, declencherDeplacement } = ctxAvecCompteur([batiment]);
    const bridge1 = makeBridge(ctx);
    const bridge2 = makeBridge(ctx);

    bridge1.buildingsNear(vueEntiere); // peuple le cache du bridge 1
    bridge2.buildingsNear(vueEntiere); // peuple le cache du bridge 2
    expect(appels()).toBe(2);

    declencherDeplacement(); // doit invalider les DEUX caches, pas un seul

    bridge1.buildingsNear(vueEntiere);
    bridge2.buildingsNear(vueEntiere);
    expect(appels()).toBe(4);
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

  // Le spike a vérifié map().extent().rectangle(), jamais map().on/off — la même
  // incertitude que pour history().on(), et le même risque : c'est cet appel précis,
  // non gardé, qui a cassé l'éditeur au premier passage (une exception remontée
  // pendant l'installation du greffon). Couvre à la fois le cache interne et la
  // méthode publique onMapMove.
  it('ne lève jamais même si map().on() échoue (déplacement de carte)', () => {
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ctx = {
        map: () => ({
          extent: () => ({ rectangle: () => [-90, -90, 90, 90] }),
          on: () => { throw new Error('map().on indisponible'); },
          off: () => { throw new Error('map().off indisponible'); },
        }),
        history: () => ({ intersects: () => [] }),
        graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
        projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
        perform: () => {},
        enter: () => {},
        container: () => ({}),
      };

      let bridge: ReturnType<typeof makeBridge> | undefined;
      expect(() => { bridge = makeBridge(ctx); }).not.toThrow();
      expect(() => bridge!.buildingsNear([[0, 0], [1, 1]])).not.toThrow();

      let desabonner: (() => void) | undefined;
      expect(() => { desabonner = bridge!.onMapMove(() => {}); }).not.toThrow();
      expect(() => desabonner!()).not.toThrow();

      expect(espion).toHaveBeenCalledWith(expect.stringContaining('map()'));
    } finally {
      espion.mockRestore();
    }
  });
});

describe('prefillChangeset', () => {
  // La valeur exacte que la Licence Ouverte exige de porter : origine + millésime.
  const SOURCE =
    'cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : 2026';

  // Contexte minimal : seules les primitives exigées par PRIMITIVES comptent ici, le
  // reste du bridge n'est pas exercé par ces tests.
  const ctxMinimal = () => ({
    map: () => ({ extent: () => ({ rectangle: () => [0, 0, 1, 1] }), on: () => {}, off: () => {} }),
    history: () => ({ intersects: () => [] }),
    graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
    projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
    perform: () => {},
    enter: () => {},
    container: () => ({}),
  });

  beforeEach(() => {
    localStorage.clear();
    delete (globalThis as any).iD;
  });

  it('écrit comment et commentDate via iD.prefs quand il existe', () => {
    const ecrits: Record<string, string> = {};
    (globalThis as any).iD = { prefs: (k: string, v: string) => { ecrits[k] = v; } };
    const bridge = makeBridge(ctxMinimal());

    bridge.prefillChangeset('Bâtiment ajouté depuis le cadastre', SOURCE);

    expect(ecrits['comment']).toBe('Bâtiment ajouté depuis le cadastre');
    // Le README annonce le préremplissage de la source sous « Règles de contribution
    // françaises », comme preuve de conformité au code de conduite des éditions
    // automatisées. La spec §4 déclarait bien prefillChangeset(comment, source) ; le
    // paramètre avait disparu à l'implémentation, sans arbitrage.
    expect(ecrits['source']).toBe(SOURCE);
    // iD périme un commentaire trop ancien : oublier commentDate le ferait ignorer en
    // silence (spike du 2026-09-23).
    expect(ecrits['commentDate']).toBeDefined();
    expect(Number(ecrits['commentDate'])).not.toBeNaN();
  });

  it('se rabat sur localStorage, sous la clé non préfixée "comment", quand iD.prefs est absent', () => {
    const bridge = makeBridge(ctxMinimal());

    bridge.prefillChangeset('Bâtiment ajouté depuis le cadastre', SOURCE);

    expect(localStorage.getItem('comment')).toBe('Bâtiment ajouté depuis le cadastre');
    expect(localStorage.getItem('source')).toBe(SOURCE);
    expect(localStorage.getItem('commentDate')).not.toBeNull();
    expect(Number(localStorage.getItem('commentDate'))).not.toBeNaN();
  });
});

describe('onMapMove — plusieurs abonnements sur le même bridge', () => {
  // Revue (tâche 16) : l'overlay (task 15) et le rechargement de commune de mode.ts
  // (task 16) s'abonnent tous deux à onMapMove SUR LE MÊME BRIDGE. Avant ce correctif,
  // les deux partageaient le même espace de nom d3 `move.${ns}` (un par bridge, pas un
  // par abonnement) : le second `.on()` remplaçait silencieusement le premier. Ces
  // tests exercent directement le contrat public d'onMapMove — deux abonnements
  // doivent coexister, et se désabonner de l'un ne doit jamais retirer l'autre.
  const ctxAvecEvenements = () => {
    // Un vrai registre keyed par type.namespace complet, comme d3 : deux clés
    // DIFFÉRENTES coexistent et sont TOUTES DEUX appelées quand on simule 'move'.
    const listeners: Record<string, () => void> = {};
    return {
      map: () => ({
        extent: () => ({ rectangle: () => [-90, -90, 90, 90] }),
        on: (typename: string, cb: () => void) => { listeners[typename] = cb; },
        off: (typename: string) => { delete listeners[typename]; },
      }),
      history: () => ({ intersects: () => [] }),
      graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
      projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
      perform: () => {},
      enter: () => {},
      container: () => ({}),
      __declencherDeplacement: () => {
        for (const k of Object.keys(listeners)) if (k.startsWith('move.')) listeners[k]!();
      },
    };
  };

  it('deux abonnements distincts reçoivent tous les deux un déplacement de carte', () => {
    const ctx = ctxAvecEvenements();
    const bridge = makeBridge(ctx);

    let appelsA = 0, appelsB = 0;
    bridge.onMapMove(() => { appelsA++; });
    bridge.onMapMove(() => { appelsB++; });

    ctx.__declencherDeplacement();

    expect(appelsA).toBe(1);
    expect(appelsB).toBe(1);
  });

  it('désabonner l’un laisse l’autre fonctionner', () => {
    const ctx = ctxAvecEvenements();
    const bridge = makeBridge(ctx);

    let appelsA = 0, appelsB = 0;
    const desabonnerA = bridge.onMapMove(() => { appelsA++; });
    bridge.onMapMove(() => { appelsB++; });

    desabonnerA();
    ctx.__declencherDeplacement();

    expect(appelsA).toBe(0);
    expect(appelsB).toBe(1);
  });
});

describe('nodesIn — éligibilité des nœuds au recalage', () => {
  // Spec §5 étape 8 : « recaler chaque sommet sur un nœud OSM existant ». L'intention
  // est de recoudre un coin de BÂTIMENT voisin. `nodesNear` ne filtrait rien : un nœud
  // taggué (une adresse, un arbre, du mobilier urbain) ou un sommet de voirie pouvait
  // devenir un sommet du bâtiment créé — ce qui change de fait un objet existant, la
  // seule chose que la v1 promet de ne jamais faire.
  const ctx = (entities: any[]) => ({
    map: () => ({ extent: () => ({ rectangle: () => [-90, -90, 90, 90] }), on: () => {}, off: () => {} }),
    history: () => ({ intersects: () => entities }),
    graph: () => ({ entity: (id: string) => entities.find(e => e.id === id) }),
    projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
    perform: () => {},
    enter: () => {},
    container: () => ({ node: () => document.createElement('div') }),
  });
  const partout: [[number, number], [number, number]] = [[-1, -1], [1, 1]];

  it('écarte un nœud taggué qui n’appartient à aucun bâtiment', () => {
    const banc = { type: 'node', id: 'n_banc', loc: [0, 0], tags: { amenity: 'bench' } };
    const nu = { type: 'node', id: 'n_nu', loc: [0, 0] };
    const bridge = makeBridge(ctx([banc, nu]));

    expect(bridge.nodesIn(partout).map(n => n.id)).toEqual(['n_nu']);
  });

  it('accepte un nœud taggué s’il est sommet d’une way bâtiment', () => {
    const coin = { type: 'node', id: 'n_coin', loc: [0, 0], tags: { 'addr:housenumber': '12' } };
    const way = { type: 'way', id: 'w1', tags: { building: 'yes' }, nodes: ['n_coin'] };
    const bridge = makeBridge(ctx([coin, way]));

    expect(bridge.nodesIn(partout).map(n => n.id)).toEqual(['n_coin']);
  });

  it('accepte un nœud sommet d’une way membre d’une relation bâtiment', () => {
    const coin = { type: 'node', id: 'n_coin', loc: [0, 0], tags: { 'addr:housenumber': '12' } };
    const way = { type: 'way', id: 'w1', nodes: ['n_coin'] };
    const rel = {
      type: 'relation', id: 'r1', tags: { type: 'multipolygon', building: 'yes' },
      members: [{ type: 'way', id: 'w1', role: 'outer' }],
    };
    const bridge = makeBridge(ctx([coin, way, rel]));

    expect(bridge.nodesIn(partout).map(n => n.id)).toEqual(['n_coin']);
  });

  it('écarte un sommet de voirie, même nu : un bâtiment ne se raccroche pas à une route', () => {
    const sommetRoute = { type: 'node', id: 'n_route', loc: [0, 0] };
    const route = { type: 'way', id: 'w_route', tags: { highway: 'residential' }, nodes: ['n_route'] };
    const bridge = makeBridge(ctx([sommetRoute, route]));

    expect(bridge.nodesIn(partout)).toEqual([]);
  });

  it('filtre sur l’étendue demandée', () => {
    const dedans = { type: 'node', id: 'n_dedans', loc: [0, 0] };
    const dehors = { type: 'node', id: 'n_dehors', loc: [10, 10] };
    const bridge = makeBridge(ctx([dedans, dehors]));

    expect(bridge.nodesIn(partout).map(n => n.id)).toEqual(['n_dedans']);
  });
});

// Contexte iD minimal dont seul le nœud conteneur compte : il sert aux deux lectures
// de DOM du bridge, `surfaceNode()` et `toolbarSlot()`.
const ctxAvecConteneur = (node: unknown) => ({
  map: () => ({ extent: () => ({ rectangle: () => [0, 0, 1, 1] }), on: () => {}, off: () => {} }),
  history: () => ({ intersects: () => [] }),
  graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
  projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
  perform: () => {},
  enter: () => {},
  container: () => ({ node: () => node }),
});

describe('surfaceNode — une seule origine de projection', () => {
  // I1 : `src/main.ts` faisait `container.querySelector('svg.surface') ?? container` —
  // un sélecteur interne d'iD HORS de src/bridge/ (contre le §4 de la spec), avec un
  // repli MUET qui changeait l'origine des coordonnées sans le dire. La connaissance
  // vit maintenant ici, et le repli se dit en console.
  it('rend la surface de carte quand elle existe, pas la racine de l’éditeur', () => {
    const conteneur = document.createElement('div');
    const surface = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    surface.setAttribute('class', 'surface');
    conteneur.appendChild(surface);

    expect(makeBridge(ctxAvecConteneur(conteneur)).surfaceNode()).toBe(surface);
  });

  it('se rabat sur le conteneur EN LE DISANT quand aucune surface n’est trouvée', () => {
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const conteneur = document.createElement('div');
      const bridge = makeBridge(ctxAvecConteneur(conteneur));

      expect(bridge.surfaceNode()).toBe(conteneur);
      // Le repli change l'origine des coordonnées : il doit être lisible en console,
      // pas deviné à l'écran.
      expect(espion).toHaveBeenCalledWith(expect.stringContaining('surface'));
    } finally {
      espion.mockRestore();
    }
  });
});

describe('buildingsNear — bâtiments en multipolygone (I5)', () => {
  // Un bâtiment à cour intérieure est cartographié en relation `multipolygon` : ses
  // tags sont sur la RELATION, jamais sur ses ways. Le filtre `e.tags?.building` les
  // manquait donc tous — et ce sont exactement les bâtiments que le greffon refuse côté
  // cadastre (géométrie à trou), donc ceux que quelqu'un a tracés à la main. Créer un
  // doublon par-dessus est la seule chose que la v1 promet de ne jamais faire.
  const sommets: Record<string, { loc: [number, number] }> = {
    a: { loc: [0, 0] }, b: { loc: [1, 0] }, c: { loc: [1, 1] }, d: { loc: [0, 1] },
    e: { loc: [0.2, 0.2] }, f: { loc: [0.8, 0.2] }, g: { loc: [0.8, 0.8] }, h: { loc: [0.2, 0.8] },
  };
  const ctx = (entities: any[]) => ({
    map: () => ({ extent: () => ({ rectangle: () => [-90, -90, 90, 90] }), on: () => {}, off: () => {} }),
    history: () => ({ intersects: () => entities }),
    graph: () => ({ entity: (id: string) => sommets[id] }),
    projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
    perform: () => {},
    enter: () => {},
    container: () => ({ node: () => document.createElement('div') }),
  });
  const partout: [[number, number], [number, number]] = [[-1, -1], [2, 2]];

  const contour = { type: 'way', id: 'w_outer', nodes: ['a', 'b', 'c', 'd', 'a'] };
  const cour = { type: 'way', id: 'w_inner', nodes: ['e', 'f', 'g', 'h', 'e'] };
  const relation = {
    type: 'relation', id: 'r1', tags: { type: 'multipolygon', building: 'yes' },
    members: [
      { type: 'way', id: 'w_outer', role: 'outer' },
      { type: 'way', id: 'w_inner', role: 'inner' },
    ],
  };

  it('voit le contour extérieur d’un bâtiment dont les tags sont sur la relation', () => {
    const bridge = makeBridge(ctx([contour, cour, relation]));
    expect(bridge.buildingsNear(partout).map(b => b.id)).toContain('w_outer');
  });

  it('ignore les ways de rôle `inner` : une cour n’est pas du bâti', () => {
    // Les inclure ferait refuser un bâtiment légitime construit DANS la cour.
    const bridge = makeBridge(ctx([contour, cour, relation]));
    expect(bridge.buildingsNear(partout).map(b => b.id)).not.toContain('w_inner');
  });

  it('ignore une relation qui n’est pas un bâtiment', () => {
    const site = {
      type: 'relation', id: 'r2', tags: { type: 'multipolygon', landuse: 'meadow' },
      members: [{ type: 'way', id: 'w_outer', role: 'outer' }],
    };
    const bridge = makeBridge(ctx([contour, site]));
    expect(bridge.buildingsNear(partout)).toEqual([]);
  });
});

// Le chien de garde de src/main.ts : si captureContext() ne se résout jamais (iD a
// changé la forme de son namespace, coreContext() n'est plus jamais appelé), le
// premier `await` du script restait bloqué pour toujours, en silence — le mode de
// rupture le plus probable, et jusqu'ici le seul à ne rien dire du tout en console.
// src/main.ts n'est pas restructuré pour être testable (IIFE de haut niveau sur les
// globales du navigateur) ; cette logique de course l'a été, en l'extrayant ici.
describe('raceCaptureAgainstTimeout', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }

  it('se résout avec le contexte capturé quand la capture aboutit avant le délai', async () => {
    vi.useFakeTimers();
    try {
      const { promise, resolve } = deferred<unknown>();
      const outcome = raceCaptureAgainstTimeout(promise, 8000);
      resolve({ marker: 'ctx' });
      await expect(outcome).resolves.toEqual({ status: 'captured', context: { marker: 'ctx' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('n’attend pas tout le délai quand la capture aboutit tout de suite', async () => {
    vi.useFakeTimers();
    try {
      const { promise, resolve } = deferred<unknown>();
      resolve({ marker: 'immediat' });
      // Aucun vi.advanceTimersByTimeAsync ici : si la résolution obtenue dépendait du
      // minuteur plutôt que de la capture elle-même, cet await resterait bloqué et le
      // test échouerait par timeout — la preuve recherchée, pas une reformulation de
      // l'implémentation.
      const outcome = await raceCaptureAgainstTimeout(promise, 8000);
      expect(outcome).toEqual({ status: 'captured', context: { marker: 'immediat' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('se résout en « timed-out » si le délai s’écoule avant que la capture aboutisse', async () => {
    vi.useFakeTimers();
    try {
      const { promise } = deferred<unknown>(); // ne se résout jamais
      const outcomePromise = raceCaptureAgainstTimeout(promise, 8000);
      await vi.advanceTimersByTimeAsync(8000);
      await expect(outcomePromise).resolves.toEqual({ status: 'timed-out' });
    } finally {
      vi.useRealTimers();
    }
  });

  // Garde contre une fausse alerte : une capture qui finit par aboutir APRÈS que le
  // délai a déjà tranché ne doit ni changer le verdict déjà rendu, ni lever quoi que
  // ce soit. C'est exactement la garantie dont src/main.ts a besoin pour ne jamais
  // journaliser « désactivé » puis, juste après, agir comme si la capture avait
  // réussi.
  it('une capture qui aboutit après le délai n’altère plus le verdict déjà rendu', async () => {
    vi.useFakeTimers();
    try {
      const { promise, resolve } = deferred<unknown>();
      const outcomePromise = raceCaptureAgainstTimeout(promise, 8000);
      await vi.advanceTimersByTimeAsync(8000);
      await expect(outcomePromise).resolves.toEqual({ status: 'timed-out' });

      resolve({ marker: 'trop-tard' });
      await vi.advanceTimersByTimeAsync(0);

      await expect(outcomePromise).resolves.toEqual({ status: 'timed-out' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Troisième lancement réel : le chien de garde de capture s'arme dans TOUT document qui
// matche `@match`, y compris `/edit` — le document parent qui ne fait qu'héberger
// l'iframe `/id` où vit réellement iD (spike du 2026-09-23). Sans distinction, `/edit`
// atteignait l'échéance à CHAQUE chargement de l'éditeur et affichait le message de
// rupture structurelle destiné à un VRAI échec de capture. `looksLikeIdDocument`
// distingue les deux documents par une marque HTML, pas par l'URL (voir le
// raisonnement complet dans src/bridge/capture.ts).
describe('looksLikeIdDocument — distinguer le document qui héberge réellement iD', () => {
  // Construit un document jsdom isolé (pas le `document` global partagé entre tests) à
  // partir d'un corps HTML complet, pour éviter qu'un test qui « ressemble » à
  // l'éditeur ne soit en fait qu'un div isolé sans rien autour — le genre de fixture
  // qui passerait même si l'implémentation cherchait le mauvais élément.
  const documentAvec = (bodyHtml: string): Document => {
    const doc = document.implementation.createHTMLDocument('osm.org');
    doc.body.innerHTML = bodyHtml;
    return doc;
  };

  it('reconnaît le document qui porte la marque de l’éditeur iD, même noyée dans une page complète', () => {
    // Reproduit la forme rapportée par le spike pour `id.html.erb` (barre d'outils,
    // panneau latéral, script du bundle) — pas juste le div isolé dont
    // getElementById aurait trivialement besoin.
    const doc = documentAvec(`
      <header class="site-header"><nav>OpenStreetMap</nav></header>
      <div id="id-container">
        <div class="main-content active">
          <div id="content" class="content">
            <div class="main-map"></div>
          </div>
        </div>
      </div>
      <script src="/assets/id-71d5cb28.js"></script>
    `);

    expect(looksLikeIdDocument(doc)).toBe(true);
  });

  it('ne reconnaît pas une page osm.org ordinaire (changeset, profil...) sans cette marque', () => {
    // Forme plausible d'une page de changeset : du contenu, une barre de navigation,
    // mais jamais le conteneur d'iD — c'est le document `/edit` (et toute autre page
    // du site) de la vraie régression rapportée.
    const doc = documentAvec(`
      <header class="site-header"><nav>OpenStreetMap</nav></header>
      <div id="content">
        <div class="changeset">
          <h2>Changeset nº 123456</h2>
          <div class="changeset-details"></div>
        </div>
      </div>
    `);

    expect(looksLikeIdDocument(doc)).toBe(false);
  });

  it('ne se laisse pas abuser par un identifiant qui ressemble sans être exact', () => {
    // Une classe (pas un id) du même nom, et un id voisin mais distinct : si
    // l'implémentation faisait une recherche de sous-chaîne sur le HTML plutôt qu'un
    // vrai getElementById('id-container'), ces deux décoys la feraient mordre.
    const doc = documentAvec(`
      <div class="id-container">pas le bon attribut</div>
      <div id="id-container-preview">id voisin, pas exact</div>
    `);

    expect(looksLikeIdDocument(doc)).toBe(false);
  });

  it('ne lève jamais, même sur un objet qui n’expose pas getElementById', () => {
    const pasUnDocument = {} as unknown as Document;
    expect(() => looksLikeIdDocument(pasUnDocument)).not.toThrow();
    expect(looksLikeIdDocument(pasUnDocument)).toBe(false);
  });
});

// I1 (le retour) : le premier correctif avait fait dire à surfaceNode() son repli en
// console, mais rien n'empêchait encore d'appeler surfaceNode() avant que
// `iD.coreContext().containerNode(container).init()` (l'amorçage réel d'osm.org) n'ait
// fini de construire la carte — captureContext() résout dès l'appel de coreContext(),
// PAS après .init(). waitForSurface() est l'attente bornée qui ferme cette porte-là.
describe('waitForSurface — attendre que la carte d’iD ait fini de s’initialiser', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const uneSurface = (): SVGElement => {
    const el = document.createElementNS(SVG_NS, 'svg');
    el.setAttribute('class', 'surface');
    return el as unknown as SVGElement;
  };

  it('résout tout de suite (true) quand la surface est déjà là', async () => {
    const conteneur = document.createElement('div');
    conteneur.appendChild(uneSurface());

    // Délai volontairement long : si l'implémentation attendait quand même le
    // minuteur au lieu de constater tout de suite que la surface existe déjà, ce
    // test resterait bloqué et échouerait par timeout — la preuve recherchée.
    await expect(waitForSurface(conteneur, 30000)).resolves.toBe(true);
  });

  it('résout (true) quand la surface apparaît après un court délai, sans attendre l’échéance', async () => {
    const conteneur = document.createElement('div');
    const debut = Date.now();

    setTimeout(() => conteneur.appendChild(uneSurface()), 20);

    // Échéance large (2000 ms) par rapport au délai réel d'apparition (20 ms) : si la
    // résolution ne venait que du minuteur plutôt que du MutationObserver, ce test
    // mesurerait une latence proche de 2000 ms plutôt que de quelques dizaines de ms.
    await expect(waitForSurface(conteneur, 2000)).resolves.toBe(true);
    expect(Date.now() - debut).toBeLessThan(1000);
  });

  it('résout (false) une fois l’échéance passée, si la surface n’apparaît jamais', async () => {
    vi.useFakeTimers();
    try {
      const conteneur = document.createElement('div'); // ne recevra jamais de surface
      const outcome = waitForSurface(conteneur, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(outcome).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Garantie « jamais lever » : un conteneur qui n'est pas un Element interrogeable
  // (capture avortée, forme inattendue) ne doit ni lever de façon synchrone au moment
  // de l'appel, ni faire rejeter la promesse — seulement se rabattre sur le délai.
  it('ne lève jamais et finit par résoudre (false) si le conteneur n’est pas interrogeable', async () => {
    vi.useFakeTimers();
    try {
      let outcome!: Promise<boolean>;
      expect(() => { outcome = waitForSurface(undefined, 5000); }).not.toThrow();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(outcome).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Ni fuite : l'observateur DOM posé sur le conteneur d'iD (qui, lui, survit toute la
  // session d'édition) doit être démonté dès que waitForSurface a tranché — succès ou
  // échéance — jamais laissé actif derrière une réponse déjà rendue.
  it('déconnecte son MutationObserver dès qu’il a tranché, succès ou échéance', async () => {
    const disconnectEspion = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      const conteneurSucces = document.createElement('div');
      const succes = waitForSurface(conteneurSucces, 2000);
      setTimeout(() => conteneurSucces.appendChild(uneSurface()), 10);
      await expect(succes).resolves.toBe(true);
      expect(disconnectEspion).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      const conteneurEchec = document.createElement('div');
      const echec = waitForSurface(conteneurEchec, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(echec).resolves.toBe(false);
      expect(disconnectEspion).toHaveBeenCalledTimes(2);
    } finally {
      disconnectEspion.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('toolbarSlot — greffer dans la barre plutôt que se battre contre elle', () => {
  // La barre d'outils d'iD est posée PAR-DESSUS la carte (relevé en navigateur :
  // svg.surface commence à top=0, le bandeau descend jusqu'à 71 px). Un bouton posé
  // sur la carte s'y retrouve donc enterré, présent et invisible — c'est arrivé deux
  // fois. Ce que le bridge rend ici, ce ne sont pas des noms de classes mais des
  // ÉLÉMENTS À IMITER : aucun sélecteur interne d'iD ne sort de src/bridge/ (§4).
  const barre = (contenu: string): HTMLElement => {
    const conteneur = document.createElement('div');
    conteneur.innerHTML = `<div class="top-toolbar">${contenu}</div>`;
    return conteneur;
  };

  it("rend l'enfant direct de la barre qui porte le bouton, pas le bouton lui-même", () => {
    const conteneur = barre('<div class="toolbar-item"><button class="bar-button"></button></div>');
    const slot = makeBridge(ctxAvecConteneur(conteneur)).toolbarSlot();

    // L'enfant direct porte la mise en page (flex, groupes) : c'est lui qu'il faut
    // cloner. Rendre le bouton seul produirait un contrôle mal placé dans la barre.
    expect(slot?.item).toBe(conteneur.querySelector('.toolbar-item'));
    expect(slot?.bouton).toBe(conteneur.querySelector('.bar-button'));
  });

  it('remonte jusqu’à l’enfant direct même si le bouton est profondément imbriqué', () => {
    const conteneur = barre(
      '<div class="toolbar-item"><div class="wrap"><span><button class="bar-button"></button></span></div></div>',
    );
    const slot = makeBridge(ctxAvecConteneur(conteneur)).toolbarSlot();

    expect(slot?.item).toBe(conteneur.querySelector('.toolbar-item'));
  });

  it('rend le bouton comme son propre item quand il est enfant direct', () => {
    const conteneur = barre('<button class="bar-button"></button>');
    const slot = makeBridge(ctxAvecConteneur(conteneur)).toolbarSlot();

    // Pas de coquille à cloner dans ce cas : l'appelant se pose à côté du bouton.
    expect(slot?.item).toBe(slot?.bouton);
  });

  it('rend null EN LE DISANT quand la barre n’a pas la forme attendue', () => {
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const conteneur = document.createElement('div');
      const bridge = makeBridge(ctxAvecConteneur(conteneur));

      expect(bridge.toolbarSlot()).toBeNull();
      // Le repli est un changement d'apparence visible : il doit se lire en console
      // plutôt que se deviner à l'écran, comme celui de surfaceNode().
      expect(espion).toHaveBeenCalledWith(expect.stringContaining("barre d'outils"));
    } finally {
      espion.mockRestore();
    }
  });
});

describe('cadastreVisible — trois réponses, pas deux', () => {
  // `context.background()` est la seule primitive lue par le projet que le spike n'a
  // PAS vérifiée en navigateur. D'où le troisième état, `null` : « je ne sais pas ».
  // Il conditionne le raccourci Ctrl, qui n'a aucune affordance visible — le traiter
  // comme « oui » armerait un déclencheur invisible n'importe où.
  const source = (id: string, nom?: string) => ({ id, name: () => nom ?? id });
  const ctxAvecFond = (bg: unknown) => ({
    ...ctxAvecConteneur(document.createElement('div')),
    background: () => bg,
  });

  it('reconnaît le cadastre en fond de carte', () => {
    const bridge = makeBridge(ctxAvecFond({
      baseLayerSource: () => source('fr.cadastre', 'Cadastre (France)'),
      overlayLayerSources: () => [],
    }));

    expect(bridge.cadastreVisible()).toBe(true);
  });

  it('reconnaît le cadastre en calque superposé', () => {
    // Le cadastre est proposé des deux façons dans l'index d'imagerie d'iD : ne
    // regarder que le fond de carte raterait l'usage le plus courant, le calque
    // par-dessus une ortho.
    const bridge = makeBridge(ctxAvecFond({
      baseLayerSource: () => source('Bing', 'Bing aerial imagery'),
      overlayLayerSources: () => [source('fr.cadastre.2024', 'Cadastre 2024')],
    }));

    expect(bridge.cadastreVisible()).toBe(true);
  });

  it('reconnaît sur le nom seul, id illisible', () => {
    // Correspondance sur le nom ET l'identifiant : l'index d'imagerie est un dépôt
    // tiers qui renomme ses entrées, un identifiant figé ici se périmerait en silence.
    const bridge = makeBridge(ctxAvecFond({
      baseLayerSource: () => ({ id: 'x-42', name: () => 'Plan cadastral informatisé' }),
      overlayLayerSources: () => [],
    }));

    expect(bridge.cadastreVisible()).toBe(true);
  });

  it('rend false quand aucune source ne parle de cadastre', () => {
    const bridge = makeBridge(ctxAvecFond({
      baseLayerSource: () => source('Bing', 'Bing aerial imagery'),
      overlayLayerSources: () => [source('osm-gps', 'Traces GPS')],
    }));

    expect(bridge.cadastreVisible()).toBe(false);
  });

  it('rend null — jamais false — quand background() est absent', () => {
    const bridge = makeBridge(ctxAvecConteneur(document.createElement('div')));

    // Distinction porteuse : `false` désarme le raccourci sur un état connu, `null`
    // le supprime entièrement et le dit en console.
    expect(bridge.cadastreVisible()).toBeNull();
  });

  it('rend null quand background() n’a pas la forme attendue', () => {
    expect(makeBridge(ctxAvecFond({})).cadastreVisible()).toBeNull();
    expect(makeBridge(ctxAvecFond(null)).cadastreVisible()).toBeNull();
  });

  it('rend null quand la lecture jette', () => {
    const bridge = makeBridge(ctxAvecFond({
      baseLayerSource: () => { throw new Error('boum'); },
    }));

    expect(bridge.cadastreVisible()).toBeNull();
  });

  it('juge sur l’id quand le nom jette', () => {
    const bridge = makeBridge(ctxAvecFond({
      baseLayerSource: () => ({ id: 'fr.cadastre', name: () => { throw new Error('boum'); } }),
      overlayLayerSources: () => [],
    }));

    expect(bridge.cadastreVisible()).toBe(true);
  });
});
