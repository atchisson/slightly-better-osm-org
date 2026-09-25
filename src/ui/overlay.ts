import type { IdBridge } from '../bridge/types';
import type { LonLat, Ring } from '../geometry/types';

const NS = 'http://www.w3.org/2000/svg';

/**
 * Calque d'aperçu au survol.
 *
 * Cet overlay est le seul garde-fou entre l'heuristique de fusion porche/bâtiment et
 * une mauvaise annexion publiée sur OpenStreetMap (voir les notes de la tâche 15) :
 * c'est ce module qui montre, avant le clic, le contour COMPOSÉ — c'est-à-dire quels
 * polygones cadastre ont été fusionnés, la décision qui compte réellement pour la
 * sécurité (255 porches par commune tranchés à moins de 5 cm). Ce contour est celui que
 * `compose()` produit, AVANT le recalage aux nœuds OSM existants (`snapToExistingNodes`,
 * task 13) : le survol ne recale jamais, donc le ring montré ici peut différer du ring
 * effectivement créé par le clic — jamais dans la composition (quels polygones ont
 * fusionné, ça ne bouge pas), seulement dans la position de certains sommets, et jamais
 * de plus que la tolérance de recalage (`DEFAULT_SNAP_TOLERANCE_M`, 0,2 m aujourd'hui).
 * (Revue : ce commentaire disait auparavant que ce module montre « le contour EXACT que
 * le clic créerait », ce qui est faux dès que le recalage déplace un sommet — le cas
 * courant, pas l'exception.)
 * Il vit délibérément hors du pipeline de rendu d'iD — un SVG que NOUS possédons,
 * ajouté au conteneur de la carte, jamais inséré dans les calques d'iD. C'est la même
 * discipline d'isolation que le bridge (task 14) applique aux internes d'iD.
 */
export interface Overlay {
  show(ring: Ring, state: 'ok' | 'refus'): void;
  hide(): void;
  /**
   * Marque ce que le curseur vise sur une voie, pour le mode d'amélioration de tracé.
   *
   * Un cercle plein sur un sommet — ce qu'un clic déplacerait — et un cercle creux sur
   * un segment — là où un clic insérerait un nœud. La distinction doit se voir sans
   * lire de légende : c'est elle qui dit ce que le geste va faire, avant qu'il ne soit
   * fait.
   *
   * `partage` vire la marque à l'orange : le nœud appartient à plusieurs voies, et le
   * déplacer déplacera la jonction pour toutes. Sur une route, c'est le cas courant,
   * pas l'exception.
   */
  showTarget(loc: LonLat, kind: 'noeud' | 'segment', partage?: boolean): void;
  hideTarget(): void;
  redraw(): void;
  destroy(): void;
}

export function createOverlay(bridge: IdBridge): Overlay {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'cadastre-id-overlay');
  svg.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:50';

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', '');
  path.setAttribute('class', 'cadastre-id-preview');
  path.setAttribute('fill', 'rgba(64,160,255,0.25)');
  path.setAttribute('stroke', '#2e7dd7');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  const marque = document.createElementNS(NS, 'circle');
  marque.setAttribute('r', '6');
  marque.setAttribute('stroke', '#2e7dd7');
  marque.setAttribute('stroke-width', '2');
  marque.setAttribute('visibility', 'hidden');
  svg.appendChild(marque);

  // Attaché à `surfaceNode()` — l'élément dont le coin EST l'origine de `project()` —
  // et jamais au conteneur d'iD, qui inclut la barre d'outils et le panneau latéral.
  // C'était le défaut : le calque dessinait des coordonnées projetées depuis l'origine
  // de la surface dans un SVG calé, lui, sur l'origine du conteneur. Le décalage vaut la
  // largeur du panneau latéral — qui s'ouvre précisément après chaque création, puisque
  // le bridge appelle `modeSelect`. Un aperçu décalé est pire qu'un aperçu absent : il a
  // l'air de fonctionner.
  //
  // Quand `surfaceNode()` est le `<svg class="surface">` d'iD, notre `<svg>` y devient
  // un viewport imbriqué : sans x/y/width/height, il vaut par défaut (0, 0, 100 %,
  // 100 %) du viewport parent, donc son système de coordonnées utilisateur coïncide
  // EXACTEMENT avec celui de la projection — par construction, sans dépendre d'aucune
  // règle CSS. Le `position:absolute;inset:0` ci-dessus ne sert que dans le cas de
  // repli, où `surfaceNode()` rend un élément HTML ; il est sans effet (et sans nuisance)
  // à l'intérieur d'un SVG. On reste pour autant hors du pipeline de rendu d'iD : notre
  // `<svg>` n'a aucune des classes que les jointures de données d'iD sélectionnent, et
  // il n'est jamais inséré dans un de ses calques.
  bridge.surfaceNode().appendChild(svg);

  // `current` est l'anneau géographique montré ; il est reprojeté à chaque déplacement
  // de carte (draw), jamais mémorisé en coordonnées écran — sinon un pan ou un zoom
  // laisserait le contour affiché à l'ancienne position.
  let current: Ring | null = null;
  let cible: { loc: LonLat; kind: 'noeud' | 'segment'; partage: boolean } | null = null;

  const drawTarget = (): void => {
    if (!cible) { marque.setAttribute('visibility', 'hidden'); return; }
    const [x, y] = bridge.project(cible.loc);
    marque.setAttribute('cx', String(x));
    marque.setAttribute('cy', String(y));
    // Plein pour un sommet existant, creux pour un point d'insertion : la forme dit
    // si le clic déplacera quelque chose ou en ajoutera.
    const teinte = cible.partage ? '#e08a2e' : '#2e7dd7';
    marque.setAttribute('stroke', teinte);
    marque.setAttribute('fill', cible.kind === 'noeud' ? teinte : 'rgba(255,255,255,0.85)');
    marque.setAttribute('visibility', 'visible');
  };

  const draw = (): void => {
    drawTarget();
    if (!current) { path.setAttribute('d', ''); return; }
    const d = current
      .map((p, i) => {
        const [x, y] = bridge.project(p);
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      })
      .join(' ') + ' Z';
    path.setAttribute('d', d);
  };

  // bridge.onMapMove renvoie un désabonnement : destroy() DOIT l'appeler, sinon un
  // overlay détruit continue de redessiner contre un conteneur qu'il ne possède plus
  // (voir le contrat de la tâche 15).
  const stopListening = bridge.onMapMove(draw);

  return {
    show(ring, state) {
      current = ring;
      // Appliqué sans condition sur un changement d'état : un premier `show('ok')` de
      // session doit porter la classe `cadastre-id-ok` au même titre qu'un `show('ok')`
      // qui suit un `show('refus')` — revue de la tâche 15, un garde sur l'état
      // précédent laissait le tout premier appel sans le suffixe d'état.
      path.setAttribute('class', `cadastre-id-preview cadastre-id-${state}`);
      path.setAttribute('fill', state === 'ok' ? 'rgba(64,160,255,0.25)' : 'rgba(224,80,80,0.25)');
      path.setAttribute('stroke', state === 'ok' ? '#2e7dd7' : '#c23b3b');
      draw();
    },
    hide() { current = null; draw(); },
    showTarget(loc, kind, partage = false) { cible = { loc, kind, partage }; drawTarget(); },
    hideTarget() { cible = null; drawTarget(); },
    redraw: draw,
    destroy() { stopListening(); svg.remove(); },
  };
}
