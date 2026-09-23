import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readCache, writeCache } from '../../src/cadastre/store';

describe('cache des communes', () => {
  beforeEach(async () => {
    indexedDB.deleteDatabase('cadastre-id');
  });

  it('rend null pour une commune jamais téléchargée', async () => {
    await expect(readCache('49007')).resolves.toBeNull();
  });

  it('relit ce qui a été écrit', async () => {
    const entry = { insee: '49007', millesime: '2026', fetchedAt: 1, features: [{ a: 1 }] };
    await writeCache(entry);
    await expect(readCache('49007')).resolves.toEqual(entry);
  });

  it('remplace une entrée existante', async () => {
    await writeCache({ insee: '49007', millesime: '2025', fetchedAt: 1, features: [] });
    await writeCache({ insee: '49007', millesime: '2026', fetchedAt: 2, features: [{ a: 1 }] });
    const got = await readCache('49007');
    expect(got!.millesime).toBe('2026');
  });
});
