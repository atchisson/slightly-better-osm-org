// Fusion des commentaires et sources de changeset entre tâches MapRoulette.
//
// Traiter plusieurs tâches (de défis différents) dans UN changeset suppose d'accumuler
// ce que chaque tâche prépare, pas de ne garder que la dernière. Module pur : aucune
// dépendance à iD ni au DOM, donc exhaustivement testable (tests/remote/changeset.test.ts).
// La décision « fusionner ou remplacer » n'est PAS ici : elle vit dans makeNavigation.

/** Limite de longueur d'un commentaire (et d'une source) de changeset côté OSM. */
const MAX_OSM = 255;

const ELLIPSE = '…';

/** Valeurs distinctes, dans l'ordre d'apparition ; `cle` définit l'égalité. */
function dedoublonner(valeurs: string[], cle: (v: string) => string = v => v): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const v of valeurs) {
    const k = cle(v);
    if (vus.has(k)) continue;
    vus.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Sépare un commentaire en « texte » et hashtags. Un hashtag est un mot (séparé par des
 * blancs) qui commence par `#` suivi d'au moins un caractère non blanc ; `#` seul, ou
 * `#` au milieu d'un mot (« C# »), reste du texte. Le texte est formé des autres mots
 * rejoints par un espace : un hashtag placé au milieu d'une phrase en sort, et se
 * retrouve en fin de résultat, comme iD range lui-même les hashtags.
 */
function decouper(commentaire: string): { texte: string; hashtags: string[] } {
  const mots = commentaire.split(/\s+/).filter(m => m !== '');
  const hashtags = mots.filter(m => m.length > 1 && m.startsWith('#'));
  const texte = mots.filter(m => !(m.length > 1 && m.startsWith('#'))).join(' ');
  return { texte, hashtags };
}

/** Assemble texte et hashtags, sans espace superflu quand l'un des deux est vide. */
function assembler(texte: string, hashtags: string[]): string {
  return [texte, hashtags.join(' ')].filter(p => p !== '').join(' ');
}

/**
 * Fusionne le commentaire déjà préparé (`existant`) avec celui d'une nouvelle tâche.
 *
 * - textes : ceux d'`existant` puis de `nouveau`, dédoublonnés à l'identique, joints
 *   par « ; » ;
 * - hashtags : idem, dédoublonnés sans tenir compte de la casse (on garde la 1re
 *   graphie), joints par un espace, placés après le texte.
 *
 * Le résultat ne dépasse jamais `max`. Pour y tenir, dans cet ordre : on retire les
 * segments de texte depuis la FIN (jamais le premier, qui dit ce que le changeset
 * fait) ; s'il n'en reste qu'un et qu'il est encore trop long, on le tronque avec « … ».
 * Si les hashtags SEULS dépassent, on ne garde que ceux qui tiennent entiers : un
 * hashtag coupé en deux serait un autre hashtag, pire qu'un hashtag absent.
 */
export function fusionnerComment(existant: string, nouveau: string, max = MAX_OSM): string {
  const a = decouper(existant);
  const b = decouper(nouveau);
  const segments = dedoublonner([a.texte, b.texte].filter(t => t !== ''));
  let hashtags = dedoublonner([...a.hashtags, ...b.hashtags], h => h.toLowerCase());

  if (hashtags.join(' ').length > max) {
    // Les hashtags seuls dépassent : il ne reste pas de place pour du texte.
    const gardes: string[] = [];
    let longueur = 0;
    for (const h of hashtags) {
      const ajout = longueur === 0 ? h.length : h.length + 1;
      if (longueur + ajout > max) continue;
      gardes.push(h);
      longueur += ajout;
    }
    return gardes.join(' ');
  }

  while (segments.length > 1 && assembler(segments.join('; '), hashtags).length > max) segments.pop();

  let texte = segments.join('; ');
  if (assembler(texte, hashtags).length > max) {
    // Un seul segment, encore trop long : on le tronque dans la place laissée aux hashtags
    // (hashtags + 1 espace). S'il n'y a même pas de place pour une lettre et « … », on
    // l'abandonne plutôt que d'émettre une ellipse seule.
    const place = max - (hashtags.length > 0 ? hashtags.join(' ').length + 1 : 0);
    texte = place >= 2 ? texte.slice(0, place - 1).trimEnd() + ELLIPSE : '';
  }
  return assembler(texte, hashtags);
}

/**
 * Fusionne la source déjà préparée avec celle d'une nouvelle tâche. Convention OSM :
 * valeurs séparées par « ; » — ici sans espace. Valeurs trimées, vides ignorées,
 * dédoublonnées à l'identique. Au-delà de `max`, on retire les valeurs depuis la fin
 * (au moins la 1re reste ; si elle dépasse seule, elle est tronquée à `max`).
 */
export function fusionnerSource(existant: string, nouveau: string, max = MAX_OSM): string {
  const valeurs = dedoublonner(
    [...existant.split(';'), ...nouveau.split(';')].map(v => v.trim()).filter(v => v !== ''),
  );
  while (valeurs.length > 1 && valeurs.join(';').length > max) valeurs.pop();
  return valeurs.join(';').slice(0, max);
}
