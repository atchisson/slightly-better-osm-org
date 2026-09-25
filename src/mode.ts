import { composeAt } from './compose';
import type { Composition } from './compose';
import { buildDataset, type Dataset } from './cadastre/dataset';
import { downloadCommune, downloadPiscinesForYear } from './cadastre/download';
import { readCache, writeCache } from './cadastre/store';
import { communeAt } from './cadastre/insee';
import { overlapsExisting } from './conflation/overlap';
import { snapToExistingNodes, planInsertions, DEFAULT_SNAP_TOLERANCE_M } from './conflation/snap';
import { dilatedExtent } from './geometry/edges';
import { buildingTags, poolTags, changesetComment, changesetSource } from './tagging/tags';
import { createOverlay, type Overlay } from './ui/overlay';
import { refusalMessage } from './ui/messages';
import type { IdBridge } from './bridge/types';
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

async function defaultLoadDataset(pt: LonLat): Promise<Dataset> {
  const commune = await communeAt(pt[1], pt[0]);
  if (!commune) throw new CommuneIntrouvableError();
  const cached = await readCache(commune.code);
  if (cached) {
    // Une entrée écrite avant la prise en charge des piscines n'en porte aucune. Sans
    // ce complément, la fonctionnalité n'existerait pas — en silence — pour quiconque
    // a déjà utilisé le greffon sur cette commune, et jusqu'à l'expiration du cache.
    let piscines = cached.piscines;
    if (piscines === undefined) {
      piscines = await downloadPiscinesForYear(cached.insee, cached.millesime);
      console.log(
        `[cadastre-id] ${piscines.length} piscine(s) ajoutées au cache de ${cached.insee} ` +
        '(entrée écrite avant leur prise en charge).',
      );
      void writeCache({ ...cached, piscines }).catch(() => { /* confort, jamais bloquant */ });
    }
    return buildDataset(cached.insee, cached.millesime, cached.features, piscines);
  }
  const { features, piscines, millesime } = await downloadCommune(commune.code);
  // Le cache est un confort, jamais une condition du chargement : il est délibérément
  // HORS du chemin de retour. `await writeCache(...)` faisait échouer tout le
  // chargement APRÈS un téléchargement réussi si IndexedDB refusait l'écriture — un
  // dépassement de quota, vraisemblable sur Paris ou Marseille et leur centaine de Mo
  // de features sérialisées — et la personne lisait alors « vérifiez votre connexion »
  // alors que le réseau avait parfaitement fonctionné.
  void writeCache({ insee: commune.code, millesime, fetchedAt: Date.now(), features, piscines })
    .catch(err => console.warn(
      '[cadastre-id] mise en cache impossible (les données restent utilisables, elles seront ' +
      'retéléchargées à la prochaine session) :', err));
  return buildDataset(commune.code, millesime, features, piscines);
}

