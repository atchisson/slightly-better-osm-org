import type { IdBridge } from './types';
import type { ExistingBuilding } from '../conflation/overlap';
import type { ExistingNode } from '../conflation/snap';
import type { LonLat, Ring } from '../geometry/types';

// `storage` ne figure PAS ici : il n'existe plus sur le contexte (spike du 2026-09-23).
const PRIMITIVES = ['map', 'history', 'graph', 'projection', 'perform', 'enter', 'container'] as const;

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
                "[cadastre-id] coreContext est une propriete figee (non configurable, " +
                "non inscriptible) : capture desactivee, l'editeur demarre normalement " +
                "sans le greffon.",
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
    buildingCache = entities
      .filter(e => e.type === 'way' && e.tags?.building && e.tags.building !== 'no')
      .map(e => ({
        id: e.id as string,
        ring: (e.nodes as string[]).map(id => graph.entity(id).loc as LonLat),
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
        return () => c.map().off(`move.${subNs}`, cb);
      } catch {
        console.log(
          "[cadastre-id] aucun signal de deplacement de carte verifie sur map() : " +
          "onMapMove n'appellera jamais son callback.",
        );
        return () => {};
      }
    },

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

    createBuilding(ring: Ring, tags: Record<string, string>, reused: (string | null)[]): void {
      const iD = (globalThis as any).iD;
      const open = ring.slice(0, -1);
      const nodeIds: string[] = [];
      const created: any[] = [];

      open.forEach((loc, i) => {
        const existing = reused[i];
        if (existing) { nodeIds.push(existing); return; }
        const node = iD.osmNode({ loc });
        created.push(node);
        nodeIds.push(node.id);
      });

      const way = iD.osmWay({ tags, nodes: [...nodeIds, nodeIds[0]!] });
      const actions = [...created, way].map(entity => iD.actionAddEntity(entity));
      c.perform(...actions, 'Bâtiment depuis le cadastre');
      buildingCache = null; // notre propre modification du graphe invalide le cache
      c.enter(iD.modeSelect(c, [way.id]));
    },

    prefillChangeset(comment: string): void {
      // `context.storage` n'existe plus (spike du 2026-09-23). iD expose `prefs` sur le
      // namespace, et le commentaire vit dans localStorage sous la clé `comment`, sans
      // préfixe. `commentDate` doit suivre : iD périme un commentaire trop ancien, et
      // l'oublier ferait ignorer le nôtre en silence.
      const iD = (globalThis as any).iD;
      const write = (k: string, v: string): void => {
        try {
          if (iD && typeof iD.prefs === 'function') iD.prefs(k, v);
          else localStorage.setItem(k, v);
        } catch { /* le préremplissage est un confort, jamais un bloquant */ }
      };
      write('comment', comment);
      write('commentDate', String(Date.now()));
    },

    containerNode(): HTMLElement {
      return c.container().node() as HTMLElement;
    },
  };
}
