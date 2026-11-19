import type { IdBridge } from '../bridge/types';
import type { Progression } from '../cadastre/download';

/**
 * Bandeau « Chargement du cadastre… », avec sa barre de progression.
 *
 * Le premier chargement d'une commune prend plusieurs secondes (téléchargement,
 * décompression, index) : sans signe visible, le mode paraît inerte. Le bandeau vit dans
 * le conteneur d'iD, hors de ses calques, comme l'overlay ; il ne capte aucun clic.
 *
 * La barre suit les octets reçus quand leur total est connu. Sinon (taille inconnue,
 * préparation de l'index) elle défile : un pourcentage inventé serait pire que rien.
 */
export interface LoadingBanner {
  show(): void;
  hide(): void;
  /** null : retour au libellé seul, au départ d'un nouveau chargement. */
  progression(p: Progression | null): void;
  destroy(): void;
}

const LIBELLE = 'Chargement du cadastre…';
const ID_STYLE = 'sb-osm-loading-style';

const mo = (octets: number): string => (octets / 1e6).toFixed(1).replace('.', ',');

function poserAnimation(doc: Document): void {
  if (doc.getElementById(ID_STYLE)) return;
  const style = doc.createElement('style');
  style.id = ID_STYLE;
  style.textContent =
    '@keyframes sb-osm-defile{from{transform:translateX(-100%)}to{transform:translateX(340%)}}';
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function createLoadingBanner(bridge: IdBridge): LoadingBanner {
  const conteneur = bridge.containerNode();
  poserAnimation(conteneur.ownerDocument);

  const el = document.createElement('div');
  el.className = 'sb-osm-loading';
  el.style.cssText =
    'position:absolute;top:60px;left:50%;transform:translateX(-50%);z-index:60;' +
    'padding:6px 14px;border-radius:4px;background:rgba(30,30,30,0.85);color:#fff;' +
    'font:13px sans-serif;pointer-events:none;display:none;min-width:240px;text-align:center';

  const texte = document.createElement('div');
  texte.textContent = LIBELLE;

  const barre = document.createElement('div');
  barre.className = 'sb-osm-loading-barre';
  barre.style.cssText =
    'margin-top:5px;height:4px;border-radius:2px;background:rgba(255,255,255,0.25);' +
    'overflow:hidden;display:none';
  const remplissage = document.createElement('div');
  remplissage.style.cssText = 'height:100%;background:#7ec8ff;border-radius:2px';
  barre.appendChild(remplissage);

  el.append(texte, barre);
  conteneur.appendChild(el);

  const determinee = (fraction: number): void => {
    remplissage.style.animationName = '';
    remplissage.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  };
  const defilante = (): void => {
    remplissage.style.width = '30%';
    remplissage.style.animationName = 'sb-osm-defile';
    remplissage.style.animationDuration = '1.2s';
    remplissage.style.animationTimingFunction = 'linear';
    remplissage.style.animationIterationCount = 'infinite';
  };

  return {
    show() { el.style.display = 'block'; },
    hide() { el.style.display = 'none'; },
    progression(p) {
      if (p === null) {
        texte.textContent = LIBELLE;
        barre.style.display = 'none';
        return;
      }
      barre.style.display = 'block';
      if (p.etape === 'preparation') {
        texte.textContent = 'Chargement du cadastre — préparation…';
        defilante();
        return;
      }
      const quoi = p.etape === 'batiments' ? 'bâtiments' : 'surfaces';
      if (p.total !== null && p.total > 0) {
        texte.textContent = `Chargement du cadastre — ${quoi} : ${mo(p.recu)} / ${mo(p.total)} Mo`;
        determinee(p.recu / p.total);
      } else {
        texte.textContent = `Chargement du cadastre — ${quoi} : ${mo(p.recu)} Mo`;
        defilante();
      }
    },
    destroy() { el.remove(); },
  };
}
