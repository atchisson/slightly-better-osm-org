import { describe, it, expect, vi } from 'vitest';
import { datasetUrl, millesimeFromUrl, downloadCommune } from '../../src/cadastre/download';

describe('datasetUrl', () => {
  it('construit l’URL Etalab depuis le code INSEE', () => {
    expect(datasetUrl('49007')).toBe(
      'https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/49/49007/cadastre-49007-batiments.json.gz');
  });

  it('gère un code corse', () => {
    expect(datasetUrl('2A004')).toContain('/communes/2A/2A004/');
  });
});

describe('millesimeFromUrl', () => {
  it('extrait l’année du chemin daté', () => {
    expect(millesimeFromUrl('https://x/etalab-cadastre/2026-06-01/geojson/communes/49/…')).toBe('2026');
  });

  it('jette plutôt que d’inventer un millésime', () => {
    expect(() => millesimeFromUrl('https://x/etalab-cadastre/latest/geojson/…')).toThrow(/millésime/i);
  });
});

describe('downloadCommune', () => {
  // Le brief renvoyait `new Uint8Array(await res.arrayBuffer())`, mais sous TypeScript
  // 5.9.3 (strict) ce Uint8Array s'infère `Uint8Array<ArrayBufferLike>`, incompatible
  // avec `BlobPart` (qui exige `ArrayBufferView<ArrayBuffer>`) — `npm run typecheck`
  // échoue sinon. Renvoyer l'ArrayBuffer tel quel produit les mêmes octets sans ce
  // décalage de type ; le comportement du test est inchangé.
  const gzip = async (text: string): Promise<ArrayBuffer> => {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([text]).stream().pipeThrough(cs);
    return new Response(stream).arrayBuffer();
  };

  it('décompresse le flux et rend features et millésime', async () => {
    const body = await gzip(JSON.stringify({ features: [{ a: 1 }, { a: 2 }] }));
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://cadastre.data.gouv.fr/data/etalab-cadastre/2026-06-01/geojson/communes/49/49007/x.json.gz',
      body: new Blob([body]).stream(),
    }) as unknown as typeof fetch;

    const r = await downloadCommune('49007', fetchFn);
    expect(r.features).toHaveLength(2);
    expect(r.millesime).toBe('2026');
  });

  it('signale une commune absente du jeu', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404, url: '' }) as unknown as typeof fetch;
    await expect(downloadCommune('49999', fetchFn)).rejects.toThrow(/404/);
  });

  it('recolle les vingt arrondissements pour Paris', async () => {
    const body = await gzip(JSON.stringify({ features: [{ a: 1 }] }));
    const fetchFn = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      url: url.replace('/latest/', '/2026-06-01/'),
      body: new Blob([body]).stream(),
    })) as unknown as typeof fetch;

    const r = await downloadCommune('75056', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(20);
    expect(r.features).toHaveLength(20);
    expect(r.millesime).toBe('2026');
    // c'est bien le code arrondissement qui est demandé, jamais 75056
    for (const [url] of (fetchFn as unknown as { mock: { calls: string[][] } }).mock.calls) {
      expect(url).not.toContain('75056');
    }
  });

  // Le millésime porté par l'objet créé est une obligation d'attribution (Licence
  // Ouverte). Pour Paris, Lyon et Marseille il était pris sur `parts[0]`, c'est-à-dire
  // sur le PREMIER arrondissement : si Etalab republie les arrondissements à des dates
  // différentes, l'attribution est fausse pour dix-neuf sur vingt — et fausse dans le
  // sens le plus gênant, en annonçant des données plus fraîches qu'elles ne sont.
  it('retient le millésime le plus ancien quand les arrondissements divergent', async () => {
    const espion = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const body = await gzip(JSON.stringify({ features: [{ a: 1 }] }));
      const fetchFn = vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        // le 1er arrondissement est republié en 2026, les autres datent de 2024
        url: url.replace('/latest/', url.includes('75101') ? '/2026-06-01/' : '/2024-01-01/'),
        body: new Blob([body]).stream(),
      })) as unknown as typeof fetch;

      const r = await downloadCommune('75056', fetchFn);

      expect(r.millesime).toBe('2024');
      // La divergence est dite, pas seulement absorbée : elle signale un jeu de données
      // en cours de republication.
      expect(espion).toHaveBeenCalledWith(expect.stringContaining('millésime'), expect.anything());
    } finally {
      espion.mockRestore();
    }
  });
});
