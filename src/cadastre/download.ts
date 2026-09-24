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

  // Le millésime porté par chaque objet créé est une obligation d'attribution (Licence
  // Ouverte). Le prendre sur `parts[0]` — le premier arrondissement — était un pari sur
  // le fait qu'Etalab republie les vingt (ou seize, ou neuf) le même jour. S'ils
  // divergent, l'attribution est fausse pour dix-neuf sur vingt, et fausse dans le sens
  // le plus gênant : elle annonce des données plus fraîches qu'elles ne sont.
  //
  // On retient donc le PLUS ANCIEN. C'est la seule date dont on puisse affirmer que
  // l'ensemble recollé est au moins à jour à cette date-là — les millésimes sont des
  // années à quatre chiffres, donc l'ordre lexicographique est l'ordre chronologique.
  // La divergence est dite en console : elle signale un jeu en cours de republication.
  const millesimes = [...new Set(parts.map(part => part.millesime))].sort();
  if (millesimes.length > 1) {
    console.warn(
      `[cadastre-id] millésimes différents entre les arrondissements de ${insee} ` +
      `(${millesimes.join(', ')}) : le plus ancien est retenu pour l'attribution.`,
      millesimes,
    );
  }

  return {
    features: parts.flatMap(part => part.features),
    millesime: millesimes[0]!,
  };
}
