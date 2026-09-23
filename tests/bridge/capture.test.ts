// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureContext, makeBridge } from '../../src/bridge/capture';

describe('captureContext', () => {
  beforeEach(() => {
    delete (globalThis as any).iD;
    vi.resetModules();
  });

  it('capture le contexte quand coreContext est appelé après l’installation du piège', async () => {
    const promise = captureContext();
    const faux = { marker: 'ctx' };
    (globalThis as any).iD = { coreContext: () => faux };
    const produit = (globalThis as any).iD.coreContext();
    expect(produit).toBe(faux);
    await expect(promise).resolves.toBe(faux);
  });

  it('laisse le namespace lisible et intact pour la page', async () => {
    captureContext();
    const ns = { coreContext: () => ({}), version: '2.30.0' };
    (globalThis as any).iD = ns;
    expect((globalThis as any).iD.version).toBe('2.30.0');
  });
});

describe('makeBridge', () => {
  const ctxComplet = () => {
    const projection: any = (p: unknown) => p;
    projection.invert = (p: [number, number]) => [p[0] / 100, p[1] / 100];
    return {
      map: () => ({ extent: () => ({ rectangle: () => [0, 0, 1, 1] }), on: () => {}, off: () => {} }),
      history: () => ({ intersects: () => [] }),
      graph: () => ({ entity: () => ({ loc: [0, 0] }) }),
      projection,
      perform: () => {},
      enter: () => {},
      storage: () => {},
      container: () => ({ node: () => document.createElement('div') }),
    };
  };

  it('jette si une primitive attendue manque', () => {
    const incomplet: any = ctxComplet();
    delete incomplet.perform;
    expect(() => makeBridge(incomplet)).toThrow(/perform/);
  });

  it('jette si le graphe est absent', () => {
    const incomplet: any = ctxComplet();
    delete incomplet.graph;
    expect(() => makeBridge(incomplet)).toThrow(/graph/);
  });

  it('accepte un contexte complet', () => {
    expect(() => makeBridge(ctxComplet())).not.toThrow();
  });

  it('expose l’inversion écran vers coordonnées', () => {
    expect(makeBridge(ctxComplet()).invert([250, 400])).toEqual([2.5, 4]);
  });
});

describe('buildingsNear', () => {
  const nodes: Record<string, { loc: [number, number] }> = {
    a: { loc: [0, 0] }, b: { loc: [1, 0] }, c: { loc: [1, 1] }, d: { loc: [0, 1] },
    e: { loc: [10, 10] }, f: { loc: [11, 10] }, g: { loc: [11, 11] }, h: { loc: [10, 11] },
  };

  const ctxAvec = (entities: any[]) => ({
    // La vue courante est large ; c'est le paramètre extent de buildingsNear, pas la
    // vue, qui doit restreindre le résultat.
    map: () => ({ extent: () => ({ rectangle: () => [-90, -90, 90, 90] }), on: () => {}, off: () => {} }),
    history: () => ({ intersects: () => entities }),
    graph: () => ({ entity: (id: string) => nodes[id] }),
    projection: Object.assign((p: unknown) => p, { invert: (p: unknown) => p }),
    perform: () => {},
    enter: () => {},
    container: () => ({}),
  });

  it('filtre au rectangle demandé plutôt que de rendre toute la vue', () => {
    const proche = { type: 'way', id: 'w1', tags: { building: 'yes' }, nodes: ['a', 'b', 'c', 'd', 'a'] };
    const loin = { type: 'way', id: 'w2', tags: { building: 'yes' }, nodes: ['e', 'f', 'g', 'h', 'e'] };
    const bridge = makeBridge(ctxAvec([proche, loin]));

    const result = bridge.buildingsNear([[-1, -1], [2, 2]]);

    expect(result.map(b => b.id)).toEqual(['w1']);
  });
});
