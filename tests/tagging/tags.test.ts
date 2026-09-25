import { describe, it, expect } from 'vitest';
import { buildingTags, changesetComment, changesetSource, poolTags } from '../../src/tagging/tags';

describe('buildingTags', () => {
  it('pose building=yes et la source verbatim avec le millésime', () => {
    expect(buildingTags({ isolatedLight: false, millesime: '2026' })).toEqual({
      building: 'yes',
      source: 'cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : 2026',
    });
  });

  it('ajoute wall=no sur une construction légère isolée', () => {
    const tags = buildingTags({ isolatedLight: true, millesime: '2026' });
    expect(tags.wall).toBe('no');
    expect(tags.building).toBe('yes');
  });

  it("n'ajoute jamais wall=no sur une union maison + porche", () => {
    expect(buildingTags({ isolatedLight: false, millesime: '2026' }).wall).toBeUndefined();
  });

  // Ce module porte la seule obligation légale du projet : la Licence Ouverte exige que
  // l'origine ET le millésime figurent sur chaque objet créé. La garde précédente
  // (`if (!input.millesime)`) ne rejetait QUE la chaîne vide — une chaîne d'espaces, un
  // `latest`, ou n'importe quel texte se serait glissé dans l'attribution de chaque
  // objet, sous la forme « Mise à jour :    » : lisible par personne, invérifiable.
  for (const mauvais of ['', '   ', '	', '20', '12345', 'latest', '2026-06-01', 'inconnu', '  2026  ', '202a']) {
    it(`refuse le millésime ${JSON.stringify(mauvais)} plutôt que d'en inventer un`, () => {
      expect(() => buildingTags({ isolatedLight: false, millesime: mauvais })).toThrow(/millésime/i);
    });
  }

  it("refuse un millésime absent plutôt que d'en inventer un", () => {
    expect(() => buildingTags({ isolatedLight: false, millesime: '' })).toThrow(/millésime/i);
  });
});

describe('changesetComment', () => {
  it('nomme la commune et le cadastre', () => {
    const c = changesetComment('Angers');
    expect(c).toContain('cadastre');
    expect(c).toContain('Angers');
  });
});

describe('changesetSource', () => {
  it('rend verbatim la même chaîne que le tag source de l’objet', () => {
    expect(changesetSource('2026'))
      .toBe(buildingTags({ isolatedLight: false, millesime: '2026' }).source);
  });

  it('refuse un millésime invalide, comme buildingTags', () => {
    expect(() => changesetSource('latest')).toThrow(/millésime/i);
  });
});

describe('poolTags', () => {
  it('tague une piscine, pas un bâtiment', () => {
    const t = poolTags('2026');

    expect(t['leisure']).toBe('swimming_pool');
    // Pas de `building` : une piscine n'en est pas un, et elle ne vient même pas de
    // la couche des bâtiments.
    expect(t['building']).toBeUndefined();
    expect(t['wall']).toBeUndefined();
  });

  it('pose access=private, qui est un choix et non une déduction', () => {
    // Le cadastre ne dit rien du régime d'accès et ne distingue pas la piscine d'un
    // particulier de celle d'un camping. C'est l'usage majoritaire du gisement, pas
    // une information lue dans la donnée.
    expect(poolTags('2026')['access']).toBe('private');
  });

  it('porte la même attribution que tout objet créé', () => {
    expect(poolTags('2026')['source']).toContain('Mise à jour : 2026');
  });

  it('refuse un millésime qui n’est pas une année', () => {
    expect(() => poolTags('latest')).toThrow(/millésime/i);
  });
});
