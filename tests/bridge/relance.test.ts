import { describe, it, expect, vi } from 'vitest';
import { relancerApresInjectionTardive, oublierRelances, RELANCES_MAX } from '../../src/bridge/relance';

// Constaté en réel (Firefox + Violentmonkey) : le script arrive dans `/id` en
// `document interactive`, après que osm.org a appelé coreContext(). Le contexte n'est
// plus atteignable ; seul un rechargement de l'iframe redonne une chance à l'injection.
// Le compteur vit en sessionStorage, qui survit au rechargement : sans lui, un
// gestionnaire systématiquement en retard rechargerait l'éditeur en boucle.
function stockageMemoire(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: k => m.get(k) ?? null,
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

describe('relancerApresInjectionTardive', () => {
  it('recharge et rend le numéro d’essai tant que le plafond n’est pas atteint', () => {
    const stockage = stockageMemoire();
    const recharger = vi.fn();
    for (let essai = 1; essai <= RELANCES_MAX; essai++) {
      expect(relancerApresInjectionTardive(stockage, recharger)).toBe(essai);
    }
    expect(recharger).toHaveBeenCalledTimes(RELANCES_MAX);
  });

  it('ne recharge plus une fois le plafond atteint : jamais de boucle', () => {
    const stockage = stockageMemoire();
    const recharger = vi.fn();
    for (let i = 0; i < RELANCES_MAX; i++) relancerApresInjectionTardive(stockage, recharger);
    recharger.mockClear();
    expect(relancerApresInjectionTardive(stockage, recharger)).toBe(0);
    expect(recharger).not.toHaveBeenCalled();
  });

  it('ne recharge pas sans stockage lisible : sans compteur, pas de garde contre la boucle', () => {
    const recharger = vi.fn();
    expect(relancerApresInjectionTardive(null, recharger)).toBe(0);
    const casse = { getItem: () => { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(relancerApresInjectionTardive(casse, recharger)).toBe(0);
    expect(recharger).not.toHaveBeenCalled();
  });

  it('une capture réussie remet le compteur à zéro', () => {
    const stockage = stockageMemoire();
    const recharger = vi.fn();
    for (let i = 0; i < RELANCES_MAX; i++) relancerApresInjectionTardive(stockage, recharger);
    oublierRelances(stockage);
    expect(relancerApresInjectionTardive(stockage, recharger)).toBe(1);
  });

  it('oublierRelances ne lève jamais', () => {
    expect(() => oublierRelances(null)).not.toThrow();
    const casse = { removeItem: () => { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(() => oublierRelances(casse)).not.toThrow();
  });
});
