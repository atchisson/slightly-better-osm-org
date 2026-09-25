import type { IdBridge } from './types';
import type { ExistingBuilding } from '../conflation/overlap';
import type { ExistingNode, Insertion } from '../conflation/snap';
import type { LonLat, Ring } from '../geometry/types';

// `storage` ne figure PAS ici : il n'existe plus sur le contexte (spike du 2026-09-23).
const PRIMITIVES = ['map', 'history', 'graph', 'projection', 'perform', 'enter', 'container'] as const;

// Rappel partagé par les trois messages de désactivation (auto-test makeBridge,
// garde coreContext figé ici même, et le chien de garde de src/main.ts) : le dépôt
// n'est pas publié, un lien GitHub qui y pointerait rendrait 404. Le seul repli
// actionnable pour quelqu'un qui voit ce message est de suspecter un changement
// dans la forme interne d'iD et de repasser la checklist qui existe pour ça.
export const DISABLE_HINT =
  "iD a peut-être changé ses internes ; voir docs/verification-manuelle.md.";

/**
 * Résultat d'une course entre `captureContext()` et un délai. `main.ts` en a besoin
 * pour distinguer « la capture a réussi » de « elle n'arrivera jamais » sans jamais
 * laisser le premier `await` du script attendre indéfiniment en silence — c'est
 * précisément le mode de rupture le plus probable (iD change la forme de son
 * namespace) et jusqu'ici le seul qui ne disait rien du tout en console.
 */
export type CaptureRaceOutcome =
  | { status: 'captured'; context: unknown }
  | { status: 'timed-out' };

/**
 * Délai avant d'abandonner l'attente de `coreContext()`. 8000 ms : assez long pour
 * couvrir le chargement du bundle d'iD (plusieurs Mo) sur une connexion lente ou un
 * cache froid — ce n'est PAS le signal qu'on cherche à capter, un chargement lent
 * finit toujours par appeler coreContext() — assez court pour qu'une rupture
 * structurelle réelle (le namespace n'a plus la forme attendue, coreContext()
 * n'est jamais appelé) se voie en console en un seul coup d'œil pendant une session
 * de débogage, plutôt que de laisser le silence sans fin d'aujourd'hui.
 */
export const CAPTURE_TIMEOUT_MS = 8000;

/**
 * Délai avant d'abandonner l'attente de `svg.surface` dans le conteneur d'iD.
 *
 * Bien plus court que CAPTURE_TIMEOUT_MS, et c'est voulu : ce délai-ci démarre APRÈS que
 * `coreContext()` a déjà été appelé, donc après que le (gros) bundle d'iD a déjà fini de
 * charger — ce n'est plus ce coût-là qu'il faut couvrir. Ce qui reste entre l'appel de
 * `coreContext()` et l'apparition de `svg.surface` est la construction synchrone du DOM
 * de la carte par `init()`, tout au plus étalée sur quelques tours de la boucle
 * d'animation (rendu piloté par requestAnimationFrame, ~16 ms chacun). 5 s, c'est deux à
 * trois ordres de grandeur au-dessus de ce que ça devrait coûter même sur une machine
 * lente, tout en restant assez court pour qu'une rupture structurelle réelle (iD a
 * renommé ou déplacé sa surface SVG) se voie en console en quelques secondes plutôt que
 * de laisser le greffon paraître accroché indéfiniment.
 */
export const SURFACE_READY_TIMEOUT_MS = 5000;

/**
 * Fait la course entre `capture` (la promesse de captureContext()) et un délai de
 * `timeoutMs`. Ne rejette et ne lève jamais : une capture qui n'arrive jamais est un
 * chemin de désactivation calme, pas une erreur, donc pas un rejet non géré.
 *
 * Une fois le délai écoulé, `capture` peut encore se résoudre plus tard (rien ne
 * l'annule : une Promise ne s'annule pas) — mais cette résolution tardive ne change
 * plus jamais le résultat déjà rendu ni ne relance de log : le drapeau `settled`
 * l'ignore. Symétriquement, dès que `capture` se résout la première, le minuteur est
 * annulé : il ne reste jamais actif pour la durée de vie de la page derrière une
 * capture réussie.
 */
export function raceCaptureAgainstTimeout(
  capture: Promise<unknown>,
  timeoutMs: number,
): Promise<CaptureRaceOutcome> {
  return new Promise(resolve => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'timed-out' });
    }, timeoutMs);

    capture.then(context => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'captured', context });
    });
  });
}

