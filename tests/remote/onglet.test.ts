import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installerOngletPrincipal, typeNavigationCourant } from '../../src/remote/onglet';
import { CANAL } from '../../src/remote/protocol';
import type { FenetreLisible as FenetreHaut } from '../../src/remote/onglet';

const MR = 'https://maproulette.org/browse/challenges/1/task/2';
const URL_TACHE =
  'https://www.openstreetmap.org/edit?editor=id&way=456#map=19/48.8566/2.3522&comment=%23defi&source=un';

/**
 * Plusieurs « onglets » dans un même navigateur : un verrou partagé (le premier qui le
 * demande l'obtient, les autres reçoivent `null` s'ils demandent `ifAvailable`) et un
 * canal en mémoire où chaque message va à tous les AUTRES membres, de façon asynchrone
 * comme le vrai BroadcastChannel.
 */
function navigateur() {
  let pris = false;
  const membres = new Set<{ recus: Array<(e: { data: unknown }) => void> }>();
  const diffuses: unknown[] = [];
  const locks = {
    request: vi.fn(async (_nom: string, _o: { ifAvailable: boolean }, cb: (l: unknown | null) => unknown) => {
      if (pris) return cb(null);
      pris = true;
      return cb({ name: 'verrou' });
    }),
  };
  const creerCanal = () => {
    const m = { recus: [] as Array<(e: { data: unknown }) => void> };
    membres.add(m);
    return {
      postMessage(data: unknown) {
        diffuses.push(data);
        for (const autre of membres) if (autre !== m) queueMicrotask(() => autre.recus.forEach(f => f({ data })));
      },
      addEventListener(_t: 'message', f: (e: { data: unknown }) => void) { m.recus.push(f); },
      close: vi.fn(() => { membres.delete(m); }),
    };
  };
  return { locks, creerCanal, diffuses, membres };
}

function onglet(nav: ReturnType<typeof navigateur>, { href = URL_TACHE, referrer = MR, delai = 3000, type = 'navigate', modifs = false } = {}) {
  const n = { aller: vi.fn(), aDesModifications: vi.fn(() => modifs) };
  const fermer = vi.fn();
  const resultat = installerOngletPrincipal({
    nav: n, href, referrer, fermer, locks: nav.locks, creerCanal: nav.creerCanal,
    typeNavigation: type, delaiAccuseMs: delai, aleatoire: () => 'abc',
  });
  return { n, fermer, resultat };
}

const commande = { canal: CANAL, type: 'aller', carte: { zoom: 18, centre: [1, 2] }, comment: 'x' };
const accuses = (b: ReturnType<typeof navigateur>) =>
  b.diffuses.filter(d => (d as { type?: string } | null)?.type === 'recu').map(d => (d as { id: string }).id);

