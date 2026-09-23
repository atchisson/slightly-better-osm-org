import { arrondissementCodes, departementOf } from './insee';

const BASE = 'https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes';

export function datasetUrl(insee: string): string {
  const dep = departementOf(insee);
  return `${BASE}/${dep}/${insee}/cadastre-${insee}-batiments.json.gz`;
}

export function millesimeFromUrl(url: string): string {
  const m = /etalab-cadastre\/(\d{4})-\d{2}-\d{2}\//.exec(url);
  if (!m) throw new Error(`millésime illisible dans l'URL : ${url}`);
  return m[1]!;
}

async function downloadOne(
  insee: string,
  fetchFn: typeof fetch,
): Promise<{ features: unknown[]; millesime: string }> {
  const res = await fetchFn(datasetUrl(insee));
  if (!res.ok) throw new Error(`cadastre.data.gouv.fr a répondu ${res.status} pour ${insee}`);
  if (!res.body) throw new Error('réponse sans corps');

  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const parsed = JSON.parse(text) as { features?: unknown[] };

  return {
    features: parsed.features ?? [],
    millesime: millesimeFromUrl(res.url),
  };
}

export async function downloadCommune(
  insee: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ features: unknown[]; millesime: string }> {
  // Paris, Lyon et Marseille n'existent pas sous leur code commune dans le jeu Etalab :
  // les données sont découpées par arrondissement, et il faut donc les recoller.
  const codes = arrondissementCodes(insee);
  if (codes.length === 1) return downloadOne(insee, fetchFn);

  const parts = await Promise.all(codes.map(code => downloadOne(code, fetchFn)));
  return {
    features: parts.flatMap(part => part.features),
    millesime: parts[0]!.millesime,
  };
}
