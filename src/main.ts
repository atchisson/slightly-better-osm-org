import {
  captureContext, makeBridge, raceCaptureAgainstTimeout, CAPTURE_TIMEOUT_MS,
  SURFACE_READY_TIMEOUT_MS, DISABLE_HINT, looksLikeIdDocument,
} from './bridge/capture';
import { createMode } from './mode';
import { createCtrlShortcut } from './ui/shortcut';
import type { LonLat } from './geometry/types';

const log = (...a: unknown[]) => console.log('[cadastre-id]', ...a);

// Tout premier acte du script, avant le moindre `await` — voir le spike du
// 2026-09-23 (spike/probe.user.js), qui journalisait son injection en tout premier
// pour cette même raison, et qui est resté diagnosticable dès le premier essai grâce
// à ça. Sans cette ligne, un script qui ne tourne jamais dans un document donné et un
// script qui tourne mais reste bloqué sur la capture (voir le chien de garde plus bas)
// sont indiscernables : silence dans les deux cas. iD tourne dans une iframe servie à
// `/id` ; le script cible aussi `/edit` (le document parent). Savoir dans lequel des
// deux ce point a été atteint est le premier réflexe de débogage.
log('injecté —', location.pathname, window === window.top ? '(cadre principal)' : '(iframe)');

