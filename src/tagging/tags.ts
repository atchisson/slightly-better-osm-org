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
 * chaîne d'espaces, un `latest` laissé passer par une future variante de la lecture
 * du millésime, ou n'importe quel texte, se serait glissé dans l'attribution de
 * CHAQUE objet créé — « Mise à jour :    », lisible par personne et invérifiable.
 *
 * Volontairement strict, et sans rattrapage : on ne `trim()` pas une valeur suspecte
 * pour la sauver. Le millésime vient d'un préfixe daté du dépôt Etalab
 * (`etalab-cadastre/2026-06-01/`), dont `downloadCommune` ne garde que l'année ; tout
 * le reste signale que la chaîne n'a pas l'origine annoncée, et il vaut mieux refuser
 * de créer que publier une attribution fausse.
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

/**
 * Tags d'une piscine créée depuis le cadastre.
 *
 * `access=private` est un choix explicite de l'utilisateur de cet outil, pas une
 * déduction : **le cadastre ne dit rien du régime d'accès**. Il ne distingue pas la
 * piscine d'un particulier de celle d'un camping ou d'un hôtel, et ce tag sera donc
 * faux sur une petite minorité d'objets. C'est l'usage majoritaire pour le bassin
 * résidentiel, qui est l'écrasante majorité du gisement — à revoir si cet outil
 * servait un jour à cartographier des équipements collectifs.
 *
 * Pas de `building` : une piscine n'est pas un bâtiment, et la couche d'où elle vient
 * n'est pas celle des bâtiments.
 */
export function poolTags(millesime: string): Record<string, string> {
  return {
    leisure: 'swimming_pool',
    access: 'private',
    source: SOURCE_PREFIX + requireMillesime(millesime),
  };
}

export function changesetComment(commune: string): string {
  return `Bâtiments depuis le cadastre (${commune})`;
}

/**
 * Champ `source` du changeset : la même chaîne, verbatim, que le tag `source` posé sur
 * chaque objet. C'est la valeur qu'exige la Licence Ouverte (origine + millésime) et
 * c'est ce que la spec §7 et le README annoncent — « le commentaire de changeset et le
 * champ source sont préremplis ».
 */
export function changesetSource(millesime: string): string {
  return SOURCE_PREFIX + requireMillesime(millesime);
}
