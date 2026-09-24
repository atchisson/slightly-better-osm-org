import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readCache, writeCache, CACHE_TTL_MS } from '../../src/cadastre/store';

describe('cache des communes', () => {
  beforeEach(async () => {
    indexedDB.deleteDatabase('cadastre-id');
  });

  it('rend null pour une commune jamais téléchargée', async () => {
    await expect(readCache('49007')).resolves.toBeNull();
  });

  it('relit ce qui a été écrit', async () => {
    const entry = { insee: '49007', millesime: '2026', fetchedAt: Date.now(), features: [{ a: 1 }] };
    await writeCache(entry);
    await expect(readCache('49007')).resolves.toEqual(entry);
  });

  it('remplace une entrée existante', async () => {
    const maintenant = Date.now();
    await writeCache({ insee: '49007', millesime: '2025', fetchedAt: maintenant, features: [] });
    await writeCache({ insee: '49007', millesime: '2026', fetchedAt: maintenant, features: [{ a: 1 }] });
    const got = await readCache('49007');
    expect(got!.millesime).toBe('2026');
  });
});

describe('péremption du cache (I6)', () => {
  // `fetchedAt` était écrit et relu par personne — vérifié par grep pendant la revue.
  // Une commune mise en cache aujourd'hui aurait resservi le même millésime dans deux
  // ans, et le tag `source` l'aurait annoncé fidèlement : de la donnée périmée importée
  // en toute bonne foi.
  beforeEach(() => { indexedDB.deleteDatabase('cadastre-id'); });

  const entree = (fetchedAt: number) =>
    ({ insee: '49007', millesime: '2024', fetchedAt, features: [{ a: 1 }] });

  it('ignore une entrée plus vieille que la durée de validité', async () => {
    await writeCache(entree(Date.now() - CACHE_TTL_MS - 1));
    await expect(readCache('49007')).resolves.toBeNull();
  });

  it('garde une entrée encore valide', async () => {
    const e = entree(Date.now() - CACHE_TTL_MS + 60_000);
    await writeCache(e);
    await expect(readCache('49007')).resolves.toEqual(e);
  });

  it('ignore une entrée dont la date est absente ou aberrante', async () => {
    // Une entrée écrite par une version antérieure, ou une horloge qui a reculé : dans
    // le doute on retélécharge, on ne sert pas une donnée dont on ignore l'âge.
    await writeCache({ insee: '49007', millesime: '2024', features: [] } as never);
    await expect(readCache('49007')).resolves.toBeNull();

    await writeCache(entree(Date.now() + 10 * 24 * 60 * 60 * 1000)); // datée du futur
    await expect(readCache('49007')).resolves.toBeNull();
  });
});