/**
 * Vrai si CE document porte la marque HTML qui identifie la page réelle de l'éditeur
 * iD : un élément `id="id-container"`.
 *
 * Pourquoi ce sélecteur précisément : le spike (`docs/superpowers/spikes/2026-09-22-
 * capture-contexte-id.md`, correction de conception n°1) a lu le gabarit Rails qui sert
 * l'éditeur — `id.html.erb` — et y a trouvé exactement `<div id="id-container">`. Ce
 * gabarit sert la page `/id`, celle que le spike a confirmée être chargée dans une
 * iframe distincte du document `/edit` qui l'héberge (une hypothèse de lecture de code
 * que la session réelle a corrigée) : `/edit` ne contient qu'un cadre pointant vers
 * `/id`, jamais cette marque elle-même ; `/id` la contient toujours, que `window.iD` se
 * soit ensuite capturé ou non.
 *
 * Pourquoi une marque DOM plutôt qu'un test sur `location.pathname` : cette fonction ne
 * tourne qu'APRÈS l'expiration du chien de garde de capture (CAPTURE_TIMEOUT_MS), donc
 * bien après que le HTML initial du document a fini d'être analysé. Cette marque est
 * produite par le gabarit Rails côté SERVEUR, donc déjà présente dans ce HTML initial —
 * bien avant que le (gros) bundle JS d'iD n'ait eu la moindre chance de s'exécuter. Sa
 * présence ne dépend donc PAS de la réussite de la capture : un document qui la porte
 * mais où `window.iD` n'a jamais été affecté est un cas structurel réel (bundle cassé,
 * iD a renommé son namespace...), exactement celui que le message de désactivation
 * existant doit continuer à signaler. Un test fondé sur l'URL resterait correct tant que
 * `@match` (src/meta.ts) et la structure de page d'osm.org restent synchronisés, mais
 * romprait silencieusement dès que l'un des deux change sans l'autre ; celui-ci reste
 * vrai même si osm.org sert un jour l'éditeur ailleurs qu'à `/id` — le cas que le spike
 * signale explicitement comme possible.
 *
 * Ne lève jamais : un document qui ne supporte pas `getElementById` (forme inattendue,
 * document déjà démoli...) est traité comme « pas l'éditeur », pas comme une exception
 * qui remonterait dans le chemin de désactivation qu'elle est censée arbitrer.
 */
export function looksLikeIdDocument(doc: Document): boolean {
  try {
    return !!doc.getElementById('id-container');
  } catch {
    return false;
  }
}

/**
 * Attend que `svg.surface` apparaisse quelque part sous `container`, borné par
 * `timeoutMs`. Résout `true` dès que trouvé, `false` si le délai s'écoule d'abord — ne
 * rejette et ne lève JAMAIS, pour la même raison que `raceCaptureAgainstTimeout` : une
 * exception qui remonterait vers l'amorçage d'iD l'a déjà cassé une fois pendant le
 * spike (voir hasFrozenCoreContext plus haut), et cette fonction tourne exactement dans
 * cette fenêtre-là, juste après que coreContext() a été appelé.
 *
 * Pourquoi ceci existe : `iD.coreContext().containerNode(container).init()` s'exécute en
 * une seule chaîne synchrone lors de l'amorçage d'osm.org. `captureContext()` résout dès
 * que `coreContext()` est APPELÉ — avant que `.containerNode(container)` et `.init()`
 * n'aient eu lieu. Comme la continuation de notre `await` ne reprend qu'en microtâche,
 * une fois cette chaîne synchrone terminée, on pourrait croire `init()` déjà fini à ce
 * moment-là — mais rien ne garantit que le rendu de la carte (et donc la création de
 * `svg.surface`) soit lui-même synchrone à l'intérieur d'`init()`. En pratique
 * (confirmé par un lancement réel), il ne l'est pas complètement : `surfaceNode()`
 * retombait sur son repli alors même qu'une commande tapée à la main, un instant plus
 * tard, trouvait l'élément. D'où cette attente bornée, plutôt qu'une simple hypothèse de
 * synchronicité.
 *
 * Préfère un MutationObserver à un sondage : la construction du DOM de la carte est un
 * événement (des nœuds apparaissent), pas un état à interroger à intervalles arbitraires
 * ; observer directement l'arrivée du bon nœud élimine tout compromis entre latence de
 * détection et coût de sondage répété. L'observateur est TOUJOURS déconnecté avant que
 * cette fonction ne résolve — succès ou délai écoulé — pour ne jamais laisser un
 * observateur vivre au-delà de sa propre réponse sur un conteneur qui, lui, survit pour
 * toute la session d'édition.
 */
