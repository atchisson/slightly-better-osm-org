import { composeAt } from './compose';
import type { Composition } from './compose';
import { buildDataset, type Dataset } from './cadastre/dataset';
import { downloadCommune, downloadSurfacesForYear } from './cadastre/download';
import { readCache, writeCache } from './cadastre/store';
import { communeAt } from './cadastre/insee';
import { overlapsExisting } from './conflation/overlap';
import { snapToExistingNodes, planInsertions, DEFAULT_SNAP_TOLERANCE_M } from './conflation/snap';
import { dilatedExtent } from './geometry/edges';
import { buildingTags, poolTags, surfaceTags, changesetComment, changesetSource } from './tagging/tags';
import { createOverlay, type Overlay } from './ui/overlay';
import { createLoadingBanner, type LoadingBanner } from './ui/loading';
import { refusalMessage } from './ui/messages';
import type { IdBridge, HoleSpec } from './bridge/types';
import type { LonLat } from './geometry/types';

export interface ModeDeps {
  loadDataset(pt: LonLat): Promise<Dataset>;
  /**
   * Code INSEE de la commune sous un point, ou null hors couverture.
   *
   * Exposé séparément de `loadDataset` pour qu'on puisse répondre à « la carte a-t-elle
   * changé de commune ? » sans payer un chargement complet. C'est une requête JSON de
   * quelques octets ; `loadDataset`, lui, coûte une résolution réseau, ~20 Mo de
   * désérialisation IndexedDB et la reconstruction du jeu de données (1 142 ms mesurés
   * sur Angers, bien plus sur Marseille).
   */
  communeCodeAt(pt: LonLat): Promise<string | null>;
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

/**
 * Âge au-delà duquel un clic mémorisé pendant un chargement n'est plus rejoué : la
 * personne a sans doute renoncé, et créer un bâtiment une minute plus tard serait une
 * surprise, pas un service.
 */
const ATTENTE_MAX_MS = 60_000;

async function defaultLoadDataset(pt: LonLat): Promise<Dataset> {
  const commune = await communeAt(pt[1], pt[0]);
  if (!commune) throw new CommuneIntrouvableError();
  const cached = await readCache(commune.code);
  if (cached) {
    // Une entrée écrite avant la prise en charge des surfaces n'en porte aucune (ou
    // seulement des piscines). Sans ce complément, la fonctionnalité n'existerait pas —
    // en silence — pour quiconque a déjà utilisé le greffon sur cette commune.
    let surfaces = cached.surfaces;
    if (surfaces === undefined) {
      surfaces = await downloadSurfacesForYear(cached.insee, cached.millesime);
      console.log(`[sb-osm] ${surfaces.length} surface(s) ajoutées au cache de ${cached.insee}.`);
      // Un complément vide est peut-être une panne : on ne l'écrit pas, pour retenter
      // au prochain chargement plutôt que de figer « aucune surface » jusqu'à expiration.
      if (surfaces.length > 0) {
        const { piscines: _ancien, ...reste } = cached;
        void writeCache({ ...reste, surfaces }).catch(() => { /* confort, jamais bloquant */ });
      }
    }
    return buildDataset(cached.insee, cached.millesime, cached.features, surfaces);
  }
  const { features, surfaces, millesime } = await downloadCommune(commune.code);
  // Le cache est un confort, jamais une condition du chargement : il est délibérément
  // HORS du chemin de retour. `await writeCache(...)` faisait échouer tout le
  // chargement APRÈS un téléchargement réussi si IndexedDB refusait l'écriture — un
  // dépassement de quota, vraisemblable sur Paris ou Marseille et leur centaine de Mo
  // de features sérialisées — et la personne lisait alors « vérifiez votre connexion »
  // alors que le réseau avait parfaitement fonctionné.
  void writeCache({ insee: commune.code, millesime, fetchedAt: Date.now(), features, surfaces })
    .catch(err => console.warn(
      '[sb-osm] mise en cache impossible (les données restent utilisables, elles seront ' +
      'retéléchargées à la prochaine session) :', err));
  return buildDataset(commune.code, millesime, features, surfaces);
}

export function createMode(bridge: IdBridge, deps: Partial<ModeDeps> = {}): CadastreMode {
  const loadDataset = deps.loadDataset ?? defaultLoadDataset;
  const communeCodeAt = deps.communeCodeAt ?? (async (pt: LonLat) =>
    (await communeAt(pt[1], pt[0]))?.code ?? null);
  const communeName = deps.communeName ?? (async (pt: LonLat) =>
    (await communeAt(pt[1], pt[0]))?.nom ?? '');
  const notify = deps.notify ?? ((m: string) => console.warn('[sb-osm]', m));

  let enabled = false;
  let overlay: Overlay | null = null;
  let dataset: Dataset | null = null;
  let loading: Promise<void> | null = null;
  let stopMapMove: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Dernière raison d'échec de chargement notifiée, ou null si le dernier chargement a
  // réussi. Sert uniquement à ne pas répéter la même notification en boucle (voir
  // startLoad) — jamais consultée pour décider quoi que ce soit d'autre.
  let lastFailureReason: 'commune-introuvable' | 'reseau' | null = null;
  /**
   * INSEE visé par le rechargement en vol, ou null si aucun.
   *
   * Sans lui, un second panoramique À L'INTÉRIEUR de la commune qu'on est en train de
   * charger relancerait un chargement identique : `dataset.insee` vaut encore celui de
   * la commune QUITTÉE tant que le chargement n'a pas abouti, donc la comparaison
   * « même commune ? » répondrait faux une seconde fois.
   */
  let loadingInsee: string | null = null;
  /**
   * Le dernier clic donné pendant un chargement, rejoué à sa fin. Un seul : deux clics
   * successifs visent le même objet, et rejouer les deux créerait un doublon.
   * Il survit à disable() — le mode n'est armé que tant que Ctrl est enfoncé, et la
   * personne qui relâche Ctrl avant la fin du chargement a bien cliqué.
   */
  let attente: { pt: LonLat; etendue: [LonLat, LonLat]; depuis: number } | null = null;
  let banniere: LoadingBanner | null = null;

  /**
   * Notifie une panne, sauf si c'est exactement la même que la précédente.
   *
   * Un rechargement déclenché par onMapMove peut se représenter toutes les 500 ms près
   * d'une frontière de commune ou pendant une panne réseau : sans cette garde, chaque
   * tentative identique rouvrirait `notify` (window.alert en production), un dialogue
   * bloquant à répétition qui rendrait le greffon inutilisable (revue, deuxième passe).
   * Une raison qui CHANGE notifie quand même — ce n'est plus la même panne.
   */
  const notifyFailure = (reason: 'commune-introuvable' | 'reseau'): void => {
    if (reason === lastFailureReason) return;
    lastFailureReason = reason;
    notify(refusalMessage(reason));
  };

  /**
   * Démarre un chargement, l'enregistre dans `loading` (que whenReady() attend et que
   * ce module utilise pour écarter un résultat périmé), et n'applique son résultat que
   * si aucun chargement plus récent ne l'a entre-temps remplacé. Partagé par le premier
   * chargement (ensureDataset) et par le rechargement au franchissement de frontière
   * (scheduleReload) : les deux chemins doivent se protéger de la même façon contre une
   * résolution tardive qui écraserait un jeu de données plus récent avec un plus ancien.
   *
   * Revue (deuxième passe) : `loading` est la SEULE source de vérité sur « un
   * chargement est-il en vol ». Une première version de ce correctif ajoutait un
   * booléen `reloading` séparé pour que hoverAt puisse le consulter sans await — mais ce
   * booléen n'avait pas la même garde d'identité que `loading`, et un rechargement lent
   * qui se termine après un plus rapide le remettait à faux pendant que le plus rapide
   * était encore réellement en vol. Supprimé : hoverAt et ensureDataset lisent
   * maintenant directement `loading`, qui a toujours eu la bonne garantie.
   */
  const startLoad = (pt: LonLat, apply: (d: Dataset) => void): Promise<void> => {
    const p: Promise<void> = loadDataset(pt)
      .then(d => {
        // Un chargement qui réussit, même s'il est périmé par un plus récent (et donc
        // pas appliqué ci-dessous), prouve que le réseau et l'API répondent : la
        // prochaine panne, s'il y en a une, mérite une notification fraîche.
        lastFailureReason = null;
        if (loading === p) apply(d);
      })
      .catch(err => {
        if (loading !== p) return; // une charge plus récente a déjà pris le relais
        attente = null; // pas de données, donc rien à rejouer : la panne est signalée une fois
        notifyFailure(err instanceof CommuneIntrouvableError ? 'commune-introuvable' : 'reseau');
      })
      .finally(() => { if (loading === p) loading = null; rejouerSiPret(); });
    loading = p;
    majBanniere();
    return p;
  };

  const ensureDataset = async (pt: LonLat): Promise<void> => {
    // Un chargement (initial OU un rechargement déclenché par un changement de
    // commune) peut être remplacé par un autre avant de se résoudre (la garde
    // `if (loading === p)` de startLoad, ci-dessus, assure qu'un résultat périmé
    // n'écrase jamais un dataset plus récent). Cette boucle attend jusqu'à ce
    // qu'AUCUN chargement ne soit plus en vol — pas seulement celui vu au premier
    // passage — sinon un clic pendant une CHAÎNE de rechargements qui se chevauchent
    // composerait contre des données pas encore à jour.
    //
    // Revue (deuxième passe) : avant ce correctif, cette fonction retournait
    // immédiatement dès que `dataset` existait, MÊME si `loading` pointait vers un
    // rechargement en cours pour une AUTRE commune.
    //
    // clickAt ne passe plus par ici pour attendre : il mémorise son clic (`attente`) et
    // le rejoue à la fin du chargement. Les appelants restants sont `enable()` et le clic
    // qui RELANCE un chargement après un échec ; la garde reste juste pour eux : ne
    // jamais lancer un second chargement par-dessus un chargement déjà en vol.
    while (loading !== null) await loading;
    if (dataset) return;
    await startLoad(pt, d => { dataset = d; });
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
      void maybeReload();
    }, RELOAD_DEBOUNCE_MS);
  };

  /**
   * Résout la commune D'ABORD, ne recharge QUE si elle a changé.
   *
   * Avant ce correctif, le débounce lançait directement `loadDataset` et ne comparait
   * l'INSEE qu'APRÈS coup, pour jeter le résultat s'il était identique. Autrement dit,
   * chaque panoramique et chaque zoom — `scheduleReload` est branché sur `move`, qui
   * couvre les deux — payait la résolution réseau, ~20 Mo de désérialisation IndexedDB
   * puis `buildDataset` (index des arêtes, composantes, grille : 1 142 ms mesurés sur
   * Angers, bien plus sur Marseille), pour presque toujours rien. Et pendant tout ce
   * temps `loading !== null`, donc `hoverAt` CACHAIT l'aperçu : chaque déplacement
   * éteignait le survol pendant une à trois secondes.
   *
   * La résolution de commune coûte, elle, une requête JSON de quelques octets.
   */
  const maybeReload = async (): Promise<void> => {
    if (!enabled || !dataset) return; // rien de chargé encore : le premier chargement s'en charge

    const pt = centreOf(bridge.mapExtent());
    let code: string | null;
    try {
      code = await communeCodeAt(pt);
    } catch {
      notifyFailure('reseau');
      return;
    }
    // Le mode a pu être coupé, ou le premier chargement échouer, pendant la résolution.
    if (!enabled || !dataset) return;

    if (code === null) { notifyFailure('commune-introuvable'); return; }
    if (code === loadingInsee) {
      // Un rechargement vers cette commune est déjà en vol : rien à relancer.
      lastFailureReason = null;
      return;
    }
    if (code === dataset.insee && loadingInsee === null) {
      // Même commune que le dataset actuel, et rien en vol : rien à recharger, et
      // surtout rien à cacher — c'est le cas de loin le plus fréquent. La résolution a
      // répondu, donc le réseau fonctionne : une prochaine panne mérite d'être annoncée
      // même si elle ressemble à la précédente.
      lastFailureReason = null;
      return;
    }
    // Sinon on laisse passer, même si `code === dataset.insee` : un chargement vers une
    // commune qu'on a quittée entre-temps (`loadingInsee`) est en vol, et `dataset.insee`
    // ne s'est pas encore remis à jour pendant que ce chargement dure. Sans ce
    // rechargement pour `code`, rien ne supplante ce chargement dépassé : il finirait par
    // s'appliquer via `startLoad` (`d.insee !== dataset?.insee` serait vrai, puisque
    // `dataset` pointe encore vers l'ancienne commune) et écraserait silencieusement le
    // dataset alors que la carte est déjà repartie ailleurs (revue, re-revue). Réémettre
    // pour `code` change `loading`, dont la garde d'identité de startLoad écarte alors
    // cette résolution périmée.

    overlay?.hide(); // le contour affiché appartient à l'ancienne commune : honnête de l'effacer
    loadingInsee = code;
    void startLoad(pt, d => {
      if (d.insee !== dataset?.insee) dataset = d;
    }).finally(() => {
      // Ne libère QUE si un rechargement plus récent n'a pas déjà repris la place.
      if (loadingInsee === code) loadingInsee = null;
    });
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
      polysNear: dataset.polysNear,   // idem : sans lui, la protection des sommets partagés balaie la commune
      // edgeIndex n'existe plus sur Dataset ni sur ComposeInput (retiré : 82,6 Mo
      // retenus pour rien, cf. cadastre/dataset.ts) — absent ici volontairement.
    });
  };

  /**
   * Doublon éventuel d'une composition : un objet OSM de MÊME nature qui couvre déjà
   * l'empreinte (cours exclues). Partagé par le survol et le clic pour qu'ils ne
   * divergent jamais — le survol comparait auparavant à tous les objets.
   */
  const doublonDe = (r: Extract<Composition, { ok: true }>, extent: [LonLat, LonLat]) => {
    const existants = bridge.buildingsNear(extent)
      .filter(b => (b.kind ?? 'batiment') === r.nature);
    return overlapsExisting(r.ring, existants, undefined, r.holes);
  };

  /** Le bandeau suit l'état : chargement en vol (mode armé) ou clic en attente. */
  const majBanniere = (): void => {
    const visible = attente !== null || (enabled && loading !== null);
    if (visible) (banniere ??= createLoadingBanner(bridge)).show();
    else banniere?.hide();
  };

  /** La carte a-t-elle quitté la zone du clic (plus d'une demi-étendue) ? */
  const carteDeplacee = (avant: [LonLat, LonLat]): boolean => {
    const [[x0, y0], [x1, y1]] = avant;
    const [cx, cy] = centreOf(bridge.mapExtent());
    const [ax, ay] = centreOf(avant);
    return Math.abs(cx - ax) > (x1 - x0) / 2 || Math.abs(cy - ay) > (y1 - y0) / 2;
  };

  /**
   * Rejoue le clic mémorisé quand les données sont là. Abandonné sans bruit s'il est trop
   * vieux ou si la carte a beaucoup bougé : la personne ne regarde plus cet endroit, et
   * créer là où elle ne regarde pas, c'est créer sans garde-fou.
   */
  const rejouerSiPret = (): void => {
    if (loading !== null || !dataset || !attente) { majBanniere(); return; }
    const a = attente;
    attente = null;
    majBanniere();
    if (Date.now() - a.depuis > ATTENTE_MAX_MS || carteDeplacee(a.etendue)) return;
    void creer(a.pt);
  };

  /**
   * Crée l'objet sous `pt` contre le jeu de données courant. Ne teste pas `enabled` : le
   * rejeu d'un clic mémorisé doit marcher mode désarmé (Ctrl relâché entre-temps).
   *
   * Contrat du clic (spec §1). L'ancienne règle « jamais de création à l'aveugle » —
   * refuser tout clic pendant un chargement, parce que hoverAt cache alors l'aperçu et
   * que l'aperçu est le seul garde-fou contre une annexion erronée (spec §5) — perdait
   * des clics et laissait un mode d'apparence inerte. Elle est assouplie sciemment : le
   * clic est mémorisé (un seul) et rejoué à la fin du chargement, contre des données à
   * jour, à condition que la carte n'ait pas quitté la zone et que l'attente n'ait pas
   * dépassé ATTENTE_MAX_MS. L'écart assumé : l'objet créé au rejeu n'a pas été
   * prévisualisé ; le bandeau de chargement dit pourquoi rien n'apparaît, et la personne
   * peut annuler (Ctrl+Z). Passé les gardes de clickAt, PLUS AUCUNE attente ne précède
   * `createBuilding` : aucune fenêtre où l'état changerait entre décision et création.
   */
  const creer = async (pt: LonLat): Promise<void> => {
    const ds = dataset;
    if (!ds) return;
    const r = compose(pt);
    if (!r) return;
    if (!r.ok) {
      // 'aucun-batiment' n'est pas notifié : cliquer en dehors de tout bâtiment
      // cadastre est le cas le plus fréquent d'un clic hors cible, pas une erreur.
      if (r.reason !== 'aucun-batiment') notify(refusalMessage(r.reason));
      return;
    }
    // Un objet ne fait doublon qu'avec un objet de même nature (voir doublonDe). Sans
    // ce filtre, une piscine serait déclarée déjà cartographiée à cause de la maison
    // qui la borde, et une piscine déjà présente dans OSM passerait inaperçue.
    if (doublonDe(r, bridge.mapExtent())) {
      notify(refusalMessage('batiment-existant'));
      return;
    }
    // Les sommets à recoudre sont les COINS de l'anneau composé, pas le point cliqué :
    // on interroge donc l'emprise de l'anneau, dilatée de la tolérance de recalage.
    // Interroger un rayon autour du clic (ce que faisait la version précédente)
    // ne ramenait aucun candidat sur une maison de taille ordinaire — ses coins sont
    // à 4,56 m du centre sur chaque axe pour une médiane d'Angers, la boîte faisait
    // ±2,70 m en longitude — donc la réutilisation de nœuds ne se déclenchait
    // pratiquement jamais, sans le moindre message. Voir IdBridge.nodesIn.
    const snapped = snapToExistingNodes(
      r.ring,
      bridge.nodesIn(dilatedExtent(r.ring, DEFAULT_SNAP_TOLERANCE_M)),
      DEFAULT_SNAP_TOLERANCE_M);
    // Les cours se recousent aux nœuds existants (le bâtiment de la cour partage ses
    // murs avec le trou) mais sans insertion dans un mur : on ne touche pas aux
    // objets voisins pour une cour.
    const trous: HoleSpec[] = r.holes.map(h => {
      const s = snapToExistingNodes(h, bridge.nodesIn(dilatedExtent(h, DEFAULT_SNAP_TOLERANCE_M)),
        DEFAULT_SNAP_TOLERANCE_M);
      return { ring: s.ring, reused: s.reused };
    });
    // Capturé AVANT la création : un rechargement de commune peut remplacer `dataset`
    // pendant l'attente du nom de commune, et l'attribution doit rester celle du jeu
    // de données qui a réellement produit cette géométrie.
    const millesime = ds.millesime;
    const tags = r.nature === 'piscine' ? poolTags(millesime)
      : r.nature === 'surface' ? surfaceTags(millesime)
      : buildingTags({ isolatedLight: r.isolatedLight, millesime });

    // Un sommet qui n'a trouvé aucun nœud à réutiliser mais qui tombe sur le MUR
    // d'un bâtiment OSM existant y est inséré : les deux bâtiments partagent alors
    // réellement leur paroi, au lieu de deux murs superposés sans nœud commun.
    // C'est la seule opération du greffon qui modifie un objet existant, et elle
    // est bornée à 20 cm — au-delà, on déformerait le bâtiment d'autrui plutôt que
    // de recoudre un mur commun. Voir planInsertions et le README.
    const insertions = planInsertions(
      snapped.ring,
      snapped.reused,
      bridge.buildingsNear(dilatedExtent(snapped.ring, DEFAULT_SNAP_TOLERANCE_M))
        .filter(b => (b.kind ?? 'batiment') === r.nature),
      DEFAULT_SNAP_TOLERANCE_M);

    bridge.createBuilding(snapped.ring, tags, snapped.reused, insertions, trous);
    overlay?.hide();

    // Après la création seulement : le préremplissage du changeset est une obligation
    // d'attribution (Licence Ouverte, §7), pas une condition de création. Il ne doit
    // ni retarder l'effet visible du clic, ni être annulé parce que le mode a été
    // coupé entre-temps — le bâtiment, lui, existe. Un échec de résolution du nom ne
    // doit pas davantage faire échouer la promesse de clickAt après coup.
    const nom = await communeName(pt).catch(() => '');
    bridge.prefillChangeset(changesetComment(nom), changesetSource(millesime));
  };

  return {
    isEnabled: () => enabled,

    enable() {
      if (enabled) return;
      enabled = true;
      // Réactiver le mode, c'est repartir d'une page blanche côté diagnostic. Sans
      // cette remise à zéro, une panne identique à celle de la session précédente
      // serait dédupliquée contre elle (voir notifyFailure) : la personne rallumerait le
      // mode, ne verrait aucun message, et n'aurait qu'un mode qui ne fait rien.
      lastFailureReason = null;
      overlay = createOverlay(bridge);
      void ensureDataset(centreOf(bridge.mapExtent()));
      majBanniere();
      // Le rechargement au franchissement de frontière (spec §3.3) : voir
      // scheduleReload(). Désabonné dans disable(), comme le fait déjà createOverlay()
      // pour son propre abonnement à onMapMove — même discipline, même contrat.
      stopMapMove = bridge.onMapMove(scheduleReload);
    },

    disable() {
      enabled = false;
      lastFailureReason = null;
      // Un rechargement peut être en vol : sa cible ne doit pas survivre à l'extinction
      // du mode, sinon la première résolution de commune après réactivation la
      // comparerait à un chargement qui n'a plus cours.
      loadingInsee = null;
      if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
      stopMapMove?.();
      stopMapMove = null;
      // destroy(), pas hide() : un calque désactivé doit disparaître du DOM, pas
      // seulement se vider — sinon il continuerait de se redessiner sur un déplacement
      // de carte pendant que le mode est censé être éteint.
      overlay?.destroy();
      overlay = null;
      majBanniere(); // reste visible si un clic attend encore son chargement
    },

    whenReady: () => loading ?? Promise.resolve(),

    hoverAt(pt) {
      if (!enabled || !overlay) return;
      // Un chargement (initial ou un rechargement de commune) est en vol : le dataset
      // actuel peut déjà être périmé (il ne sera remplacé, ou confirmé inchangé,
      // qu'à la résolution de startLoad), donc tout contour produit maintenant
      // pourrait appartenir à un endroit que la carte a déjà quitté. Cacher plutôt que
      // risquer de montrer faux. `loading` porte déjà la bonne garantie (garde
      // d'identité dans startLoad) : pas besoin d'un second drapeau qui pourrait
      // diverger de lui — c'était le bug de l'ancien booléen `reloading` (revue,
      // deuxième passe).
      if (loading !== null) { overlay.hide(); return; }
      const r = compose(pt);
      // r === null (dataset pas encore chargé) et r.ok === false (refus de composition,
      // qui ne porte jamais de ring) empruntent le même chemin : rien à montrer de
      // vrai, donc on efface plutôt que de laisser un contour périmé à l'écran.
      if (!r || !r.ok) { overlay.hide(); return; }
      const conflit = doublonDe(r, bridge.mapExtent());
      overlay.show(r.ring, conflit ? 'refus' : 'ok', r.holes);
    },

    hoverEnd() {
      if (!enabled || !overlay) return;
      overlay.hide();
    },

    async clickAt(pt) {
      if (!enabled) return;
      // Pendant un chargement (ou sans jeu de données après une panne), on ne crée rien
      // à l'aveugle mais on ne perd pas le clic : il est mémorisé et rejoué dès que les
      // données sont là, sans message. Une panne précédente est oubliée avant de
      // relancer, pour que sa répétition soit signalée à nouveau.
      if (loading !== null || !dataset) {
        attente = { pt, etendue: bridge.mapExtent(), depuis: Date.now() };
        if (loading === null) { lastFailureReason = null; void ensureDataset(pt); }
        majBanniere();
        return;
      }
      await creer(pt);
    },
  };
}
