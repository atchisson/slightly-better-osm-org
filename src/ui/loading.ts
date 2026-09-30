import type { IdBridge } from '../bridge/types';

/**
 * Bandeau « Chargement du cadastre… ».
 *
 * Le premier chargement d'une commune prend plusieurs secondes (téléchargement,
 * décompression, index) : sans signe visible, le mode paraît inerte. Le bandeau vit dans
 * le conteneur d'iD, hors de ses calques, comme l'overlay ; il ne capte aucun clic.
 */
export interface LoadingBanner {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createLoadingBanner(bridge: IdBridge): LoadingBanner {
  const el = document.createElement('div');
  el.className = 'sb-osm-loading';
  el.textContent = 'Chargement du cadastre…';
  el.style.cssText =
    'position:absolute;top:60px;left:50%;transform:translateX(-50%);z-index:60;' +
    'padding:6px 14px;border-radius:4px;background:rgba(30,30,30,0.85);color:#fff;' +
    'font:13px sans-serif;pointer-events:none;display:none';
  bridge.containerNode().appendChild(el);
  return {
    show() { el.style.display = 'block'; },
    hide() { el.style.display = 'none'; },
    destroy() { el.remove(); },
  };
}
