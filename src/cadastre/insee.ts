export interface Commune { code: string; nom: string; }

// Vérifié contre le jeu de données Etalab réel le 2026-09-23 : 69381/69389 répondent
// 200, tandis que 69301/69309 (calculés par préfixe + index) répondent 404. Les codes
// des arrondissements de Lyon ne sont PAS contigus avec son code commune (69123) —
// c'est le piège qui a produit la version précédente, fausse, de cette table.
const ARRONDISSEMENTS: Record<string, { first: number; count: number }> = {
  '75056': { first: 75101, count: 20 },  // Paris
  '69123': { first: 69381, count: 9 },   // Lyon
  '13055': { first: 13201, count: 16 },  // Marseille
};

export function departementOf(insee: string): string {
  if (insee.startsWith('2A') || insee.startsWith('2B')) return insee.slice(0, 2);
  if (insee.startsWith('97') || insee.startsWith('98')) return insee.slice(0, 3);
  return insee.slice(0, 2);
}

export function arrondissementCodes(insee: string): string[] {
  const split = ARRONDISSEMENTS[insee];
  if (!split) return [insee];
  return Array.from({ length: split.count }, (_, i) => String(split.first + i));
}

export async function communeAt(
  lat: number,
  lon: number,
  fetchFn: typeof fetch = fetch,
): Promise<Commune | null> {
  const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=code,nom`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`geo.api.gouv.fr a répondu ${res.status}`);
  const list = (await res.json()) as Commune[];
  return list[0] ?? null;
}
