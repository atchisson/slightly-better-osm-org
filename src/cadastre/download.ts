import { arrondissementCodes, departementOf } from './insee';

/**
 * Le dépôt Etalab est atteint DIRECTEMENT sur son bucket S3, sans passer par
 * `cadastre.data.gouv.fr`.
 *
 * Ce n'est pas une préférence : `https://cadastre.data.gouv.fr/.../latest/...` répond
 * `302` vers ce bucket, et **cette redirection ne porte aucun en-tête CORS**. Le
 * navigateur la bloque au premier saut, avant même d'atteindre le S3 — qui, lui,
 * répond `Access-Control-Allow-Origin: *`. Vérifié des deux côtés le 2026-09-24 :
 * en ligne de commande, et dans la console de l'éditeur (« CORS missing allow
 * origin »). La spec §3 annonçait l'inverse ; elle décrivait la réponse finale, pas
 * la chaîne.
 *
 * Conséquence : le millésime, qu'on lisait dans l'URL d'arrivée de la redirection,
 * doit maintenant être découvert autrement — d'où le listing ci-dessous.
 */
const BUCKET = 'https://cadastre.s3.rbx.io.cloud.ovh.net';

/**
 * Listing S3 des millésimes publiés. `delimiter=/` ne rend que les préfixes de
 * premier niveau (une trentaine de dates), pas les millions d'objets du dépôt.
 */
export const LISTING_URL =
  `${BUCKET}/?list-type=2&prefix=etalab-cadastre/&delimiter=/&max-keys=1000`;

export function datasetUrl(insee: string, millesime: string): string {
  const dep = departementOf(insee);
  return `${BUCKET}/etalab-cadastre/${millesime}/geojson/communes/${dep}/${insee}/cadastre-${insee}-batiments.json.gz`;
}

/** Le jeu demandé n'existe pas à ce millésime — distinct de toute autre panne. */
export class DatasetIntrouvable extends Error {}

/**
 * Les millésimes publiés, du plus récent au plus ancien, lus dans le listing XML.
 *
 * Lecture par expression régulière et non par `DOMParser` : on cherche une trentaine
 * de dates dans des `<Prefix>`, la structure XML n'apporte rien, et le greffon n'a
 * aucune dépendance de production.
 *
 * Les dates sont au format `AAAA-MM-JJ` : l'ordre lexicographique est l'ordre
 * chronologique.
 */
export function millesimesFromListing(xml: string): string[] {
  const dates = new Set<string>();
  for (const m of xml.matchAll(/etalab-cadastre\/(\d{4}-\d{2}-\d{2})\//g)) dates.add(m[1]!);
  if (dates.size === 0) {
    throw new Error('aucun millésime lisible dans le listing du dépôt cadastre');
  }
  return [...dates].sort().reverse();
}

async function fetchMillesimes(fetchFn: typeof fetch): Promise<string[]> {
  const res = await fetchFn(LISTING_URL);
  if (!res.ok) throw new Error(`le dépôt cadastre a répondu ${res.status} au listing`);
  return millesimesFromListing(await res.text());
}

async function downloadOne(
  insee: string,
  millesime: string,
  fetchFn: typeof fetch,
): Promise<unknown[]> {
  const res = await fetchFn(datasetUrl(insee, millesime));
  if (res.status === 404) {
    throw new DatasetIntrouvable(`${insee} absent du millésime ${millesime}`);
  }
  if (!res.ok) throw new Error(`le dépôt cadastre a répondu ${res.status} pour ${insee}`);
  if (!res.body) throw new Error('réponse sans corps');

  // Le fichier est gzippé mais servi sans `Content-Encoding` (Content-Type
  // application/octet-stream) : le navigateur ne le décompresse donc pas tout seul.
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const parsed = JSON.parse(await new Response(stream).text()) as { features?: unknown[] };
  return parsed.features ?? [];
}

export async function downloadCommune(
  insee: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ features: unknown[]; millesime: string }> {
  const millesimes = await fetchMillesimes(fetchFn);

  // Paris, Lyon et Marseille n'existent pas sous leur code commune dans le jeu Etalab :
  // les données sont découpées par arrondissement, et il faut donc les recoller.
  const codes = arrondissementCodes(insee);

  // Le millésime le plus récent, puis celui d'avant.
  //
  // Ce repli remplace un garde-fou devenu sans objet. Tant qu'on suivait `latest`,
  // chaque arrondissement était redirigé indépendamment et pouvait atterrir sur une
  // date différente en pleine republication : le code retenait alors le plus ancien,
  // parce qu'une attribution ne doit jamais annoncer des données plus fraîches
  // qu'elles ne sont. En épinglant un préfixe unique pour toute la requête, cette
  // divergence devient impossible par construction — on ne la détecte plus, on
  // l'empêche.
  //
  // Mais on perd `latest`, qu'Etalab ne fait pointer que sur un millésime entièrement
  // publié, alors que le listing brut expose aussi celui en cours de téléversement.
  // D'où l'essai du précédent quand le plus récent rend 404, et seulement dans ce
  // cas : toute autre panne remonte telle quelle.
  const candidats = millesimes.slice(0, 2);
  let absence: unknown;

  for (const millesime of candidats) {
    try {
      const parts = await Promise.all(codes.map(code => downloadOne(code, millesime, fetchFn)));
      if (millesime !== candidats[0]) {
        console.warn(
          `[cadastre-id] ${insee} absent du millésime ${candidats[0]} ; repli sur ` +
          `${millesime}. Le dépôt est probablement en cours de republication.`,
        );
      }
      return { features: parts.flat(), millesime: millesime.slice(0, 4) };
    } catch (err) {
      if (!(err instanceof DatasetIntrouvable)) throw err;
      absence = err;
    }
  }

  throw absence;
}
