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

/**
 * Couche des surfaces topographiques du PCI, d'où viennent les piscines.
 *
 * Elles ne sont PAS dans la couche bâtiments — vérifié : celle-ci ne porte que les
 * types `01` et `02`. Elles vivent dans `tsurf`, sous le dossier `raw/` du dépôt, et
 * s'y reconnaissent au code symbole 65 (voir `estPiscine`).
 */
export function tsurfUrl(insee: string, millesime: string): string {
  const dep = departementOf(insee);
  return `${BUCKET}/etalab-cadastre/${millesime}/geojson/communes/${dep}/${insee}/raw/pci-${insee}-tsurf.json.gz`;
}

/**
 * Code symbole des piscines dans la couche `tsurf`.
 *
 * **Mesuré, pas supposé.** Confronté aux piscines déjà cartographiées dans OSM, sur
 * deux communes de profils opposés :
 *
 * | SYM | Le Lavandou (83069) | Angers (49007) |
 * |-----|---------------------|----------------|
 * | 65  | 73,5 %              | 65,1 %         |
 * | 34  | 81,4 %              | **1,0 %**      |
 * | 33  | 3,3 %               | 0 %            |
 *
 * `34` semblait convaincant dans le Var — c'était un artefact de densité : là-bas ses
 * objets (38 m² de médiane) voisinent les piscines, alors qu'à Angers ils en font 379
 * et n'ont rien à voir. Seul `65` tient sur les deux. Les 4 objets étiquetés
 * « piscine » de la commune 28404 portent tous ce code.
 *
 * Les 26 à 35 % sans correspondance OSM sont vraisemblablement des piscines non
 * encore cartographiées — précisément ce que cet outil sert à ajouter.
 */
const SYM_PISCINE = '65';

const estPiscine = (f: unknown): boolean =>
  (f as { properties?: { SYM?: unknown } })?.properties?.SYM === SYM_PISCINE;

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

/**
 * Piscines d'une commune à un millésime donné.
 *
 * Une couche absente n'est pas une panne : toutes les communes n'ont pas de fichier
 * `tsurf`, et une commune sans piscine est un cas parfaitement ordinaire. On rend
 * alors une liste vide plutôt que de faire échouer le chargement des bâtiments.
 */
async function downloadPiscines(
  insee: string,
  millesime: string,
  fetchFn: typeof fetch,
): Promise<unknown[]> {
  try {
    const res = await fetchFn(tsurfUrl(insee, millesime));
    if (!res.ok || !res.body) return [];
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    const parsed = JSON.parse(await new Response(stream).text()) as { features?: unknown[] };
    return (parsed.features ?? []).filter(estPiscine);
  } catch {
    return [];
  }
}

/**
 * Piscines seules, pour une commune dont les bâtiments sont déjà en cache.
 *
 * Existe à cause d'un défaut introduit avec la prise en charge des piscines : le champ
 * a été rendu optionnel dans le cache pour ne pas périmer des dizaines de mégaoctets
 * déjà téléchargés, si bien qu'une entrée antérieure rendait zéro piscine — en
 * silence, et donc pour tout utilisateur de la version précédente. Ce complément
 * comble l'entrée au premier usage, au prix d'une seule requête sur un fichier léger.
 *
 * **On ne prend que les millésimes de la même ANNÉE que les bâtiments en cache.**
 * L'attribution portée par chaque objet créé est une année : servir des piscines de
 * 2026 sous une attribution 2025 serait une attribution fausse, et la Licence Ouverte
 * ne s'en accommode pas. Si aucun millésime ne correspond, on rend une liste vide.
 */
export async function downloadPiscinesForYear(
  insee: string,
  annee: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown[]> {
  try {
    const millesimes = (await fetchMillesimes(fetchFn)).filter(d => d.startsWith(`${annee}-`));
    if (millesimes.length === 0) return [];
    const codes = arrondissementCodes(insee);
    const parts = await Promise.all(
      codes.map(code => downloadPiscines(code, millesimes[0]!, fetchFn)));
    return parts.flat();
  } catch {
    return [];
  }
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
): Promise<{ features: unknown[]; piscines: unknown[]; millesime: string }> {
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
      // Les piscines seulement une fois les bâtiments obtenus : leur absence ne doit
      // jamais empêcher un repli de millésime sur les bâtiments, qui sont l'essentiel.
      const piscines = await Promise.all(codes.map(code => downloadPiscines(code, millesime, fetchFn)));
      if (millesime !== candidats[0]) {
        console.warn(
          `[cadastre-id] ${insee} absent du millésime ${candidats[0]} ; repli sur ` +
          `${millesime}. Le dépôt est probablement en cours de republication.`,
        );
      }
      return { features: parts.flat(), piscines: piscines.flat(), millesime: millesime.slice(0, 4) };
    } catch (err) {
      if (!(err instanceof DatasetIntrouvable)) throw err;
      absence = err;
    }
  }

  throw absence;
}
