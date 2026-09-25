import type { IdBridge } from '../bridge/types';
import { planMerge, type MergePlan } from '../merge';

/** Ce que l'entrée de menu doit pouvoir faire savoir à l'extérieur. */
export interface MergeMenuHooks {
  /** Rend un message à afficher, ou rien si la fusion s'est faite. */
  notify(message: string): void;
}

export const LIBELLE = 'Fusionner (cadastre-id)';

/**
 * Icône empruntée à l'opération « Combiner » d'iD.
 *
 * Toutes ses opérations suivent la convention `#iD-operation-{id}` et `merge` en est
 * une : l'icône existe donc dans sa feuille de symboles. C'est aussi la plus juste
 * sémantiquement — notre fusion fait ce que « Combiner » ferait si iD savait produire
 * une voie unique au lieu d'un multipolygone.
 */
const ICONE = '#iD-operation-merge';

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
 * L'entrée est **clonée en profondeur sur un voisin** : même balise, mêmes classes,
 * et surtout même structure interne — le menu contextuel d'iD est une colonne
 * d'icônes, pas une liste de libellés. Un premier essai clonait superficiellement et
 * posait du texte : l'entrée débordait de la colonne et se faisait couper. On ne
 * remplace donc que la cible de l'icône, et le libellé passe en infobulle.
 *
 * Même leçon que le bouton de barre d'outils : imiter un voisin, jamais reproduire
 * les règles d'iD ni supposer la forme de ses éléments.
 *
 * @returns de quoi se détacher.
 */
export function attachMergeMenu(bridge: IdBridge, hooks: MergeMenuHooks): () => void {
  return bridge.onEditMenu(({ menu, modele }) => {
    // Deux bâtiments sélectionnés, sinon l'entrée n'a rien à faire là : le menu
    // contextuel d'iD sert à bien d'autres choses.
    if (bridge.selectedBuildings().length !== 2) return;

    const item = modele.cloneNode(true) as HTMLElement;
    // Les identifiants du voisin ne doivent pas être dupliqués : ils casseraient le
    // getElementById d'iD sur ses propres éléments.
    item.removeAttribute('id');
    for (const el of item.querySelectorAll('[id]')) el.removeAttribute('id');
    // Un voisin désactivé au moment du clonage nous transmettrait son état.
    item.classList.remove('disabled');

    // On ne garde que l'icône du modèle, dont on change la cible. Vider puis remettre
    // supprime au passage tout libellé que le voisin porterait.
    const icone = item.querySelector('svg');
    item.textContent = '';
    if (icone) {
      for (const use of icone.querySelectorAll('use')) {
        use.setAttribute('href', ICONE);
        use.setAttribute('xlink:href', ICONE);
      }
      item.appendChild(icone);
    }
    item.title = LIBELLE;
    item.setAttribute('aria-label', LIBELLE);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const message = fusionnerSelection(bridge);
      if (message) hooks.notify(message);
    });
    menu.appendChild(item);
  });
}
