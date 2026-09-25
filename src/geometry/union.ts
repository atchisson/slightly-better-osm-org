import { edgeKey, METRES_PAR_DEGRE_LAT, surSegment } from './edges';
import type { LonLat, Poly, Ring } from './types';

export type UnionResult =
  | { ok: true; ring: Ring }
  | { ok: false; reason: 'pincement' | 'trou' | 'parties-multiples' | 'vide' | 'chevauchement' };

const vertexKey = (p: LonLat): string => `${p[0]},${p[1]}`;

export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export function pointInRing(pt: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Test d'appartenance complet à un polygone : dans l'anneau extérieur, et hors de
 * chacun de ses trous. `pointInRing(pt, poly.outer)` seul accepterait un point posé
 * dans la cour d'un polygone troué, attribuant à tort ce point à l'enveloppe trouée —
 * revue Task 12 sur données réelles d'Angers : 19 bâtiments sur 29 dont le centre tombe
 * dans la cour d'un voisin étaient mal attribués par les deux points d'appel du survol
 * (`Dataset.polyAt` et le balayage linéaire de secours dans `compose.ts`), qui ne
 * testaient que l'anneau extérieur. Les deux doivent partager ce test : ils sont censés
 * être interchangeables (`ComposeInput.polyAt` peut être fourni ou, à défaut, remplacé
 * par ce même balayage).
 */
export function pointInPoly(pt: LonLat, poly: Poly): boolean {
  if (!pointInRing(pt, poly.outer)) return false;
  for (const hole of poly.holes) if (pointInRing(pt, hole)) return false;
  return true;
}

/**
 * Tolérance pour qu'un sommet soit jugé « posé sur » une arête : 2 cm.
 *
 * **Mesurée, et le creux de la distribution la désigne.** Écart entre un sommet et
 * l'arête d'un membre voisin sur laquelle il tombe presque, sur deux communes
 * entières :
 *
 * | écart         | 28404 | Angers |
 * |---------------|-------|--------|
 * | ≤ 20 mm       |    35 |    975 |
 * | ]20 ; 50] mm  |     0 |     22 |
 * | > 50 mm       |   235 |  2 599 |
 *
 * La distribution est bimodale : un amas serré sous 2 cm — le bruit de
 * représentation d'un mur censé être commun — puis un creux quasi vide, puis la
 * géométrie réelle, où un sommet proche d'une arête voisine l'est pour de bon. Le
 * seuil se pose dans le creux.
 *
 * Une première version plaçait cette tolérance à 1 mm, par prudence. Trop serrée :
 * le cas qui a motivé ce correctif (polygones 268 et 365 de 28404) a son sommet à
 * **4,4 mm** du mur. La prudence ne se décrète pas, elle se mesure.
 *
 * 2 cm est aussi la tolérance de `dropCollinear` : dans tout le projet, un sommet à
 * moins de 2 cm d'une ligne est considéré comme posé dessus.
 */
const SUR_ARETE_M = 0.02;

/**
 * Découpe chaque arête aux sommets des autres membres qui tombent en son milieu.
 *
 * **Sans cette passe, l'union ne s'annule pas là où elle devrait.** Elle repose sur
 * « une arête présente deux fois est interne » : une identité EXACTE d'arêtes. Or un
 * bâtiment léger adossé au MILIEU du mur d'un bâtiment dur ne partage pas une arête
 * avec lui — il partage un bout d'arête. Le mur `A→B` du dur et le haut `P→Q` du
 * léger (P et Q strictement entre A et B) sont deux arêtes différentes : rien ne
 * s'annule, et le mur mitoyen survit dans le contour rendu. C'est exactement ce qui
 * a été constaté à l'écran — « il ne devrait pas y avoir de ligne en haut du bâtiment
 * clair ».
 *
 * Après découpe, `A→B` devient `A→P→Q→B` : `P→Q` s'annule avec le haut du léger, et
 * il ne reste que les vrais bords du contour uni. La découpe n'introduit AUCUNE
 * coordonnée nouvelle — elle ne fait qu'insérer des sommets qui existaient déjà chez
 * un voisin, donc l'union reste exacte, sans arithmétique d'intersection.
 *
 * Fréquence mesurée le 2026-09-24 : 50 T-jonctions sur 33 compositions de la commune
 * 28404 (961 compositions absorbantes), soit 3,4 %.
 */
export function noderAnneaux(polys: Poly[]): Ring[] {
  return polys.map((poly) => {
    const r = poly.outer;

    // Les sommets des AUTRES membres, jamais les siens. Un anneau nodé contre
    // lui-même s'autodétruit : la fixture « minuscule » (le plus petit bâtiment réel
    // d'Angers, 137 cm²) est un éclat large de 2 cm, donc son troisième sommet tombe
    // à moins de la tolérance de sa propre base. Découpée là, chacune de ses arêtes
    // s'annulait avec sa jumelle et l'union rendait « vide » — un bâtiment réel
    // devenu incréable. Souder un mur mitoyen n'a de sens qu'entre polygones
    // distincts.
    const siens = new Set(r.map(vertexKey));
    const sommets = new Map<string, LonLat>();
    for (const autre of polys) {
      if (autre === poly) continue;
      for (const v of autre.outer) {
        const k = vertexKey(v);
        if (!siens.has(k)) sommets.set(k, v);
      }
    }
    const tous = [...sommets.entries()];

    const sortie: LonLat[] = [];
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i]!, b = r[i + 1]!;
      const ka = vertexKey(a), kb = vertexKey(b);
      sortie.push(a);

      const intermediaires: { t: number; v: LonLat }[] = [];
      for (const [kv, v] of tous) {
        if (kv === ka || kv === kb) continue;
        const { t, ecart } = surSegment(v, a, b);
        if (t > 0 && t < 1 && ecart <= SUR_ARETE_M) intermediaires.push({ t, v });
      }
      intermediaires.sort((x, y) => x.t - y.t);
      for (const { v } of intermediaires) sortie.push(v);
    }
    sortie.push(r[r.length - 1]!);
    return sortie;
  });
}

