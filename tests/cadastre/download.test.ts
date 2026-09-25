import { describe, it, expect, vi } from 'vitest';
import {
  datasetUrl, millesimesFromListing, downloadCommune, LISTING_URL,
} from '../../src/cadastre/download';

/** Un listing S3 comme en rend le dépôt Etalab, réduit aux préfixes qui nous importent. */
const listing = (...dates: string[]): string =>
  `<?xml version='1.0' encoding='UTF-8'?><ListBucketResult><Name>cadastre</Name>` +
  dates.map(d => `<CommonPrefixes><Prefix>etalab-cadastre/${d}/</Prefix></CommonPrefixes>`).join('') +
  `</ListBucketResult>`;

describe('datasetUrl', () => {
  it('vise le bucket S3 directement, à un millésime explicite', () => {
    // Surtout PAS cadastre.data.gouv.fr/.../latest/ : sa redirection 302 ne porte
    // aucun en-tête CORS et le navigateur la bloque au premier saut.
    expect(datasetUrl('49007', '2026-06-01')).toBe(
      'https://cadastre.s3.rbx.io.cloud.ovh.net/etalab-cadastre/2026-06-01' +
      '/geojson/communes/49/49007/cadastre-49007-batiments.json.gz');
  });

  it('gère un code corse', () => {
    expect(datasetUrl('2A004', '2026-06-01')).toContain('/communes/2A/2A004/');
  });
});

describe('millesimesFromListing', () => {
  it('rend les millésimes du plus récent au plus ancien', () => {
    // Format AAAA-MM-JJ : l'ordre lexicographique est l'ordre chronologique.
    expect(millesimesFromListing(listing('2025-12-01', '2026-06-01', '2026-03-01')))
      .toEqual(['2026-06-01', '2026-03-01', '2025-12-01']);
  });

  it('dédoublonne', () => {
    expect(millesimesFromListing(listing('2026-06-01', '2026-06-01'))).toEqual(['2026-06-01']);
  });

  it('jette plutôt que d’inventer un millésime', () => {
    expect(() => millesimesFromListing('<ListBucketResult></ListBucketResult>'))
      .toThrow(/millésime/i);
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

  /**
   * Un dépôt simulé : le listing d'abord, puis les objets. `absentes` nomme les
   * millésimes où la commande rend 404, pour jouer la republication en cours.
   */
  const depot = async (
    dates: string[],
    features: unknown[] = [{ a: 1 }],
    absentes: string[] = [],
  ) => {
    const body = await gzip(JSON.stringify({ features }));
    return vi.fn().mockImplementation(async (url: string) => {
      if (url === LISTING_URL) return { ok: true, status: 200, text: async () => listing(...dates) };
      if (absentes.some(d => url.includes(`/${d}/`))) return { ok: false, status: 404 };
      return { ok: true, status: 200, body: new Blob([body]).stream() };
    }) as unknown as typeof fetch;
  };

  it('décompresse le flux et rend features et millésime', async () => {
    const fetchFn = await depot(['2026-06-01'], [{ a: 1 }, { a: 2 }]);

    const r = await downloadCommune('49007', fetchFn);

    expect(r.features).toHaveLength(2);
    // L'attribution porte l'année, convention des imports cadastre français.
    expect(r.millesime).toBe('2026');
  });

  it('prend le millésime le plus récent du dépôt', async () => {
    const fetchFn = await depot(['2024-01-01', '2026-06-01', '2025-09-01']);

    await downloadCommune('49007', fetchFn);

    const urls = (fetchFn as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0]);
    expect(urls.some(u => u?.includes('/2026-06-01/'))).toBe(true);
  });

  it('signale une commune absente de tout le dépôt', async () => {
    const fetchFn = await depot(['2026-06-01'], [{ a: 1 }], ['2026-06-01']);

    await expect(downloadCommune('49999', fetchFn)).rejects.toThrow(/absent/i);
  });

  it('remonte telle quelle une panne qui n’est pas une absence', async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) => (
      url === LISTING_URL
        ? { ok: true, status: 200, text: async () => listing('2026-06-01') }
        : { ok: false, status: 500 }
    )) as unknown as typeof fetch;

    // Un 500 n'est pas une republication en cours : essayer le millésime précédent
    // masquerait une panne du dépôt derrière des données périmées.
    await expect(downloadCommune('49007', fetchFn)).rejects.toThrow(/500/);
  });

  it('se replie sur le millésime précédent quand le plus récent est incomplet', async () => {
    const espion = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // On perd `latest`, qu'Etalab ne fait pointer que sur un millésime entièrement
      // publié : le listing brut expose aussi celui en cours de téléversement.
      const fetchFn = await depot(['2025-12-01', '2026-06-01'], [{ a: 1 }], ['2026-06-01']);

      const r = await downloadCommune('49007', fetchFn);

      expect(r.millesime).toBe('2025');
      expect(espion).toHaveBeenCalledWith(expect.stringContaining('republication'));
    } finally {
      espion.mockRestore();
    }
  });

  it('recolle les vingt arrondissements pour Paris', async () => {
    const fetchFn = await depot(['2026-06-01']);

    const r = await downloadCommune('75056', fetchFn);

    const urls = (fetchFn as unknown as { mock: { calls: string[][] } }).mock.calls
      .map(c => c[0]!).filter(u => u !== LISTING_URL);
    expect(urls.filter(u => u.includes('-batiments.'))).toHaveLength(20);
    expect(urls.filter(u => u.includes('-tsurf.'))).toHaveLength(20);
    expect(r.features).toHaveLength(20);
    // c'est bien le code arrondissement qui est demandé, jamais 75056
    for (const url of urls) expect(url).not.toContain('75056');
  });

  it('sert les vingt arrondissements depuis un seul millésime', async () => {
    const fetchFn = await depot(['2025-12-01', '2026-06-01']);

    await downloadCommune('75056', fetchFn);

    // En épinglant un préfixe unique, la divergence de millésimes entre
    // arrondissements devient impossible PAR CONSTRUCTION. La version précédente
    // suivait `latest` et redirigeait chaque arrondissement indépendamment : elle ne
    // pouvait que détecter la divergence après coup et retenir la date la plus
    // ancienne, pour ne jamais annoncer des données plus fraîches qu'elles ne sont.
    const urls = (fetchFn as unknown as { mock: { calls: string[][] } }).mock.calls
      .map(c => c[0]!).filter(u => u !== LISTING_URL);
    expect(urls.every(u => u.includes('/2026-06-01/'))).toBe(true);
  });
});

