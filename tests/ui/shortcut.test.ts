// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCtrlShortcut, type CtrlShortcutHooks } from '../../src/ui/shortcut';

let enabled: boolean;
let autorise: boolean;
let armements: boolean[];
let detacher: () => void;

const hooks = (): CtrlShortcutHooks => ({
  isEnabled: () => enabled,
  allowed: () => autorise,
  setArmed: (on) => { armements.push(on); enabled = on; },
});

const ctrl = (type: 'keydown' | 'keyup'): void => {
  document.dispatchEvent(new KeyboardEvent(type, { key: 'Control' }));
};

beforeEach(() => {
  enabled = false;
  autorise = true;
  armements = [];
  detacher = createCtrlShortcut(hooks());
});

afterEach(() => {
  detacher();
  vi.restoreAllMocks();
});

describe('createCtrlShortcut', () => {
  it('arme en maintenant Ctrl et désarme en le relâchant', () => {
    ctrl('keydown');
    expect(armements).toEqual([true]);

    ctrl('keyup');
    expect(armements).toEqual([true, false]);
  });

  it("ne s'arme pas quand la couche cadastre n'est pas affichée", () => {
    autorise = false;

    ctrl('keydown');
    ctrl('keyup');

    // Un déclencheur sans affordance doit être difficile à déclencher par accident :
    // hors du contexte où il a un sens, il n'existe pas.
    expect(armements).toEqual([]);
  });

  it('relit l’autorisation à chaque appui, sans la mettre en cache', () => {
    autorise = false;
    ctrl('keydown');
    ctrl('keyup');

    // La couche s'allume en cours de session : une réponse figée au démarrage
    // condamnerait le raccourci pour toute la session.
    autorise = true;
    ctrl('keydown');

    expect(armements).toEqual([true]);
  });

  it('ignore les répétitions de keydown', () => {
    ctrl('keydown');
    ctrl('keydown');
    ctrl('keydown');

    // `keydown` se répète tant que la touche est enfoncée.
    expect(armements).toEqual([true]);
  });

  it('ne désarme pas un mode armé par ailleurs', () => {
    enabled = true;

    ctrl('keydown');
    ctrl('keyup');

    // Sans la mémoire de « qui a armé », relâcher Ctrl éteindrait un mode que le
    // raccourci n'avait pas allumé. Ctrl est aujourd'hui le seul déclencheur, mais
    // `mode` reste une source d'état extérieure : il se désactive tout seul sur
    // certains chemins d'échec.
    expect(armements).toEqual([]);
    expect(enabled).toBe(true);
  });

  it('rend la main quand la fenêtre perd le focus, Ctrl encore enfoncé', () => {
    ctrl('keydown');

    // Alt+Tab emporte le keyup avec lui. Sans ce filet, le mode resterait armé
    // indéfiniment et le clic suivant, au retour, créerait un bâtiment que personne
    // n'a demandé.
    window.dispatchEvent(new Event('blur'));

    expect(armements).toEqual([true, false]);
  });

  it('ne fait rien sur blur quand il n’avait rien armé', () => {
    window.dispatchEvent(new Event('blur'));

    expect(armements).toEqual([]);
  });

  it('ignore les autres touches', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

    expect(armements).toEqual([]);
  });

  it('retire ses écouteurs au détachement', () => {
    detacher();

    ctrl('keydown');
    window.dispatchEvent(new Event('blur'));

    expect(armements).toEqual([]);
  });
});