void (async () => {
  const capture = await raceCaptureAgainstTimeout(captureContext(), CAPTURE_TIMEOUT_MS);
  if (capture.status === 'timed-out') {
    // Troisième lancement réel : ce chien de garde s'arme dans TOUT document qui
    // matche `@match`, et `window.iD` n'est jamais assigné dans le document `/edit` —
    // iD vit dans l'iframe `/id`, `/edit` ne fait que l'héberger (spike du
    // 2026-09-23). Sans ce test, `/edit` atteignait cette échéance à CHAQUE
    // chargement de l'éditeur et affichait un avertissement de rupture structurelle
    // qui n'en était pas une : un faux positif systématique, sur le document où le
    // greffon n'a jamais eu la moindre chance de tourner. `looksLikeIdDocument`
    // (src/bridge/capture.ts) distingue les deux : seul un document qui porte la
    // marque HTML de l'éditeur (`#id-container`) justifie encore l'avertissement.
    if (!looksLikeIdDocument(document)) {
      // Délibérément `console.log`, pas `console.warn` : rien n'est cassé ici, ce
      // document n'a jamais été candidat. Le dire une fois plutôt que se taire
      // entièrement garde le même bénéfice diagnostique que la ligne d'injection
      // ci-dessus — silence total et « je tourne, je me tais volontairement »
      // doivent rester distinguables en console.
      console.log(
        "[cadastre-id] inactif : ce document ne porte pas la marque de l'éditeur iD " +
        "(#id-container absent) ; rien à faire ici, l'éditeur vit dans l'autre cadre.",
      );
      return;
    }
    console.warn(
      `[cadastre-id] désactivé : le contexte iD n'a jamais été capturé (${CAPTURE_TIMEOUT_MS / 1000} s ` +
      `écoulées) ; le greffon reste inactif, l'éditeur n'est pas affecté. ${DISABLE_HINT}`,
    );
    return;
  }

  let bridge;
  try {
    bridge = makeBridge(capture.context);
  } catch (err) {
    console.warn('[cadastre-id] désactivé :', (err as Error).message, `— ${DISABLE_HINT}`);
    return;
  }

  // L'amorçage d'osm.org est `iD.coreContext().containerNode(container).init()`, une
  // seule chaîne synchrone. captureContext() résout dès l'appel de coreContext() — AVANT
  // `.init()`. Sans cette attente, tout ce qui suit (mode, écouteurs, bouton) pouvait
  // s'installer avant que la carte n'ait fini de se construire : `surfaceNode()`
  // retombait alors sur son repli container-entier, décalant l'origine de la projection
  // pour toute la session, en silence. Voir bridge/types.ts (whenSurfaceReady) et
  // bridge/capture.ts (waitForSurface) pour le détail. Rien n'est câblé — ni le mode, ni
  // les écouteurs, ni le bouton — avant que ce signal ne soit au vert, exactement comme
  // pour les deux autres chemins de désactivation ci-dessus : si l'attente expire,
  // l'utilisatrice ne voit tout simplement jamais apparaître le bouton.
  const surfaceReady = await bridge.whenSurfaceReady();
  if (!surfaceReady) {
    console.warn(
      "[cadastre-id] désactivé : la surface de carte n'est jamais apparue dans le conteneur " +
      `d'iD (${SURFACE_READY_TIMEOUT_MS / 1000} s écoulées) ; le greffon reste inactif, ` +
      `l'éditeur n'est pas affecté. ${DISABLE_HINT}`,
    );
    return;
  }

  const mode = createMode(bridge, { notify: m => window.alert(m) });

  // `bridge.surfaceNode()` et rien d'autre : l'élément dont le coin EST l'origine de
  // `bridge.project()`. Ce fichier faisait auparavant
  // `container.querySelector('svg.surface') ?? container` — un sélecteur interne d'iD
  // hors de `src/bridge/` (contre le §4 de la spec), avec un repli MUET qui changeait
  // l'origine des coordonnées sans rien dire. La connaissance est maintenant dans le
  // bridge, qui dit son repli en console, et l'overlay lit la même source : il ne peut
  // plus y avoir deux origines qui divergent.
  const surface = bridge.surfaceNode();

  // offsetX/offsetY sont relatifs à e.target, pas forcément à `surface` : dans un SVG,
  // e.target est souvent un élément descendant (un <path>, un <g>...) dont l'origine
  // peut différer de celle de la surface. On mesure donc l'origine de `surface`
  // elle-même via getBoundingClientRect() et on convertit depuis les coordonnées
  // écran absolues (clientX/clientY), qui elles ne dépendent jamais de la cible.
  const toLonLat = (e: MouseEvent): LonLat => {
    const rect = surface.getBoundingClientRect();
    return bridge.invert([e.clientX - rect.left, e.clientY - rect.top]);
  };

  let frame = 0;
  surface.addEventListener('mousemove', (e) => {
    if (!mode.isEnabled()) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => mode.hoverAt(toLonLat(e as MouseEvent)));
  });

  // Le curseur qui quitte la carte est un des chemins de sortie de l'overlay (voir
  // src/mode.ts) : sans ce signal, le dernier contour survolé resterait affiché,
  // pointant vers un endroit que le curseur a quitté.
  surface.addEventListener('mouseleave', () => {
    if (!mode.isEnabled()) return;
    cancelAnimationFrame(frame);
    mode.hoverEnd();
  });

  surface.addEventListener('click', (e) => {
    if (!mode.isEnabled()) return;
    void mode.clickAt(toLonLat(e as MouseEvent));
  });

  // Le raccourci Ctrl est le SEUL déclencheur du greffon : il n'y a pas de bouton.
  // Maintenir Ctrl arme le mode le temps de l'appui, et seulement quand une couche
  // cadastre est affichée dans iD.
  //
  // Cette condition n'a rien à voir avec l'exactitude du tracé : la géométrie vient de
  // l'API GeoJSON du cadastre, jamais de la couche affichée, et le greffon produirait
  // le même bâtiment sur un fond satellite. Ce qu'elle garantit, c'est que
  // l'utilisatrice REGARDE la source qu'elle trace — ce qu'on exige d'un déclencheur
  // sans affordance visible.
  //
  // `cadastreVisible()` rend `null` quand `context.background()` n'a pas la forme
  // attendue. Tant qu'un bouton existait, ce cas se contentait de retirer le
  // raccourci ; maintenant qu'il est l'unique porte d'entrée, l'impossibilité de lire
  // la couche désactive le greffon entier — et le dit, plutôt que de laisser une
  // interface muette qui a l'air de fonctionner.
  if (bridge.cadastreVisible() === null) {
    console.warn(
      "[cadastre-id] désactivé : impossible de lire la couche de fond affichée " +
      "(context.background() absent ou de forme inattendue). Le raccourci Ctrl est le " +
      `seul déclencheur du greffon et ne peut pas s'armer sans elle. ${DISABLE_HINT}`,
    );
    return;
  }

  createCtrlShortcut({
    isEnabled: () => mode.isEnabled(),
    // Relu à chaque appui : la couche s'allume et s'éteint en cours de session.
    allowed: () => bridge.cadastreVisible() === true,
    setArmed: on => (on ? mode.enable() : mode.disable()),
  });

  // Sans bouton, cette ligne est la seule chose qui dise comment déclencher le
  // greffon. Elle nomme donc le geste, pas seulement son état.
  log('prêt — maintenir Ctrl sur la carte (couche cadastre affichée) pour armer');
})();
