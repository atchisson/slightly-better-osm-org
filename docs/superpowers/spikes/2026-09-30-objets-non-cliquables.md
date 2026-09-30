# Mesure — objets du cadastre encore non cliquables

Date : 2026-09-30 · millésime Etalab 2026-09-01 · communes : Angers (49007), Le Lavandou (83069).

Méthode : `buildDataset` sur `cadastre-<insee>-batiments.json.gz` + `raw/pci-<insee>-tsurf.json.gz` ;
pour chaque polygone, point intérieur = milieu de la plus longue corde horizontale
(11 cordes échantillonnées, validées par `pointInPoly`), puis `composeAt(point)`. Script jetable,
non versionné.

## Verdicts par commune (un clic au centre de chaque polygone)

| Verdict | Angers (51 330) | Le Lavandou (37 190) |
|---|---|---|
| ok | 50 815 | 36 720 |
| trou-source | 193 | 53 |
| trou | 156 | 103 |
| pincement | 82 | 133 |
| chevauchement | 84 | 179 |
| parties-multiples | 0 | 2 |
| degenere | 0 | 0 |
| aucun-batiment | 0 | 0 |

Par nature à Angers : bâtiments 01/02/03 = 50 193 ok sur 50 707 ; surfaces 382/382 ok ;
piscines 240/241 ok. Au Lavandou : surfaces 872/872, piscines 1 847/1 851.

## Non cliquables

Aucun polygone ne rend `aucun-batiment` sur son propre point intérieur : le point est
toujours attribué à un polygone. Mais il n'est pas toujours attribué à LUI : `polyAt` rendait
le premier polygone de la case contenant le point, masquant tout polygone superposé (piscine
dans sa surface, bâtiment recouvert par un autre). Sur 11 cordes, polygones dont aucun point
d'essai ne désignait le polygone lui-même :

- avant correctif : Angers 13 (2 piscines, 11 surfaces), Le Lavandou 94 (25 bâtiments 01, 20 bâtiments 02, 22 piscines, 27 surfaces) ;
- après correctif : Angers 3 (surfaces), Le Lavandou 36 (14 bâtiments 01, 2 bâtiments 02, 13 piscines, 7 surfaces).

**Corrigé** (`src/cadastre/dataset.ts`, `polyAt`) : parmi les polygones contenant le point, le
plus petit (aire extérieure moins aires des cours) l'emporte, égalité au plus petit identifiant.
Test : `tests/cadastre/dataset.test.ts` (« polyAt — polygones superposés »).

**Limite laissée** : les polygones restants sont recouverts par un plus petit polygone sur toutes
les cordes échantillonnées (doublons de géométrie quasi identiques, ou polygone englobant
entièrement des plus petits). Ils ne sont accessibles, au mieux, que dans une zone que
l'échantillonnage n'a pas visée. Non investigué plus avant.

Les autres refus (trou-source, trou, pincement, chevauchement, parties-multiples) sont des
refus explicites de la composition, pas des objets non cliquables ; ils sont décrits dans le README.
