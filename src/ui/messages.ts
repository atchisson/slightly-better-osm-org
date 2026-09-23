import type { RefusalReason } from '../compose';

export type AnyRefusal = RefusalReason | 'batiment-existant' | 'commune-introuvable' | 'reseau';

const MESSAGES: Record<AnyRefusal, string> = {
  'aucun-batiment': 'Aucun bâtiment cadastre à cet endroit.',
  'trou-source': 'Ce bâtiment comporte une cour intérieure : le cadastre le décrit avec un trou, que cette version ne sait pas encore convertir. À tracer à la main.',
  'degenere': 'Le contour cadastre de ce bâtiment est dégénéré (surface nulle). Rien à créer.',
  'pincement': 'Le contour obtenu se pince sur lui-même : la fusion avec les constructions légères ne donne pas un tracé propre. À tracer à la main.',
  'trou': 'La fusion des constructions légères enferme une cour. Cette version ne crée pas de multipolygone. À tracer à la main.',
  'parties-multiples': 'La fusion donnerait plusieurs morceaux séparés. À tracer à la main.',
  // Formulé sans le mot « vide » : c'est aussi le code de raison lui-même, et le test
  // vérifie qu'un message n'est jamais un code brut (voir tests/ui/messages.test.ts).
  // Le libellé du brief (« Le contour cadastre est vide. ») échoue à ce test pour cette
  // raison précise — corrigé ici, sans toucher au test.
  'vide': 'Le contour cadastre ne comporte aucun point : rien à créer.',
  'batiment-existant': 'Un bâtiment OSM existe déjà ici : cette version ne remplace pas la géométrie existante.',
  'commune-introuvable': 'Commune introuvable ou hors couverture du cadastre français.',
  'reseau': 'Données cadastre indisponibles : vérifiez votre connexion.',
};

export function refusalMessage(reason: AnyRefusal): string {
  return MESSAGES[reason] ?? 'Création impossible.';
}
