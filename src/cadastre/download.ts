import { arrondissementCodes, departementOf } from './insee';
import { etape } from './etape';

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
 * Couche des surfaces topographiques du PCI : elle porte TOUTES les surfaces
 * topographiques, les piscines n'en étant qu'une (code symbole 65).
 *
 * Elles ne sont PAS dans la couche bâtiments — vérifié : celle-ci ne porte que les
 * types `01` et `02`. Elles vivent dans `tsurf`, sous le dossier `raw/` du dépôt, et
 * s'y reconnaissent au code symbole 65 (voir `SYM_PISCINE`).
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
export const SYM_PISCINE = '65';

/** Le jeu demandé n'existe pas à ce millésime — distinct de toute autre panne. */
export class DatasetIntrouvable extends Error {
  /** Traverse `etape` sans être enveloppée : le repli de millésime la reconnaît à son type. */
  readonly intacte = true;
}

/**
 * Où en est le chargement d'une commune. `recu` et `total` sont des octets COMPRESSÉS :
 * le bucket sert ses `.json.gz` sans `Content-Encoding`, donc `Content-Length` est
 * exactement ce qui transite. `total` vaut null tant que la taille d'un des fichiers de
 * l'étape est inconnue (en-tête absent, ou pas encore reçu pour Paris et ses vingt
 * arrondissements) : un pourcentage calculé sur une partie des fichiers sauterait en
 * arrière à l'arrivée des suivants.
 */
export type Progression =
  | { etape: 'batiments' | 'surfaces'; recu: number; total: number | null }
  | { etape: 'preparation' };

export type SuiviProgression = (p: Progression) => void;

/** Compte les octets reçus sur les `n` fichiers d'une étape, téléchargés en parallèle. */
interface Compteur {
  entete(res: Response): void;
  /** Des octets compressés viennent d'arriver. */
  recu(octets: number): void;
}

const SANS_SUIVI: Compteur = { entete() {}, recu() {} };

/**
 * Lit un GeoJSON gzippé.
 *
 * Le corps reçu n'est lu QUE par son propre lecteur, et n'est jamais branché sur un autre
 * flux. Depuis le monde isolé de Firefox, il appartient au greffon alors que
 * `DecompressionStream`, `Blob` et `TextDecoder` appartiennent à la page (constaté dans
 * Firefox 159) : `body.pipeThrough(new DecompressionStream())` y avorte
 * (« AbortError : The operation was aborted. »), et la page refuse les octets du greffon
 * écrits un à un dans son flux. Rassemblés dans un `Blob`, ces mêmes octets passent ;
 * flux, décompression et lecture restent alors du même côté. Partout ailleurs (monde de
 * la page, Chrome, tests), ce chemin est simplement ordinaire.
 */
async function lireGeoJson(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  c: Compteur,
): Promise<{ features?: unknown[] }> {
  const morceaux = await etape('réception', () => lireOctets(body, c));
  const texte = await etape('décompression', () => decompresserGzip(morceaux));
  return etape('analyse JSON', async () => JSON.parse(texte) as { features?: unknown[] });
}

/** Tout le corps, morceau par morceau, en comptant les octets au passage. */
async function lireOctets(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  c: Compteur,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const lecteur = body.getReader();
  const morceaux: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const lu = await lecteur.read();
    if (lu.done) return morceaux;
    morceaux.push(lu.value);
    c.recu(lu.value.byteLength);
  }
}

async function decompresserGzip(morceaux: Uint8Array<ArrayBuffer>[]): Promise<string> {
  const lecteur = new Blob(morceaux).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decodeur = new TextDecoder();
  let texte = '';
  for (;;) {
    const lu = await lecteur.read();
    if (lu.done) return texte + decodeur.decode();
    texte += decodeur.decode(lu.value, { stream: true });
  }
}

function compteur(etape: 'batiments' | 'surfaces', n: number, suivi?: SuiviProgression): Compteur {
  if (!suivi) return SANS_SUIVI;
  let recu = 0;
  let total = 0;
  let connus = 0;
  let inconnu = false;
  const emettre = () => suivi({ etape, recu, total: connus === n && !inconnu ? total : null });
  return {
    entete(res) {
      // Un fichier absent (tsurf en 404) ne transmettra rien : il compte pour zéro.
      if (res.ok && res.body) {
        const taille = Number(res.headers?.get?.('content-length'));
        if (taille > 0) total += taille; else inconnu = true;
      }
      connus++;
      emettre();
    },
    // Compté dans la lecture même du corps (voir lireGeoJson), sans `TransformStream` :
    // depuis le monde isolé de Firefox, c'est le constructeur de la PAGE, qui ne peut pas
    // lire l'objet du greffon (« Permission denied to access property "flush" »).
    recu(octets) {
      recu += octets;
      emettre();
    },
  };
}

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
  return etape('listing du dépôt', async () => {
    const res = await fetchFn(LISTING_URL);
    if (!res.ok) throw new Error(`le dépôt cadastre a répondu ${res.status} au listing`);
    return millesimesFromListing(await res.text());
  });
}

