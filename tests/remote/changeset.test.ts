import { describe, it, expect } from 'vitest';
import { fusionnerComment, fusionnerSource } from '../../src/remote/changeset';

describe('fusionnerComment', () => {
  it('dédoublonne les hashtags communs et garde l’ordre', () => {
    expect(fusionnerComment('#maproulette #a', '#maproulette #b')).toBe('#maproulette #a #b');
  });

  it('joint les textes par « ; » et range les hashtags à la fin', () => {
    expect(fusionnerComment('Fix roads #maproulette #a', 'Fix names #maproulette #b'))
      .toBe('Fix roads; Fix names #maproulette #a #b');
  });

  it('dédoublonne les hashtags sans tenir compte de la casse, en gardant la 1re graphie', () => {
    expect(fusionnerComment('Fix #maproulette #a', 'Fix #MapRoulette #a')).toBe('Fix #maproulette #a');
    expect(fusionnerComment('#MapRoulette', '#maproulette')).toBe('#MapRoulette');
  });

  it('dédoublonne les textes à l’identique, mais pas selon la casse', () => {
    expect(fusionnerComment('Fix', 'Fix')).toBe('Fix');
    expect(fusionnerComment('Fix', 'fix')).toBe('Fix; fix');
  });

  it('gère les vides', () => {
    expect(fusionnerComment('', 'x')).toBe('x');
    expect(fusionnerComment('x', '')).toBe('x');
    expect(fusionnerComment('', '')).toBe('');
    expect(fusionnerComment('  ', '#a')).toBe('#a');
    expect(fusionnerComment('', '#a #b')).toBe('#a #b');
  });

  it('normalise les blancs multiples, tabulations et retours à la ligne', () => {
    expect(fusionnerComment('  Fix   roads \n #a ', '\t#b')).toBe('Fix roads #a #b');
  });

  it('un # seul ou un # au milieu d’un mot n’est pas un hashtag', () => {
    expect(fusionnerComment('Fix # roads', 'C#')).toBe('Fix # roads; C#');
  });

  it('un hashtag au milieu du texte est déplacé en fin', () => {
    expect(fusionnerComment('Fix #a roads', '')).toBe('Fix roads #a');
  });

  it('ne dépasse jamais max : retire les textes depuis la fin, jamais le premier', () => {
    expect(fusionnerComment('aaaa #t', 'bbbb', 12)).toBe('aaaa #t');
    expect(fusionnerComment('aaaa #t', 'bbbb', 100)).toBe('aaaa; bbbb #t');
    expect(fusionnerComment('aaaa', 'bbbb; cccc', 13)).toBe('aaaa');
    const r = fusionnerComment('aaaa', 'bbbb', 5);
    expect(r).toBe('aaaa');
  });

  it('tronque le seul texte restant avec « … », sans toucher aux hashtags', () => {
    expect(fusionnerComment('abcdefghijklmnop #tag', '', 12)).toBe('abcdef… #tag');
  });

  it('respecte exactement max après troncature', () => {
    const r = fusionnerComment('abcdefghijklmnop #tag', '', 12);
    expect(r.length).toBeLessThanOrEqual(12);
    expect(r.endsWith(' #tag')).toBe(true);
    expect(r).toContain('…');
  });

  it('tronque un texte seul sans hashtag', () => {
    expect(fusionnerComment('abcdefghij', '', 5)).toBe('abcd…');
  });

  it('si les hashtags seuls dépassent, ne garde que ceux qui tiennent entiers, dans l’ordre', () => {
    expect(fusionnerComment('texte #aaaa #bbbb', '#cccc', 11)).toBe('#aaaa #bbbb');
    expect(fusionnerComment('texte #aaaa #bbbb', '#cccc', 10)).toBe('#aaaa');
  });

  it('un hashtag trop long à lui seul est abandonné, jamais coupé', () => {
    expect(fusionnerComment('#a #unhashtagbeaucouptroplong', '', 5)).toBe('#a');
    expect(fusionnerComment('#unhashtagbeaucouptroplong', '', 5)).toBe('');
  });

  it('un résultat qui tient pile est conservé', () => {
    expect(fusionnerComment('abc #de', '', 7)).toBe('abc #de');
  });

  it('par défaut max vaut 255 et le résultat ne le dépasse jamais', () => {
    const long = 'x'.repeat(300);
    expect(fusionnerComment(long, '#a').length).toBeLessThanOrEqual(255);
    const tags = Array.from({ length: 80 }, (_, i) => `#tag${i}`).join(' ');
    const r = fusionnerComment(tags, 'texte');
    expect(r.length).toBeLessThanOrEqual(255);
    expect(r.split(' ').every(m => /^#tag\d+$/.test(m))).toBe(true);
  });
});

describe('fusionnerSource', () => {
  it('joint par « ; » sans espace', () => {
    expect(fusionnerSource('defi un', 'defi deux')).toBe('defi un;defi deux');
  });

  it('dédoublonne à l’identique', () => {
    expect(fusionnerSource('a;b', 'b;c')).toBe('a;b;c');
    expect(fusionnerSource('a', 'A')).toBe('a;A');
  });

  it('trim les valeurs et ignore les vides', () => {
    expect(fusionnerSource(' a ; ;b;', ';; c')).toBe('a;b;c');
    expect(fusionnerSource('', '')).toBe('');
    expect(fusionnerSource('a;b', '')).toBe('a;b');
    expect(fusionnerSource('', 'a')).toBe('a');
  });

  it('retire les valeurs depuis la fin pour tenir, en gardant au moins la 1re', () => {
    expect(fusionnerSource('aaa;bbb', 'ccc', 7)).toBe('aaa;bbb');
    expect(fusionnerSource('aaa;bbb', 'ccc', 6)).toBe('aaa');
  });

  it('tronque la 1re valeur si elle dépasse seule', () => {
    expect(fusionnerSource('abcdefghij', 'x', 4)).toBe('abcd');
  });

  it('max vaut 255 par défaut', () => {
    expect(fusionnerSource('x'.repeat(300), 'y').length).toBe(255);
  });
});