export function waitForSurface(container: unknown, timeoutMs: number): Promise<boolean> {
  const canQuery = (node: unknown): node is Element =>
    !!node && typeof (node as { querySelector?: unknown }).querySelector === 'function';
  const found = (): boolean => canQuery(container) && !!container.querySelector('svg.surface');

  return new Promise(resolve => {
    if (found()) { resolve(true); return; }

    let settled = false;
    let observer: MutationObserver | undefined;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        observer?.disconnect();
      } catch {
        /* la déconnexion est un nettoyage, pas une condition de la réponse déjà rendue */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      if (canQuery(container) && typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {
          if (found()) finish(true);
        });
        observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      }
    } catch {
      /* pas d'observation possible ici : le minuteur seul tranchera, jamais d'exception */
    }
  });
}

// Suffixe unique par bridge construit. Sous la convention "un seul emplacement par
// espace de nom" de d3/iD, un espace de nom fixe (littéral) partagé entre deux bridges
// construits sur le même contexte ferait que le second remplace silencieusement les
// écouteurs du premier. Un compteur suffit : monotone, jamais réutilisé, pas besoin
// d'aléatoire pour éviter une collision.
let bridgeInstanceCounter = 0;

/**
 * Vrai si `coreContext` est une propriété de DONNEES non configurable et non
 * inscriptible sur `namespace` — la forme exacte où envelopper `coreContext` dans un
 * Proxy est illégale.
 *
 * Repéré en revue, pas par le spike : aujourd'hui `coreContext` est un ACCESSEUR (un
 * getter, sans setter), et pour un accesseur avec un getter présent, l'invariant
 * [[Get]] du spec Proxy (ECMA-262 §9.5.8) n'impose RIEN sur ce que le piège `get` peut
 * renvoyer — c'est le cas qui rend notre Proxy légal aujourd'hui. Mais si un futur
 * build d'iD exposait plutôt `coreContext` comme une propriété de données figée
 * (`{ value, writable: false, configurable: false }` — par exemple via
 * `Object.freeze`), l'invariant devient strict : le piège `get` DOIT renvoyer
 * exactement (SameValue) `desc.value`, sous peine d'une TypeError levée par le moteur
 * lui-même, APRES le retour du piège — donc dans un cadre qu'aucun try/catch écrit ici
 * ne peut intercepter. Vérifié en pratique (pas seulement en théorie) sur V8 :
 * `TypeError: 'get' on proxy: property 'coreContext' is a read-only and
 * non-configurable data property on the proxy target but the proxy did not return its
 * actual value...`
 *
 * La défense ne peut donc pas être un garde ; il faut éviter la situation en amont. Si
 * cette fonction renvoie vrai, on n'enveloppe pas du tout : le namespace est exposé
 * intact, la capture ne se fait pas, et l'éditeur démarre normalement sans le greffon.
 */
function hasFrozenCoreContext(namespace: unknown): boolean {
  if (namespace === null || (typeof namespace !== 'object' && typeof namespace !== 'function')) return false;
  const desc = Object.getOwnPropertyDescriptor(namespace, 'coreContext');
  return desc?.writable === false && desc.configurable === false;
}

/**
 * Pose un piège sur window.iD et résout dès que coreContext() a produit une instance.
 *
 * Deux contraintes viennent du spike, et aucune n'est négociable :
 *
 * 1. On n'écrit JAMAIS sur le namespace. Ses exports sont des getters sans setter, et
 *    `value.coreContext = wrapper` lève une TypeError. Comme cette exception remonte
 *    depuis le setter de window.iD, elle casse l'amorçage d'iD. On expose donc un Proxy.
 * 2. Tout est sous try/catch. En cas d'échec on rend le namespace intact : le plugin se
 *    désactive, l'éditeur démarre.
 */
export function captureContext(): Promise<unknown> {
  return new Promise(resolve => {
    let exposed: unknown = undefined;

    const wrap = (namespace: any): any => new Proxy(namespace, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'coreContext' || typeof value !== 'function') return value;
        return function (this: unknown, ...args: unknown[]) {
          const ctx = value.apply(this, args);
          resolve(ctx);
          return ctx;
        };
      },
    });

    try {
      Object.defineProperty(globalThis, 'iD', {
        configurable: true,
        get: () => exposed,
        set(value: any) {
          try {
            if (hasFrozenCoreContext(value)) {
              console.log(
                "[cadastre-id] désactivé : coreContext est une propriété figée (non " +
                "configurable, non inscriptible) ; l'éditeur démarre normalement sans " +
                `le greffon. ${DISABLE_HINT}`,
              );
              exposed = value;
              return;
            }
            exposed = wrap(value);
          } catch {
            exposed = value; // iD doit démarrer même si on échoue
          }
        },
      });
    } catch {
      /* on ne peut pas piéger : whenReady ne résoudra pas, l'auto-test désactivera */
    }
  });
}

