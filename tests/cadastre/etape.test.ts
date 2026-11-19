import { describe, it, expect } from 'vitest';
import { etape } from '../../src/cadastre/etape';
import { DatasetIntrouvable } from '../../src/cadastre/download';

describe('etape — nommer où une erreur est née', () => {
  it('enchaîne les étapes imbriquées, de l’extérieur vers l’intérieur, et garde la cause', async () => {
    const origine = new DOMException('The operation was aborted.', 'AbortError');
    const p = etape('bâtiments 49007', () => etape('requête', async () => { throw origine; }));
    await expect(p).rejects.toThrow('bâtiments 49007 › requête › AbortError : The operation was aborted.');
    await p.catch(e => expect(e.cause).toBe(origine));
  });

  it('laisse passer DatasetIntrouvable intacte : le repli de millésime la reconnaît à son type', async () => {
    const absent = new DatasetIntrouvable('49999 absent');
    await expect(etape('bâtiments', async () => { throw absent; })).rejects.toBe(absent);
  });

  it('rend la valeur quand tout va bien', async () => {
    await expect(etape('x', async () => 42)).resolves.toBe(42);
  });
});