export function createMode(bridge: IdBridge, deps: Partial<ModeDeps> = {}): CadastreMode {
  const loadDataset = deps.loadDataset ?? defaultLoadDataset;
  const communeCodeAt = deps.communeCodeAt ?? (async (pt: LonLat) =>
    (await communeAt(pt[1], pt[0]))?.code ?? null);
  const communeName = deps.communeName ?? (async (pt: LonLat) =>
    (await communeAt(pt[1], pt[0]))?.nom ?? '');
  const notify = deps.notify ?? ((m: string) => console.warn('[cadastre-id]', m));

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
        notifyFailure(err instanceof CommuneIntrouvableError ? 'commune-introuvable' : 'reseau');
      })
      .finally(() => { if (loading === p) loading = null; });
    loading = p;
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
    // Revue finale : clickAt ne passe plus par ici pour attendre — il refuse tout court
    // quand un chargement est en vol (I3, « jamais de création à l'aveugle »). Les
    // appelants restants sont `enable()` et le clic qui RELANCE un chargement après un
    // échec ; la garde reste juste pour eux : ne jamais lancer un second chargement
    // par-dessus un chargement déjà en vol.
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
      const conflit = overlapsExisting(r.ring, bridge.buildingsNear(bridge.mapExtent()));
      overlay.show(r.ring, conflit ? 'refus' : 'ok');
    },

    hoverEnd() {
      if (!enabled || !overlay) return;
      overlay.hide();
    },

    async clickAt(pt) {
      if (!enabled) return;

      // Jamais de création à l'aveugle.
      //
      // Cette fonction attendait `ensureDataset(pt)`. Or pendant toute cette attente,
      // `hoverAt` cachait l'aperçu (`loading !== null`) : le bâtiment finalement créé
      // n'avait JAMAIS été prévisualisé. La spec est explicite (§5) — l'aperçu au survol
      // est le seul garde-fou contre une annexion erronée ; créer sans lui, c'est créer
      // sans garde-fou. Et `enabled` n'était pas revérifié après l'attente : couper le
      // mode pendant ce délai n'empêchait pas la création.
      //
      // On préfère donc « ne jamais créer à l'aveugle » à « ne jamais perdre un clic » :
      // si un chargement est en vol, on ne crée rien et on le dit ; la personne
      // recliquera quand elle verra un contour. La contrepartie est acquise dès
      // l'entrée : passé ces deux gardes, plus AUCUNE attente ne précède
      // `createBuilding` — il n'y a donc plus de fenêtre où l'état pourrait changer
      // entre la décision et la création, et plus rien à revérifier après un await.
      if (loading !== null) { notify(refusalMessage('chargement-en-cours')); return; }
      if (!dataset) {
        // Rien de chargé et rien en vol : le premier chargement a échoué, ou n'a jamais
        // eu lieu. Le clic le relance (sans l'attendre) plutôt que de ne rien faire du
        // tout, ce qui laisserait un mode définitivement inerte après une panne réseau.
        void ensureDataset(pt);
        notify(refusalMessage('chargement-en-cours'));
        return;
      }

      const r = compose(pt);
      if (!r) return;
      if (!r.ok) {
        // 'aucun-batiment' n'est pas notifié : cliquer en dehors de tout bâtiment
        // cadastre est le cas le plus fréquent d'un clic hors cible, pas une erreur.
        if (r.reason !== 'aucun-batiment') notify(refusalMessage(r.reason));
        return;
      }
      // Un objet ne fait doublon qu'avec un objet de même nature. Sans ce filtre, une
      // piscine serait déclarée déjà cartographiée à cause de la maison qui la borde,
      // et une piscine déjà présente dans OSM passerait inaperçue.
      const memeNature = (b: { kind?: string }): boolean =>
        (b.kind === 'piscine') === r.isPiscine;
      const existants = bridge.buildingsNear(bridge.mapExtent()).filter(memeNature);
      if (overlapsExisting(r.ring, existants)) {
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
      // Capturé AVANT la création : un rechargement de commune peut remplacer `dataset`
      // pendant l'attente du nom de commune, et l'attribution doit rester celle du jeu
      // de données qui a réellement produit cette géométrie.
      const millesime = dataset.millesime;
      const tags = r.isPiscine
        ? poolTags(millesime)
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
          .filter(memeNature),
        DEFAULT_SNAP_TOLERANCE_M);

      bridge.createBuilding(snapped.ring, tags, snapped.reused, insertions);
      overlay?.hide();

      // Après la création seulement : le préremplissage du changeset est une obligation
      // d'attribution (Licence Ouverte, §7), pas une condition de création. Il ne doit
      // ni retarder l'effet visible du clic, ni être annulé parce que le mode a été
      // coupé entre-temps — le bâtiment, lui, existe. Un échec de résolution du nom ne
      // doit pas davantage faire échouer la promesse de clickAt après coup.
      const nom = await communeName(pt).catch(() => '');
      bridge.prefillChangeset(changesetComment(nom), changesetSource(millesime));
    },
  };
}
