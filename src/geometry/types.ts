export type LonLat = [number, number];
export type Ring = LonLat[];              // closed: first vertex === last
export type BatType = '01' | '02' | '03'; // dur / léger / « FI, vu du ciel »
export interface Poly { id: number; type: BatType; outer: Ring; holes: Ring[]; }
