/**
 * Ce que le raccourci Ctrl a besoin de savoir et de faire.
 *
 * Il ne parle jamais au mode directement : il passe par `setArmed`, que
 * `src/main.ts` branche sur le bouton. Un seul état d'armement existe donc, et
 * l'utilisatrice voit toujours dans la barre d'outils ce que le greffon croit —
 * sans quoi maintenir Ctrl armerait le mode en laissant le bouton éteint.
 */
export interface CtrlShortcutHooks {
  /** Le mode est-il déjà armé par le bouton ? On ne prend alors pas la main. */
  isEnabled(): boolean;
  /**
   * Le raccourci a-t-il le droit de s'armer maintenant ?
   *
   * Relu à CHAQUE appui, jamais mis en cache : la couche cadastre s'allume et
   * s'éteint en cours de session, et une réponse figée au démarrage autoriserait
   * (ou interdirait) le raccourci pour toute la session sur un état périmé.
   */
  allowed(): boolean;
  /** Arme ou désarme, via le bouton. */
  setArmed(on: boolean): void;
}

/**
 * Maintenir Ctrl arme le mode cadastre ; le relâcher le désarme.
 *
 * Déclencheur transitoire, sans affordance : il double le bouton, il ne le
 * remplace pas. Deux garde-fous en découlent.
 *
 * **Il ne s'arme que si `allowed()` le permet** — en pratique, que si la couche
 * cadastre est affichée. Un raccourci qu'on ne voit pas doit être difficile à
 * déclencher par accident, et la couche affichée est la preuve que l'utilisatrice
 * regarde ce qu'elle trace.
 *
 * **Il rend la main sur `blur`.** Sans ça, un Alt+Tab ou un Ctrl+Tab pendant que
 * Ctrl est enfoncé emporte le `keyup` avec lui : le mode resterait armé
 * indéfiniment, et le clic suivant au retour créerait un bâtiment que personne
 * n'a demandé. C'est le défaut classique des modificateurs maintenus, et il est
 * silencieux.
 *
 * @returns de quoi retirer les écouteurs.
 */
export function createCtrlShortcut(hooks: CtrlShortcutHooks): () => void {
  // Distingue « c'est nous qui avons armé » de « le bouton était déjà armé » : sans
  // cette mémoire, relâcher Ctrl désarmerait un mode que l'utilisatrice avait
  // délibérément activé au bouton.
  let armeParNous = false;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Control') return;
    // `keydown` se répète tant que la touche est enfoncée : sans ce garde, chaque
    // répétition rejouerait l'armement.
    if (armeParNous || hooks.isEnabled()) return;
    if (!hooks.allowed()) return;
    armeParNous = true;
    hooks.setArmed(true);
  };

  const relacher = (): void => {
    if (!armeParNous) return;
    armeParNous = false;
    hooks.setArmed(false);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Control') relacher();
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', relacher);

  return () => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', relacher);
  };
}