describe('piscines', () => {
  const tsurf = (syms: string[]) => ({
    features: syms.map(SYM => ({
      properties: { SYM },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    })),
  });

  const gzip = async (text: string): Promise<ArrayBuffer> => {
    const cs = new CompressionStream('gzip');
    return new Response(new Blob([text]).stream().pipeThrough(cs)).arrayBuffer();
  };

  it('ne retient que le code symbole des piscines', async () => {
    // Mesuré contre les piscines déjà cartographiées dans OSM : seul 65 tient sur deux
    // communes de profils opposés. 34 semblait convaincant dans le Var (81 %) et
    // s'effondre à Angers (1 %) — un artefact de densité.
    const bat = await gzip(JSON.stringify({ features: [] }));
    const sur = await gzip(JSON.stringify(tsurf(['65', '34', '33', '65'])));
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === LISTING_URL) return { ok: true, status: 200, text: async () => listing('2026-06-01') };
      return { ok: true, status: 200,
        body: new Blob([url.includes('tsurf') ? sur : bat]).stream() };
    }) as unknown as typeof fetch;

    const r = await downloadCommune('49007', fetchFn);

    expect(r.piscines).toHaveLength(2);
  });

  it('se passe d’une couche tsurf absente sans faire échouer les bâtiments', async () => {
    // Toutes les communes n'ont pas ce fichier, et une commune sans piscine est un cas
    // parfaitement ordinaire : ce n'est pas une panne.
    const bat = await gzip(JSON.stringify({ features: [{ a: 1 }] }));
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === LISTING_URL) return { ok: true, status: 200, text: async () => listing('2026-06-01') };
      if (url.includes('tsurf')) return { ok: false, status: 404 };
      return { ok: true, status: 200, body: new Blob([bat]).stream() };
    }) as unknown as typeof fetch;

    const r = await downloadCommune('49007', fetchFn);

    expect(r.features).toHaveLength(1);
    expect(r.piscines).toEqual([]);
  });
});
