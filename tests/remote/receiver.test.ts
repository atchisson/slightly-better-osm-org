import { describe, it, expect, vi } from 'vitest';
import { installerRelais, installerRecepteur } from '../../src/remote/receiver';
import { CANAL, pret } from '../../src/remote/protocol';

const MR = 'https://maproulette.org';
const OSM = 'https://www.openstreetmap.org';

/** Une fenêtre factice : un registre d'écouteurs et des cibles de postMessage espionnées. */
function fenetre(origin: string) {
  const ecouteurs = new Set<(e: MessageEvent) => void>();
  const w: any = {
    location: { origin },
    addEventListener: (_: string, f: (e: MessageEvent) => void) => ecouteurs.add(f),
    removeEventListener: (_: string, f: (e: MessageEvent) => void) => ecouteurs.delete(f),
    postMessage: vi.fn(),
    document: { querySelector: () => null },
  };
  w.top = w;
  w.opener = null;
  w.parent = w;
  w.recevoir = (data: unknown, source: unknown, origine: string) =>
    ecouteurs.forEach(f => f({ data, source, origin: origine } as MessageEvent));
  w.nbEcouteurs = () => ecouteurs.size;
  return w;
}

const commande = { canal: CANAL, type: 'aller', carte: { zoom: 19, centre: [2.35, 48.85] }, ids: ['w1'] };

describe('installerRecepteur (iframe d’iD)', () => {
  const montage = () => {
    const parent = fenetre(OSM);
    const iframe = fenetre(OSM);
    iframe.top = parent;
    iframe.parent = parent;
    const nav = { aller: vi.fn() };
    const retirer = installerRecepteur(nav, iframe);
    return { parent, iframe, nav, retirer };
  };

  it('annonce « prêt » au cadre principal, de même origine', () => {
    const { parent } = montage();
    expect(parent.postMessage).toHaveBeenCalledOnce();
    expect(parent.postMessage).toHaveBeenCalledWith(pret(), OSM);
  });

  it('exécute une commande venue du cadre principal', () => {
    const { parent, iframe, nav } = montage();
    iframe.recevoir(commande, parent, OSM);
    expect(nav.aller).toHaveBeenCalledOnce();
    expect(nav.aller.mock.calls[0]![0].ids).toEqual(['w1']);
  });

  it('ignore tout autre expéditeur ou origine', () => {
    const { iframe, nav, parent } = montage();
    iframe.recevoir(commande, {}, OSM);               // pas le cadre principal
    iframe.recevoir(commande, parent, MR);            // bonne source, mauvaise origine
    iframe.recevoir({ canal: 'autre' }, parent, OSM); // pas une commande
    expect(nav.aller).not.toHaveBeenCalled();
  });

  it('une commande qui lève ne casse pas l’écoute', () => {
    const { parent, iframe, nav } = montage();
    const espion = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nav.aller.mockImplementationOnce(() => { throw new Error('iD a changé'); });
    iframe.recevoir(commande, parent, OSM);
    iframe.recevoir(commande, parent, OSM);
    expect(nav.aller).toHaveBeenCalledTimes(2);
    espion.mockRestore();
  });

  it('se désabonne', () => {
    const { iframe, retirer } = montage();
    retirer();
    expect(iframe.nbEcouteurs()).toBe(0);
  });
});

describe('installerRecepteur (iD comme cadre principal)', () => {
  it('reçoit de la fenêtre MapRoulette qui l’a ouvert, et lui annonce être prêt', () => {
    const w = fenetre(OSM);
    w.opener = fenetre(MR);
    const nav = { aller: vi.fn() };
    installerRecepteur(nav, w);

    expect(w.opener.postMessage).toHaveBeenCalledWith(pret(), '*');
    w.recevoir(commande, w.opener, MR);
    expect(nav.aller).toHaveBeenCalledOnce();
  });

  it('refuse un opener d’une autre origine, ou une autre fenêtre', () => {
    const w = fenetre(OSM);
    w.opener = fenetre(MR);
    const nav = { aller: vi.fn() };
    installerRecepteur(nav, w);
    w.recevoir(commande, w.opener, 'https://evil.example');
    w.recevoir(commande, fenetre(MR), MR);
    expect(nav.aller).not.toHaveBeenCalled();
  });
});

describe('installerRelais (cadre principal /edit)', () => {
  const montage = () => {
    const w = fenetre(OSM);
    w.opener = fenetre(MR);
    const cadre = fenetre(OSM);
    w.document.querySelector = () => ({ contentWindow: cadre });
    const retirer = installerRelais(w);
    return { w, cadre, retirer };
  };

  it('transmet à l’iframe une commande valide de MapRoulette', () => {
    const { w, cadre } = montage();
    w.recevoir(commande, w.opener, MR);
    expect(cadre.postMessage).toHaveBeenCalledOnce();
    expect(cadre.postMessage.mock.calls[0]![1]).toBe(OSM);
  });

  it('ne transmet rien venant d’ailleurs ou d’invalide', () => {
    const { w, cadre } = montage();
    w.recevoir(commande, w.opener, 'https://evil.example');
    w.recevoir(commande, {}, MR);
    w.recevoir({ canal: 'autre' }, w.opener, MR);
    expect(cadre.postMessage).not.toHaveBeenCalled();
  });

  it('relaie « prêt » de l’iframe vers l’onglet MapRoulette', () => {
    const { w, cadre } = montage();
    w.recevoir(pret(), cadre, OSM);
    expect(w.opener.postMessage).toHaveBeenCalledWith(pret(), '*');
  });

  it('ne relaie pas un « prêt » d’une origine étrangère', () => {
    const { w, cadre } = montage();
    w.recevoir(pret(), cadre, 'https://evil.example');
    expect(w.opener.postMessage).not.toHaveBeenCalled();
  });

  it('ne fait rien dans une iframe', () => {
    const w = fenetre(OSM);
    w.top = fenetre(OSM);
    installerRelais(w);
    expect(w.nbEcouteurs()).toBe(0);
  });
});
