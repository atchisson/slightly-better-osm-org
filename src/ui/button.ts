/** Marge entre le coin de la surface de carte et le bouton. */
const INSET_PX = 10;

/**
 * Le bouton d'activation du mode cadastre, posé sur la carte.
 *
 * **Le placement se mesure, il ne se devine pas.** La première version posait le
 * bouton en `top:10px; right:10px` du conteneur d'iD — c'est-à-dire exactement
 * sous la barre « Annuler / Rétablir / Sauvegarder ». Constaté en navigateur :
 * le bouton était bien dans le DOM (68×34, `display:block`, `visibility:visible`,
 * opacité 1), mais `document.elementFromPoint()` sur son centre renvoyait le
 * compteur du bouton Sauvegarder. Il était recouvert : invisible et incliquable.
 * Monter le `z-index` l'aurait fait passer PAR-DESSUS Sauvegarder — pire encore.
 *
 * D'où le coin haut-GAUCHE de la surface : iD occupe le haut (barre d'outils) et
 * la colonne de droite (zoom, fonds, calques, préférences) ; ce coin-là est libre.
 *
 * On ne connaît ni la hauteur de la barre d'outils d'iD ni la largeur de son
 * panneau latéral, et aucune des deux n'est stable (repli du panneau,
 * redimensionnement). On lit donc l'écart réel entre le coin de la surface et
 * celui du conteneur, et on le remesure dès que la surface bouge. Aucune valeur
 * interne d'iD n'est codée en dur ici.
 *
 * @param container conteneur d'iD (`bridge.containerNode()`), ancêtre positionné
 * @param surface   surface de carte (`bridge.surfaceNode()`), la même que celle
 *                  qui sert d'origine à la projection et porte l'overlay
 */
export function createButton(
  container: HTMLElement,
  surface: Element,
  onToggle: (on: boolean) => void,
): HTMLButtonElement {
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
    button.style.top = `${Math.round(s.top - c.top) + INSET_PX}px`;
    button.style.left = `${Math.round(s.left - c.left) + INSET_PX}px`;
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
  // pour les environnements qui ne l'implémentent pas (jsdom, entre autres).
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(place).observe(surface);
  window.addEventListener('resize', place);

  return button;
}
