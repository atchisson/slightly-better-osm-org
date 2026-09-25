import type { IdBridge } from '../bridge/types';
import { planMerge, type MergePlan } from '../merge';

/** Ce que l'entrée de menu doit pouvoir faire savoir à l'extérieur. */
export interface MergeMenuHooks {
  /** Rend un message à afficher, ou rien si la fusion s'est faite. */
  notify(message: string): void;
}

export const LIBELLE = 'Fusionner (cadastre-id)';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Contour en L : deux rectangles dont le mur commun a disparu.
 *
 * **Dessinée ici, et non empruntée à iD.** Le premier jet reprenait
 * `#iD-operation-merge`, l'icône de « Combiner » — trompeur, puisque cette opération
 * produit une relation multipolygone là où la nôtre produit une voie unique. Deux
 * gestes différents ne doivent pas porter le même signe.
 *
 * La dessiner plutôt que d'emprunter un autre identifiant de sa feuille de symboles
 * supprime aussi une dépendance jamais vérifiée : un identifiant absent afficherait
 * un bouton muet, sans rien dire.
 *
 * Le tracé dit exactement ce que l'opération fait : un seul contour, avec le décroché
 * que laissent deux bâtiments réunis.
 */
const TRACE_ICONE = 'M4 5 h8 v7 h8 v7 H4 Z';

/** Repli si la couleur des icônes d'iD n'est pas lisible : son menu est sombre. */
const COULEUR_REPLI = '#fff';

/**
 * La couleur dont iD peint ses propres icônes de menu, lue sur un voisin.
 *
 * Mesurée plutôt qu'écrite : `currentColor` ne convient pas — il suit la couleur de
 * TEXTE du bouton, qui n'est pas celle de son icône, et donnait un tracé noir dans un
 * menu sombre. Lire le voisin donne le bon ton ici, et le suivra si iD change de
 * thème, ce qu'une valeur en dur ne ferait pas.
 */
function couleurDesIcones(modele: Element): string {
  try {
    const cible = modele.querySelector('use') ?? modele.querySelector('svg') ?? modele;
    const fill = getComputedStyle(cible).fill;
    if (fill && fill !== 'none') return fill;
  } catch { /* environnement sans mise en page : on prend le repli */ }
  return COULEUR_REPLI;
}

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

    // On garde l'ENVELOPPE svg du modèle — ses classes portent la taille et la
    // couleur que le menu d'iD applique à ses icônes — et on remplace son contenu par
    // notre tracé. Vider puis remettre supprime au passage tout libellé que le voisin
    // porterait.
    const couleur = couleurDesIcones(modele);
    const icone = item.querySelector('svg');
    item.textContent = '';
    if (icone) {
      icone.textContent = '';
      icone.setAttribute('viewBox', '0 0 24 24');
      const trace = document.createElementNS(SVG_NS, 'path');
      trace.setAttribute('d', TRACE_ICONE);
      // En style EN LIGNE, pas en attributs : les règles CSS d'iD sur ses icônes
      // (`fill: currentColor`) l'emporteraient sur de simples attributs de
      // présentation et rempliraient le contour.
      trace.setAttribute('style',
        `fill:none;stroke:${couleur};stroke-width:2;stroke-linejoin:round`);
      icone.appendChild(trace);
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
