// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createOverlay } from '../../src/ui/overlay';
import type { IdBridge } from '../../src/bridge/types';
import type { Ring } from '../../src/geometry/types';

const carre: Ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

const fauxBridge = (container: HTMLElement): IdBridge => ({
  mapExtent: () => [[0, 0], [1, 1]],
  project: (p) => [p[0] * 100, p[1] * 100],
  invert: (p) => [p[0] / 100, p[1] / 100],
  onMapMove: () => () => {},
  buildingsNear: () => [],
  nodesNear: () => [],
  createBuilding: () => {},
  prefillChangeset: () => {},
  containerNode: () => container,
});

describe('overlay', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('n’affiche rien tant qu’on n’a rien montré', () => {
    createOverlay(fauxBridge(container));
    expect(container.querySelector('path')?.getAttribute('d')).toBeFalsy();
  });

  it('trace le contour projeté', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    const d = container.querySelector('path')!.getAttribute('d')!;
    expect(d).toContain('M 0 0');
    expect(d).toContain('100 0');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('distingue visuellement un refus', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    const okClass = container.querySelector('path')!.getAttribute('class');
    o.show(carre, 'refus');
    expect(container.querySelector('path')!.getAttribute('class')).not.toBe(okClass);
  });

  it('efface le contour', () => {
    const o = createOverlay(fauxBridge(container));
    o.show(carre, 'ok');
    o.hide();
    expect(container.querySelector('path')!.getAttribute('d')).toBe('');
  });

  it('se retire proprement', () => {
    const o = createOverlay(fauxBridge(container));
    o.destroy();
    expect(container.querySelector('svg')).toBeNull();
  });
});
