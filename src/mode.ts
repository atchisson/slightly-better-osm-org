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

/**
 * Délai avant de recharger après un déplacement de carte : « quelque chose de l'ordre
 * de la demi-seconde après que le mouvement se stabilise » (revue). Un déplacement de
 * carte se traduit typiquement par une rafale d'événements move.* ; ce délai laisse la
 * rafale se terminer avant de résoudre la commune, plutôt que d'interroger l'API à
 * chaque événement intermédiaire.
 */
const RELOAD_DEBOUNCE_MS = 500;

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
  let stopMapMove: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Vrai pendant qu'un rechargement déclenché par un déplacement de carte est en vol
  // (voir scheduleReload). hoverAt le consulte pour ne jamais dessiner un contour qui
  // viendrait de l'ancienne commune pendant que la nouvelle se charge — « cacher
  // pendant l'échange est le comportement honnête » (revue).
  let reloading = false;

  /**
   * Démarre un chargement, l'enregistre dans `loading` (que whenReady() attend et que
   * ce module utilise pour écarter un résultat périmé), et n'applique son résultat que
   * si aucun chargement plus récent ne l'a entre-temps remplacé. Partagé par le premier
   * chargement (ensureDataset) et par le rechargement au franchissement de frontière
   * (scheduleReload) : les deux chemins doivent se protéger de la même façon contre une
   * résolution tardive qui écraserait un jeu de données plus récent avec un plus ancien.
   */
  const startLoad = (pt: LonLat, apply: (d: Dataset) => void): Promise<void> => {
    const p: Promise<void> = loadDataset(pt)
      .then(d => { if (loading === p) apply(d); })
      .catch(err => {
        if (loading !== p) return; // une charge plus récente a déjà pris le relais
        const reason = err instanceof CommuneIntrouvableError ? 'commune-introuvable' : 'reseau';
        notify(refusalMessage(reason));
      })
      .finally(() => { if (loading === p) loading = null; });
    loading = p;
    return p;
  };

  const ensureDataset = (pt: LonLat): Promise<void> => {
    if (dataset) return Promise.resolve();
    if (loading !== null) return loading;
    return startLoad(pt, d => { dataset = d; });
  };

  const centreOf = (extent: [LonLat, LonLat]): LonLat => {
    const [[minLon, minLat], [maxLon, maxLat]] = extent;
    return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  };

  /**
   * Spec §3.3 : « Rechargement quand la carte change de commune ». Sans ce
   * rechargement, une fois le premier jeu de données chargé, ensureDataset() ne charge
   * plus jamais rien d'autre (`if (dataset) return Promise.resolve();`) : franchir une
   * frontière de commune — un événement ordinaire, les communes françaises sont petites
   * — fait échouer tout survol et tout clic avec « aucun bâtiment », silencieusement,
   * exactement ce qu'un endroit réellement vide donnerait.
   *
   * Débattu sur `bridge.onMapMove`, avec un débounce : un déplacement de carte produit
   * une rafale d'événements, et on ne résout la commune qu'une fois le mouvement
   * stabilisé — jamais à chaque frame, jamais depuis hoverAt.
   */
  const scheduleReload = (): void => {
    if (!enabled) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!enabled || !dataset) return; // rien de chargé encore : le premier chargement s'en charge
      reloading = true;
      overlay?.hide(); // le contour affiché appartient à l'ancienne commune : honnête de l'effacer
      void startLoad(centreOf(bridge.mapExtent()), d => {
        if (d.insee !== dataset?.insee) dataset = d;
      }).finally(() => { reloading = false; });
    }, RELOAD_DEBOUNCE_MS);
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
      void ensureDataset(centreOf(bridge.mapExtent()));
      // Le rechargement au franchissement de frontière (spec §3.3) : voir
      // scheduleReload(). Désabonné dans disable(), comme le fait déjà createOverlay()
      // pour son propre abonnement à onMapMove — même discipline, même contrat.
      stopMapMove = bridge.onMapMove(scheduleReload);
    },

    disable() {
      enabled = false;
      if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
      stopMapMove?.();
      stopMapMove = null;
      // destroy(), pas hide() : un calque désactivé doit disparaître du DOM, pas
      // seulement se vider — sinon il continuerait de se redessiner sur un déplacement
      // de carte pendant que le mode est censé être éteint.
      overlay?.destroy();
      overlay = null;
    },

    whenReady: () => loading ?? Promise.resolve(),

    hoverAt(pt) {
      if (!enabled || !overlay) return;
      // Un rechargement de commune est en vol : le dataset actuel appartient encore à
      // l'ancienne commune (il ne sera remplacé qu'à la résolution de startLoad), donc
      // tout contour qu'il produirait maintenant serait potentiellement celui d'un
      // endroit que la carte a déjà quitté. Cacher plutôt que risquer de montrer faux.
      if (reloading) { overlay.hide(); return; }
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
