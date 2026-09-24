import type { IdBridge, ToolbarSlot } from '../bridge/types';

/** Marge entre le bouton flottant et ce qui le borde (coin de la carte, ou gêneur). */
const GAP_PX = 10;

/** Nombre maximal de descentes avant d'abandonner et de le dire. */
const MAX_DESCENTES = 5;

/** Classes d'un élément, en tolérant le `SVGAnimatedString` des éléments SVG. */
const classesDe = (el: Element): string =>
  typeof el.className === 'string' ? el.className : '';

/**
 * Ce qu'une variante de placement doit savoir faire : montrer l'état armé, et se
 * défaire.
 */
interface Placement {
  setActive(on: boolean): void;
  destroy(): void;
}

/**
 * Le plus bas des éléments qui recouvrent `button`, en coordonnées écran, ou
 * `null` si rien ne le recouvre.
 *
 * On sonde neuf points (les quatre coins, les milieux d'arêtes, le centre) et non
 * le seul centre : un bouton dont le centre est dégagé peut avoir son arête haute
 * encore sous la barre d'outils, et c'est exactement ce qui se voit à l'écran.
 *
 * `elementFromPoint` est le bon outil ici parce qu'il a été vérifié en navigateur
 * que la barre d'outils d'iD le renvoie bien (`div.top-toolbar`, `button.bar-button`,
 * `span.localized-text`) : elle n'est pas traversée par les événements de pointeur.
 * Si elle l'avait été, cette méthode aurait déclaré « libre » un point visuellement
 * caché.
 */
function recouvrementLePlusBas(button: HTMLElement): number | null {
  const r = button.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;

  const xs = [r.left + 2, (r.left + r.right) / 2, r.right - 2];
  const ys = [r.top + 2, (r.top + r.bottom) / 2, r.bottom - 2];

  let bas: number | null = null;
  for (const x of xs) {
    for (const y of ys) {
      let el: Element | null = null;
      // Absent ou non implémenté (jsdom) : on renonce à descendre plutôt que
      // d'échouer. Le bouton reste au coin de la carte, ce qui est dégradé mais
      // jamais cassé.
      try { el = document.elementFromPoint(x, y); } catch { return null; }
      if (!el || el === button || button.contains(el)) continue;
      const b = el.getBoundingClientRect().bottom;
      if (bas === null || b > bas) bas = b;
    }
  }
  return bas;
}

/**
 * Variante de repli : le bouton flotte sur la carte et cherche une place libre.
 *
 * Deux placements codés en dur ont échoué avant celle-ci, pour la même raison :
 * toute constante suppose une géométrie d'iD que personne n'a mesurée.
 *
 * 1. `top:10px; right:10px` du conteneur — sous la barre « Annuler / Rétablir /
 *    Sauvegarder ». Le bouton était dans le DOM, `visibility:visible`, opacité 1,
 *    et pourtant invisible.
 * 2. Coin haut-gauche de la surface de carte, mesuré contre le conteneur. Faux
 *    aussi : la barre d'outils d'iD est posée PAR-DESSUS la carte. La surface
 *    commence à `top=0`, l'écart mesuré valait zéro, et le bouton est resté sous
 *    le bandeau (qui descend, lui, jusqu'à 71 px).
 *
 * D'où : le bouton se pose au coin de la carte, demande au document qui le
 * recouvre, descend sous le plus bas des gêneurs, et recommence.
 */
