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

  it('affiche l’étape, les mégaoctets et une barre remplie au prorata', () => {
    const c = document.createElement('div');
    const b = createLoadingBanner(pont(c));
    const el = c.querySelector('.sb-osm-loading') as HTMLElement;
    const remplissage = c.querySelector('.sb-osm-loading-barre > div') as HTMLElement;

    b.progression({ etape: 'batiments', recu: 3_200_000, total: 8_000_000 });
    expect(el.textContent).toContain('bâtiments');
    expect(el.textContent).toContain('3,2 / 8,0 Mo');
    expect(remplissage.style.width).toBe('40%');

    b.progression({ etape: 'surfaces', recu: 500_000, total: null });
    expect(el.textContent).toContain('surfaces');
    expect(el.textContent).toContain('0,5 Mo');
    // taille inconnue : pas de pourcentage inventé, la barre défile
    expect(remplissage.style.animationName).toBe('sb-osm-defile');

    b.progression({ etape: 'preparation' });
    expect(el.textContent).toMatch(/préparation/i);

    b.progression(null);
    expect(el.textContent).toBe('Chargement du cadastre…');
  });

  it('destroy retire l’élément', () => {
    const c = document.createElement('div');
    createLoadingBanner(pont(c)).destroy();
    expect(c.querySelector('.sb-osm-loading')).toBeNull();
  });
});
