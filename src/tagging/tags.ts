export interface TagInput {
  isolatedLight: boolean;
  millesime: string;
}

const SOURCE_PREFIX =
  'cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : ';

export function buildingTags(input: TagInput): Record<string, string> {
  if (!input.millesime) {
    throw new Error('millésime absent : il doit venir du jeu Etalab téléchargé');
  }
  const tags: Record<string, string> = {
    building: 'yes',
    source: SOURCE_PREFIX + input.millesime,
  };
  if (input.isolatedLight) tags.wall = 'no';
  return tags;
}

export function changesetComment(commune: string): string {
  return `Bâtiments depuis le cadastre (${commune})`;
}