function addAdjacency(adjacency: Map<string, string[]>, from: string, to: string): void {
  const neighbours = adjacency.get(from);
  if (neighbours) {
    neighbours.push(to);
  } else {
    adjacency.set(from, [to]);
  }
}

/**
 * Union topologique exacte d'un ensemble de polygones cadastraux.
 *
 * Contrat : n'opère que sur les anneaux extérieurs (`Poly.outer`) ; `Poly.holes`
 * n'est jamais lu. L'appelant ne doit jamais transmettre un membre porteur d'un
 * trou existant — un tel trou serait silencieusement perdu du résultat. Le
 * refus de composer dès qu'un membre a un trou est la responsabilité de
 * l'appelant (voir la sélection des composantes, en amont), pas de cette
 * fonction.
 */
/** Distance de sonde de part et d'autre d'une arête : 10 cm. */
const SONDE_M = 0.10;

/**
 * Le contour rendu longe-t-il le bâti, ou le traverse-t-il ?
 *
 * **La précondition de l'annulation d'arêtes est que les intérieurs des membres
 * soient disjoints** — ils peuvent partager un bord, jamais une surface. Deux
 * polygones qui se recouvrent vraiment demanderaient un découpage avec calcul
 * d'intersections, ce que ce projet a choisi de ne pas faire pour n'introduire
 * aucune coordonnée nouvelle. La spec la supposait toujours vraie (« le PCI est
 * topologiquement propre ») ; elle ne l'est pas. Polygones 941 et 1015 de la commune
 * 28404 : un sommet du bâtiment léger tombe **4,6 m à l'intérieur** du bâtiment dur.
 *
 * Plutôt que de rendre un contour faux, on vérifie le résultat : chaque arête du
 * contour doit avoir le bâti d'un seul côté. Une arête qui l'a des DEUX côtés est un
 * mur intérieur — exactement le trait signalé à l'écran, « il ne devrait pas y avoir
 * de ligne en haut du bâtiment clair ».
 *
 * Ni l'aire ni un test de sommet-dans-polygone ne conviennent ici, et les deux ont
 * été essayés et mesurés. L'aire ne voit rien : un éperon qui retrace un mur a une
 * aire nulle (écart relatif médian des cas fautifs, 6,6e-6, contre 0 pour les cas
 * sains — aucun pouvoir discriminant). Le test de sommet échoue dans les deux sens,
 * `pointInRing` n'étant pas fiable sur le bord : il n'attrapait qu'un cas sur dix-huit
 * tout en refusant une fixture saine.
 *
 * La sonde est à 10 cm, au-dessus de la tolérance de simplification (5 cm) : plus
 * près, une arête qui saute un sommet quasi colinéaire se dénonce à tort. Mesuré :
 * 48 faux positifs à 2 cm, contre 18 cas réels à 10 cm.
 */
