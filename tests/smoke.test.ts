import { describe, it, expect } from 'vitest';
import { USERSCRIPT_META } from '../src/meta';

describe('meta userscript', () => {
  it('déclare run-at document-start et grant none', () => {
    expect(USERSCRIPT_META).toContain('@run-at       document-start');
    expect(USERSCRIPT_META).toContain('@grant        none');
  });

  it('cible les pages osm.org', () => {
    expect(USERSCRIPT_META).toContain('@match        https://www.openstreetmap.org/*');
  });
});
