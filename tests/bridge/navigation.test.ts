import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeNavigation } from '../../src/bridge/capture';
import { CANAL } from '../../src/remote/protocol';
import type { Commande } from '../../src/remote/protocol';

const cmd = (extra: Partial<Commande>): Commande => ({ canal: CANAL, type: 'aller', ...extra });

function contexte(chargees: Set<string> = new Set()) {
  return {
    map: () => ({ centerZoom: vi.fn() }),
    graph: () => ({ hasEntity: (id: string) => chargees.has(id) }),
    enter: vi.fn(),
    zoomToEntities: vi.fn(),
  } as any;
}

describe('makeNavigation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).iD = { modeSelect: (_c: unknown, ids: string[]) => ({ ids }) };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).iD;
  });

  it('centre la carte', () => {
    const centerZoom = vi.fn();
    const ctx = { ...contexte(), map: () => ({ centerZoom }) };
    makeNavigation(ctx, vi.fn()).aller(cmd({ carte: { zoom: 19, centre: [2.35, 48.85] } }));
    expect(centerZoom).toHaveBeenCalledWith([2.35, 48.85], 19);
  });

  it('sélectionne les objets dès qu’ils sont chargés', () => {
    const chargees = new Set<string>();
    const ctx = contexte(chargees);
    makeNavigation(ctx, vi.fn()).aller(cmd({ ids: ['w1'] }));

    expect(ctx.zoomToEntities).toHaveBeenCalledWith(['w1']);
    vi.advanceTimersByTime(500);
    expect(ctx.enter).not.toHaveBeenCalled();

    chargees.add('w1');
    vi.advanceTimersByTime(250);
    expect(ctx.enter).toHaveBeenCalledOnce();
    expect(ctx.enter.mock.calls[0][0].ids).toEqual(['w1']);
  });

  it('abandonne un objet qui ne se charge jamais, sans sonder indéfiniment', () => {
    const ctx = contexte();
    makeNavigation(ctx, vi.fn()).aller(cmd({ ids: ['w404'] }));
    vi.advanceTimersByTime(60_000);
    expect(ctx.enter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sélectionne ce qui est chargé quand une partie manque, à l’échéance', () => {
    const ctx = contexte(new Set(['w1']));
    makeNavigation(ctx, vi.fn()).aller(cmd({ ids: ['w1', 'w404'] }));
    vi.advanceTimersByTime(60_000);
    expect(ctx.enter).toHaveBeenCalledOnce();
    expect(ctx.enter.mock.calls[0][0].ids).toEqual(['w1']);
  });

  it('préremplit le changeset, source vide si absente', () => {
    const prefill = vi.fn();
    makeNavigation(contexte(), prefill).aller(cmd({ comment: 'c', source: 's' }));
    makeNavigation(contexte(), prefill).aller(cmd({ comment: 'seul' }));
    expect(prefill).toHaveBeenNthCalledWith(1, 'c', 's');
    expect(prefill).toHaveBeenNthCalledWith(2, 'seul', '');
  });

  it('un centerZoom qui lève ne prive pas des autres effets', () => {
    const espion = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefill = vi.fn();
    const ctx = { ...contexte(), map: () => ({ centerZoom: () => { throw new Error('x'); } }) };
    makeNavigation(ctx, prefill).aller(cmd({ carte: { zoom: 1, centre: [0, 0] }, comment: 'c' }));
    expect(prefill).toHaveBeenCalledOnce();
    espion.mockRestore();
  });

  it('une absence de zoomToEntities n’empêche pas la sélection', () => {
    const ctx = contexte(new Set(['w1']));
    delete ctx.zoomToEntities;
    makeNavigation(ctx, vi.fn()).aller(cmd({ ids: ['w1'] }));
    vi.advanceTimersByTime(250);
    expect(ctx.enter).toHaveBeenCalledOnce();
  });

  describe('fusion du changeset', () => {
    // Réglages d'iD factices : `iD.prefs(k)` lit, `iD.prefs(k, v)` écrit.
    const reglages = (init: Record<string, string>) => {
      const iD: any = (globalThis as any).iD;
      iD.prefs = (k: string) => init[k];
    };
    const avecHistorique = (history: unknown) => ({ ...contexte(), history } as any);
    const existants = { comment: '#maproulette #defi-un', source: 'defi un' };
    const nouvelle = cmd({ comment: '#maproulette #defi-deux', source: 'defi deux' });

    it('fusionne quand des modifications sont en cours', () => {
      reglages(existants);
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({ hasChanges: () => true })), prefill).aller(nouvelle);
      expect(prefill).toHaveBeenCalledWith('#maproulette #defi-un #defi-deux', 'defi un;defi deux');
    });

    it('conserve la source existante quand la commande n’en a pas (fusion)', () => {
      reglages({ comment: 'a', source: 'x;y' });
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({ hasChanges: () => true })), prefill)
        .aller(cmd({ comment: 'b' }));
      expect(prefill).toHaveBeenCalledWith('a; b', 'x;y');
    });

    it('remplace quand rien n’est en cours d’édition', () => {
      reglages(existants);
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({ hasChanges: () => false })), prefill).aller(nouvelle);
      expect(prefill).toHaveBeenCalledWith('#maproulette #defi-deux', 'defi deux');
    });

    it('remplace (source vide si absente) quand rien n’est en cours', () => {
      reglages(existants);
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({ hasChanges: () => false })), prefill)
        .aller(cmd({ comment: 'seul' }));
      expect(prefill).toHaveBeenCalledWith('seul', '');
    });

    it('remplace quand hasChanges est absent', () => {
      reglages(existants);
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({})), prefill).aller(nouvelle);
      expect(prefill).toHaveBeenCalledWith('#maproulette #defi-deux', 'defi deux');
    });

    it('remplace quand history() est absent', () => {
      reglages(existants);
      const prefill = vi.fn();
      makeNavigation(contexte(), prefill).aller(nouvelle);
      expect(prefill).toHaveBeenCalledWith('#maproulette #defi-deux', 'defi deux');
    });

    it('remplace quand hasChanges lève', () => {
      reglages(existants);
      const prefill = vi.fn();
      const ctx = avecHistorique(() => ({ hasChanges: () => { throw new Error('x'); } }));
      makeNavigation(ctx, prefill).aller(nouvelle);
      expect(prefill).toHaveBeenCalledWith('#maproulette #defi-deux', 'defi deux');
    });

    it('lit les réglages existants dans localStorage si iD.prefs n’est pas une fonction', () => {
      const magasin: Record<string, string> = { ...existants };
      vi.stubGlobal('localStorage', { getItem: (k: string) => magasin[k] ?? null });
      try {
        const prefill = vi.fn();
        makeNavigation(avecHistorique(() => ({ hasChanges: () => true })), prefill).aller(nouvelle);
        expect(prefill).toHaveBeenCalledWith('#maproulette #defi-un #defi-deux', 'defi un;defi deux');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('traite des réglages illisibles comme vides (fusion avec du vide)', () => {
      (globalThis as any).iD.prefs = () => { throw new Error('illisible'); };
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({ hasChanges: () => true })), prefill).aller(nouvelle);
      expect(prefill).toHaveBeenCalledWith('#maproulette #defi-deux', 'defi deux');
    });

    it('n’appelle pas prefill sans commentaire', () => {
      reglages(existants);
      const prefill = vi.fn();
      makeNavigation(avecHistorique(() => ({ hasChanges: () => true })), prefill).aller(cmd({}));
      expect(prefill).not.toHaveBeenCalled();
    });
  });

  describe('aDesModifications', () => {
    const avec = (history: () => unknown) => ({ ...contexte(), history }) as any;
    it('reflète history().hasChanges()', () => {
      expect(makeNavigation(avec(() => ({ hasChanges: () => true })), vi.fn()).aDesModifications()).toBe(true);
      expect(makeNavigation(avec(() => ({ hasChanges: () => false })), vi.fn()).aDesModifications()).toBe(false);
    });
    it('absent ou qui lève : false', () => {
      expect(makeNavigation(contexte(), vi.fn()).aDesModifications()).toBe(false);
      expect(makeNavigation(avec(() => { throw new Error('x'); }), vi.fn()).aDesModifications()).toBe(false);
      expect(makeNavigation(avec(() => ({ hasChanges: () => 'oui' })), vi.fn()).aDesModifications()).toBe(false);
    });
  });
});
