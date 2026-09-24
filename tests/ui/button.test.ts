// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createButton } from '../../src/ui/button';
import type { IdBridge, ToolbarSlot } from '../../src/bridge/types';

const faireRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
     toJSON: () => ({}) }) as DOMRect;

const poser = (el: Element, left: number, top: number, width: number, height: number): void => {
  el.getBoundingClientRect = () => faireRect(left, top, width, height);
};

/**
 * Géométrie relevée dans un vrai iD (sonde en navigateur, cadre `/id`) : la surface
 * de carte commence à `top=0` — la barre d'outils est posée PAR-DESSUS elle, pas
 * au-dessus — et ce bandeau descend jusqu'à 71 px. Reproduire ces chiffres est tout
 * l'intérêt de ces tests : c'est cette superposition, et elle seule, qui a fait
 * échouer deux placements successifs.
 */
const SURFACE = { left: 400, top: 0, width: 1520, height: 606 };
const BAS_BANDEAU = 71;

let container: HTMLElement;
let surface: Element;
let slot: ToolbarSlot | null;
const rectOrigine = HTMLButtonElement.prototype.getBoundingClientRect;
const vivants: Array<() => void> = [];

const fauxBridge = (): IdBridge => ({
  mapExtent: () => [[0, 0], [1, 1]],
  project: (p) => [p[0] * 100, p[1] * 100],
  invert: (p) => [p[0] / 100, p[1] / 100],
  onMapMove: () => () => {},
  buildingsNear: () => [],
  nodesIn: () => [],
  createBuilding: () => {},
  prefillChangeset: () => {},
  containerNode: () => container,
  whenSurfaceReady: () => Promise.resolve(true),
  surfaceNode: () => surface,
  toolbarSlot: () => slot,
  cadastreVisible: () => true,
});

/**
 * Crée un bouton et retient son `destroy`. Sans cela, les boutons d'un test restent
 * abonnés à `resize` et se replacent pendant les tests suivants — une fuite qui
 * noyait la sortie sous des avertissements étrangers au test en cours.
 */
