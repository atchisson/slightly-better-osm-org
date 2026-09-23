import { composeAt } from './compose';
import type { Composition } from './compose';
import { buildDataset, type Dataset } from './cadastre/dataset';
import { downloadCommune } from './cadastre/download';
import { readCache, writeCache } from './cadastre/store';
import { communeAt } from './cadastre/insee';
import { overlapsExisting } from './conflation/overlap';
import { snapToExistingNodes, DEFAULT_SNAP_TOLERANCE_M } from './conflation/snap';
import { buildingTags, changesetComment } from './tagging/tags';
import { createOverlay, type Overlay } from './ui/overlay';
import { refusalMessage } from './ui/messages';
import type { IdBridge } from './bridge/types';
import type { LonLat } from './geometry/types';

export interface ModeDeps {
  loadDataset(pt: LonLat): Promise<Dataset>;
  communeName(pt: LonLat): Promise<string>;
  notify(message: string): void;
}

export interface CadastreMode {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  whenReady(): Promise<void>;
  hoverAt(pt: LonLat): void;
  /**
   * Le curseur quitte la surface de la carte : sans ce signal, le dernier contour
   * survolé resterait affiché — un aperçu qui ne correspond plus à rien sous le
   * curseur. Absent de l'interface du brief, ajouté ici : c'est un des chemins de
   * sortie de l'overlay (mode désactivé, refus en cours de survol, composition vide,
   * et celui-ci) que la tâche 15 a explicitement demandé de couvrir.
   */
  hoverEnd(): void;
  clickAt(pt: LonLat): Promise<void>;
}

/**
 * Distingue « pas de commune ici » (communeAt renvoie null : une réponse légitime, hors
 * couverture du cadastre français) d'un échec d'API (communeAt ou downloadCommune
 * lèvent). Une comparaison de message aurait pu suffire ici, mais un type dédié rend la
 * distinction robuste à un futur message d'erreur qui contiendrait par coïncidence la
 * chaîne 'commune-introuvable' — et documente l'intention au premier coup d'œil. Sans
 * cette distinction, une panne réseau à Bordeaux dirait à l'utilisateur que Bordeaux
 * n'est pas en France.
 */
class CommuneIntrouvableError extends Error {
  constructor() {
    super('commune-introuvable');
    this.name = 'CommuneIntrouvableError';
  }
}

async function defaultLoadDataset(pt: LonLat): Promise<Dataset> {
  const commune = await communeAt(pt[1], pt[0]);
  if (!commune) throw new CommuneIntrouvableError();
  const cached = await readCache(commune.code);
  if (cached) return buildDataset(cached.insee, cached.millesime, cached.features);
  const { features, millesime } = await downloadCommune(commune.code);
  await writeCache({ insee: commune.code, millesime, fetchedAt: Date.now(), features });
  return buildDataset(commune.code, millesime, features);
}

export function createMode(bridge: IdBridge, deps: Partial<ModeDeps> = {}): CadastreMode {
  const loadDataset = deps.loadDataset ?? defaultLoadDataset;
  const communeName = deps.communeName ?? (async (pt: LonLat) =>
    (await communeAt(pt[1], pt[0]))?.nom ?? '');
  const notify = deps.notify ?? ((m: string) => console.warn('[cadastre-id]', m));

  let enabled = false;
  let overlay: Overlay | null = null;
  let dataset: Dataset | null = null;
  let loading: Promise<void> | null = null;

  const ensureDataset = (pt: LonLat): Promise<void> => {
    if (dataset) return Promise.resolve();
    loading ??= loadDataset(pt)
      .then(d => { dataset = d; })
      .catch(err => {
        const reason = err instanceof CommuneIntrouvableError ? 'commune-introuvable' : 'reseau';
        notify(refusalMessage(reason));
      })
      .finally(() => { loading = null; });
    return loading;
  };

  // Fermée sur `dataset` : composeAt() lit exactement l'état courant, jamais un
  // instantané pris à un autre moment. C'est ce qui garantit que hoverAt et clickAt,
  // qui appellent tous deux `compose(pt)` et rien d'autre, ne peuvent pas diverger :
  // aucun cache de composition, aucun raccourci propre au clic ou au survol.
  const compose = (pt: LonLat): Composition | null => {
    if (!dataset) return null;
    return composeAt(pt, {
      polys: dataset.polys,
      absorption: dataset.absorption,
      byId: dataset.byId,             // précalculé en Task 12 ; jamais reconstruit par appel
      lightIndex: dataset.lightIndex, // idem : sans lui, anchorOf balaie et les orphelines se tronquent
      polyAt: dataset.polyAt,         // indispensable : le survol balaierait sinon tous les polygones par frame
      // edgeIndex n'existe plus sur Dataset ni sur ComposeInput (retiré : 82,6 Mo
      // retenus pour rien, cf. cadastre/dataset.ts) — absent ici volontairement.
    });
  };

  return {
    isEnabled: () => enabled,

    enable() {
      if (enabled) return;
      enabled = true;
      overlay = createOverlay(bridge);
      const [[minLon, minLat], [maxLon, maxLat]] = bridge.mapExtent();
      const centre: LonLat = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
      void ensureDataset(centre);
    },

    disable() {
      enabled = false;
      // destroy(), pas hide() : un calque désactivé doit disparaître du DOM, pas
      // seulement se vider — sinon il continuerait de se redessiner sur un déplacement
      // de carte pendant que le mode est censé être éteint.
      overlay?.destroy();
      overlay = null;
    },

    whenReady: () => loading ?? Promise.resolve(),

    hoverAt(pt) {
      if (!enabled || !overlay) return;
      const r = compose(pt);
      // r === null (dataset pas encore chargé) et r.ok === false (refus de composition,
      // qui ne porte jamais de ring) empruntent le même chemin : rien à montrer de
      // vrai, donc on efface plutôt que de laisser un contour périmé à l'écran.
      if (!r || !r.ok) { overlay.hide(); return; }
      const conflit = overlapsExisting(r.ring, bridge.buildingsNear(bridge.mapExtent()));
      overlay.show(r.ring, conflit ? 'refus' : 'ok');
    },

    hoverEnd() {
      if (!enabled || !overlay) return;
      overlay.hide();
    },

    async clickAt(pt) {
      if (!enabled) return;
      await ensureDataset(pt);
      const r = compose(pt);
      if (!r) return;
      if (!r.ok) {
        // 'aucun-batiment' n'est pas notifié : cliquer en dehors de tout bâtiment
        // cadastre est le cas le plus fréquent d'un clic hors cible, pas une erreur.
        if (r.reason !== 'aucun-batiment') notify(refusalMessage(r.reason));
        return;
      }
      if (overlapsExisting(r.ring, bridge.buildingsNear(bridge.mapExtent()))) {
        notify(refusalMessage('batiment-existant'));
        return;
      }
      const snapped = snapToExistingNodes(
        r.ring, bridge.nodesNear(pt, DEFAULT_SNAP_TOLERANCE_M * 10), DEFAULT_SNAP_TOLERANCE_M);
      const tags = buildingTags({ isolatedLight: r.isolatedLight, millesime: dataset!.millesime });

      bridge.createBuilding(snapped.ring, tags, snapped.reused);
      bridge.prefillChangeset(changesetComment(await communeName(pt)));
      overlay?.hide();
    },
  };
}
