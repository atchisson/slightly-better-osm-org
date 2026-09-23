import { describe, it, expect, vi } from 'vitest';
import { departementOf, arrondissementCodes, communeAt } from '../../src/cadastre/insee';

describe('departementOf', () => {
  it('prend les deux premiers chiffres en métropole', () => {
    expect(departementOf('49007')).toBe('49');
  });

  it('gère la Corse', () => {
    expect(departementOf('2A004')).toBe('2A');
    expect(departementOf('2B033')).toBe('2B');
  });

  it('prend trois caractères en outre-mer', () => {
    expect(departementOf('97411')).toBe('974');
  });
});

describe('arrondissementCodes', () => {
  it('éclate Paris en vingt arrondissements', () => {
    const codes = arrondissementCodes('75056');
    expect(codes).toHaveLength(20);
    expect(codes[0]).toBe('75101');
    expect(codes[19]).toBe('75120');
  });

  it('éclate Lyon en neuf arrondissements', () => {
    const codes = arrondissementCodes('69123');
    expect(codes).toHaveLength(9);
    expect(codes[0]).toBe('69381');
    expect(codes[8]).toBe('69389');
  });

  it('éclate Marseille en seize arrondissements', () => {
    const codes = arrondissementCodes('13055');
    expect(codes).toHaveLength(16);
    expect(codes[0]).toBe('13201');
    expect(codes[15]).toBe('13216');
  });

  it('rend le code tel quel pour une commune ordinaire', () => {
    expect(arrondissementCodes('49007')).toEqual(['49007']);
  });
});

describe('communeAt', () => {
  it('rend la commune trouvée', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ code: '49007', nom: 'Angers' }],
    }) as unknown as typeof fetch;
    await expect(communeAt(47.4784, -0.5632, fetchFn)).resolves.toEqual({ code: '49007', nom: 'Angers' });
  });

  it('rend null hors couverture', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as unknown as typeof fetch;
    await expect(communeAt(0, 0, fetchFn)).resolves.toBeNull();
  });

  it('propage une panne réseau plutôt que de la masquer', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    await expect(communeAt(47, -0.5, fetchFn)).rejects.toThrow(/503/);
  });
});
