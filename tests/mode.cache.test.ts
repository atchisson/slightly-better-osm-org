// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/cadastre/insee', () => ({
  communeAt: vi.fn(async () => ({ code: '49007', nom: 'Angers' })),
}));
vi.mock('../src/cadastre/store', () => ({
  readCache: vi.fn(async () => null),
  writeCache: vi.fn(async () => { throw new Error('QuotaExceededError'); }),
}));
vi.mock('../src/cadastre/download', () => ({
  downloadCommune: vi.fn(async () => ({
    features: [{
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]] },
      properties: { type: '01' },
    }],
    millesime: '2026',
  })),
}));

import { createMode } from '../src/mode';
import type { IdBridge } from '../src/bridge/types';

describe('chargement par défaut — le cache ne peut jamais faire échouer le chargement', () => {
  let container: HTMLElement;
  let bridge: IdBridge;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    bridge = {
      mapExtent: () => [[0, 0], [0.01, 0.01]],
      project: p => [p[0] * 1000, p[1] * 1000],
      invert: p => [p[0] / 1000, p[1] / 1000],
      onMapMove: () => () => {},
      buildingsNear: () => [],
      nodesIn: () => [],
      createBuilding: () => {},
      prefillChangeset: vi.fn(),
      containerNode: () => container,
      whenSurfaceReady: () => Promise.resolve(true),
      surfaceNode: () => container,
      toolbarSlot: () => null,
      cadastreVisible: () => true,
    };
  });

  // I6 : `await writeCache(...)` était sur le chemin de retour de defaultLoadDataset.
  // Un refus d'IndexedDB — dépassement de quota, vraisemblable sur Paris ou Marseille et
  // leur centaine de Mo de features sérialisées — faisait échouer le chargement APRÈS un
  // téléchargement réussi, et la personne lisait « vérifiez votre connexion » alors que
  // le réseau avait parfaitement fonctionné.
  it('ne dit pas « vérifiez votre connexion » après un téléchargement réussi', async () => {
    const notify = vi.fn();
    const mode = createMode(bridge, { notify });
    mode.enable();
    await mode.whenReady();
    await Promise.resolve();

    expect(notify).not.toHaveBeenCalled();
    // et le jeu de donnees est bien la : le survol montre un contour
    mode.hoverAt([0.0005, 0.0005]);
    expect(container.querySelector('path')!.getAttribute('d')).not.toBe('');
  });
});
