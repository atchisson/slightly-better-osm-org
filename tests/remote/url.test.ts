import { describe, it, expect } from 'vitest';
import { commandeDepuisUrl } from '../../src/remote/url';
import { CANAL } from '../../src/remote/protocol';

// L'URL exacte que MapRoulette ouvre (Editor.js) : l'objet en paramètre de requête,
// tout le reste dans le hash.
const MAPROULETTE =
  'https://www.openstreetmap.org/edit?editor=id&way=456#map=19/48.8566/2.3522' +
  '&comment=%23maproulette%20%23defi&source=defi%20un&background=x&presets=a,b';

describe('commandeDepuisUrl', () => {
  it('lit l’URL réelle de MapRoulette', () => {
    expect(commandeDepuisUrl(MAPROULETTE)).toEqual({
      canal: CANAL, type: 'aller',
      carte: { zoom: 19, centre: [2.3522, 48.8566] },
      ids: ['w456'],
      comment: '#maproulette #defi',
      source: 'defi un',
    });
  });

  it('lit node= et relation=', () => {
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit?editor=id&node=12#map=18/1/2')!.ids).toEqual(['n12']);
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit?editor=id&relation=7#map=18/1/2')!.ids).toEqual(['r7']);
  });

  it('lit plusieurs identifiants, par paramètre et par liste', () => {
    const c = commandeDepuisUrl('https://www.openstreetmap.org/edit?node=1&way=2,3&relation=4#map=18/1/2')!;
    expect(c.ids).toEqual(['n1', 'w2', 'w3', 'r4']);
  });

  it('lit le paramètre de hash id=', () => {
    const c = commandeDepuisUrl('https://www.openstreetmap.org/id#id=w1,n2,r3&map=18/1/2')!;
    expect(c.ids).toEqual(['w1', 'n2', 'r3']);
  });

  it('cumule la requête et le hash pour les identifiants', () => {
    const c = commandeDepuisUrl('https://www.openstreetmap.org/edit?way=5#id=n9&map=18/1/2')!;
    expect(c.ids).toEqual(['w5', 'n9']);
  });

  it('rend null sans rien d’utile', () => {
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit?editor=id')).toBeNull();
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit?editor=id#background=x&presets=a')).toBeNull();
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit#')).toBeNull();
  });

  it('rend null pour une entrée invalide', () => {
    expect(commandeDepuisUrl('')).toBeNull();
    expect(commandeDepuisUrl('pas une url')).toBeNull();
    expect(commandeDepuisUrl(undefined as unknown as string)).toBeNull();
  });

  it('ignore les identifiants non numériques ou malformés', () => {
    const c = commandeDepuisUrl('https://www.openstreetmap.org/edit?way=abc,12,&node=x#map=18/1/2')!;
    expect(c.ids).toEqual(['w12']);
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit?way=abc')).toBeNull();
  });

  it('écarte une carte invalide sans rejeter le reste', () => {
    for (const map of ['map=19/48', 'map=a/b/c', 'map=99/1/2', 'map=19/95/2', 'map=19/1/200', 'map=']) {
      const c = commandeDepuisUrl(`https://www.openstreetmap.org/edit?way=1#${map}`)!;
      expect(c.carte).toBeUndefined();
      expect(c.ids).toEqual(['w1']);
    }
  });

  it('accepte une carte seule, avec zoom décimal', () => {
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit#map=17.5/-1.5/-2.5')).toEqual({
      canal: CANAL, type: 'aller', carte: { zoom: 17.5, centre: [-2.5, -1.5] },
    });
  });

  it('ignore les paramètres inconnus', () => {
    const c = commandeDepuisUrl('https://www.openstreetmap.org/edit?foo=1&editor=id#map=18/1/2&bar=2&layers=x')!;
    expect(Object.keys(c).sort()).toEqual(['canal', 'carte', 'type']);
  });

  it('décode %2B, + et %20 du commentaire', () => {
    const c = commandeDepuisUrl('https://www.openstreetmap.org/edit#comment=a%2Bb+c%20d&source=x%2By')!;
    expect(c.comment).toBe('a+b c d');
    expect(c.source).toBe('x+y');
  });

  it('un commentaire seul suffit', () => {
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit#comment=Salut')).toEqual({
      canal: CANAL, type: 'aller', comment: 'Salut',
    });
  });

  it('laisse lireCommande borner la taille du texte', () => {
    expect(commandeDepuisUrl('https://www.openstreetmap.org/edit#comment=' + 'a'.repeat(2001))).toBeNull();
  });
});