function traverseLeBati(ring: Ring, polys: Poly[]): boolean {
  const dans = (p: LonLat): boolean => polys.some(poly => pointInPoly(p, poly));
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    const lat = (a[1] + b[1]) / 2;
    const k = Math.cos((lat * Math.PI) / 180);
    const dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    // Normale à l'arête, longue de SONDE_M, ramenée en degrés.
    const nx = ((-dy / len) * SONDE_M) / (METRES_PAR_DEGRE_LAT * k);
    const ny = ((dx / len) * SONDE_M) / METRES_PAR_DEGRE_LAT;
    const mx = (a[0] + b[0]) / 2;
    if (dans([mx + nx, lat + ny]) && dans([mx - nx, lat - ny])) return true;
  }
  return false;
}

export function topologicalUnion(polys: Poly[]): UnionResult {
  if (polys.length === 0) return { ok: false, reason: 'vide' };

  // Découpe préalable aux sommets intermédiaires : sans elle, un mur partagé sur une
  // PARTIE d'arête seulement ne s'annule pas (voir noderAnneaux).
  const anneaux = noderAnneaux(polys);

  // une arête présente deux fois dans l'ensemble est interne : elle disparaît
  const count = new Map<string, number>();
  for (const r of anneaux) {
    for (let i = 0; i < r.length - 1; i++) {
      const k = edgeKey(r[i]!, r[i + 1]!);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }

  const adjacency = new Map<string, string[]>();
  const coords = new Map<string, LonLat>();
  for (const r of anneaux) {
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i]!, b = r[i + 1]!;
      if (count.get(edgeKey(a, b)) !== 1) continue;
      const ka = vertexKey(a), kb = vertexKey(b);
      coords.set(ka, a); coords.set(kb, b);
      addAdjacency(adjacency, ka, kb);
      addAdjacency(adjacency, kb, ka);
    }
  }

  if (adjacency.size === 0) return { ok: false, reason: 'vide' };
  for (const neighbours of adjacency.values()) {
    if (neighbours.length !== 2) return { ok: false, reason: 'pincement' };
  }

  // recoudre les arêtes de bord en anneaux
  const rings: Ring[] = [];
  const seen = new Set<string>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const keys = [start];
    seen.add(start);
    let previous: string | null = null;
    let current = start;
    for (;;) {
      const [a, b] = adjacency.get(current)! as [string, string];
      const next = a === previous ? b : a;
      if (next === start) break;
      if (seen.has(next)) return { ok: false, reason: 'pincement' };
      seen.add(next);
      keys.push(next);
      previous = current;
      current = next;
    }
    const ring = keys.map(k => coords.get(k)!);
    ring.push(ring[0]!);
    rings.push(ring);
  }

  if (rings.length === 1) {
    const ring = rings[0]!;
    // Vérification du résultat, pas de l'entrée : voir traverseLeBati.
    if (traverseLeBati(ring, polys)) return { ok: false, reason: 'chevauchement' };
    return { ok: true, ring };
  }

  // Limite connue : pointInRing() repose sur le ray casting, non défini pour un point
  // situé exactement sur une arête du plus grand anneau (un T proche mais non un sommet
  // partagé). Le pire effet possible est un mauvais choix entre 'trou' et
  // 'parties-multiples' — jamais une géométrie erronée, l'union restant de toute façon
  // refusée. Non observé sur les 37 848 bâtiments durs d'Angers ; non corrigé
  // délibérément, le coût d'un point-in-polygon robuste aux bords dépassant la valeur
  // d'un libellé de refus parfois erroné.
  const largest = rings.reduce((a, b) => (Math.abs(ringArea(a)) >= Math.abs(ringArea(b)) ? a : b));
  const nested = rings.every(r => r === largest || pointInRing(r[0]!, largest));
  return { ok: false, reason: nested ? 'trou' : 'parties-multiples' };
}
