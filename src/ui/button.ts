/** Marge entre le bouton et ce qui le borde (coin de la carte, ou bas d'un élément d'iD). */
const GAP_PX = 10;

/** Nombre maximal de descentes avant d'abandonner et de le dire. */
const MAX_DESCENTES = 5;

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
 * caché et il aurait fallu viser la barre par son nom, depuis le bridge.
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
 * Le bouton d'activation du mode cadastre, posé sur la carte.
 *
 * **Il cherche sa place lui-même.** Deux placements codés en dur ont échoué avant
 * celui-ci, pour la même raison : toute constante suppose une géométrie d'iD que
 * personne n'a mesurée.
 *
 * 1. `top:10px; right:10px` du conteneur — sous la barre « Annuler / Rétablir /
 *    Sauvegarder ». Le bouton était dans le DOM, `visibility:visible`, opacité 1,
 *    et pourtant invisible : `elementFromPoint` sur son centre renvoyait le
 *    compteur du bouton Sauvegarder.
 * 2. Coin haut-gauche de la surface de carte, mesuré contre le conteneur. Faux
 *    aussi : la barre d'outils d'iD est posée PAR-DESSUS la carte, elle ne la
 *    décale pas. La surface commence à `top=0`, l'écart mesuré valait zéro, et le
 *    bouton est resté sous le bandeau (qui descend, lui, jusqu'à 71 px).
 *
 * D'où cette version : le bouton se pose au coin de la carte, demande au document
 * qui le recouvre, descend sous le plus bas des gêneurs, et recommence. Aucune
 * hauteur de barre d'outils, aucun nom de classe d'iD, aucune constante à revoir
 * quand l'éditeur changera — ni quand la barre se repliera sur une fenêtre étroite.
 *
 * @param container conteneur d'iD (`bridge.containerNode()`), ancêtre positionné
 * @param surface   surface de carte (`bridge.surfaceNode()`), la même que celle
 *                  qui sert d'origine à la projection et porte l'overlay
 * @returns le bouton et son `destroy`, sur le modèle de `createOverlay` : le
 *          replacement s'abonne à la fenêtre et à la surface, il doit pouvoir s'en
 *          détacher. `src/main.ts` n'a pas de chemin de démontage et ne l'appelle
 *          pas — le bouton vit autant que la page ; les tests, eux, en ont besoin.
 */
export function createButton(
  container: HTMLElement,
  surface: Element,
  onToggle: (on: boolean) => void,
): { element: HTMLButtonElement; destroy: () => void } {
  const button = document.createElement('button');
  button.className = 'cadastre-id-toggle';
  button.type = 'button';
  button.textContent = 'Cadastre';
  button.title = 'Créer un bâtiment depuis le cadastre (un clic par bâtiment)';
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

  let on = false;
  button.addEventListener('click', () => {
    on = !on;
    button.style.background = on ? '#2e7dd7' : '#fff';
    button.style.color = on ? '#fff' : '#333';
    onToggle(on);
  });

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
    element: button,
    destroy: () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
      button.remove();
    },
  };
}
