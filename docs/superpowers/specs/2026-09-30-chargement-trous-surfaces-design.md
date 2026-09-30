# Clic différé, bâtiments à trous, surfaces du fond cadastre — design

Date : 2026-09-30. Complète `2026-09-22-cadastre-id-design.md`.

## Objectif

1. Le délai de chargement du cadastre est signalé, et un clic donné pendant ce délai
   crée l'objet dès que les données sont prêtes, sans message d'erreur.
2. Les bâtiments décrits avec une cour intérieure (trou) sont créés comme multipolygones.
3. Toutes les surfaces du fond « cadastre » d'OSM FR sont survolables et cliquables.

## 1. Clic différé et indicateur de chargement

- `clickAt` pendant un chargement (ou sans jeu de données, après relance du chargement)
  mémorise **un seul** clic en attente (le dernier remplace le précédent) au lieu de
  notifier `chargement-en-cours`.
- Un bandeau « Chargement du cadastre… » est affiché dans le conteneur de la carte tant
  qu'un chargement est en vol ; il disparaît à la fin ou à l'échec.
- Quand le chargement aboutit, le clic en attente est rejoué par le chemin normal de
  `clickAt` (même composition, mêmes refus, même contrôle de doublon).
- Le mode n'est armé que tant que Ctrl est enfoncé (`src/ui/shortcut.ts`) : relâcher Ctrl
  avant la fin du chargement appelle `disable()`. Le clic en attente **survit** à
  `disable()` — la personne a cliqué délibérément — et le chargement en vol n'est pas
  annulé.
- Le clic en attente est abandonné si : la carte s'est déplacée de plus d'une
  demi-étendue depuis le clic ; plus de 60 s se sont écoulées ; le chargement échoue
  (seule la notification réseau existante apparaît, aucun message supplémentaire).
- Un clic après une panne relance le chargement et se met en attente ; la panne
  précédente est oubliée pour que, si elle se reproduit, elle soit de nouveau signalée.
- Le bandeau est visible tant qu'un clic est en attente, ou que le mode est armé et
  qu'un chargement est en vol.
- Écart assumé avec la règle « jamais de création à l'aveugle » (spec initiale §5) : le
  clic rejoué crée sans que l'aperçu ait été vu. Les refus de composition et le contrôle
  de doublon restent appliqués.
- Le message `chargement-en-cours` disparaît (plus aucun émetteur).
- Le survol applique le même contrôle de doublon que le clic (même filtre par nature) :
  aujourd'hui il compare à tous les objets, si bien qu'une piscine voisine d'une maison
  s'afficherait en refus alors que le clic passerait.

## 2. Bâtiments à trous

- `composeAt`/`composeFor` n'émettent plus `trou-source` pour un polygone seul (sans
  membre absorbé) : la composition rend l'anneau extérieur et `holes`.
- Si l'ancre a des trous et absorbe des constructions légères, ou si un léger absorbé a
  un trou, le refus `trou-source` est conservé (l'union ne lit pas les trous).
- `IdBridge.createBuilding` reçoit `holes: Ring[]`. Avec des trous, il crée : les nœuds,
  une voie extérieure et une voie par trou, sans tags, et une relation
  `type=multipolygon` portant les tags (`building=yes`, `source`). Une seule transaction
  `perform`, donc un seul Ctrl+Z ; sélection finale sur la relation.
- Recalage : les nœuds des trous sont réutilisés comme ceux de l'extérieur, sans
  insertion dans les murs voisins (`planInsertions` ne les concerne pas).
- Aperçu : l'overlay dessine les trous (remplissage evenodd).
- Contrôle de doublon : un bâtiment OSM situé entièrement dans un trou n'est pas un
  conflit.
- Le message `trou-source` reste pour les cas conservés ci-dessus.

## 3. Surfaces du fond cadastre

- On charge **toutes** les surfaces de la couche `tsurf`, plus seulement le code 65.
- Type `Poly.type` : `piscine` (code 65) ou `surface` (tout autre code). Une `surface`
  ne participe à aucune composante légère, n'absorbe et n'est absorbée par rien.
- Tags : piscine inchangée (`leisure=swimming_pool`, `access=private`, `source`) ; autre
  surface : `area=yes` et `source` uniquement, sans autre tag, pour lever l'avertissement
  d'iD sans inventer de sémantique.
- Cache : le champ `piscines` devient `surfaces` (toutes les surfaces). Une entrée qui n'a
  que `piscines` est complétée une fois par un rechargement de `tsurf` (même mécanisme
  et même contrainte de millésime-année que `downloadPiscinesForYear`).
- Contrôle de doublon : comparaison entre objets de même nature ; une surface générique
  se compare aux voies OSM taguées `area=yes`.
- Hors périmètre : lignes (`tline`), parcelles, sections, limites.

## Vérification des objets non cliquables

Après implémentation, on parcourt Angers et Le Lavandou pour lister les bâtiments et
surfaces du fond encore non cliquables, et on rapporte leurs causes.

## Tests

vitest, style existant : mise en attente et rejeu du clic (dont abandons) dans
`tests/mode.test.ts` ; composition avec trous dans `tests/compose.test.ts` ; création
d'une relation dans `tests/bridge/capture.test.ts` ; téléchargement, cache et tags des
surfaces dans `tests/cadastre/*` et `tests/tagging/tags.test.ts` ; overlay avec trous
dans `tests/ui/overlay.test.ts`.
