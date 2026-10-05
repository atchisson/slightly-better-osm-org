import type { LonLat } from '../geometry/types';

/**
 * Protocole des commandes de navigation entre onglets iD (voir `onglet.ts`).
 *
 * Pourquoi une commande et non un changement de `#…` dans l'URL d'iD : le hash est un
 * détail d'implémentation d'iD, qui peut changer sans préavis (`id=`, `map=`, les
 * paramètres reconnus au chargement mais pas au changement, comme `comment`). Une
 * commande porte une intention — « va ici, sélectionne cela, préremplis ceci » — dont
 * seul l'onglet principal sait comment l'exécuter dans la version d'iD qu'il a sous la main.
 *
 * Tout ce qui arrive est une donnée non fiable, même d'un autre onglet.
 * `lireCommande` ne rend qu'une commande reconstruite champ par champ, jamais l'objet
 * reçu.
 */
export const CANAL = 'sb-osm';

export interface Commande {
  canal: typeof CANAL;
  type: 'aller';
  /** centre et zoom de la carte ; absent = ne pas déplacer la carte */
  carte?: { zoom: number; centre: LonLat };
  /** objets OSM à sélectionner, au format d'iD : `n123`, `w456`, `r789` */
  ids?: string[];
  /** préremplissage du changeset */
  comment?: string;
  source?: string;
}

/** MapRoulette et ses sous-domaines : les seules pages dont un onglet peut transmettre une tâche. */
export const origineMapRoulette = (origin: string): boolean =>
  /^https:\/\/([a-z0-9-]+\.)*maproulette\.org$/.test(origin);

const MAX_TEXTE = 2000;
const MAX_IDS = 50;
const ID_OSM = /^[nwr]\d{1,15}$/;

const texte = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= MAX_TEXTE ? v : undefined;

/**
 * Valide un message reçu et le reconstruit en `Commande`, ou rend `null`.
 *
 * Les coordonnées doivent être finies et dans le globe, le zoom dans [0, 24], les
 * identifiants de la forme `n|w|r` suivie de chiffres : rien de ce qui est reçu n'est
 * transmis tel quel à iD.
 */
export function lireCommande(data: unknown): Commande | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || d.canal !== CANAL || d.type !== 'aller') return null;

  const cmd: Commande = { canal: CANAL, type: 'aller' };

  const c = d.carte as { zoom?: unknown; centre?: unknown } | undefined;
  if (c && typeof c === 'object') {
    const [lon, lat] = Array.isArray(c.centre) ? c.centre : [];
    const zoom = c.zoom;
    if (
      typeof lon === 'number' && typeof lat === 'number' && typeof zoom === 'number' &&
      Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(zoom) &&
      Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && zoom >= 0 && zoom <= 24
    ) {
      cmd.carte = { zoom, centre: [lon, lat] };
    }
  }

  if (Array.isArray(d.ids)) {
    const ids = d.ids.filter((i): i is string => typeof i === 'string' && ID_OSM.test(i));
    if (ids.length > 0) cmd.ids = ids.slice(0, MAX_IDS);
  }

  const comment = texte(d.comment);
  if (comment !== undefined) cmd.comment = comment;
  const source = texte(d.source);
  if (source !== undefined) cmd.source = source;

  // Une commande sans aucun effet n'est pas une commande.
  if (!cmd.carte && !cmd.ids && cmd.comment === undefined && cmd.source === undefined) return null;
  return cmd;
}
