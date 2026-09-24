import { describe, it, expect } from 'vitest';
import { USERSCRIPT_META } from '../src/meta';

describe('meta userscript', () => {
  it('déclare run-at document-start et grant none', () => {
    expect(USERSCRIPT_META).toContain('@run-at       document-start');
    expect(USERSCRIPT_META).toContain('@grant        none');
  });

  it('cible seulement les chemins de l’éditeur (/edit et /id), pas tout le site', () => {
    // Le greffon n'est utile que dans l'éditeur : `/edit` (spike du 2026-09-23,
    // héberge l'iframe /id) et `/id` (où vit réellement iD). Un match site-wide
    // (`https://www.openstreetmap.org/*`, la forme d'origine) armait le chien de garde
    // de capture sur CHAQUE page du site — carte, changesets, profils... — et y
    // produisait un faux avertissement de rupture structurelle après 8 s, sur des
    // documents où iD n'a jamais été candidat.
    expect(USERSCRIPT_META).toContain('@match        https://www.openstreetmap.org/edit*');
    expect(USERSCRIPT_META).toContain('@match        https://www.openstreetmap.org/id*');
    expect(USERSCRIPT_META).not.toContain('openstreetmap.org/*');
  });
});
