import { captureContext, makeBridge } from './bridge/capture';
import { createMode } from './mode';
import { createButton } from './ui/button';
import type { LonLat } from './geometry/types';

const log = (...a: unknown[]) => console.log('[cadastre-id]', ...a);

void (async () => {
  let bridge;
  try {
    bridge = makeBridge(await captureContext());
  } catch (err) {
    console.warn('[cadastre-id] désactivé :', (err as Error).message,
      '— iD a probablement changé ; voir https://github.com/alenoir/cadastre-id');
    return;
  }

  const container = bridge.containerNode();
  const mode = createMode(bridge, { notify: m => window.alert(m) });

  const surface = (container.querySelector('svg.surface') ?? container) as HTMLElement | SVGElement;

  // offsetX/offsetY sont relatifs à e.target, pas forcément à `surface` : dans un SVG,
  // e.target est souvent un élément descendant (un <path>, un <g>...) dont l'origine
  // peut différer de celle de la surface. On mesure donc l'origine de `surface`
  // elle-même via getBoundingClientRect() et on convertit depuis les coordonnées
  // écran absolues (clientX/clientY), qui elles ne dépendent jamais de la cible.
  const toLonLat = (e: MouseEvent): LonLat => {
    const rect = surface.getBoundingClientRect();
    return bridge.invert([e.clientX - rect.left, e.clientY - rect.top]);
  };

  let frame = 0;
  surface.addEventListener('mousemove', (e) => {
    if (!mode.isEnabled()) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => mode.hoverAt(toLonLat(e as MouseEvent)));
  });

  // Le curseur qui quitte la carte est un des chemins de sortie de l'overlay (voir
  // src/mode.ts) : sans ce signal, le dernier contour survolé resterait affiché,
  // pointant vers un endroit que le curseur a quitté.
  surface.addEventListener('mouseleave', () => {
    if (!mode.isEnabled()) return;
    cancelAnimationFrame(frame);
    mode.hoverEnd();
  });

  surface.addEventListener('click', (e) => {
    if (!mode.isEnabled()) return;
    void mode.clickAt(toLonLat(e as MouseEvent));
  });

  createButton(container, on => (on ? mode.enable() : mode.disable()));
  log('prêt');
})();
