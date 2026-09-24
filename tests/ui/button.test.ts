// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createButton } from '../../src/ui/button';

const faireRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
     toJSON: () => ({}) }) as DOMRect;

const poser = (el: Element, left: number, top: number, width: number, height: number): void => {
  el.getBoundingClientRect = () => faireRect(left, top, width, height);
};

/**
 * Géométrie relevée dans un vrai iD (sonde en navigateur, cadre `/id`) :
 * la surface de carte commence à `top=0` — la barre d'outils est posée
 * PAR-DESSUS elle, pas au-dessus — et ce bandeau descend jusqu'à 71 px.
 * Reproduire ces chiffres est tout l'intérêt de ces tests : c'est cette
 * superposition, et elle seule, qui a fait échouer les deux placements précédents.
 */
const SURFACE = { left: 400, top: 0, width: 1520, height: 606 };
const BAS_BANDEAU = 71;

let container: HTMLElement;
let surface: Element;
const rectOrigine = HTMLButtonElement.prototype.getBoundingClientRect;
const vivants: Array<() => void> = [];

/**
 * Crée un bouton et retient son `destroy`. Sans cela, les boutons d'un test
 * restent abonnés à `resize` et se replacent pendant les tests suivants — une
 * fuite qui noyait la sortie sous des avertissements étrangers au test en cours.
 */
const creer = (onToggle: (on: boolean) => void = () => {}): HTMLButtonElement => {
  const { element, destroy } = createButton(container, surface, onToggle);
  vivants.push(destroy);
  return element;
};

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  surface = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.appendChild(surface);
  document.body.appendChild(container);
  poser(container, 0, 0, 1920, 606);
  poser(surface, SURFACE.left, SURFACE.top, SURFACE.width, SURFACE.height);

  // jsdom ne fait pas de mise en page : le rectangle du bouton se déduit du style
  // qu'on vient de lui écrire, pour que l'algorithme de descente soit réellement
  // exercé au lieu de sonder un rectangle nul.
  HTMLButtonElement.prototype.getBoundingClientRect = function (this: HTMLButtonElement) {
    return faireRect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, 68, 30);
  };
});

afterEach(() => {
  for (const destroy of vivants.splice(0)) destroy();
  HTMLButtonElement.prototype.getBoundingClientRect = rectOrigine;
  vi.restoreAllMocks();
});

/** Un iD dont la barre d'outils recouvre tout point au-dessus de `BAS_BANDEAU`. */
const simulerBandeau = (): void => {
  const bandeau = document.createElement('div');
  bandeau.className = 'top-toolbar';
  poser(bandeau, 0, 0, 1920, BAS_BANDEAU);
  document.body.appendChild(bandeau);
  document.elementFromPoint = (_x: number, y: number) =>
    y < BAS_BANDEAU ? bandeau : document.querySelector('.cadastre-id-toggle');
};

describe('createButton', () => {
  it("descend sous la barre d'outils d'iD au lieu de rester dessous", () => {
    simulerBandeau();

    const button = creer();

    // 71 (bas du bandeau) + 10 de marge. Les deux versions précédentes donnaient
    // 10px : le bouton se retrouvait dans le bandeau, invisible.
    expect(button.style.top).toBe('81px');
    expect(button.style.left).toBe('410px');
  });

  it('reste au coin de la carte quand rien ne le recouvre', () => {
    document.elementFromPoint = () => null;

    const button = creer();

    expect(button.style.top).toBe('10px');
    expect(button.style.left).toBe('410px');
  });

  it("ne part pas hors écran si tout le recouvre, et le signale", () => {
    const avertir = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gêneur = document.createElement('div');
    document.body.appendChild(gêneur);
    // Un gêneur qui descend toujours plus bas que le bouton : sans garde-fou,
    // la descente serait infinie et le bouton finirait sous la carte.
    document.elementFromPoint = (_x: number, y: number) => {
      poser(gêneur, 0, 0, 1920, y + 1000);
      return gêneur;
    };

    const button = creer();

    expect(parseFloat(button.style.top)).toBeLessThan(SURFACE.top + SURFACE.height / 2);
    expect(avertir).toHaveBeenCalledOnce();
  });

  it('est bien rattaché au conteneur, seul ancêtre positionné connu', () => {
    document.elementFromPoint = () => null;
    const button = creer();
    expect(button.parentElement).toBe(container);
    expect(button.style.position).toBe('absolute');
  });

  it('se replace quand la surface bouge (repli du panneau, redimensionnement)', () => {
    simulerBandeau();
    const button = creer();

    poser(surface, 0, SURFACE.top, 1920, SURFACE.height); // panneau latéral replié
    window.dispatchEvent(new Event('resize'));

    expect(button.style.left).toBe('10px');
    expect(button.style.top).toBe('81px');
  });

  it('bascule à chaque clic et signale son état', () => {
    document.elementFromPoint = () => null;
    const etats: boolean[] = [];
    const button = creer(on => etats.push(on));

    button.click();
    button.click();
    button.click();

    expect(etats).toEqual([true, false, true]);
  });
});