describe('installerOngletPrincipal', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'info').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('le premier onglet devient principal et applique commentaire/source de son URL', async () => {
    const b = navigateur();
    const a = onglet(b);
    expect(await a.resultat).toBe('principal');
    expect(b.locks.request).toHaveBeenCalledWith('sb-osm-onglet-principal', { ifAvailable: true }, expect.any(Function));
    // commande réduite : ni carte ni objet, l'URL les a déjà appliqués
    expect(a.n.aller).toHaveBeenCalledTimes(1);
    expect(a.n.aller).toHaveBeenCalledWith({ canal: CANAL, type: 'aller', comment: '#defi', source: 'un' });
    expect(a.fermer).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[sb-osm]', 'onglet principal');
  });

  it('un principal ouvert à la main n’exécute rien', async () => {
    const b = navigateur();
    const a = onglet(b, { referrer: '' });
    expect(await a.resultat).toBe('principal');
    expect(a.n.aller).not.toHaveBeenCalled();
  });

  it('un principal venu de MapRoulette sans commentaire ni source n’exécute rien', async () => {
    const b = navigateur();
    const a = onglet(b, { href: 'https://www.openstreetmap.org/edit?way=1#map=18/1/2' });
    expect(await a.resultat).toBe('principal');
    expect(a.n.aller).not.toHaveBeenCalled();
  });

  it('un second onglet venu de MapRoulette transmet, reçoit l’accusé et se ferme', async () => {
    const b = navigateur();
    const a = onglet(b);
    await a.resultat;
    a.n.aller.mockClear();

    const c = onglet(b, { href: 'https://www.openstreetmap.org/edit?editor=id&way=9#map=17/1.5/2.5&comment=%23deux&source=B' });
    expect(await c.resultat).toBe('transmis');
    expect(a.n.aller).toHaveBeenCalledTimes(1);
    expect(a.n.aller).toHaveBeenCalledWith({
      canal: CANAL, type: 'aller', carte: { zoom: 17, centre: [2.5, 1.5] }, ids: ['w9'], comment: '#deux', source: 'B',
    });
    expect(c.fermer).toHaveBeenCalledTimes(1);
    expect(c.n.aller).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[sb-osm]', "commande transmise à l'onglet principal");
    expect(b.diffuses).toContainEqual({ canal: CANAL, type: 'recu', id: 'abc' });
    expect(b.diffuses).toContainEqual(expect.objectContaining({ canal: CANAL, type: 'aller', id: 'abc' }));
  });

  it('un second onglet ouvert à la main reste ordinaire, sans rien envoyer', async () => {
    const b = navigateur();
    await onglet(b).resultat;
    b.diffuses.length = 0;
    const c = onglet(b, { referrer: '' });
    expect(await c.resultat).toBe('ordinaire');
    await vi.advanceTimersByTimeAsync(10000);
    expect(b.diffuses).toEqual([]);
    expect(c.fermer).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[sb-osm]', 'onglet ordinaire');
  });

  it('un référent qui n’est pas MapRoulette ne compte pas', async () => {
    const b = navigateur();
    await onglet(b).resultat;
    for (const referrer of ['https://evil-maproulette.org/', 'https://maproulette.org.evil.com/', 'n’importe quoi']) {
      const c = onglet(b, { referrer });
      expect(await c.resultat).toBe('ordinaire');
      expect(c.fermer).not.toHaveBeenCalled();
    }
  });

  it('sans accusé dans le délai : onglet ordinaire, rien n’est fermé', async () => {
    const b = navigateur();
    // un « principal » qui verrouille mais ne répond jamais
    void b.locks.request('x', { ifAvailable: true }, () => new Promise(() => {}));
    const c = onglet(b, { delai: 3000 });
    let fini: string | null = null;
    void c.resultat.then(r => { fini = r; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fini).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(fini).toBe('ordinaire');
    expect(c.fermer).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[sb-osm]', 'onglet ordinaire');
  });

  it('un accusé tardif, après le délai, ne ferme rien', async () => {
    const b = navigateur();
    void b.locks.request('x', { ifAvailable: true }, () => new Promise(() => {}));   // principal muet
    // on garde la main sur les écouteurs du canal du nouvel onglet : l'accusé lui sera livré
    // directement, même si son canal est déjà fermé
    const ecouteurs: Array<(e: { data: unknown }) => void> = [];
    const creerCanal = () => {
      const c = b.creerCanal();
      return { ...c, addEventListener: (t: 'message', f: (e: { data: unknown }) => void) => { ecouteurs.push(f); c.addEventListener(t, f); } };
    };
    const n = { aller: vi.fn(), aDesModifications: () => false };
    const fermer = vi.fn();
    let resolu: string | null = null;
    const r = installerOngletPrincipal({
      nav: n, href: URL_TACHE, referrer: MR, typeNavigation: 'navigate', fermer, locks: b.locks,
      creerCanal, delaiAccuseMs: 1000, aleatoire: () => 'abc',
    });
    void r.then(v => { resolu = v; });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolu).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(resolu).toBe('ordinaire');   // le délai a été honoré, AVANT tout accusé
    expect(ecouteurs).toHaveLength(1);
    // l'accusé arrive enfin : l'onglet a déjà renoncé, il reste ouvert
    expect(() => ecouteurs[0]!({ data: { canal: CANAL, type: 'recu', id: 'abc' } })).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    expect(await r).toBe('ordinaire');
    expect(fermer).not.toHaveBeenCalled();
  });

  it('ignore l’accusé d’une autre transmission', async () => {
    const b = navigateur();
    void b.locks.request('x', { ifAvailable: true }, () => new Promise(() => {}));
    const c = onglet(b, { delai: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    for (const m of b.membres) m.recus.forEach(f => f({ data: { canal: CANAL, type: 'recu', id: 'autre' } }));
    await vi.advanceTimersByTimeAsync(1001);
    expect(await c.resultat).toBe('ordinaire');
    expect(c.fermer).not.toHaveBeenCalled();
  });

  it('une commande invalide reçue sur le canal est ignorée, sans accusé', async () => {
    const b = navigateur();
    const a = onglet(b);
    await a.resultat;
    a.n.aller.mockClear();
    const emetteur = b.creerCanal();
    for (const data of [
      { canal: CANAL, type: 'aller', id: 'z', carte: { zoom: 99, centre: [1, 2] } },
      { canal: CANAL, type: 'aller', id: 'z', ids: ['x1'] },
      { canal: CANAL, type: 'aller', id: 'z' },
      { ...commande },   // valide mais sans identifiant de transmission : rien à accuser
      null, 'texte', 42,
    ]) emetteur.postMessage(data);
    await vi.advanceTimersByTimeAsync(10);
    expect(a.n.aller).not.toHaveBeenCalled();
    expect(accuses(b)).toEqual([]);
  });

  it('ignore ce qui vient d’un autre canal ou d’un autre type', async () => {
    const b = navigateur();
    const a = onglet(b);
    await a.resultat;
    a.n.aller.mockClear();
    const emetteur = b.creerCanal();
    emetteur.postMessage({ ...commande, canal: 'autre', id: 'q' });
    emetteur.postMessage({ ...commande, type: 'recu', id: 'q' });
    emetteur.postMessage({ ...commande, type: 'effacer', id: 'q' });
    await vi.advanceTimersByTimeAsync(10);
    expect(a.n.aller).not.toHaveBeenCalled();
    expect(b.diffuses).toHaveLength(3);   // les trois messages envoyés, aucun accusé en retour
  });

  it('exécute deux commandes successives, dans l’ordre', async () => {
    const b = navigateur();
    const a = onglet(b, { referrer: '' });
    await a.resultat;
    const emetteur = b.creerCanal();
    emetteur.postMessage({ ...commande, id: '1', comment: 'premier' });
    emetteur.postMessage({ ...commande, id: '2', comment: 'second' });
    await vi.advanceTimersByTimeAsync(10);
    expect(a.n.aller.mock.calls.map(([c]) => c.comment)).toEqual(['premier', 'second']);
    expect(accuses(b)).toEqual(['1', '2']);
  });

  it('une navigation qui lève ne casse pas l’écoute, et l’accusé part quand même', async () => {
    const b = navigateur();
    const a = onglet(b, { referrer: '' });
    await a.resultat;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    a.n.aller.mockImplementationOnce(() => { throw new Error('boum'); });
    const emetteur = b.creerCanal();
    emetteur.postMessage({ ...commande, id: '1' });
    emetteur.postMessage({ ...commande, id: '2' });
    await vi.advanceTimersByTimeAsync(10);
    expect(a.n.aller).toHaveBeenCalledTimes(2);
    expect(accuses(b)).toEqual(['1', '2']);
  });

  it('une navigation qui lève pour la commande réduite n’empêche pas d’être principal', async () => {
    const b = navigateur();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = { aller: vi.fn(() => { throw new Error('boum'); }), aDesModifications: () => false };
    const r = await installerOngletPrincipal({
      nav: n, href: URL_TACHE, referrer: MR, typeNavigation: 'navigate', fermer: vi.fn(), locks: b.locks, creerCanal: b.creerCanal,
    });
    expect(r).toBe('principal');
  });

  it('un fermer() qui lève ne fait pas échouer la transmission', async () => {
    const b = navigateur();
    await onglet(b).resultat;
    const c = installerOngletPrincipal({
      nav: { aller: vi.fn(), aDesModifications: () => false }, href: URL_TACHE, referrer: MR, typeNavigation: 'navigate', locks: b.locks, creerCanal: b.creerCanal,
      fermer: () => { throw new Error('refusé'); },
    });
    expect(await c).toBe('transmis');
  });

  describe('garde-fous : ne jamais fermer un onglet rechargé ou qui porte des modifications', () => {
    for (const type of ['reload', 'back_forward', 'prerender', 'inconnu', undefined as unknown as string]) {
      it(`un chargement « ${type} » ne transmet rien et ne ferme rien`, async () => {
        const b = navigateur();
        await onglet(b).resultat;
        b.diffuses.length = 0;
        const c = onglet(b, { type: type ?? '' });
        expect(await c.resultat).toBe('ordinaire');
        await vi.advanceTimersByTimeAsync(10000);
        expect(b.diffuses).toEqual([]);
        expect(c.fermer).not.toHaveBeenCalled();
        expect(console.info).toHaveBeenCalledWith('[sb-osm]', 'onglet ordinaire');
      });
    }

    it('sans API de navigation (type illisible), l’onglet n’est pas frais', async () => {
      const b = navigateur();
      await onglet(b).resultat;
      const fermer = vi.fn();
      // en Node, `performance.getEntriesByType('navigation')` ne donne rien : valeur par défaut
      const r = await installerOngletPrincipal({
        nav: { aller: vi.fn(), aDesModifications: () => false }, href: URL_TACHE, referrer: MR,
        fermer, locks: b.locks, creerCanal: b.creerCanal,
      });
      expect(r).toBe('ordinaire');
      expect(fermer).not.toHaveBeenCalled();
    });

    it('le type par défaut est lu dans performance.getEntriesByType', async () => {
      vi.stubGlobal('performance', { getEntriesByType: () => [{ type: 'navigate' }] });
      const b = navigateur();
      await onglet(b).resultat;
      const fermer = vi.fn();
      const r = installerOngletPrincipal({
        nav: { aller: vi.fn(), aDesModifications: () => false }, href: URL_TACHE, referrer: MR,
        fermer, locks: b.locks, creerCanal: b.creerCanal, aleatoire: () => 'abc',
      });
      expect(await r).toBe('transmis');
      expect(fermer).toHaveBeenCalledTimes(1);
    });

    it('un principal rechargé n’exécute pas la commande réduite', async () => {
      const b = navigateur();
      const a = onglet(b, { type: 'reload' });
      expect(await a.resultat).toBe('principal');
      expect(a.n.aller).not.toHaveBeenCalled();
    });

    it('un onglet qui porte des modifications reste ordinaire, sans rien envoyer ni fermer', async () => {
      const b = navigateur();
      await onglet(b).resultat;
      b.diffuses.length = 0;
      const c = onglet(b, { modifs: true });
      expect(await c.resultat).toBe('ordinaire');
      await vi.advanceTimersByTimeAsync(10000);
      expect(b.diffuses).toEqual([]);
      expect(c.fermer).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledWith('[sb-osm]', 'onglet ordinaire');
    });

    it('des modifications apparues pendant l’attente de l’accusé empêchent la fermeture', async () => {
      const b = navigateur();
      await onglet(b).resultat;
      const c = onglet(b);
      c.n.aDesModifications.mockReturnValueOnce(false).mockReturnValue(true);
      expect(await c.resultat).toBe('ordinaire');
      expect(c.fermer).not.toHaveBeenCalled();
    });

    it('aDesModifications qui lève : dans le doute, on ne ferme rien', async () => {
      const b = navigateur();
      await onglet(b).resultat;
      const c = onglet(b);
      c.n.aDesModifications.mockImplementation(() => { throw new Error('x'); });
      expect(await c.resultat).toBe('ordinaire');
      expect(c.fermer).not.toHaveBeenCalled();
    });

    it('navigate et sans modification : transmet comme avant', async () => {
      const b = navigateur();
      await onglet(b).resultat;
      const c = onglet(b, { type: 'navigate', modifs: false });
      expect(await c.resultat).toBe('transmis');
      expect(c.fermer).toHaveBeenCalledTimes(1);
    });
  });

  it('API Web Locks absente : onglet ordinaire, rien n’est fait', async () => {
    vi.stubGlobal('navigator', {});
    const n = { aller: vi.fn(), aDesModifications: () => false };
    const fermer = vi.fn();
    const creerCanal = vi.fn();
    expect(await installerOngletPrincipal({ nav: n, href: URL_TACHE, referrer: MR, typeNavigation: 'navigate', fermer, creerCanal })).toBe('ordinaire');
    expect(creerCanal).not.toHaveBeenCalled();
    expect(n.aller).not.toHaveBeenCalled();
    expect(fermer).not.toHaveBeenCalled();
  });

  it('BroadcastChannel absent : onglet ordinaire, rien n’est fait', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const b = navigateur();
    const n = { aller: vi.fn(), aDesModifications: () => false };
    const fermer = vi.fn();
    expect(await installerOngletPrincipal({ nav: n, href: URL_TACHE, referrer: MR, typeNavigation: 'navigate', fermer, locks: b.locks })).toBe('ordinaire');
    expect(b.locks.request).not.toHaveBeenCalled();
    expect(n.aller).not.toHaveBeenCalled();
    expect(fermer).not.toHaveBeenCalled();
  });
});

