import { edgeKey, segmentLength } from './edges';
import type { Poly } from './types';

export interface LightComponent {
  members: number[];
  ownerId: number | null;
  contacts: Map<number, number>;   // id du dur -> longueur cumulée partagée
}

const isHard = (p: Poly): boolean => p.type === '01' || p.type === '03';

export function lightComponents(polys: Poly[], index: Map<string, number[]>): LightComponent[] {
  const byId = new Map(polys.map(p => [p.id, p]));
  const light = polys.filter(p => p.type === '02');

  // union-find sur les légers reliés par une arête partagée
  const parent = new Map<number, number>(light.map(p => [p.id, p.id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const owners of index.values()) {
    const legers = owners.filter(id => byId.get(id)?.type === '02');
    for (let i = 1; i < legers.length; i++) unite(legers[0]!, legers[i]!);
  }

  const groups = new Map<number, number[]>();
  for (const p of light) {
    const root = find(p.id);
    const g = groups.get(root);
    if (g) g.push(p.id);
    else groups.set(root, [p.id]);
  }

  const components: LightComponent[] = [];
  for (const members of groups.values()) {
    const inComponent = new Set(members);
    const contacts = new Map<number, number>();
    for (const id of members) {
      const poly = byId.get(id)!;
      const r = poly.outer;
      for (let k = 0; k < r.length - 1; k++) {
        const a = r[k]!, b = r[k + 1]!;
        for (const other of index.get(edgeKey(a, b)) ?? []) {
          if (inComponent.has(other)) continue;
          const op = byId.get(other);
          if (!op || !isHard(op)) continue;
          contacts.set(other, (contacts.get(other) ?? 0) + segmentLength(a, b));
        }
      }
    }
    let ownerId: number | null = null;
    let best = -1;
    for (const id of [...contacts.keys()].sort((x, y) => x - y)) {
      const len = contacts.get(id)!;
      if (len > best) { best = len; ownerId = id; }
    }
    components.push({ members: members.sort((a, b) => a - b), ownerId, contacts });
  }
  return components;
}

export function absorptionMap(components: LightComponent[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const c of components) {
    if (c.ownerId === null) continue;
    const list = map.get(c.ownerId);
    if (list) list.push(...c.members);
    else map.set(c.ownerId, [...c.members]);
  }
  return map;
}
