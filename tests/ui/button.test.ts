// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createButton } from '../../src/ui/button';

/**
 * Le coin du conteneur d'iD n'est PAS le coin de la carte : la barre d'outils
 * occupe le haut, le panneau latéral la gauche. Ces rectangles reproduisent cet
 * écart, qui est précisément ce que le placement doit compenser.
 */
const rect = (el: Element, left: number, top: number, width = 800, height = 600): void => {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
       toJSON: () => ({}) }) as DOMRect;
};

let container: HTMLElement;
let surface: Element;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  surface = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.appendChild(surface);
  document.body.appendChild(container);
  rect(container, 0, 0, 1280, 800);
  rect(surface, 400, 60);   // 400 px de panneau latéral, 60 px de barre d'outils
});

describe('createButton', () => {
  it("se place sur le coin de la CARTE, pas sur celui du conteneur d'iD", () => {
    // Le défaut d'origine : top:10/right:10 du conteneur, soit le coin qu'occupe
    // déjà la barre « Annuler / Rétablir / Sauvegarder ». Le bouton y était
    // recouvert, donc invisible. Il doit atterrir sur la surface, à gauche.
    const button = createButton(container, surface, () => {});

    expect(button.style.left).toBe('410px');
    expect(button.style.top).toBe('70px');
    expect(button.style.right).toBe('');
  });

  it('est bien rattaché au conteneur, seul ancêtre positionné connu', () => {
    const button = createButton(container, surface, () => {});
    expect(button.parentElement).toBe(container);
    expect(button.style.position).toBe('absolute');
  });

  it('se replace quand la surface bouge (repli du panneau, redimensionnement)', () => {
    const button = createButton(container, surface, () => {});

    rect(surface, 0, 60);   // panneau latéral replié : la carte gagne la gauche
    window.dispatchEvent(new Event('resize'));

    expect(button.style.left).toBe('10px');
    expect(button.style.top).toBe('70px');
  });

  it('bascule à chaque clic et signale son état', () => {
    const etats: boolean[] = [];
    const button = createButton(container, surface, on => etats.push(on));

    button.click();
    button.click();
    button.click();

    expect(etats).toEqual([true, false, true]);
  });
});
