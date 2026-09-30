// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createLoadingBanner } from '../../src/ui/loading';
import type { IdBridge } from '../../src/bridge/types';

const pont = (conteneur: HTMLElement) => ({ containerNode: () => conteneur }) as unknown as IdBridge;

describe('bandeau de chargement', () => {
  it('est caché à la création, visible après show, caché après hide', () => {
    const c = document.createElement('div');
    const b = createLoadingBanner(pont(c));
    const el = c.querySelector('.sb-osm-loading') as HTMLElement;
    expect(el.style.display).toBe('none');
    b.show();
    expect(el.style.display).not.toBe('none');
    expect(el.textContent).toMatch(/chargement du cadastre/i);
    b.hide();
    expect(el.style.display).toBe('none');
  });

  it('destroy retire l’élément', () => {
    const c = document.createElement('div');
    createLoadingBanner(pont(c)).destroy();
    expect(c.querySelector('.sb-osm-loading')).toBeNull();
  });
});
