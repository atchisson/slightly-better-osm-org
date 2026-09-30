// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Migration du cache : une entrée écrite avant les surfaces porte `piscines` (ou rien).
const mocks = vi.hoisted(() => ({
  readCache: vi.fn(),
  writeCache: vi.fn(async () => {}),
  downloadCommune: vi.fn(),
  downloadSurfacesForYear: vi.fn(),
}));
vi.mock('../src/cadastre/insee', () => ({
  communeAt: vi.fn(async () => ({ code: '49007', nom: 'Angers' })),
}));
vi.mock('../src/cadastre/store', () => ({ readCache: mocks.readCache, writeCache: mocks.writeCache }));
vi.mock('../src/cadastre/download', () => ({
  downloadCommune: mocks.downloadCommune,
  downloadSurfacesForYear: mocks.downloadSurfacesForYear,
  SYM_PISCINE: 65, // lu par cadastre/dataset.ts
}));

import { createMode } from '../src/mode';
import type { IdBridge } from '../src/bridge/types';

const batiment = {
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]] },
  properties: { type: '01' },
};
// Une surface (symbole 65 = piscine) à l'abscisse x, pour reconnaître d'où elle vient.
const surface = (x: number) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[x, 0], [x + 0.001, 0], [x + 0.001, 0.001], [x, 0.001], [x, 0]]] },
  properties: { SYM: 65 },
});

/** Charge la commune par le chemin par défaut et dit si un contour apparaît au survol de x. */
async function survole(x: number): Promise<boolean> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const bridge = {
    mapExtent: () => [[0, 0], [0.01, 0.01]],
    project: (p: number[]) => [p[0]! * 1000, p[1]! * 1000],
    invert: (p: number[]) => [p[0]! / 1000, p[1]! / 1000],
    onMapMove: () => () => {},
    buildingsNear: () => [],
    nodesIn: () => [],
    containerNode: () => container,
    whenSurfaceReady: () => Promise.resolve(true),
    surfaceNode: () => container,
  } as unknown as IdBridge;
  const notify = vi.fn();
  const mode = createMode(bridge, { notify });
  mode.enable();
  await mode.whenReady();
  await Promise.resolve();
  mode.hoverAt([x + 0.0005, 0.0005]);
  // Un chargement en échec notifie : le verdict serait alors trompeur.
  expect(notify).not.toHaveBeenCalled();
  return (container.querySelector('path')?.getAttribute('d') ?? '') !== '';
}

describe('defaultLoadDataset — migration du cache vers les surfaces', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('entrée avec `surfaces` : utilisée telle quelle, sans téléchargement', async () => {
    mocks.readCache.mockResolvedValue({ insee: '49007', millesime: '2026', fetchedAt: 1, features: [batiment], surfaces: [surface(0.005)] });
    expect(await survole(0.005)).toBe(true);
    expect(mocks.downloadSurfacesForYear).not.toHaveBeenCalled();
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });

  it('entrée héritée avec `piscines` seules : complément téléchargé, utilisé, réécrit sans `piscines`', async () => {
    mocks.readCache.mockResolvedValue({ insee: '49007', millesime: '2026', fetchedAt: 1, features: [batiment], piscines: [surface(0.003)] });
    mocks.downloadSurfacesForYear.mockResolvedValue([surface(0.005)]);
    expect(await survole(0.005)).toBe(true);
    expect(mocks.downloadSurfacesForYear).toHaveBeenCalledWith('49007', '2026');
    expect(mocks.writeCache).toHaveBeenCalledOnce();
    const ecrit = (mocks.writeCache.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(ecrit.surfaces).toEqual([surface(0.005)]);
    expect('piscines' in ecrit).toBe(false);
  });

  it('entrée sans `surfaces` ni `piscines` : même complément, même réécriture', async () => {
    mocks.readCache.mockResolvedValue({ insee: '49007', millesime: '2026', fetchedAt: 1, features: [batiment] });
    mocks.downloadSurfacesForYear.mockResolvedValue([surface(0.005)]);
    expect(await survole(0.005)).toBe(true);
    expect(mocks.writeCache).toHaveBeenCalledOnce();
    const ecrit = (mocks.writeCache.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(ecrit.surfaces).toEqual([surface(0.005)]);
    expect('piscines' in ecrit).toBe(false);
  });

  it('complément vide : cache non réécrit, et les `piscines` héritées servent de repli pour la session', async () => {
    mocks.readCache.mockResolvedValue({ insee: '49007', millesime: '2026', fetchedAt: 1, features: [batiment], piscines: [surface(0.003)] });
    mocks.downloadSurfacesForYear.mockResolvedValue([]);
    expect(await survole(0.003)).toBe(true);
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });
});