/**
 * Toutes les surfaces d'une commune à un millésime donné.
 *
 * Aucun filtre ici : les codes symbole sont triés à la construction du jeu (piscine ou
 * surface générique, voir `toSurfaces`).
 *
 * Une couche absente n'est pas une panne : toutes les communes n'ont pas de fichier
 * `tsurf`. On rend alors une liste vide plutôt que de faire échouer le chargement des
 * bâtiments.
 */
async function downloadSurfaces(
  insee: string,
  millesime: string,
  fetchFn: typeof fetch,
  c: Compteur = SANS_SUIVI,
): Promise<unknown[]> {
  try {
    const res = await fetchFn(tsurfUrl(insee, millesime));
    c.entete(res);
    if (!res.ok || !res.body) return [];
    return (await lireGeoJson(res.body, c)).features ?? [];
  } catch {
    return [];
  }
}

/**
 * Surfaces seules, pour une commune dont les bâtiments sont déjà en cache.
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
export async function downloadSurfacesForYear(
  insee: string,
  annee: string,
  fetchFn: typeof fetch = fetch,
  suivi?: SuiviProgression,
): Promise<unknown[]> {
  try {
    const millesimes = (await fetchMillesimes(fetchFn)).filter(d => d.startsWith(`${annee}-`));
    if (millesimes.length === 0) return [];
    const codes = arrondissementCodes(insee);
    const c = compteur('surfaces', codes.length, suivi);
    const parts = await Promise.all(
      codes.map(code => downloadSurfaces(code, millesimes[0]!, fetchFn, c)));
    return parts.flat();
  } catch {
    return [];
  }
}

async function downloadOne(
  insee: string,
  millesime: string,
  fetchFn: typeof fetch,
  c: Compteur,
): Promise<unknown[]> {
  return etape(`bâtiments ${insee}`, () => downloadOneEtapes(insee, millesime, fetchFn, c));
}

async function downloadOneEtapes(
  insee: string,
  millesime: string,
  fetchFn: typeof fetch,
  c: Compteur,
): Promise<unknown[]> {
  const res = await etape('requête', () => fetchFn(datasetUrl(insee, millesime)));
  c.entete(res);
  if (res.status === 404) {
    throw new DatasetIntrouvable(`${insee} absent du millésime ${millesime}`);
  }
  if (!res.ok) throw new Error(`le dépôt cadastre a répondu ${res.status} pour ${insee}`);
  if (!res.body) throw new Error('réponse sans corps');

  // Le fichier est gzippé mais servi sans `Content-Encoding` (Content-Type
  // application/octet-stream) : le navigateur ne le décompresse donc pas tout seul.
  return (await lireGeoJson(res.body, c)).features ?? [];
}

export async function downloadCommune(
  insee: string,
  fetchFn: typeof fetch = fetch,
  suivi?: SuiviProgression,
): Promise<{ features: unknown[]; surfaces: unknown[]; millesime: string }> {
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
      // Un compteur neuf par millésime essayé : un repli repart de zéro.
      const cb = compteur('batiments', codes.length, suivi);
      const parts = await Promise.all(codes.map(code => downloadOne(code, millesime, fetchFn, cb)));
      // Les surfaces seulement une fois les bâtiments obtenus : leur absence ne doit
      // jamais empêcher un repli de millésime sur les bâtiments, qui sont l'essentiel.
      const cs = compteur('surfaces', codes.length, suivi);
      const surfaces = await Promise.all(codes.map(code => downloadSurfaces(code, millesime, fetchFn, cs)));
      if (millesime !== candidats[0]) {
        console.warn(
          `[sb-osm] ${insee} absent du millésime ${candidats[0]} ; repli sur ` +
          `${millesime}. Le dépôt est probablement en cours de republication.`,
        );
      }
      return { features: parts.flat(), surfaces: surfaces.flat(), millesime: millesime.slice(0, 4) };
    } catch (err) {
      if (!(err instanceof DatasetIntrouvable)) throw err;
      absence = err;
    }
  }

  throw absence;
}
