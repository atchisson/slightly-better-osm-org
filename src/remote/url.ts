import { CANAL, lireCommande } from './protocol';
import type { Commande } from './protocol';

/**
 * Construit une commande à partir de l'URL d'un onglet iD ouvert par MapRoulette.
 *
 * MapRoulette ouvre `…/edit?editor=id[&node=ID|&way=ID|&relation=ID]#map=Z/LAT/LON&comment=…&source=…` :
 * l'objet à sélectionner est un paramètre de REQUÊTE (avant le `#`), la carte, le
 * commentaire et la source sont dans le hash. On lit aussi `id=n1,w2,r3` du hash, la forme
 * qu'iD écrit lui-même.
 *
 * Ce n'est qu'un « brouillon » : il passe par `lireCommande`, qui valide et reconstruit
 * tout (bornes de la carte, forme des identifiants, taille des textes). Rend `null` si
 * l'URL est illisible ou n'a rien d'utile.
 */
export function commandeDepuisUrl(href: string): Commande | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));

  const brut: Record<string, unknown> = { canal: CANAL, type: 'aller' };

  // `map=zoom/lat/lon`, et l'ordre du centre d'une commande est [lon, lat].
  const map = hash.get('map')?.split('/');
  if (map && map.length === 3 && map.every(p => p.trim() !== '')) {
    const [zoom, lat, lon] = map.map(Number);
    brut.carte = { zoom, centre: [lon, lat] };
  }

  const ids: string[] = [];
  const ajouter = (prefixe: string, liste: string | null): void => {
    for (const v of (liste ?? '').split(',')) if (/^\d+$/.test(v)) ids.push(prefixe + v);
  };
  ajouter('n', url.searchParams.get('node'));
  ajouter('w', url.searchParams.get('way'));
  ajouter('r', url.searchParams.get('relation'));
  // `id=` du hash est déjà préfixé ; `lireCommande` écarte ce qui n'a pas la bonne forme.
  for (const v of (hash.get('id') ?? '').split(',')) if (v) ids.push(v);
  if (ids.length > 0) brut.ids = ids;

  const comment = hash.get('comment');
  if (comment !== null) brut.comment = comment;
  const source = hash.get('source');
  if (source !== null) brut.source = source;

  return lireCommande(brut);
}
