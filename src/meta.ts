export const USERSCRIPT_META = `// ==UserScript==
// @name         slightly-better-osm-org
// @namespace    https://github.com/atchisson/slightly-better-osm-org
// @description  Outils d'édition pour iD : bâtiments et piscines depuis le cadastre français, fusion de deux bâtiments, correction de tracé
// @match        https://www.openstreetmap.org/edit*
// @match        https://www.openstreetmap.org/id*
// @run-at       document-start
// @grant        none
// @version      0.1.0
// ==/UserScript==
`;

/**
 * Horodatage de construction, remplacé textuellement par esbuild (`define`).
 *
 * Sa raison d'être est un diagnostic, pas une fonctionnalité. Sept allers-retours
 * en navigateur ont eu lieu sans qu'aucune trace ne dise QUEL build s'exécutait :
 * une session a été passée à analyser une pile d'appels qui venait de la version
 * précédente, encore installée dans le gestionnaire de scripts. La ligne
 * d'injection le nomme maintenant.
 *
 * Absent des tests (esbuild n'y passe pas) : `typeof` sur un identifiant non
 * déclaré rend « undefined » sans lever, d'où le repli.
 */
declare const __BUILD__: string;
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