const creer = (onToggle: (on: boolean) => void = () => {}): HTMLButtonElement => {
  const { element, destroy } = createButton(fauxBridge(), onToggle);
  vivants.push(destroy);
  return element;
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.getElementById('cadastre-id-styles')?.remove();
  slot = null;
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

/** Une barre d'outils d'iD : un enfant direct, portant un bouton. */
const barreDOutils = (): { barre: HTMLElement; item: HTMLElement; bouton: HTMLElement } => {
  const barre = document.createElement('div');
  barre.className = 'top-toolbar';
  const item = document.createElement('div');
  item.className = 'toolbar-item bar-item';
  const bouton = document.createElement('button');
  bouton.className = 'bar-button';
  item.appendChild(bouton);
  barre.appendChild(item);
  container.appendChild(barre);
  slot = { item, bouton };
  return { barre, item, bouton };
};

/** Un iD dont la barre d'outils recouvre tout point au-dessus de `BAS_BANDEAU`. */
const simulerBandeau = (): void => {
  const bandeau = document.createElement('div');
  bandeau.className = 'top-toolbar';
  poser(bandeau, 0, 0, 1920, BAS_BANDEAU);
  document.body.appendChild(bandeau);
  document.elementFromPoint = (_x: number, y: number) =>
    y < BAS_BANDEAU ? bandeau : document.querySelector('.cadastre-id-toggle');
};

describe('createButton — dans la barre d\'outils d\'iD', () => {
  it("se greffe juste après l'élément modèle, dans une coquille clonée", () => {
    const { barre, item } = barreDOutils();

    const button = creer();

    const coquille = item.nextElementSibling as HTMLElement;
    expect(coquille.parentElement).toBe(barre);
    expect(coquille.tagName).toBe(item.tagName);
    // La coquille porte les mêmes classes que celle d'iD : c'est elle qui décide de
    // la mise en page (flex, groupes), et la copier évite de la reproduire ici.
    expect(coquille.className).toBe('toolbar-item bar-item');
    expect(coquille.contains(button)).toBe(true);
  });

  it("prend la couleur d'un bouton voisin d'iD, sans hériter de ses règles", () => {
    const { bouton } = barreDOutils();
    bouton.style.color = 'rgb(200, 210, 220)';

    const button = creer();

    // Mesurer la couleur du voisin plutôt que copier sa classe : la première version
    // copiait `bar-button`, et les règles d'iD en faisaient une pastille blanche au
    // milieu d'une barre sombre — une infobulle, pas un outil.
    expect(button.style.color).toBe('rgb(200, 210, 220)');
    expect(button.className).toBe('cadastre-id-toggle');
  });

  it("n'emporte pas l'id du voisin en clonant sa coquille", () => {
    const { item } = barreDOutils();
    item.id = 'un-id-d-iD';

    const button = creer();

    // `cloneNode(false)` reprend les attributs : un id dupliqué casserait le
    // `getElementById` d'iD sur son propre élément.
    expect(button.parentElement?.id).toBe('');
  });

  it("signale l'état armé visuellement et par ARIA", () => {
    barreDOutils();
    const button = creer();

    expect(button.classList.contains('cadastre-id-armed')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.click();

    expect(button.classList.contains('cadastre-id-armed')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it("n'injecte sa feuille de style qu'une fois", () => {
    barreDOutils();
    creer();
    creer();

    expect(document.querySelectorAll('#cadastre-id-styles')).toHaveLength(1);
  });

  it('retire sa coquille au démontage', () => {
    const { barre, item } = barreDOutils();
    const { destroy } = createButton(fauxBridge(), () => {});

    destroy();

    expect(item.nextElementSibling).toBeNull();
    expect(barre.querySelector('.cadastre-id-toggle')).toBeNull();
  });
});

describe('createButton — repli flottant sur la carte', () => {
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

  it('ne part pas hors écran si tout le recouvre, et le signale', () => {
    const avertir = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gêneur = document.createElement('div');
    document.body.appendChild(gêneur);
    // Un gêneur qui descend toujours plus bas que le bouton : sans garde-fou, la
    // descente serait infinie et le bouton finirait sous la carte.
    document.elementFromPoint = (_x: number, y: number) => {
      poser(gêneur, 0, 0, 1920, y + 1000);
      return gêneur;
    };

    const button = creer();

    expect(parseFloat(button.style.top)).toBeLessThan(SURFACE.top + SURFACE.height / 2);
    expect(avertir).toHaveBeenCalledOnce();
  });

  it('est rattaché au conteneur, seul ancêtre positionné connu', () => {
    document.elementFromPoint = () => null;
    const button = creer();

    expect(button.parentElement).toBe(container);
    // Le positionnement absolu vient de la feuille de style (classe flottante) ;
    // seules les coordonnées restent écrites en ligne, puisqu'elles se mesurent.
    expect(button.classList.contains('cadastre-id-flottant')).toBe(true);
  });

  it('se replace quand la surface bouge (repli du panneau, redimensionnement)', () => {
    simulerBandeau();
    const button = creer();

    poser(surface, 0, SURFACE.top, 1920, SURFACE.height); // panneau latéral replié
    window.dispatchEvent(new Event('resize'));

    expect(button.style.left).toBe('10px');
    expect(button.style.top).toBe('81px');
  });
});

describe('createButton — setOn, pour le raccourci Ctrl', () => {
  it('arme et désarme de l’extérieur, en notifiant', () => {
    barreDOutils();
    const etats: boolean[] = [];
    const { setOn, element } = createButton(fauxBridge(), on => etats.push(on));

    setOn(true);
    expect(etats).toEqual([true]);
    expect(element.classList.contains('cadastre-id-armed')).toBe(true);

    setOn(false);
    expect(etats).toEqual([true, false]);
    expect(element.classList.contains('cadastre-id-armed')).toBe(false);
  });

  it('est idempotent', () => {
    barreDOutils();
    const etats: boolean[] = [];
    const { setOn } = createButton(fauxBridge(), on => etats.push(on));

    setOn(true);
    setOn(true);
    setOn(false);
    setOn(false);

    // Le raccourci relâche Ctrl sur des chemins concurrents (keyup, blur) : sans
    // idempotence, le mode serait désarmé deux fois pour un seul relâchement.
    expect(etats).toEqual([true, false]);
  });
});

describe('createButton — bascule', () => {
  it.each([
    ['dans la barre', () => { barreDOutils(); }],
    ['en repli flottant', () => { document.elementFromPoint = () => null; }],
  ])('bascule à chaque clic et signale son état (%s)', (_nom, preparer) => {
    preparer();
    const etats: boolean[] = [];
    const button = creer(on => etats.push(on));

    button.click();
    button.click();
    button.click();

    expect(etats).toEqual([true, false, true]);
  });
});
