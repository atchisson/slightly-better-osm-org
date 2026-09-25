import { describe, it, expect } from 'vitest';
import { planMerge } from '../src/merge';
import type { OsmWay } from '../src/merge';

const M = 1 / 111320;   // ~1 m en latitude

/** Un rectangle OSM, avec ses nœuds nommés. */
const rect = (
  id: string,
  x0: number, y0: number, x1: number, y1: number,
  noms: string[],
  tags: Record<string, string> = { building: 'yes' },
): OsmWay => ({
  id,
  ring: [[x0 * M, y0 * M], [x1 * M, y0 * M], [x1 * M, y1 * M], [x0 * M, y1 * M], [x0 * M, y0 * M]],
  nodeIds: [...noms, noms[0]!],
  tags,
});

// Deux moitiés d'un même bâtiment, séparées par une limite de parcelle : le mur
// commun x=10 porte les mêmes nœuds des deux côtés, comme après un import cadastre.
const gauche = rect('w1', 0, 0, 10, 8, ['nA', 'nB', 'nC', 'nD']);
const droite: OsmWay = {
  id: 'w2',
  ring: [[10 * M, 0], [20 * M, 0], [20 * M, 8 * M], [10 * M, 8 * M], [10 * M, 0]],
  nodeIds: ['nB', 'nE', 'nF', 'nC', 'nB'],
  tags: { building: 'yes' },
};

describe('planMerge', () => {
  it('réunit deux moitiés en une seule voie', () => {
    const p = planMerge([gauche, droite]);

    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // Le mur intérieur disparaît : nB et nC ne sont plus reliés l'un à l'autre. Ils
    // RESTENT dans l'anneau, comme sommets colinéaires des bords extérieurs — rien
    // ici ne permet d'affirmer qu'aucun autre objet ne les utilise, et les supprimer
    // sur cette seule présomption casserait ce qui s'y accroche.
    expect(p.nodeIds).toEqual(['nA', 'nB', 'nE', 'nF', 'nC', 'nD', 'nA']);
  });

  it('conserve la plus grande des deux voies, quel que soit l’ordre', () => {
    // L'identifiant, l'historique et les appartenances à des relations de la voie
    // conservée survivent à la fusion — ce qu'une création suivie de deux
    // suppressions détruirait.
    const petit = rect('petit', 0, 0, 10, 8, ['nA', 'nB', 'nC', 'nD']);
    const grand: OsmWay = { ...droite, id: 'grand', ring: [
      [10 * M, 0], [40 * M, 0], [40 * M, 8 * M], [10 * M, 8 * M], [10 * M, 0]] };

    expect((planMerge([petit, grand]) as { keepId: string }).keepId).toBe('grand');
    expect((planMerge([grand, petit]) as { keepId: string }).keepId).toBe('grand');
  });

  it('ne crée ni ne déplace aucun nœud', () => {
    const p = planMerge([gauche, droite]);

    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const connus = new Set([...gauche.nodeIds, ...droite.nodeIds]);
    for (const id of p.nodeIds) expect(connus.has(id)).toBe(true);
  });

  it('refuse deux bâtiments qui ne se touchent pas', () => {
    const loin: OsmWay = { ...droite, id: 'w3', ring: [
      [50 * M, 0], [60 * M, 0], [60 * M, 8 * M], [50 * M, 8 * M], [50 * M, 0]],
      nodeIds: ['nX', 'nY', 'nZ', 'nW', 'nX'] };

    const p = planMerge([gauche, loin]);

    expect(p.ok).toBe(false);
    if (p.ok) return;
    // Message dédié : c'est l'erreur de manipulation la plus probable.
    expect(p.reason).toBe('pas-mitoyens');
  });

  it('refuse autre chose que deux bâtiments', () => {
    expect((planMerge([gauche]) as { reason: string }).reason).toBe('pas-deux');
    expect((planMerge([gauche, droite, droite]) as { reason: string }).reason).toBe('pas-deux');
  });

  it('refuse une géométrie dont les nœuds ne suivent pas l’anneau', () => {
    const casse: OsmWay = { ...droite, nodeIds: ['nB', 'nE'] };

    expect((planMerge([gauche, casse]) as { reason: string }).reason).toBe('geometrie-illisible');
  });

  it('réunit les tags et signale ceux qui divergeaient', () => {
    const a = rect('w1', 0, 0, 10, 8, ['nA', 'nB', 'nC', 'nD'],
      { building: 'house', 'addr:housenumber': '12' });
    const b: OsmWay = { ...droite, tags: { building: 'yes', roof: 'gabled' } };

    const p = planMerge([a, b]);

    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // b est plus grand (10x8 contre... non : même taille, donc a est conservé car
    // l'égalité retient le premier) — la valeur du conservé l'emporte, et la clé
    // en conflit est nommée plutôt qu'écrasée en silence.
    expect(p.tags['building']).toBe('house');
    expect(p.tags['addr:housenumber']).toBe('12');
    expect(p.tags['roof']).toBe('gabled');
    expect(p.tagsEnConflit).toEqual(['building']);
  });
});
