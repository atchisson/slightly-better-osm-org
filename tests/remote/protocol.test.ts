import { describe, it, expect } from 'vitest';
import { lireCommande, origineMapRoulette, estPret, pret, CANAL } from '../../src/remote/protocol';

const valide = {
  canal: CANAL, type: 'aller',
  carte: { zoom: 19, centre: [2.35, 48.85] },
  ids: ['w123', 'n4'],
  comment: 'Fix #maproulette', source: 'cadastre',
};

describe('lireCommande', () => {
  it('reconstruit une commande valide', () => {
    expect(lireCommande(valide)).toEqual(valide);
  });

  it('rejette ce qui n’est pas de notre canal ou pas une commande', () => {
    expect(lireCommande(null)).toBeNull();
    expect(lireCommande('aller')).toBeNull();
    expect(lireCommande({ ...valide, canal: 'autre' })).toBeNull();
    expect(lireCommande({ ...valide, type: 'effacer' })).toBeNull();
  });

  it('ne retient que les champs valides, jamais l’objet reçu', () => {
    const r = lireCommande({ ...valide, intrus: () => 1, ids: ['w1', 'x9', '1; DROP', 'r2'] })!;
    expect(r).not.toHaveProperty('intrus');
    expect(r.ids).toEqual(['w1', 'r2']);
  });

  it('écarte une carte aux coordonnées ou au zoom invalides, sans rejeter le reste', () => {
    for (const carte of [
      { zoom: 19, centre: [200, 48] },
      { zoom: 19, centre: [2, 95] },
      { zoom: 99, centre: [2, 48] },
      { zoom: NaN, centre: [2, 48] },
      { zoom: 19, centre: ['2', '48'] },
      { zoom: 19, centre: [2] },
    ]) {
      const r = lireCommande({ ...valide, carte })!;
      expect(r.carte).toBeUndefined();
      expect(r.comment).toBe('Fix #maproulette');
    }
  });

  it('refuse un texte démesuré', () => {
    const r = lireCommande({ ...valide, comment: 'x'.repeat(5000) })!;
    expect(r.comment).toBeUndefined();
  });

  it('borne le nombre d’identifiants', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `w${i + 1}`);
    expect(lireCommande({ ...valide, ids })!.ids).toHaveLength(50);
  });

  it('rejette une commande sans aucun effet', () => {
    expect(lireCommande({ canal: CANAL, type: 'aller' })).toBeNull();
    expect(lireCommande({ canal: CANAL, type: 'aller', ids: ['zzz'] })).toBeNull();
  });
});

describe('origineMapRoulette', () => {
  it('accepte maproulette.org et ses sous-domaines en https', () => {
    expect(origineMapRoulette('https://maproulette.org')).toBe(true);
    expect(origineMapRoulette('https://staging.maproulette.org')).toBe(true);
  });

  it('refuse le reste, y compris les imitations', () => {
    for (const o of [
      'http://maproulette.org', 'https://maproulette.org.evil.com',
      'https://evilmaproulette.org', 'https://www.openstreetmap.org', 'null', '',
    ]) expect(origineMapRoulette(o)).toBe(false);
  });
});

describe('estPret', () => {
  it('reconnaît son propre message', () => {
    expect(estPret(pret())).toBe(true);
    expect(estPret({ canal: 'autre', type: 'pret' })).toBe(false);
    expect(estPret(null)).toBe(false);
  });
});
