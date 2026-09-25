import type { IdBridge } from '../bridge/types';
import { planMerge, type MergePlan } from '../merge';

/** Ce que l'entrée de menu doit pouvoir faire savoir à l'extérieur. */
export interface MergeMenuHooks {
  /** Rend un message à afficher, ou rien si la fusion s'est faite. */
  notify(message: string): void;
}

export const LIBELLE = 'Fusionner (cadastre-id)';

const REFUS: Record<string, string> = {
  'pas-deux': 'Sélectionnez exactement deux bâtiments pour les fusionner.',
  'pas-mitoyens': 'Ces deux bâtiments ne se touchent pas : la fusion donnerait deux morceaux séparés.',
  'geometrie-illisible': 'La géométrie de ces bâtiments n’est pas exploitable (voie ouverte, ou nœuds illisibles).',
  'union-impossible': 'La fusion ne donne pas un contour propre.',
};

export function messageDeRefus(plan: Extract<MergePlan, { ok: false }>): string {
  const base = REFUS[plan.reason] ?? 'Fusion impossible.';
  return plan.detail ? `${base} (${plan.detail})` : base;
}

/**
 * Tente la fusion des bâtiments actuellement sélectionnés, et rend le message à
 * afficher — ou `null` si elle a réussi sans rien à signaler.
 *
 * Séparée de toute interface : c'est elle que le clic droit et le raccourci clavier
 * appellent tous les deux, de sorte que les deux chemins ne puissent pas diverger.
 */
export function fusionnerSelection(bridge: IdBridge): string | null {
  const plan = planMerge(bridge.selectedBuildings());
  if (!plan.ok) return messageDeRefus(plan);

  bridge.mergeBuildings(plan);
  if (plan.tagsEnConflit.length === 0) return null;
  // Un tag écrasé en silence est une perte d'information invisible : on la dit.
  return `Fusion faite. Attention : ${plan.tagsEnConflit.join(', ')} ` +
    `${plan.tagsEnConflit.length > 1 ? 'avaient' : 'avait'} deux valeurs différentes ; ` +
    'celle du plus grand bâtiment a été retenue.';
}

/**
 * Greffe « Fusionner » dans le menu contextuel d'iD, à chaque ouverture.
 *
 * L'entrée est **clonée sur un voisin** : même balise, mêmes classes, donc même
 * apparence et même comportement de survol que les opérations natives, sans qu'une
 * seule règle CSS d'iD soit reproduite ici. C'est la leçon du bouton de barre
 * d'outils, où copier une classe et laisser iD peindre avait produit une pastille
 * blanche au milieu d'une barre sombre.
 *
 * @returns de quoi se détacher.
 */
export function attachMergeMenu(bridge: IdBridge, hooks: MergeMenuHooks): () => void {
  return bridge.onEditMenu(({ menu, modele }) => {
    // Deux bâtiments sélectionnés, sinon l'entrée n'a rien à faire là : le menu
    // contextuel d'iD sert à bien d'autres choses.
    if (bridge.selectedBuildings().length !== 2) return;

    const item = modele.cloneNode(false) as HTMLElement;
    item.removeAttribute('id');
    item.textContent = LIBELLE;
    item.title = LIBELLE;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const message = fusionnerSelection(bridge);
      if (message) hooks.notify(message);
    });
    menu.appendChild(item);
  });
}