describe('typeNavigationCourant', () => {
  const perf = (type: string) => ({ getEntriesByType: () => [{ type }] });
  const quiLeve = (): never => { throw new Error('cross-origin'); };

  it('un cadre principal distinct et lisible fait foi, pas l’entrée de l’iframe', () => {
    const haut = { performance: perf('reload') };
    expect(typeNavigationCourant({ top: haut, performance: perf('navigate') })).toBe('reload');
  });

  it('top.performance qui lève : undefined, jamais l’entrée de l’iframe', () => {
    const haut = { get performance(): never { return quiLeve(); } };
    expect(typeNavigationCourant({ top: haut as FenetreHaut, performance: perf('navigate') })).toBeUndefined();
  });

  it('top.performance.getEntriesByType qui lève : undefined', () => {
    const haut = { performance: { getEntriesByType: quiLeve } };
    expect(typeNavigationCourant({ top: haut, performance: perf('navigate') })).toBeUndefined();
  });

  it('top illisible (accès qui lève) : undefined', () => {
    const f = { get top(): never { return quiLeve(); }, performance: perf('navigate') };
    expect(typeNavigationCourant(f as FenetreHaut)).toBeUndefined();
  });

  it('un cadre principal distinct sans entrée : undefined (pas frais)', () => {
    expect(typeNavigationCourant({ top: { performance: { getEntriesByType: () => [] } }, performance: perf('navigate') })).toBeUndefined();
    expect(typeNavigationCourant({ top: {}, performance: perf('navigate') })).toBeUndefined();
  });

  it('sans cadre principal distinct (top absent ou top === soi) : l’entrée du document', () => {
    expect(typeNavigationCourant({ performance: perf('navigate') })).toBe('navigate');
    expect(typeNavigationCourant({ top: null, performance: perf('reload') })).toBe('reload');
    const soi: FenetreHaut = { performance: perf('back_forward') };
    soi.top = soi;
    expect(typeNavigationCourant(soi)).toBe('back_forward');
  });

  it('aucune API de performance : undefined', () => {
    expect(typeNavigationCourant({})).toBeUndefined();
  });
});