/** Auto-test : refuse un contexte auquel manque une primitive attendue. */
export function makeBridge(ctx: unknown): IdBridge {
  const c = ctx as Record<string, unknown>;
  for (const key of PRIMITIVES) {
    if (typeof c[key] !== 'function') {
      throw new Error(`contexte iD inutilisable : ${key} manquant`);
    }
  }
  return buildBridge(c);
}

/** Chevauchement de rectangles englobants : vrai dès que l'anneau touche l'étendue. */
function ringOverlapsExtent(ring: Ring, extent: [LonLat, LonLat]): boolean {
  const [[minLon, minLat], [maxLon, maxLat]] = extent;
  let rMinLon = Infinity, rMinLat = Infinity, rMaxLon = -Infinity, rMaxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < rMinLon) rMinLon = lon;
    if (lon > rMaxLon) rMaxLon = lon;
    if (lat < rMinLat) rMinLat = lat;
    if (lat > rMaxLat) rMaxLat = lat;
  }
  return rMinLon <= maxLon && rMaxLon >= minLon && rMinLat <= maxLat && rMaxLat >= minLat;
}

/** Vrai si l'entité ne porte aucun tag — un simple sommet de géométrie. */
function hasNoTags(e: any): boolean {
  return !e.tags || Object.keys(e.tags).length === 0;
}

/** Vrai si `tags` décrit un bâtiment (au sens du contrôle de recouvrement, spec §5 étape 7). */
function taggedBuilding(tags: any): boolean {
  return !!tags?.building && tags.building !== 'no';
}

/**
 * Ways membres (hors rôle `inner`) d'une relation taguée `building`.
 *
 * Un bâtiment cartographié en multipolygone porte ses tags sur la RELATION, jamais sur
 * ses ways : `e.tags?.building` seul les manque tous. Or ce sont précisément les
 * bâtiments à cour intérieure que le greffon refuse côté cadastre — donc ceux que
 * quelqu'un a tracés à la main, et par-dessus lesquels créer un doublon serait la seule
 * chose que la v1 promet de ne jamais faire.
 *
 * Les membres de rôle `inner` sont exclus : ce sont les cours, pas le bâti.
 */
function relationBuildingWayIds(entities: any[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entities) {
    if (e.type !== 'relation' || !taggedBuilding(e.tags)) continue;
    for (const m of (e.members ?? []) as any[]) {
      if (m?.type === 'way' && m.role !== 'inner' && typeof m.id === 'string') ids.add(m.id);
    }
  }
  return ids;
}

