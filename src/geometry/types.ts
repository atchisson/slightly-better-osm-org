export type LonLat = [number, number];
export type Ring = LonLat[];              // closed: first vertex === last
/**
 * Nature d'un polygone du cadastre.
 *
 * `01` dur, `02` léger, `03` « FI, vu du ciel » — les trois valeurs de l'attribut
 * `type` de la couche bâtiments. `piscine` et `surface` n'en font PAS partie : elles
 * viennent d'une autre couche (`tsurf`, surfaces topographiques) et ne sont pas des
 * bâtiments. Elles partagent ce type parce qu'elles partagent tout le reste du
 * pipeline — survol, composition, recalage — mais ne participent jamais à une union :
 * elles ne fusionnent ni avec un bâtiment, ni entre elles. `surface` regroupe tous les
 * codes symbole de `tsurf` autres que la piscine.
 */
export type BatType = '01' | '02' | '03' | 'piscine' | 'surface';
export interface Poly { id: number; type: BatType; outer: Ring; holes: Ring[]; }
