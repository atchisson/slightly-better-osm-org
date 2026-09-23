export interface TagInput {
  isolatedLight: boolean;
  millesime: string;
}

const SOURCE_PREFIX =
  'cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : ';

/**
 * Vérifie que le millésime est une année à quatre chiffres, et le rend tel quel.
 *
 * Ce module porte la seule obligation légale du projet : la Licence Ouverte exige que
 * l'origine ET le millésime des données figurent sur chaque objet qui en dérive. La
 * garde précédente (`if (!input.millesime)`) ne rejetait que la chaîne vide : une
 * chaîne d'espaces, un `latest` laissé passer par une future variante de
 * `millesimeFromUrl`, ou n'importe quel texte, se serait glissé dans l'attribution de
 * CHAQUE objet créé — « Mise à jour :    », lisible par personne et invérifiable.
 *
 * Volontairement strict, et sans rattrapage : on ne `trim()` pas une valeur suspecte
 * pour la sauver. Le millésime vient du chemin de redirection d'Etalab
 * (`/etalab-cadastre/2026-06-01/`), d'où `millesimeFromUrl` extrait déjà exactement
 * quatre chiffres ; tout le reste signale que la chaîne n'a pas l'origine annoncée, et
 * il vaut mieux refuser de créer que publier une attribution fausse.
 */
function requireMillesime(millesime: string): string {
  if (!/^\d{4}$/.test(millesime)) {
    throw new Error(
      `millésime invalide (${JSON.stringify(millesime)}) : une année à quatre chiffres ` +
      'est attendue, lue sur le jeu Etalab téléchargé',
    );
  }
  return millesime;
}

export function buildingTags(input: TagInput): Record<string, string> {
  const tags: Record<string, string> = {
    building: 'yes',
    source: SOURCE_PREFIX + requireMillesime(input.millesime),
  };
  if (input.isolatedLight) tags.wall = 'no';
  return tags;
}

export function changesetComment(commune: string): string {
  return `Bâtiments depuis le cadastre (${commune})`;
}