function poserSurLaCarte(bridge: IdBridge, button: HTMLButtonElement): Placement {
  const container = bridge.containerNode();
  const surface = bridge.surfaceNode();

  button.style.cssText =
    'position:absolute;z-index:100;padding:6px 10px;' +
    'background:#fff;color:#333;border:1px solid #ccc;border-radius:4px;' +
    'cursor:pointer;font:inherit;line-height:normal';

  const place = (): void => {
    const c = container.getBoundingClientRect();
    const s = surface.getBoundingClientRect();

    // Garde-fou : un élément inattendu qui couvrirait toute la hauteur pousserait
    // le bouton hors de la carte. Passé la moitié de la surface, on s'arrête et on
    // le dit — un bouton mal placé se voit et se contourne, un bouton parti hors
    // écran ne se diagnostique pas.
    const limite = s.top + s.height / 2;

    button.style.left = `${Math.round(s.left + GAP_PX - c.left)}px`;
    let haut = s.top + GAP_PX;

    for (let i = 0; i <= MAX_DESCENTES; i++) {
      button.style.top = `${Math.round(haut - c.top)}px`;
      const bas = recouvrementLePlusBas(button);
      if (bas === null) return;
      if (bas + GAP_PX > limite) break;
      haut = bas + GAP_PX;
    }

    console.warn(
      "[cadastre-id] le bouton Cadastre n'a pas trouvé de place libre sur la carte ; " +
      "il reste visible mais peut être recouvert par l'interface d'iD.",
    );
  };

  container.appendChild(button);
  place();

  // La surface change de taille sans que la fenêtre bouge : repli du panneau
  // latéral, ouverture d'un panneau d'informations. ResizeObserver couvre ces cas
  // comme le redimensionnement de fenêtre ; l'écouteur `resize` reste en filet
  // pour les environnements qui ne l'implémentent pas.
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(place);
    observer.observe(surface);
  }
  window.addEventListener('resize', place);

  return {
    setActive: (on) => {
      button.style.background = on ? '#2e7dd7' : '#fff';
      button.style.color = on ? '#fff' : '#333';
    },
    destroy: () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
      button.remove();
    },
  };
}

/**
 * Variante préférée : le bouton prend place dans la barre d'outils d'iD.
 *
 * Elle supprime la question du recouvrement au lieu de la contourner — la barre
 * est posée par-dessus la carte, alors autant être dedans — et range l'outil là où
 * l'utilisateur va le chercher.
 *
 * L'habillage est **copié sur un voisin**, jamais écrit : on clone la coquille de
 * `slot.item` et les classes de `slot.bouton`. Le bouton hérite ainsi du thème
 * d'iD (sombre, compact) sans qu'aucune règle CSS d'iD ne soit reproduite ici, et
 * il suivra ses évolutions.
 */
function grefferDansLaBarre(slot: ToolbarSlot, button: HTMLButtonElement): Placement {
  button.className = `${classesDe(slot.bouton)} cadastre-id-toggle`.trim();

  // Si le bouton modèle EST l'enfant direct de la barre, il n'y a pas de coquille à
  // cloner : on se pose à côté de lui.
  const coquille = slot.item === slot.bouton ? null : document.createElement(slot.item.tagName);
  if (coquille) {
    coquille.className = classesDe(slot.item);
    coquille.appendChild(button);
  }
  slot.item.after(coquille ?? button);

  return {
    setActive: (on) => {
      // `active` est la convention d'iD pour un outil armé ; la couleur explicite
      // garantit que l'état se voit même si cette classe n'est pas stylée.
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
      button.style.background = on ? '#2e7dd7' : '';
      button.style.color = on ? '#fff' : '';
    },
    destroy: () => (coquille ?? button).remove(),
  };
}

/**
 * Le bouton d'activation du mode cadastre.
 *
 * Il se greffe dans la barre d'outils d'iD quand elle a la forme attendue, et
 * retombe sinon sur un placement flottant qui cherche sa place sur la carte. Le
 * repli n'est pas décoratif : il est ce qui reste si iD renomme ses classes, et il
 * se signale en console (voir `toolbarSlot()` dans le bridge).
 *
 * @returns le bouton et son `destroy`, sur le modèle de `createOverlay`. Le
 *          placement flottant s'abonne à la fenêtre et à la surface, il doit
 *          pouvoir s'en détacher. `src/main.ts` ne l'appelle pas — le bouton vit
 *          autant que la page ; les tests, eux, en ont besoin.
 */
export function createButton(
  bridge: IdBridge,
  onToggle: (on: boolean) => void,
): { element: HTMLButtonElement; destroy: () => void } {
  const button = document.createElement('button');
  button.className = 'cadastre-id-toggle';
  button.type = 'button';
  button.textContent = 'Cadastre';
  button.title = 'Créer un bâtiment depuis le cadastre (un clic par bâtiment)';

  const slot = bridge.toolbarSlot();
  const placement = slot ? grefferDansLaBarre(slot, button) : poserSurLaCarte(bridge, button);
  placement.setActive(false);

  let on = false;
  button.addEventListener('click', () => {
    on = !on;
    placement.setActive(on);
    onToggle(on);
  });

  return { element: button, destroy: placement.destroy };
}
