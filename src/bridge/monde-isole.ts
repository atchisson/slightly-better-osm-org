import { hasFrozenCoreContext } from './capture';

/**
 * Faire tourner le greffon depuis le monde isolé de l'extension, sous Firefox.
 *
 * Constaté en réel (Firefox + Violentmonkey, mode « auto ») : la CSP d'osm.org
 * (`script-src 'self' 'nonce-…'`) bloque l'injection du script dans la page, et
 * Violentmonkey se rabat sur son monde isolé (« content »). `window` n'y est qu'une vue
 * filtrée (Xray) : `iD` y est invisible, et un objet ou une fonction du monde isolé
 * passé tel quel à la page lui est illisible. Forcer `@inject-into page` n'aide pas :
 * le script n'est plus injecté du tout. Réinjecter le code dans la page non plus :
 * `/id` ne porte aucun jeton (nonce) lisible.
 *
 * Mais ce monde isolé démarre AVANT tout script de la page — mieux que le mode page,
 * dont l'injection arrivait parfois trop tard. Firefox fournit aux scripts de contenu
 * de quoi parler à la page : `wrappedJSObject` (la vue non filtrée), `exportFunction`
 * (rendre une fonction appelable par la page) et `XPCNativeWrapper` (revenir à la vue
 * filtrée). Ce module s'en sert pour deux choses :
 *
 * 1. poser le piège sur `iD` directement dans la page (captureContextIsole) ;
 * 2. une membrane : chaque objet de la page rendu au greffon passe derrière un Proxy
 *    qui convertit tout ce qui traverse — fonctions du greffon exportées, données
 *    recopiées en objets de la page, valeurs de la page à nouveau enveloppées. La
 *    jonction avec iD (capture.ts) s'écrit alors comme si elle vivait dans la page.
 *
 * Les nœuds DOM ne passent PAS par la membrane : rendus dans leur vue filtrée, ils
 * restent de vrais nœuds pour `MutationObserver`, `getComputedStyle` ou `appendChild`.
 */

/** Ce que Firefox fournit pour parler à la page, abstrait pour être simulé en test. */
export interface OutilsPage {
  /** La fenêtre de la page, vue non filtrée. */
  page: any;
  /** Rend une fonction du monde isolé appelable par la page. */
  exporter(fn: (...args: any[]) => unknown): unknown;
  /** Vue non filtrée d'une valeur de la page (identité si elle l'est déjà). */
  deballer(v: unknown): any;
  /** Vrai pour une valeur qui appartient à la page (vue filtrée comprise). */
  estPage(v: unknown): boolean;
  /** La valeur dans sa vue filtrée si c'est un nœud, un événement ou une fenêtre ; sinon null. */
  versDom(v: unknown): unknown;
}

declare const exportFunction: ((fn: (...a: any[]) => unknown, cible: object) => unknown) | undefined;
declare const XPCNativeWrapper: any;

/** Les outils Firefox du monde isolé, ou null s'ils manquent (autre navigateur, autre gestionnaire). */
export function outilsFirefox(win: any): OutilsPage | null {
  try {
    if (typeof exportFunction !== 'function' || typeof XPCNativeWrapper !== 'function') return null;
    const page = win.wrappedJSObject;
    if (!page) return null;
    const { Node: NodeX, Event: EventX, Window: WindowX } = win;
    return {
      page,
      exporter: fn => exportFunction(fn, page),
      deballer: v => {
        try { return (v as { wrappedJSObject?: unknown }).wrappedJSObject ?? v; } catch { return v; }
      },
      estPage: v => {
        try {
          return (v as { wrappedJSObject?: unknown }).wrappedJSObject !== undefined ||
            XPCNativeWrapper.unwrap(v) !== v;
        } catch { return false; }
      },
      versDom: v => {
        try {
          const x = XPCNativeWrapper(v);
          return x instanceof NodeX || x instanceof EventX || x instanceof WindowX ? x : null;
        } catch { return null; }
      },
    };
  } catch {
    return null;
  }
}

export interface Membrane {
  /** Valeur de la page → valeur utilisable par le greffon. */
  sortir(v: unknown): any;
  /** Valeur du greffon → valeur que la page peut lire. */
  versPage(v: unknown): any;
}

const estObjet = (v: unknown): v is object =>
  v !== null && (typeof v === 'object' || typeof v === 'function');