function buildBridge(c: any): IdBridge {
  // Suffixe propre à CET appel de buildBridge (voir bridgeInstanceCounter plus haut) :
  // deux bridges construits sur le même contexte (retry, re-init...) ne doivent jamais
  // se marcher dessus sur un espace de nom d3/iD.
  const ns = `cadastre-id-${++bridgeInstanceCounter}`;

  // Cache des bâtiments existants de la vue courante.
  //
  // Mesuré sur un contexte synthétique dimensionné comme la vue réelle du spike
  // (24 611 entités) : reconstruire cette liste à chaque appel de buildingsNear coûte,
  // selon la composition retenue, jusqu'à ~14 ms au pire appel — trop près du budget de
  // 16 ms par frame, sachant que buildingsNear est appelé par requestAnimationFrame
  // depuis hoverAt (une fois par mouvement de souris). D'où le cache.
  //
  // Invalidé :
  //  - au déplacement de la carte, sur l'événement 'move' de map() — SI le contexte le
  //    permet, voir la tentative juste en dessous : le spike a vérifié
  //    map().extent().rectangle(), jamais map().on/off ;
  //  - après un perform() déclenché par NOTRE PROPRE createBuilding, seul endroit où ce
  //    bridge modifie le graphe lui-même ;
  //  - au changement de graphe fait AILLEURS dans iD (l'utilisatrice déplace un nœud
  //    existant, dessine un autre bâtiment à la main, annule/rétablit...), SI le
  //    contexte le permet — voir la seconde tentative juste en dessous.
  let buildingCache: ExistingBuilding[] | null = null;

  // Revue (tâche 16) : `onMapMove` utilisait un espace de nom fixe, un par BRIDGE
  // (`move.${ns}`) — jamais un par abonnement. L'overlay (task 15) s'y abonne une
  // fois ; le mode cadastre (task 16, rechargement au changement de commune) s'y
  // abonne une seconde fois SUR LE MÊME BRIDGE. Sous la convention d3 « type.namespace
  // remplace tout abonnement portant exactement le même type.namespace », le second
  // `.on('move.${ns}', ...)` écrasait silencieusement le premier : passé l'activation
  // du mode, le calque de survol arrêtait de se redessiner sur un déplacement de carte.
  // Personne ne l'avait vu : `onMapMove` n'avait jamais eu qu'un seul appelant avant.
  // Corrigé comme le cache interne le fait déjà pour lui-même (suffixe `-cache`,
  // commentaire juste en dessous) : chaque appel à `onMapMove` reçoit son PROPRE
  // suffixe, unique pour ce bridge, de sorte que N abonnements coexistent sans se
  // remplacer, et que se désabonner de l'un ne retire que le sien.
  let mapMoveSubCounter = 0;

  const allBuildings = (): ExistingBuilding[] => {
    if (buildingCache) return buildingCache;
    const entities = c.history().intersects(c.map().extent()) as any[];
    const graph = c.graph();
    // Un bâtiment cartographié en MULTIPOLYGONE porte ses tags sur la relation, pas sur
    // ses ways : `e.tags?.building` seul les manquait tous. Or ce sont exactement les
    // bâtiments à cour intérieure que le greffon refuse côté cadastre — donc ceux que
    // quelqu'un a tracés à la main — et créer un doublon par-dessus est précisément la
    // seule chose que la v1 promet de ne jamais faire.
    const membresDeRelation = relationBuildingWayIds(entities);
    buildingCache = entities
      .filter(e =>
        e.type === 'way' &&
        Array.isArray(e.nodes) &&
        (taggedBuilding(e.tags) || membresDeRelation.has(e.id as string)))
      .map(e => ({
        id: e.id as string,
        ring: (e.nodes as string[]).map(id => graph.entity(id).loc as LonLat),
        // Les nœuds, pas seulement leurs positions : insérer un sommet dans un mur
        // existant se désigne par l'arête `[idA, idB]` qu'il coupe (voir
        // planInsertions et createBuilding).
        nodeIds: e.nodes as string[],
      }));
    return buildingCache;
  };

  // Tentative, pas hypothèse : le spike n'a jamais exercé map().on/off, seulement
  // map().extent().rectangle(). C'est la même incertitude que pour history().on()
  // juste en dessous, donc le même traitement : sous try/catch, dégradation en
  // console si ça échoue plutôt qu'une exception qui remonterait hors de makeBridge.
  // Espace de nom distinct de celui d'onMapMove (même préfixe `ns`, suffixe `-cache`
  // en plus) : les deux doivent coexister sans se remplacer l'un l'autre.
  try {
    c.map().on(`move.${ns}-cache`, () => { buildingCache = null; });
  } catch {
    console.log(
      "[cadastre-id] aucun signal de deplacement de carte verifie sur map() : " +
      "le cache des batiments existants ne s'invalide plus qu'apres nos propres modifications.",
    );
  }

  // Tentative, pas hypothèse : le spike a vérifié que history() existe et que
  // history().intersects() fonctionne, jamais ce que l'objet renvoyé expose par
  // ailleurs. iD's history est un émetteur d'événements dans toutes les versions
  // connues, donc history().on('change...') a de bonnes chances de marcher — mais « de
  // bonnes chances » n'est pas « vérifié ». Si l'appel échoue ou si .on est absent, on
  // garde le comportement actuel (invalidation au seul déplacement de carte) : la
  // dégradation est silencieuse pour l'éditeur, mais dite une fois en console, pour
  // quiconque déboguerait, plutôt qu'enterrée dans un commentaire.
  try {
    c.history().on(`change.${ns}-cache`, () => { buildingCache = null; });
  } catch {
    console.log(
      "[cadastre-id] aucun signal de changement du graphe verifie sur history() : " +
      "le cache des batiments existants ne s'invalide qu'au deplacement de carte.",
    );
  }

  return {
    mapExtent(): [LonLat, LonLat] {
      const r = c.map().extent().rectangle() as number[];
      return [[r[0]!, r[1]!], [r[2]!, r[3]!]];
    },

    project(p: LonLat): [number, number] {
      return c.projection(p) as [number, number];
    },

    invert(p: [number, number]): LonLat {
      return c.projection.invert(p) as LonLat;
    },

    onMapMove(cb: () => void): () => void {
      // Même tentative que le cache interne, avec le même degré de prudence : le
      // spike n'a jamais exercé map().on/off. Si ça échoue, on ne casse pas l'appelant
      // (Task 15/16) : on rend un désabonnement inoffensif plutôt que de propager.
      // Suffixe propre à CET appel (voir mapMoveSubCounter plus haut) : deux abonnements
      // sur le même bridge ne doivent jamais se marcher dessus, et se désabonner de
      // l'un ne doit jamais retirer l'autre.
      const subNs = `${ns}-move${++mapMoveSubCounter}`;
      try {
        c.map().on(`move.${subNs}`, cb);
      } catch {
        console.log(
          "[cadastre-id] aucun signal de deplacement de carte verifie sur map() : " +
          "onMapMove n'appellera jamais son callback.",
        );
        return () => {};
      }
      // Le désabonnement s'exécute PLUS TARD, hors du try ci-dessus : sa protection ne
      // l'a jamais couvert. Il jetait `c.map().off is not a function` à chaque
      // désactivation du mode — la carte d'iD est un dispatch d3, qui n'a pas d'`off`.
      // On s'y désabonne en réassignant `null` au même `type.namespace`. `off` reste
      // essayé d'abord, au cas où une version d'iD en exposerait un.
      return () => {
        try {
          const map = c.map();
          if (typeof map.off === 'function') map.off(`move.${subNs}`, cb);
          else map.on(`move.${subNs}`, null);
        } catch {
          // Se désabonner ne doit jamais casser l'appelant : au pire le callback
          // survit, ce qui est sans effet sur un overlay déjà détruit.
        }
      }
    },

    /**
     * Limite connue, documentée et non corrigée ici : `history().intersects()` ne rend
     * que ce qui est CHARGÉ. Juste après un déplacement de carte, avant que la réponse
     * de l'API OSM n'arrive, cette liste est vide — et l'aperçu affiche alors « ok »,
     * une affirmation positive qu'il n'y a rien là, fondée sur un graphe vide.
     *
     * Le contexte capturé par le spike n'expose aucune primitive VÉRIFIÉE qui dise
     * qu'un chargement OSM est en cours ; en inventer une sur une hypothèse serait
     * exactement le genre de pari que ce projet a refusé ailleurs. C'est donc documenté
     * dans le README (« Limites connues ») plutôt que deviné ici.
     */
    buildingsNear(extent: [LonLat, LonLat]): ExistingBuilding[] {
      return allBuildings().filter(b => ringOverlapsExtent(b.ring, extent));
    },

    nodesIn(extent: [LonLat, LonLat]): ExistingNode[] {
      const [[minLon, minLat], [maxLon, maxLat]] = extent;
      const entities = c.history().intersects(c.map().extent()) as any[];

      // Sommets des bâtiments OSM chargés — y compris ceux des ways membres d'une
      // relation taguée `building` (un multipolygone porte ses tags sur la relation,
      // jamais sur ses ways : voir relationBuildingWayIds).
      const relationWays = relationBuildingWayIds(entities);
      const buildingVertexIds = new Set<string>();
      const otherWayVertexIds = new Set<string>();
      for (const e of entities) {
        if (e.type !== 'way' || !Array.isArray(e.nodes)) continue;
        const cible = taggedBuilding(e.tags) || relationWays.has(e.id as string)
          ? buildingVertexIds
          : otherWayVertexIds;
        for (const id of e.nodes as string[]) cible.add(id);
      }

      return entities
        .filter(e => e.type === 'node')
        // Éligibilité (spec §5 étape 8 : « recaler sur un nœud OSM existant ») :
        // l'intention est de recoudre un COIN DE BÂTIMENT voisin, rien d'autre. Sans
        // filtre — c'était le cas — n'importe quel nœud chargé pouvait être happé et
        // devenir un sommet du bâtiment créé :
        //  - un nœud TAGUÉ (une adresse, un arbre, du mobilier urbain) : on lui ferait
        //    porter un coin de maison, ce qui change le sens de l'objet existant ;
        //  - un sommet de VOIRIE : rattacher un bâtiment à une route est une erreur que
        //    les validateurs OSM signalent, et exactement le genre d'artefact d'import
        //    que la communauté FR demande d'éviter.
        // Un nœud est donc retenu s'il est sommet d'un bâtiment (way taguée `building`
        // ou membre d'une relation `building`), ou s'il est nu ET n'appartient à aucune
        // autre way. La règle est volontairement plus stricte que « nu ou sommet de
        // bâtiment » : un sommet de route nu tomberait sinon dans le premier cas.
        .filter(e => {
          const id = e.id as string;
          if (buildingVertexIds.has(id)) return true;
          return hasNoTags(e) && !otherWayVertexIds.has(id);
        })
        .map(e => ({ id: e.id as string, loc: e.loc as LonLat }))
        .filter(n =>
          n.loc[0] >= minLon && n.loc[0] <= maxLon &&
          n.loc[1] >= minLat && n.loc[1] <= maxLat);
    },

    createBuilding(
      ring: Ring,
      tags: Record<string, string>,
      reused: (string | null)[],
      insertions: (Insertion | null)[] = [],
    ): void {
      const iD = (globalThis as any).iD;
      const open = ring.slice(0, -1);
      const nodeIds: string[] = [];
      const created: any[] = [];
      const aInserer: { node: any; edge: [string, string] }[] = [];

      open.forEach((loc, i) => {
        const existing = reused[i];
        if (existing) { nodeIds.push(existing); return; }
        const node = instancier(iD.osmNode, { loc });
        nodeIds.push(node.id);
        // Un sommet qui tombe sur le mur d'un bâtiment existant y est INSÉRÉ plutôt
        // qu'ajouté à côté : les deux bâtiments partagent alors réellement ce nœud.
        // `actionAddMidpoint` ajoute le nœud ET le coud dans toutes les voies qui
        // portent cette arête — inutile de l'ajouter séparément.
        const ins = insertions[i];
        if (ins) aInserer.push({ node, edge: ins.edge });
        else created.push(node);
      });

      const way = instancier(iD.osmWay, { tags, nodes: [...nodeIds, nodeIds[0]!] });
      // Une seule transaction, dans cet ordre : les nœuds existent avant la voie qui
      // les référence. Ctrl+Z défait l'ensemble — création ET coutures — en une fois,
      // ce que la spec exige et qui importe d'autant plus maintenant qu'on touche à
      // des objets existants.
      const actions = [
        ...created.map(e => instancier(iD.actionAddEntity, e)),
        ...aInserer.map(({ node, edge }) =>
          instancier(iD.actionAddMidpoint, { loc: node.loc, edge }, node)),
        instancier(iD.actionAddEntity, way),
      ];
      c.perform(...actions, 'Bâtiment depuis le cadastre');
      buildingCache = null; // notre propre modification du graphe invalide le cache
      c.enter(instancier(iD.modeSelect, c, [way.id]));
    },

    prefillChangeset(comment: string, source: string): void {
      // `context.storage` n'existe plus (spike du 2026-09-23). iD expose `prefs` sur le
      // namespace, et le commentaire vit dans localStorage sous la clé `comment`, sans
      // préfixe. `commentDate` doit suivre : iD périme un commentaire trop ancien, et
      // l'oublier ferait ignorer le nôtre en silence.
      //
      // `source` passe par le MÊME mécanisme. Honnêteté sur le degré de certitude : la
      // clé `comment` a été lue sur une session réelle par le spike ; la clé `source`,
      // non — elle est déduite du code d'iD, où l'expiration d'un commentaire trop
      // ancien efface ensemble `comment`, `hashtags` et `source`. Le pire cas d'une
      // clé fausse est un champ non prérempli (l'écriture est inoffensive, et le tag
      // `source` de l'objet lui-même, lui, est posé par tagging/), pas une donnée
      // fausse — mais c'est exactement pour ça que la vérification manuelle porte
      // dessus (docs/verification-manuelle.md).
      const iD = (globalThis as any).iD;
      const write = (k: string, v: string): void => {
        try {
          if (iD && typeof iD.prefs === 'function') iD.prefs(k, v);
          else localStorage.setItem(k, v);
        } catch { /* le préremplissage est un confort, jamais un bloquant */ }
      };
      write('comment', comment);
      write('source', source);
      write('commentDate', String(Date.now()));
    },

    containerNode(): HTMLElement {
      return c.container().node() as HTMLElement;
    },

    whenSurfaceReady(): Promise<boolean> {
      // Voir waitForSurface plus haut pour le pourquoi. Le conteneur est relu ICI (pas
      // mis en cache dans une fermeture au moment de construire le bridge) : appeler
      // c.container() une seconde fois coûte une lecture triviale, et ça évite de
      // supposer que rien ne remplace jamais le nœud conteneur entre la construction du
      // bridge et cet appel.
      return waitForSurface(c.container().node(), SURFACE_READY_TIMEOUT_MS);
    },

    surfaceNode(): Element {
      // C'est ICI, et nulle part ailleurs, que vit la connaissance d'un sélecteur
      // interne d'iD. Elle était auparavant dans src/main.ts — hors de bridge/, contre
      // la règle du §4 de la spec — sous la forme
      // `container.querySelector('svg.surface') ?? container`, dont le repli silencieux
      // changeait l'origine des coordonnées sans le dire.
      const container = c.container().node() as HTMLElement;
      const surface = typeof container?.querySelector === 'function'
        ? container.querySelector('svg.surface')
        : null;
      if (surface) return surface;
      // Repli explicite, jamais muet : le conteneur inclut la barre d'outils et le
      // panneau latéral, donc son coin n'est probablement PAS l'origine de la
      // projection. Tout ce qui en dépend (survol, conversion écran -> coordonnées)
      // sera décalé, et il faut pouvoir le lire en console plutôt que le deviner à
      // l'écran.
      console.log(
        "[cadastre-id] surface de carte (svg.surface) introuvable dans le conteneur d'iD : " +
        "repli sur le conteneur lui-meme. L'origine de la projection est probablement " +
        "decalee (barre d'outils, panneau lateral) ; le calque de survol et la " +
        "conversion ecran -> coordonnees peuvent ne plus coincider avec la carte.",
      );
      return container;
    },

    cadastreVisible(): boolean | null {
      // `context.background()` n'a PAS été vérifié par le spike, contrairement aux
      // autres primitives lues ici. Tout est donc gardé, et l'échec rend `null` —
      // « je ne sais pas » — que l'appelant ne doit jamais confondre avec « non ».
      try {
        const bg = (c as { background?: () => unknown }).background?.();
        if (!bg) return null;
        const b = bg as {
          baseLayerSource?: () => unknown;
          overlayLayerSources?: () => unknown[];
        };
        const sources: unknown[] = [];
        if (typeof b.baseLayerSource === 'function') sources.push(b.baseLayerSource());
        if (typeof b.overlayLayerSources === 'function') sources.push(...b.overlayLayerSources());
        if (sources.length === 0) return null;
        return sources.some(estCadastre);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Appelle une fabrique du namespace iD, qu'elle soit fonction ou classe.
 *
 * `iD.osmNode({loc})` jetait « class constructors must be invoked with 'new' » au
 * premier clic : les entités d'iD sont des classes ES. Les fabriques historiques
 * (`actionAddEntity`, `modeSelect`) restent, elles, de simples fonctions, qu'il
 * serait faux d'appeler avec `new`.
 *
 * On ne devine donc pas : on demande à chaque fabrique ce qu'elle est. Un `new`
 * appliqué à tort, ou omis à tort, se solde par un `TypeError` au premier clic —
 * c'est-à-dire au pire moment, sur l'unique action que le greffon existe pour faire.
 */
function instancier(fabrique: any, ...args: unknown[]): any {
  const estClasse = typeof fabrique === 'function' &&
    /^class[\s{]/.test(Function.prototype.toString.call(fabrique));
  return estClasse ? new fabrique(...args) : fabrique(...args);
}

/**
 * Une source d'imagerie d'iD est-elle le cadastre ?
 *
 * Correspondance sur le nom et l'identifiant plutôt que sur un identifiant en dur :
 * l'index d'imagerie d'iD est un dépôt tiers qui renomme et réorganise ses entrées,
 * et le cadastre y est proposé sous plusieurs formes (fond de carte, calque
 * superposé, millésimes). Un identifiant figé ici se périmerait en silence — et le
 * silence est précisément ce qu'on ne veut pas sur la condition d'un raccourci
 * invisible.
 *
 * Sur le RADICAL `cadastr`, pas sur le mot `cadastre` : la couche de référence
 * s'appelle « Plan Cadastral Informatisé » (le PCI, d'où viennent nos données), que
 * `cadastre` seul ne reconnaît pas. « cadastral », « cadastraux » et « cadastre »
 * tombent tous dans ce radical.
 */
function estCadastre(source: unknown): boolean {
  const s = source as { id?: unknown; name?: unknown };
  const morceaux: string[] = [];
  if (typeof s?.id === 'string') morceaux.push(s.id);
  try {
    if (typeof s?.name === 'function') {
      const n = (s.name as () => unknown)();
      if (typeof n === 'string') morceaux.push(n);
    }
  } catch { /* une source sans nom lisible reste jugeable sur son id */ }
  return morceaux.join(' ').toLowerCase().includes('cadastr');
}
