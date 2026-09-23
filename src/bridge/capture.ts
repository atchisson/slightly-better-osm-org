import type { IdBridge } from './types';
import type { ExistingBuilding } from '../conflation/overlap';
import type { ExistingNode } from '../conflation/snap';
import type { LonLat, Ring } from '../geometry/types';

// `storage` ne figure PAS ici : il n'existe plus sur le contexte (spike du 2026-09-23).
const PRIMITIVES = ['map', 'history', 'graph', 'projection', 'perform', 'enter', 'container'] as const;

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

function buildBridge(c: any): IdBridge {
  // Cache des bâtiments existants de la vue courante.
  //
  // Mesuré sur un contexte synthétique dimensionné comme la vue réelle du spike
  // (24 611 entités) : reconstruire cette liste à chaque appel de buildingsNear coûte,
  // selon la composition retenue, jusqu'à ~14 ms au pire appel — trop près du budget de
  // 16 ms par frame, sachant que buildingsNear est appelé par requestAnimationFrame
  // depuis hoverAt (une fois par mouvement de souris). D'où le cache.
  //
  // Invalidé :
  //  - au déplacement de la carte, sur l'événement 'move' de map() (primitive déjà
  //    utilisée par onMapMove, donc déjà supposée disponible par la conception
  //    d'origine — ceci n'ajoute pas de nouvelle hypothèse non vérifiée) ;
  //  - après un perform() déclenché par NOTRE PROPRE createBuilding, seul endroit où ce
  //    bridge modifie le graphe lui-même.
  //
  // PAS invalidé : une modification du graphe faite par ailleurs dans iD pendant que
  // notre greffon est actif (l'utilisatrice déplace un nœud existant, dessine un autre
  // bâtiment à la main, annule/rétablit...). Le contexte capturé n'expose aucun signal
  // vérifié de changement de graphe — le spike n'a pas confirmé de `history().on(...)`
  // ou équivalent, et en inventer un serait pire qu'assumer cette limite : le survol
  // peut, dans cette fenêtre étroite, ignorer un bâtiment tout juste modifié ailleurs,
  // jusqu'au prochain déplacement de carte.
  let buildingCache: ExistingBuilding[] | null = null;

  const allBuildings = (): ExistingBuilding[] => {
    if (buildingCache) return buildingCache;
    const entities = c.history().intersects(c.map().extent()) as any[];
    const graph = c.graph();
    buildingCache = entities
      .filter(e => e.type === 'way' && e.tags?.building)
      .map(e => ({
        id: e.id as string,
        ring: (e.nodes as string[]).map(id => graph.entity(id).loc as LonLat),
      }));
    return buildingCache;
  };

  // Espace de nom distinct de celui utilisé par onMapMove ('move.cadastre-id') : les
  // deux doivent coexister sans se remplacer l'un l'autre.
  c.map().on('move.cadastre-id-cache', () => { buildingCache = null; });

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
      c.map().on('move.cadastre-id', cb);
      return () => c.map().off('move.cadastre-id', cb);
    },

    buildingsNear(extent: [LonLat, LonLat]): ExistingBuilding[] {
      return allBuildings().filter(b => ringOverlapsExtent(b.ring, extent));
    },

    nodesNear(pt: LonLat, radiusM: number): ExistingNode[] {
      const d = radiusM / 111320;
      const entities = c.history().intersects(c.map().extent()) as any[];
      return entities
        .filter(e => e.type === 'node')
        .map(e => ({ id: e.id as string, loc: e.loc as LonLat }))
        .filter(n => Math.abs(n.loc[0] - pt[0]) < d * 2 && Math.abs(n.loc[1] - pt[1]) < d * 2);
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