export function creerMembrane(o: OutilsPage): Membrane {
  const proxies = new WeakMap<object, object>(); // objet de la page → son intermédiaire
  const cibles = new WeakMap<object, object>();  // intermédiaire → objet de la page
  const exportees = new WeakMap<object, unknown>(); // fonction du greffon → version exportée

  const versPage = (v: unknown): any => {
    if (!estObjet(v)) return v;
    const cible = cibles.get(v);
    if (cible) return cible;
    if (o.versDom(v) || o.estPage(v)) return v;
    if (typeof v === 'function') {
      let e = exportees.get(v);
      if (e === undefined) {
        const f = v as (...a: unknown[]) => unknown;
        e = o.exporter(function (this: unknown, ...args: unknown[]) {
          return versPage(f.apply(sortir(this), args.map(sortir)));
        });
        exportees.set(v, e);
      }
      return e;
    }
    // Données du greffon (tags, coordonnées, options) : recopiées en objets de la page.
    if (Array.isArray(v)) {
      const a = new o.page.Array();
      for (const x of v) a.push(versPage(x));
      return a;
    }
    const copie = new o.page.Object();
    for (const k of Object.keys(v)) copie[k] = versPage((v as Record<string, unknown>)[k]);
    return copie;
  };

  const sortir = (v: unknown): any => {
    if (!estObjet(v) || cibles.has(v)) return v;
    const brut = o.deballer(v);
    const dom = o.versDom(brut);
    if (dom) return dom;
    const connu = proxies.get(brut);
    if (connu) return connu;
    const p = new Proxy(brut, {
      get(t, k) {
        const val = Reflect.get(t, k);
        if (estObjet(val)) {
          // Invariant des Proxy : une propriété figée doit rendre sa valeur exacte.
          const d = Reflect.getOwnPropertyDescriptor(t, k);
          if (d && d.configurable === false && d.writable === false) return val;
        }
        return sortir(val);
      },
      set: (t, k, val) => Reflect.set(t, k, versPage(val)),
      apply: (t, self, args) => sortir(Reflect.apply(t as (...a: unknown[]) => unknown, versPage(self), args.map(versPage))),
      construct: (t, args) => sortir(Reflect.construct(t as new (...a: unknown[]) => object, args.map(versPage))),
    });
    proxies.set(brut, p);
    cibles.set(p, brut);
    return p;
  };

  return { sortir, versPage };
}

/**
 * Pose, depuis le monde isolé, le piège sur `window.iD` de la PAGE, et résout avec le
 * contexte (derrière la membrane) dès que l'amorçage d'osm.org appelle `coreContext()`.
 *
 * Même contrat que captureContext (capture.ts) : on n'écrit jamais sur le namespace,
 * on expose un Proxy — créé ici avec le `Proxy` de la page et un gestionnaire exporté,
 * pour que la page puisse s'en servir —, on ne masque jamais un `iD` déjà affecté, on
 * respecte l'accesseur d'un tiers, et un échec rend le namespace intact.
 */
export function captureContextIsole(o: OutilsPage, m: Membrane): Promise<unknown> {
  return new Promise(resolve => {
    try {
      const page = o.page;
      const existant = page.Object.getOwnPropertyDescriptor(page, 'iD');
      if (existant && !('value' in existant)) return; // accesseur d'un tiers

      let expose: unknown = undefined;
      let enveloppe: unknown;

      const exposer = (ns: unknown): void => {
        const brut = o.deballer(ns);
        try {
          if (!estObjet(brut) || hasFrozenCoreContext(brut)) { expose = brut; return; }
          const gestionnaire = new page.Object();
          gestionnaire.get = o.exporter((cible: unknown, prop: unknown) => {
            const valeur = o.deballer(cible)[prop as string];
            if (prop !== 'coreContext' || typeof valeur !== 'function') return valeur;
            enveloppe ??= o.exporter(function (this: unknown, ...args: unknown[]) {
              // `Reflect.apply` du monde isolé, JAMAIS `valeur.apply(…, args)` : sur une
              // fonction de la page, `.apply` est celui de la page, qui lit `length` sur
              // `args` — un tableau du monde isolé, illisible pour elle. Constaté en réel :
              // « Permission denied to access property "length" », et l'amorçage d'iD
              // cassé. Ici, chaque argument passe seul, et ce sont des valeurs de la page.
              const ctx = Reflect.apply(valeur, o.deballer(this), args);
              try { resolve(m.sortir(ctx)); } catch { /* jamais au prix du démarrage d'iD */ }
              return ctx;
            });
            return enveloppe;
          });
          expose = new page.Proxy(brut, gestionnaire);
        } catch {
          expose = brut; // iD doit démarrer même si on échoue
        }
      };

      const descripteur = new page.Object();
      descripteur.configurable = true;
      descripteur.get = o.exporter(() => expose);
      descripteur.set = o.exporter(exposer);
      page.Object.defineProperty(page, 'iD', descripteur);
      if (existant && existant.value !== undefined) exposer(existant.value);
    } catch {
      /* on ne peut pas piéger : le chien de garde de main.ts tranchera */
    }
  });
}
