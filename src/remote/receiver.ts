import { estPret, lireCommande, origineMapRoulette, pret } from './protocol';
import type { Commande } from './protocol';

/**
 * Ce que le récepteur sait faire d'une commande. L'implémentation vit dans
 * `src/bridge/` (`makeNavigation`) : c'est là, et là seulement, qu'on touche à iD.
 */
export interface Navigation {
  aller(cmd: Commande): void;
}

/** Les deux surfaces dont on a besoin d'une fenêtre : testables sans navigateur. */
type Fenetre = Pick<Window, 'addEventListener' | 'removeEventListener' | 'location' | 'top' | 'opener' | 'parent' | 'document'>;

/**
 * Cadre principal (`/edit`) : transmet à l'iframe d'iD ce que la page MapRoulette lui
 * envoie, et lui renvoie, vers l'onglet MapRoulette, l'annonce « je suis prêt ».
 *
 * iD vit dans une iframe servie à `/id` (spike du 2026-09-22) : la page qui a ouvert
 * l'onglet ne peut parler qu'au cadre principal, c'est lui qui doit faire suivre. Un
 * message ne traverse jamais deux frontières d'origine : de MapRoulette au cadre
 * principal, puis du cadre principal à l'iframe, de même origine.
 *
 * Sans iframe (éditeur ouvert directement sur `/id`), il ne fait rien : le récepteur
 * du même document reçoit alors les messages directement.
 */
export function installerRelais(fenetre: Fenetre = window): () => void {
  if (fenetre !== fenetre.top) return () => {};

  const iframe = (): HTMLIFrameElement | null => fenetre.document.querySelector('iframe');

  const surMessage = (e: MessageEvent): void => {
    const cadre = iframe()?.contentWindow;
    if (!cadre) return;

    // De l'iframe vers l'onglet MapRoulette : « l'éditeur est prêt ».
    if (e.source === cadre) {
      if (e.origin === fenetre.location.origin && estPret(e.data)) fenetre.opener?.postMessage(pret(), '*');
      return;
    }

    // De MapRoulette vers l'iframe : seulement ce qui vient de la fenêtre qui nous a
    // ouverts, depuis MapRoulette, et qui est une commande valide.
    if (e.source !== fenetre.opener || !origineMapRoulette(e.origin)) return;
    const cmd = lireCommande(e.data);
    if (cmd) cadre.postMessage(cmd, fenetre.location.origin);
  };

  fenetre.addEventListener('message', surMessage);
  return () => fenetre.removeEventListener('message', surMessage);
}

/**
 * Document qui héberge iD : exécute les commandes reçues, puis annonce être prêt.
 *
 * Il accepte deux sources, et seulement elles : le cadre principal (même origine) quand
 * on est dans l'iframe `/id`, ou la fenêtre MapRoulette qui nous a ouverts quand on est
 * soi-même le cadre principal.
 *
 * L'annonce n'est faite qu'une fois la navigation prête : la page MapRoulette ne
 * remplace le comportement par défaut (fermer l'onglet, en ouvrir un autre) que sur
 * cette annonce. Sans elle — script absent, éditeur pas encore chargé —, rien ne change
 * pour la personne.
 */
export function installerRecepteur(nav: Navigation, fenetre: Fenetre = window): () => void {
  const principal = fenetre === fenetre.top;

  const surMessage = (e: MessageEvent): void => {
    const autorise = principal
      ? e.source === fenetre.opener && origineMapRoulette(e.origin)
      : e.source === fenetre.parent && e.origin === fenetre.location.origin;
    if (!autorise) return;
    const cmd = lireCommande(e.data);
    if (!cmd) return;
    try {
      nav.aller(cmd);
    } catch (err) {
      console.warn('[sb-osm] commande de navigation en échec :', err);
    }
  };

  fenetre.addEventListener('message', surMessage);

  if (principal) fenetre.opener?.postMessage(pret(), '*');
  else fenetre.parent.postMessage(pret(), fenetre.location.origin);

  return () => fenetre.removeEventListener('message', surMessage);
}
