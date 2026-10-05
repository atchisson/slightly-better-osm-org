import { CANAL, lireCommande, origineMapRoulette } from './protocol';
import type { Commande } from './protocol';
import { commandeDepuisUrl } from './url';

/**
 * Ce qu'on sait faire d'une commande. L'implémentation vit dans `src/bridge/`
 * (`makeNavigation`) : c'est là, et là seulement, qu'on touche à iD.
 */
export interface Navigation {
  aller(cmd: Commande): void;
}

/** Nom du verrou Web Locks qui désigne l'onglet principal, et du canal entre onglets. */
const NOM_VERROU = 'sb-osm-onglet-principal';
const NOM_CANAL = 'sb-osm-onglet';

interface Verrous {
  request(
    name: string,
    options: { ifAvailable: boolean },
    cb: (lock: unknown | null) => unknown,
  ): Promise<unknown>;
}

interface Canal {
  postMessage(m: unknown): void;
  addEventListener(t: 'message', f: (e: { data: unknown }) => void): void;
  close(): void;
}

export interface Dependances {
  nav: Navigation;
  /** URL du cadre principal de l'onglet (celle que MapRoulette a ouverte). */
  href: string;
  /** Référent du cadre principal : la page d'où l'onglet a été ouvert, ou ''. */
  referrer: string;
  locks?: Verrous;
  creerCanal?: (nom: string) => Canal;
  /** Ferme l'onglet courant. Peut lever : l'appelant n'en dépend pas. */
  fermer: () => void;
  /** Attente maximale de l'accusé de l'onglet principal. */
  delaiAccuseMs?: number;
  aleatoire?: () => string;
}

export type Role = 'principal' | 'transmis' | 'ordinaire';

const log = (...a: unknown[]) => console.info('[sb-osm]', ...a);

/**
 * Plusieurs tâches MapRoulette dans un seul onglet iD, malgré le COOP d'openstreetmap.org.
 *
 * `openstreetmap.org` répond `Cross-Origin-Opener-Policy: same-origin` : le lien entre la
 * page MapRoulette et l'onglet qu'elle ouvre est coupé (`window.opener` est `null`, pas
 * de `postMessage`, pas de `close()`). Tout se joue donc entre onglets iD, de même origine :
 *
 * - le premier onglet à obtenir le verrou Web Locks `sb-osm-onglet-principal` est
 *   l'ONGLET PRINCIPAL ; il le garde tant qu'il vit (le navigateur le libère à sa mort,
 *   un autre onglet pourra alors le prendre) et écoute le canal `sb-osm-onglet` ;
 * - un onglet qui n'obtient pas le verrou ET vient de MapRoulette transmet sa commande
 *   (carte, objet, commentaire, source tirés de son URL) au principal, attend l'accusé,
 *   puis se ferme : seul un onglet ouvert par un lien peut se fermer lui-même, et c'est
 *   le cas de celui-là ;
 * - tout autre onglet (ouvert à la main) reste ordinaire et ne se ferme jamais.
 *
 * Sans accusé (principal gelé, disparu entre-temps), rien n'est fermé : l'onglet reste
 * un onglet iD ordinaire, le comportement d'origine. Sans Web Locks ni BroadcastChannel,
 * on ne fait rien non plus.
 */
export async function installerOngletPrincipal(deps: Dependances): Promise<Role> {
  const locks = deps.locks ?? (globalThis as { navigator?: { locks?: Verrous } }).navigator?.locks;
  const creerCanal = deps.creerCanal ??
    (typeof BroadcastChannel === 'function' ? (nom: string) => new BroadcastChannel(nom) as Canal : undefined);
  if (!locks || !creerCanal) {
    log('onglet ordinaire');
    return 'ordinaire';
  }

  const principal = await new Promise<boolean>(resolve => {
    void locks.request(NOM_VERROU, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      return new Promise(() => {});   // le verrou est tenu tant que l'onglet vit
    });
  });

  const vientDeMapRoulette = (() => {
    try { return origineMapRoulette(new URL(deps.referrer).origin); } catch { return false; }
  })();

  if (principal) {
    const canal = creerCanal(NOM_CANAL);
    canal.addEventListener('message', e => {
      // Ce qui arrive est une donnée non fiable, même d'un onglet de même origine.
      const d = e.data as { id?: unknown } | null;
      const cmd = lireCommande(d);
      if (!cmd || typeof d?.id !== 'string') return;
      try {
        deps.nav.aller(cmd);
      } catch (err) {
        console.warn('[sb-osm] commande de navigation en échec :', err);
      }
      canal.postMessage({ canal: CANAL, type: 'recu', id: d.id });
    });
    log('onglet principal');

    // Le commentaire et la source de la PREMIÈRE tâche ne sont que dans l'URL de cet
    // onglet : la carte et l'objet, eux, sont déjà appliqués par iD au chargement.
    if (vientDeMapRoulette) {
      const url = commandeDepuisUrl(deps.href);
      const reduite = lireCommande({ canal: CANAL, type: 'aller', comment: url?.comment, source: url?.source });
      if (reduite) {
        try {
          deps.nav.aller(reduite);
        } catch (err) {
          console.warn('[sb-osm] commande de navigation en échec :', err);
        }
      }
    }
    return 'principal';
  }

  const commande = vientDeMapRoulette ? commandeDepuisUrl(deps.href) : null;
  if (!commande) {
    log('onglet ordinaire');
    return 'ordinaire';
  }

  const id = (deps.aleatoire ?? (() => Math.random().toString(36).slice(2)))();
  const canal = creerCanal(NOM_CANAL);
  const accuse = await new Promise<boolean>(resolve => {
    const minuterie = setTimeout(() => resolve(false), deps.delaiAccuseMs ?? 3000);
    // L'écouteur d'abord, l'envoi ensuite : l'accusé ne doit pas pouvoir nous précéder.
    canal.addEventListener('message', e => {
      const d = e.data as { canal?: unknown; type?: unknown; id?: unknown } | null;
      if (d && typeof d === 'object' && d.canal === CANAL && d.type === 'recu' && d.id === id) {
        clearTimeout(minuterie);
        resolve(true);
      }
    });
    canal.postMessage({ ...commande, id });
  });
  canal.close();

  if (!accuse) {
    log('onglet ordinaire');
    return 'ordinaire';
  }
  log("commande transmise à l'onglet principal");
  try {
    deps.fermer();
  } catch { /* fermeture refusée : l'onglet reste ouvert, la tâche est déjà transmise */ }
  return 'transmis';
}
