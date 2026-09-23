// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { makeBridge } from '../src/bridge/capture';

const ctxMinimal = () => ({
  map: () => ({ extent: () => ({ rectangle: () => [0, 0, 1, 1] }), on: () => {}, off: () => {} }),
  history: () => ({ intersects: () => [] }),
  graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
  projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
  perform: () => {},
  enter: () => {},
  container: () => ({ node: () => document.createElement('div') }),
});

describe('I7 — le champ source est reellement prerempli', () => {
  beforeEach(() => { localStorage.clear(); delete (globalThis as any).iD; });

  it('ecrit source via iD.prefs', () => {
    const ecrits: Record<string, string> = {};
    (globalThis as any).iD = { prefs: (k: string, v: string) => { ecrits[k] = v; } };
    const bridge: any = makeBridge(ctxMinimal());
    bridge.prefillChangeset('Bâtiments depuis le cadastre (Angers)', 'cadastre-dgi-fr source : ... 2026');
    expect(ecrits['source']).toContain('cadastre-dgi-fr');
  });

  it('se rabat sur localStorage', () => {
    const bridge: any = makeBridge(ctxMinimal());
    bridge.prefillChangeset('c', 'cadastre-dgi-fr source : ... 2026');
    expect(localStorage.getItem('source')).toContain('cadastre-dgi-fr');
  });
});
