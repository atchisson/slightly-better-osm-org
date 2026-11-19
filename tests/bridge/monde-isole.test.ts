// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  creerMembrane, captureContextIsole, type OutilsPage,
} from '../../src/bridge/monde-isole';

/**
 * Ces tests simulent le monde de la page par une iframe jsdom : elle a ses propres
 * `Object`, `Array`, `Proxy` et `Function`, ce qui suffit à vérifier QUE chaque valeur
 * passe la frontière sous la bonne forme (objet de la page, fonction exportée, nœud DOM
 * tel quel). Ils ne reproduisent pas la sécurité de Firefox (vues filtrées, exportFunction
 * réel) : seul un essai sous Firefox le valide.
 */
const fenetrePage = (): any => {
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  return f.contentWindow;
};

let page: any;
let exportees: Set<unknown>;
let outils: OutilsPage;

beforeEach(() => {
  page = fenetrePage();
  exportees = new Set();
  outils = {
    page,
    exporter: fn => { exportees.add(fn); return fn; },
    deballer: v => v,
    estPage: v => v instanceof page.Object || exportees.has(v),
    versDom: v => (v instanceof page.Node ? v : null),
  };
});

describe('membrane entre le monde isolé et la page', () => {
  it('rend les objets de la page derrière un intermédiaire stable', () => {
    const m = creerMembrane(outils);
    const brut = page.eval('({ a: { b: 2 } })');
    const p = m.sortir(brut);
    expect(p).not.toBe(brut);
    expect(p.a.b).toBe(2);
    expect(m.sortir(brut)).toBe(p); // même objet de la page, même intermédiaire
  });

  it('recopie un objet du monde isolé en objet de la page avant de le passer', () => {
    const m = creerMembrane(outils);
    const garde = m.sortir(page.eval('(function (x) { window.__vu = x; return x.loc[0]; })'));
    expect(garde({ loc: [1.5, 47] })).toBe(1.5);
    expect(page.__vu instanceof page.Object).toBe(true);
    expect(page.__vu.loc instanceof page.Array).toBe(true);
  });

  it('exporte une fonction de rappel, qui reçoit ses arguments derrière l’intermédiaire', () => {
    const m = creerMembrane(outils);
    const appeler = m.sortir(page.eval('(function (cb) { window.__cb = cb; return cb({ v: 3 }); })'));
    let recu: any;
    const r = appeler((x: any) => { recu = x; return x.v * 2; });
    expect(r).toBe(6);
    expect(exportees.has(page.__cb)).toBe(true);
    expect(recu.v).toBe(3);
  });

  it('instancie une classe de la page, reconnaissable comme classe', () => {
    const m = creerMembrane(outils);
    const Classe = m.sortir(page.eval('(class Noeud { constructor(o) { this.loc = o.loc; } })'));
    expect(String(Classe)).toMatch(/^class[\s{]/);
    const n = new Classe({ loc: [2, 3] });
    expect(n.loc[1]).toBe(3);
  });

  it('itère un tableau de la page', () => {
    const m = creerMembrane(outils);
    const t = m.sortir(page.eval('[1, 2, 3]'));
    expect([...t]).toEqual([1, 2, 3]);
    expect(t.filter((x: number) => x > 1).length).toBe(2);
    expect(Array.isArray(t)).toBe(true);
  });

  it('rend les nœuds DOM tels quels, pour MutationObserver et getComputedStyle', () => {
    const m = creerMembrane(outils);
    const div = page.document.createElement('div');
    const conteneur = m.sortir(page.eval('(function (d) { return { node: function () { return d; } }; })'))(div);
    expect(conteneur.node()).toBe(div);
  });

  it('rend à la page l’objet d’origine, pas l’intermédiaire', () => {
    const m = creerMembrane(outils);
    const brut = page.eval('({})');
    const memeObjet = m.sortir(page.eval('(function (a, b) { return a === b; })'));
    expect(memeObjet(m.sortir(brut), brut)).toBe(true);
  });
});

describe('captureContextIsole — piéger `iD` dans la page depuis le monde isolé', () => {
  it('capture le contexte quand l’amorçage de la page appelle coreContext()', async () => {
    const m = creerMembrane(outils);
    const promesse = captureContextIsole(outils, m);
    page.eval(`
      window.iD = { coreContext: function () { return { map: function () { return 'carte'; } }; },
                    version: '2.30' };
      window.__ctx = window.iD.coreContext();
    `);
    const ctx: any = await promesse;
    expect(ctx.map()).toBe('carte');
    expect(page.eval('iD.version')).toBe('2.30');
  });

  it('n’appelle jamais le `.apply` de la page avec un tableau du monde isolé', async () => {
    // Constaté en réel : `valeur.apply(this, args)` exécute le `apply` de la page, qui lit
    // `length` sur `args` — refusé par Firefox (« Permission denied to access property
    // "length" »), et l'amorçage d'iD cassé. Simulé ici par un `apply` piégé.
    const m = creerMembrane(outils);
    const promesse = captureContextIsole(outils, m);
    page.eval(`
      var cc = function () { return { ok: true }; };
      cc.apply = function () { throw new Error('Permission denied to access property "length"'); };
      window.iD = { coreContext: cc };
      window.__ctx = window.iD.coreContext();
    `);
    expect(page.__ctx.ok).toBe(true);
    expect(((await promesse) as any).ok).toBe(true);
  });

  it('pose l’accesseur avec des fonctions exportées vers la page', () => {
    const m = creerMembrane(outils);
    void captureContextIsole(outils, m);
    const d = page.Object.getOwnPropertyDescriptor(page, 'iD');
    expect(exportees.has(d.get)).toBe(true);
    expect(exportees.has(d.set)).toBe(true);
  });

  it('ne masque pas un `iD` déjà affecté', async () => {
    page.eval(`window.iD = { coreContext: function () { return { deja: true }; }, version: '2.31' };`);
    const m = creerMembrane(outils);
    const promesse = captureContextIsole(outils, m);
    expect(page.eval('iD.version')).toBe('2.31');
    page.eval('iD.coreContext()');
    expect(((await promesse) as any).deja).toBe(true);
  });

  it('respecte l’accesseur d’un tiers', () => {
    page.eval(`Object.defineProperty(window, 'iD', { get: function () { return 'tiers'; }, configurable: true });`);
    const m = creerMembrane(outils);
    void captureContextIsole(outils, m);
    expect(page.eval('iD')).toBe('tiers');
  });
});
