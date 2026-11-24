/**
 * Rechargement borné de l'éditeur quand le script est injecté trop tard.
 *
 * Constaté en réel (Firefox + Violentmonkey) : la CSP d'osm.org bloque l'injection
 * inline du gestionnaire, qui injecte alors de façon asynchrone — parfois après le
 * DOMContentLoaded de `/id`, donc après que osm.org a appelé `iD.coreContext()`. Le
 * contexte ne vit plus que dans une fermeture d'osm.org (voir injecteApresAmorcage) :
 * rien ne permet de le retrouver. Recharger l'iframe redonne une chance à l'injection ;
 * c'est sans risque à ce moment-là, l'éditeur vient de démarrer et ne porte encore
 * aucune modification. Seule l'iframe recharge : le cadre principal, dont l'onglet
 * MapRoulette lit l'URL, le référent et le type de navigation, n'est pas touché.
 *
 * Le compteur vit en `sessionStorage` (propre à l'onglet, survit au rechargement) : un
 * gestionnaire systématiquement en retard ne doit jamais faire recharger en boucle.
 * Sans stockage lisible, pas de compteur, donc pas de rechargement.
 */

/** Rechargements consécutifs tentés avant d'abandonner. */
export const RELANCES_MAX = 2;

const CLE = 'sb-osm:relances-injection-tardive';

/**
 * Recharge via `recharger` si le plafond n'est pas atteint. Rend le numéro de l'essai
 * lancé (1, 2…), ou 0 si rien n'a été rechargé. Ne lève jamais.
 */
export function relancerApresInjectionTardive(stockage: Storage | null, recharger: () => void): number {
  let essai: number;
  try {
    if (!stockage) return 0;
    const deja = Number(stockage.getItem(CLE) ?? '0');
    if (!Number.isFinite(deja) || deja >= RELANCES_MAX) return 0;
    essai = deja + 1;
    stockage.setItem(CLE, String(essai));
  } catch {
    return 0;
  }
  recharger();
  return essai;
}

/** Remet le compteur à zéro après une capture réussie. Ne lève jamais. */
export function oublierRelances(stockage: Storage | null): void {
  try {
    stockage?.removeItem(CLE);
  } catch {
    /* compteur non effacé : au pire, un prochain retard abandonnera plus tôt */
  }
}
