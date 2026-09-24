import { describe, it, expect } from 'vitest';
import { isDegenerate, dropCollinear, simplify, SIMPLIFY_TOLERANCE_M } from '../../src/geometry/clean';
import type { LonLat, Ring } from '../../src/geometry/types';

const ferme = (pts: Ring): Ring => [...pts, pts[0]!];

const M_PER_DEG_LAT = 111320;

/**
 * Distance point-segment en mètres, réimplémentée indépendamment de
 * src/geometry/clean.ts (même projection équirectangulaire, mais un calcul
 * séparé) pour que le test ne valide pas l'implémentation contre elle-même.
 */
function distPointToSegment(p: LonLat, a: LonLat, b: LonLat): number {
  const sx = Math.cos((a[1] * Math.PI) / 180);
  const toXY = (q: LonLat): [number, number] => [q[0] * M_PER_DEG_LAT * sx, q[1] * M_PER_DEG_LAT];
  const [px, py] = toXY(p);
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distPointToRing(p: LonLat, ring: Ring): number {
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = distPointToSegment(p, ring[i]!, ring[i + 1]!);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Le contrat réel de dropCollinear/simplify : tout sommet supprimé doit
 * rester à moins de toleranceM du contour conservé. C'est la garantie que
 * Douglas-Peucker offre par construction, et qu'un test de colinéarité
 * sommet-par-sommet contre un repère mobile ne peut pas garantir.
 */
function assertBoundedError(original: Ring, result: Ring, toleranceM: number): void {
  const kept = new Set(result.map(p => `${p[0]},${p[1]}`));
  for (const p of original.slice(0, -1)) {
    if (kept.has(`${p[0]},${p[1]}`)) continue;
    expect(distPointToRing(p, result)).toBeLessThanOrEqual(toleranceM + 1e-9);
  }
}

describe('isDegenerate', () => {
  it('rejette un anneau de moins de trois sommets distincts', () => {
    expect(isDegenerate(ferme([[0, 0], [1, 0]]))).toBe(true);
  });

  it('rejette un anneau d’aire nulle', () => {
    expect(isDegenerate(ferme([[0, 0], [1, 0], [2, 0]]))).toBe(true);
  });

  it('accepte un triangle', () => {
    expect(isDegenerate(ferme([[0, 0], [0.001, 0], [0, 0.001]]))).toBe(false);
  });
});

describe('dropCollinear', () => {
  it('supprime un sommet aligné au milieu d’un côté', () => {
    const avec = ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(dropCollinear(avec)).toHaveLength(5);   // 4 sommets + fermeture
  });

  it('conserve un décrochement réel', () => {
    const marche = ferme([[0, 0], [0.001, 0], [0.001, 0.0005], [0.002, 0.0005], [0.002, 0.001], [0, 0.001]]);
    expect(dropCollinear(marche)).toHaveLength(marche.length);
  });

  it('rend un anneau toujours fermé', () => {
    const r = dropCollinear(ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]));
    expect(r[0]).toEqual(r[r.length - 1]);
  });

  it('conserve le sommet d’une bosse réelle au milieu d’une rampe à plusieurs points', () => {
    // Régression : deux sommets réels A et B à ~10 m l'un de l'autre, avec
    // entre eux une rampe à 3 points (montée, sommet, descente) qui culmine
    // à ~2,5 cm de la corde A-B réelle — au-delà de la tolérance par défaut
    // (2 cm). Un troisième sommet C referme un triangle, loin de la rampe.
    // Sous l'ancienne version de dropCollinear (repère = dernier sommet
    // CONSERVÉ, qui dérivait à mesure que la rampe se vidait, plutôt que la
    // vraie corde), ce sommet de bosse était effacé : mesuré contre le
    // sommet suivant non encore traité (lui-même déjà décalé), il semblait
    // localement aligné bien qu'il dévie de ~2,5 cm de la corde réelle.
    const a: LonLat = [0, 0];
    const montee: LonLat = [0.0000225, 0.0000001125];   // épaule, ~1,25 cm de la corde A-B
    const sommet: LonLat = [0.000045, 0.000000225];     // sommet de la bosse, ~2,5 cm de la corde A-B
    const descente: LonLat = [0.0000675, 0.0000001125]; // épaule, ~1,25 cm de la corde A-B
    const b: LonLat = [0.00009, 0];
    const c: LonLat = [0.000045, 0.0001];                // 3e sommet réel, referme le triangle
    const rampe = ferme([a, montee, sommet, descente, b, c]);

    const kept = new Set(dropCollinear(rampe).map(p => `${p[0]},${p[1]}`));
    expect(kept.has(`${sommet[0]},${sommet[1]}`)).toBe(true);
  });

  it('ne supprime jamais un sommet à plus de la tolérance du contour résultant', () => {
    const a: LonLat = [0, 0];
    const montee: LonLat = [0.0000225, 0.0000001125];
    const sommet: LonLat = [0.000045, 0.000000225];
    const descente: LonLat = [0.0000675, 0.0000001125];
    const b: LonLat = [0.00009, 0];
    const c: LonLat = [0.000045, 0.0001];
    const rampe = ferme([a, montee, sommet, descente, b, c]);
    assertBoundedError(rampe, dropCollinear(rampe), 0.02);

    const rectangle = ferme([[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    assertBoundedError(rectangle, dropCollinear(rectangle), 0.02);
  });
});

describe('simplify', () => {
  it('efface une déviation inférieure à la tolérance', () => {
    // sommet médian dévié d’environ 5 cm
    const r = ferme([[0, 0], [0.0005, 0.0000004], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(simplify(r, 0.2).length).toBeLessThan(r.length);
  });

  it('conserve une déviation supérieure à la tolérance', () => {
    // sommet médian dévié d’environ 2 m
    const r = ferme([[0, 0], [0.0005, 0.000018], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
    expect(simplify(r, 0.2)).toHaveLength(r.length);
  });

  it('un triangle est renvoyé tel quel sans entrer dans la récursion', () => {
    // open.length === 3 : simplify sort par le retour anticipé du haut
    // (`if (open.length <= 3) return ring;`), avant tout appel à recurse().
    const r = ferme([[0, 0], [0.000001, 0], [0.0000005, 0.0000005]]);
    expect(simplify(r, 100).length).toBeGreaterThanOrEqual(4);
  });

  it('la récursion elle-même ne redescend jamais sous un triangle', () => {
    // 4 sommets exactement alignés sur une même droite. Le sommet le plus
    // éloigné du premier est aussi le dernier (far === open.length - 1), et
    // les deux sommets intermédiaires sont à distance nulle de la corde
    // (0)-(3) puisqu'ils sont sur cette droite : aucun n'est jamais ajouté à
    // `keep`, qui reste { 0, 3 } — 2 éléments. La récursion s'exécute donc
    // pour de vrai (open.length === 4 > 3, on dépasse le retour anticipé du
    // haut), mais c'est le garde-fou du bas (`if (kept.length < 3) return
    // ring;`) qui renvoie l'anneau initial inchangé.
    const r = ferme([[0, 0], [0.000001, 0.000001], [0.000002, 0.000002], [0.0001, 0.0001]]);
    expect(simplify(r)).toEqual(r);
  });
});

describe('sommets inamovibles (keepVertex)', () => {
  // Utilisé par compose.ts pour protéger les sommets partagés avec un bâtiment voisin.
  // Ajouter des ancres ne peut que réduire l'erreur : la garantie Douglas-Peucker
  // (aucun sommet supprimé à plus de la tolérance de la ligne conservée) tient toujours.
  const avecSommetColineaire: Ring = [
    [0, 47.5], [0.0005, 47.5], [0.001, 47.5],
    [0.001, 47.5007], [0, 47.5007], [0, 47.5],
  ];
  const cle = (p: number[]) => `${p[0]},${p[1]}`;

  it('supprime le sommet colinéaire quand rien ne le protège', () => {
    expect(dropCollinear(avecSommetColineaire).map(cle)).not.toContain('0.0005,47.5');
  });

  it('le garde quand keepVertex le déclare inamovible', () => {
    const protege = dropCollinear(avecSommetColineaire, 0.02, p => p[0] === 0.0005 && p[1] === 47.5);
    expect(protege.map(cle)).toContain('0.0005,47.5');
  });

  it('simplify honore la même protection', () => {
    const protege = simplify(avecSommetColineaire, 0.2, p => p[0] === 0.0005 && p[1] === 47.5);
    expect(protege.map(cle)).toContain('0.0005,47.5');
  });

  it('protéger un sommet ne déplace aucun autre sommet conservé', () => {
    const sans = dropCollinear(avecSommetColineaire);
    const avec = dropCollinear(avecSommetColineaire, 0.02, p => p[0] === 0.0005 && p[1] === 47.5);
    // le contour protégé contient tout ce que le contour non protégé contenait
    for (const p of sans) expect(avec.map(cle)).toContain(cle(p));
  });
});

describe('SIMPLIFY_TOLERANCE_M — la tolérance par défaut est une décision mesurée', () => {
  it('borne l’écart à 5 cm, et pas davantage', () => {
    expect(SIMPLIFY_TOLERANCE_M).toBe(0.05);
  });

  it('garde un sommet qui s’écarte de plus que la tolérance', () => {
    // Un décroché de 10 cm : le genre de détail que la tolérance précédente de
    // 20 cm effaçait, et qui se voyait à l'écran sur un bâtiment léger.
    const m = 1 / 111320;                       // ~1 m en degrés de latitude
    const ring: Ring = [
      [0, 47.5], [0.0001, 47.5], [0.0001, 47.5 + 10 * m],
      [0.00005, 47.5 + 10 * m + 0.1 * m],       // décroché de 10 cm
      [0, 47.5 + 10 * m], [0, 47.5],
    ];

    expect(simplify(ring)).toHaveLength(ring.length);
  });

  it('efface un décroché nettement sous la tolérance', () => {
    const m = 1 / 111320;
    const ring: Ring = [
      [0, 47.5], [0.0001, 47.5], [0.0001, 47.5 + 10 * m],
      [0.00005, 47.5 + 10 * m + 0.01 * m],      // décroché de 1 cm
      [0, 47.5 + 10 * m], [0, 47.5],
    ];

    expect(simplify(ring).length).toBeLessThan(ring.length);
  });
});
