export type LonLat = [number, number];
export type Ring = LonLat[];              // closed: first vertex === last
/**
 * Nature d'un polygone du cadastre.
 *
 * `01` dur, `02` léger, `03` « FI, vu du ciel » — les trois valeurs de l'attribut
 * `type` de la couche bâtiments. `piscine` n'en fait PAS partie : elle vient d'une
 * autre couche (`tsurf`, surfaces topographiques) et n'est pas un bâtiment. Elle
 * partage ce type parce qu'elle partage tout le reste du pipeline — survol,
 * composition, recalage — mais elle ne participe jamais à une union : une piscine ne
 * fusionne ni avec un bâtiment, ni avec une autre piscine.
 */
export type BatType = '01' | '02' | '03' | 'piscine';
export interface Poly { id: number; type: BatType; outer: Ring; holes: Ring[]; }
