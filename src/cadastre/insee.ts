export interface Commune { code: string; nom: string; }

const ARRONDISSEMENTS: Record<string, { prefix: string; count: number }> = {
  '75056': { prefix: '751', count: 20 },   // Paris
  '69123': { prefix: '693', count: 9 },    // Lyon
  '13055': { prefix: '132', count: 16 },   // Marseille
};

export function departementOf(insee: string): string {
  if (insee.startsWith('2A') || insee.startsWith('2B')) return insee.slice(0, 2);
  if (insee.startsWith('97') || insee.startsWith('98')) return insee.slice(0, 3);
  return insee.slice(0, 2);
}

export function arrondissementCodes(insee: string): string[] {
  const split = ARRONDISSEMENTS[insee];
  if (!split) return [insee];
  return Array.from({ length: split.count }, (_, i) =>
    `${split.prefix}${String(i + 1).padStart(2, '0')}`);
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
