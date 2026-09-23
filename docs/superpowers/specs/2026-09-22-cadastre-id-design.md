# cadastre-id — conception

Userscript ajoutant à l'éditeur iD, sur openstreetmap.org, la création d'un bâtiment OSM à partir du cadastre français, en un clic.

Date : 2026-09-22 · Statut : validé, prêt pour le plan d'implémentation

## 1. Objectif et cadrage

Tout l'outillage cadastre français est JOSM-centré : `cadastre.openstreetmap.fr` génère des fichiers `.osm` à ouvrir dans JOSM, et le greffon `cadastre-fr` lit l'EDIGÉO. Rien n'existe côté iD — c'est-à-dire côté débutants, qui sont précisément ceux qui n'installeront jamais JOSM. Ce projet comble ce trou.

Le geste visé : en mode cadastre, survoler un bâtiment fait apparaître son contour final ; cliquer le crée dans iD, tagué et sélectionné, prêt à être complété.

Hors périmètre v1 : les adresses, les parcelles, le mode zone, l'import en lot.

## 2. Décisions validées

| Décision | Choix | Motif |
|---|---|---|
| Forme | Userscript dédié (Violentmonkey / Tampermonkey) | Pas de backend, l'utilisateur reste sur osm.org avec son compte et son flux de sauvegarde. Contribution à better-osm-org possible plus tard. |
| Granularité | Un bâtiment par clic | Maintient le régime « semi-automatique » des règles françaises, pas l'import de masse. |
| Bâtiment OSM déjà présent | v1 : refus + message. v2 : remplacement de géométrie | Découpe le risque : on verrouille la création avant de toucher à l'existant. |
| Constructions légères adjacentes | Fusionnées dans le bâtiment en dur avec lequel elles partagent la plus longue frontière | Un porche sans mur fait partie de la maison. Voir §5 pour le cas ambigu. |
| Mitoyenneté | Réutilisation des nœuds OSM existants à portée, sans jamais les déplacer | 70 % du bâti est mitoyen ; créer des murs en double déclencherait les validateurs. |
| Source des données | Fichiers bâtiments Etalab par commune | C'est le jeu qu'utilise la communauté FR pour ses imports, millésime traçable, CORS ouvert. |

## 3. Données

### 3.1 Source

`https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/{dep}/{insee}/cadastre-{insee}-batiments.json.gz`

Vérifié le 2026-09-22 : redirige vers un stockage objet OVH renvoyant `Access-Control-Allow-Origin: *`. Donc `fetch` direct depuis osm.org, sans `GM_xmlhttpRequest`, sans proxy, sans backend.

La redirection expose le millésime dans le chemin (`/etalab-cadastre/2026-06-01/`) : c'est de là que vient l'année du tag `source`, jamais d'une constante.

Résolution du code INSEE : `https://geo.api.gouv.fr/communes?lat=&lon=&fields=code` (vérifié : `access-control-allow-origin: https://www.openstreetmap.org`).

Attention : Paris, Lyon et Marseille n'existent pas sous leur code commune dans ce jeu (`75056` renvoie 404) — les données sont découpées par arrondissement. `geo.api.gouv.fr` renvoie le code commune, pas l'arrondissement ; la résolution devra le gérer.

### 3.2 Forme des données

Mesuré sur Angers (`49007`) : 2,6 Mo gzippés, 19,6 Mo décompressés, **50 740 bâtiments**.

Chaque entité est un `MultiPolygon` avec `{type, nom, commune, created, updated}`.

| `type` | Signification ([datagouv/cadastre#50](https://github.com/datagouv/cadastre/issues/50)) | Part | Surface médiane |
|---|---|---|---|
| `01` | Bâtiment en dur : fondations et fermé sur 4 côtés, ou industriel | 37 759 (74 %) | 83 m² |
| `02` | Construction légère : sans fondations, **ou ouverte sur au moins un côté** | 12 892 (25 %) | 11 m² |
| `03` | Bâtiment « FI, vu du ciel » — relevé récent par voie aérienne | 89 (0,2 %) | 57 m² |

Faits mesurés qui pilotent la conception :

- **0 géométrie multi-parties.** Tous les `MultiPolygon` n'ont qu'un polygone. La v1 n'a pas à gérer ce cas.
- **186 géométries à trou (0,4 %).** Rares : refus explicite en v1.
- **26 539 bâtiments en dur sont mitoyens d'un autre bâtiment en dur (70,3 %).** Fusionner deux `01` serait donc massivement destructeur. Interdit.
- Parmi les `02` : 3 111 isolés (24 %), 7 718 touchant exactement un `01` (60 %), **2 063 touchant au moins deux bâtiments en dur (16 %)**, 1 813 touchant un autre `02`.
- Les 89 `03` sont tous isolés et tous créés entre 2025-12-22 et 2026-04-06.
- **Aucun polygone dégénéré.** Corrigé le 2026-09-23 : une première lecture, faussée par un arrondi à l'entier, annonçait des surfaces nulles. Vérification faite, il n'existe dans ce jeu ni polygone d'aire exactement nulle, ni polygone à moins de trois sommets distincts. La plus petite aire réelle vaut environ 0,02 m². La garde contre la dégénérescence reste utile — autres communes, sortie d'union ou de simplification — mais elle se teste sur des anneaux synthétiques, pas sur ces données.
- 34 entités seulement portent un `nom` sur 50 740.

### 3.3 Cache

Un fichier commune est téléchargé une fois, puis conservé en IndexedDB avec son millésime et sa date de récupération. Rechargement quand la carte change de commune.

**L'entrée en cache se périme au bout de 30 jours** (corrigé le 2026-09-23, à la revue de branche : la date de récupération était écrite et relue par personne). Sans péremption, une commune mise en cache aujourd'hui resservirait le même millésime dans deux ans, et le tag `source` l'annoncerait fidèlement — de la donnée périmée importée en toute bonne foi. 30 jours est court devant le rythme de publication d'Etalab et long devant une session de contribution.

**L'écriture du cache n'est jamais sur le chemin critique** (même correction) : un refus d'IndexedDB — dépassement de quota, vraisemblable sur Paris ou Marseille — faisait échouer le chargement *après* un téléchargement réussi, en affichant « vérifiez votre connexion ». Le cache est un confort ; il ne doit jamais faire échouer la fonctionnalité.

Les polygones sont indexés dans une grille spatiale à l'ingestion.

> **Corrigé le 2026-09-23, par la mesure.** Cette section prescrivait une forme compacte — bbox et anneaux en `Float64Array` — au motif que 50 000 géométries parsées coûteraient trop cher. **C'était faux.** Ventilation réelle de ce que retenait le jeu de données d'Angers avant correction :
>
> | Structure | Retenu |
> |---|---|
> | Index des arêtes | **82,6 Mo** |
> | Grille spatiale | 19,7 Mo |
> | Coordonnées référencées depuis le JSON parsé | 39,6 Mo |
> | `Poly[]` lui-même | 4,7 Mo |
> | `byId` + `lightIndex` + `absorption` | 4,5 Mo |
>
> La forme compacte visait les 4,7 Mo. Le vrai coût était un index des arêtes **que plus aucun code ne lisait** après la construction des composantes : il figurait dans deux interfaces et était conservé pour rien. Son retrait fait tomber la rétention de 147,1 à 63,8 Mo, sans rien changer d'autre.
>
> Ce que ça coûterait de ne pas mesurer : un refactor de tous les modules géométriques pour gagner trois pour cent, l'essentiel du problème restant en place.

**Rétention résiduelle, assumée.** À 63,8 Mo pour Angers, une commune comme Marseille — dont les seize arrondissements pèsent 4,6 fois plus — se situerait autour de 293 Mo. C'est lourd mais ce n'est pas dangereux : il s'agit de données longues à vivre, pas de churn d'allocation, donc sans effet sur les temps de frame. La mitigation existe si elle devient nécessaire — ne retenir que les polygones proches de la vue et recharger au déplacement — mais elle complique le cycle de vie du cache, et rien ne justifie de la payer avant d'avoir constaté une gêne. Voir §12.

## 4. Architecture

Le principe : **tout ce qui est fragile tient dans un module**, le reste est pur et testable sans navigateur.

### `bridge/` — la seule couche qui connaît les entrailles de iD

Sur osm.org, iD n'est plus dans une iframe, avait conclu la lecture du code de rails (`id.html.erb`, `<div id="id-container">`) : il se monterait directement dans la page. Le contexte n'est de toute façon pas exposé — `app/assets/javascripts/id.js` fait `const idContext = iD.coreContext()`, en portée locale. Seul `window.iD`, le namespace de la bibliothèque, est global.

> **Corrigé le 2026-09-23, par le spike (`docs/superpowers/spikes/2026-09-22-capture-contexte-id.md`).** **C'était faux : iD est bien dans une iframe, servie à `/id`.** Le script s'injecte d'abord sur `/edit`, puis à nouveau sur `/id`, où vit réellement l'éditeur — c'est ce document-là, et non le document parent, que le bridge, le bouton et le calque de survol doivent cibler ; une commande tapée dans la console du document parent ne capture jamais rien, il faut basculer le sélecteur de cadre. C'est exactement pour vérifier l'hypothèse dont dépend tout le bridge — qu'on puisse intercepter `window.iD` avant le bootstrap et capturer l'instance de `coreContext()` — que le spike a été mené : la seule lecture du code de rails y avait fait conclure à l'inverse de ce qu'une vraie session de navigateur a montré.

Le bridge s'exécute donc en `document-start`, pose un `Object.defineProperty` sur `window.iD` pour intercepter l'affectation du namespace, enveloppe `coreContext` et capture l'instance au moment où `id.js` l'appelle.

Il expose au reste du code une interface étroite, et c'est la seule autorisée :

```
whenReady()          -> Promise<void>
mapExtent()          -> bbox
project(lonLat)      -> [x, y] écran
onMapMove(cb)
buildingsNear(bbox)  -> entités OSM chargées (bâtiments)
nodesIn(bbox)        -> nœuds OSM existants ÉLIGIBLES dans une étendue
createBuilding(ring, tags, reusedNodes) -> une opération annulable
prefillChangeset(comment, source)
containerNode()      -> racine de l'éditeur (bouton de mode)
surfaceNode()        -> l'élément dont le coin EST l'origine de project()
```

> **Corrigé le 2026-09-23, à la revue de branche.** Cette liste annonçait
> `nodesNear(lonLat, m)` — un point et un rayon — et c'est ce qui a été implémenté.
> C'était une erreur de la conception, pas de l'implémentation : **les sommets à
> recoudre sont les coins de l'anneau composé, pas le point cliqué.** Avec un rayon de
> 2 m centré sur le clic, la boîte interrogée vaut ±4,00 m en latitude et ±2,70 m en
> longitude à 47,5° N, tandis que les coins d'une maison médiane d'Angers (83 m²,
> ~9,1 m de côté) sont à 4,56 m du centre sur chaque axe : cliquer le milieu d'une
> maison ordinaire ne ramenait **aucun** candidat. La réutilisation de nœuds — décision
> validée du §2, motivée par les 70 % de bâti mitoyen — ne se déclenchait donc
> pratiquement jamais, sans le moindre message. La primitive prend maintenant une
> étendue, et l'appelant lui passe le rectangle englobant de l'anneau dilaté de la
> tolérance de recalage.
>
> Deuxième correction du même appel : `nodesNear` ne filtrait **rien**. Un nœud
> porteur de tags (adresse, arbre, mobilier urbain) ou un sommet de voirie pouvait
> devenir un sommet du bâtiment créé. `nodesIn` ne rend qu'un nœud sommet d'un bâtiment
> (way taguée `building`, ou membre d'une relation `building`), ou nu et n'appartenant
> à aucune autre way.
>
> Troisième correction, même revue : `containerNode()` et `surfaceNode()` manquaient à
> cette liste, et le second n'existait pas du tout. Faute d'une source de vérité unique
> sur l'origine de la projection, `main.ts` mesurait l'écran contre `svg.surface` (avec
> un `querySelector` d'iD hors de `bridge/`, et un repli muet sur le conteneur) pendant
> que le calque de survol se posait sur le conteneur — la racine de l'éditeur, barre
> d'outils et panneau latéral compris. Les deux ne peuvent pas être justes : le contour
> aurait été dessiné à des centaines de pixels du bâtiment qu'il décrit, et le panneau
> latéral s'ouvre justement à chaque création puisqu'on appelle `modeSelect`. Un
> garde-fou décalé est pire qu'un garde-fou absent — il a l'air de fonctionner.

Aucun autre module ne touche à `iD`. Si iD change son amorçage, on répare ce fichier.

**Auto-test au démarrage** : si la capture du contexte échoue, ou si une des primitives attendues manque, le plugin ne s'active pas et affiche un message unique expliquant pourquoi. Il ne reste jamais à moitié fonctionnel.

### `cadastre/` — accès aux données

Résolution INSEE, téléchargement, décompression, cache IndexedDB, forme compacte, index spatial, test d'appartenance d'un point.

### `geometry/` — pur

`MultiPolygon` vers anneau, calcul des arêtes partagées, union, nettoyage des sommets colinéaires, simplification Douglas-Peucker, détection des dégénérescences.

### `conflation/` — pur

Recouvrement avec les bâtiments OSM existants ; recalage des sommets sur les nœuds OSM à portée.

### `tagging/` — pur

Construction des tags à partir du type cadastre et du millésime.

### `ui/`

Bouton de mode, calque de survol, messages de refus, réglages.

Le calque de survol est un SVG **qui nous appartient**, superposé au conteneur de carte et recalé via `bridge.project()` sur les événements de déplacement. On ne s'insère pas dans le pipeline de rendu de iD : c'est ce qui garde la surface fragile minuscule.

### Build

esbuild vers un `.user.js` unique avec bandeau de métadonnées. Vitest pour les tests. Rien d'autre.

## 5. Règle de composition du bâtiment

C'est le cœur du produit et la partie la plus facile à casser en silence. Elle est spécifiée précisément ici.

**Arête partagée.** Le PCI est topologiquement propre : deux polygones adjacents partagent des sommets exacts. Deux polygones partagent une arête si un segment consécutif de l'un apparaît, dans un sens ou dans l'autre, chez l'autre. La longueur de frontière partagée est la somme des longueurs de ces segments communs. Partager seulement des sommets isolés, sans segment, ne compte pas comme une adjacence.

**Composantes légères.** Les polygones `02` connectés entre eux par des arêtes partagées forment une composante. Une composante est traitée comme un tout : elle est absorbée entièrement, ou pas du tout. Cela évite qu'une chaîne d'appentis soit coupée en deux entre deux maisons.

**Propriétaire d'une composante légère.** Parmi les bâtiments en dur (`01` et `03`) adjacents à la composante, le propriétaire est celui avec lequel la **somme** des longueurs de frontière partagée est la plus grande. Égalité départagée de façon déterministe par l'index du polygone. Une composante sans aucun dur adjacent n'a pas de propriétaire.

Ce choix a été fait en connaissance du risque : 16 % des constructions légères touchent au moins deux bâtiments en dur, et l'heuristique se trompera sur les porches réellement partagés entre deux maisons mitoyennes. Le garde-fou n'est pas algorithmique mais visuel — le survol affiche le contour final **avant** le clic, donc l'annexion est toujours vue avant d'être validée.

**Composition, à partir du point cliqué :**

1. Trouver le polygone contenant le point. Aucun : ne rien faire.
2. Déterminer l'ancre :
   - `01` ou `03` : l'ancre est ce polygone.
   - `02` : l'ancre est le propriétaire de sa composante. Sans propriétaire, l'ancre est la composante elle-même (construction légère isolée).
3. Absorber toutes les composantes légères dont le propriétaire est l'ancre.
4. Union géométrique de l'ancre et des composantes absorbées.
5. Si l'union produit un trou ou plusieurs parties : refus, avec message.
6. Supprimer les sommets colinéaires apparus aux coutures, puis simplifier (Douglas-Peucker, coefficient réglable, défaut à caler pendant l'implémentation). **Les deux passes doivent borner leur erreur** : tout sommet supprimé reste à moins de la tolérance du contour retenu. C'est une garantie que seul un algorithme global comme Douglas-Peucker apporte ; un test de proximité local, appliqué en cascade, laisse l'erreur se composer. Mesuré le 2026-09-23 : une première implémentation locale déplaçait des contours réels jusqu'à 7,27 m avec une tolérance de 2 cm. **Un sommet partagé avec un polygone cadastre non membre de l'union est inamovible** : les deux passes le conservent, quelle que soit sa colinéarité.

   > **Corrigé le 2026-09-23, à la revue de branche.** Cette étape, telle qu'elle était
   > écrite, nettoyait sans regarder le voisinage — et c'est de là que venait le défaut,
   > pas de l'implémentation. Le PCI est topologiquement propre : deux bâtiments mitoyens
   > partagent des sommets exacts. Or un sommet partagé peut être quasi colinéaire sur
   > NOTRE anneau sans l'être sur celui du voisin. Mesuré sur la fixture réelle : le
   > polygone 99 de `rangeeMitoyenne` en porte deux, à 1,1 mm et 0,6 mm de leur corde,
   > tous deux partagés avec un voisin du même jeu ; `dropCollinear` (2 cm) les
   > supprimait, `simplify` (20 cm) à plus forte raison.
   >
   > Deux conséquences, toutes deux silencieuses. Le nœud OSM déjà importé du voisin est
   > bien là, mais nous n'avons plus de sommet à recaler dessus : le mur mitoyen ne peut
   > pas être recousu (étape 8), quand bien même la primitive de recherche de nœuds serait
   > correcte. Et quand ce voisin sera créé plus tard par ce même outil, **son** sommet —
   > non colinéaire sur son propre anneau, donc conservé — tombera au milieu de notre
   > arête, sans nœud partagé : l'artefact d'import que la communauté FR demande
   > justement d'éviter.
   >
   > L'ordre nettoyer (6) puis recaler (8) rend le défaut structurel : il ne peut pas se
   > rattraper à l'étape 8. La correction est donc à l'étape 6, et l'information
   > nécessaire y est disponible — ce sont les sommets de l'anneau uni qui appartiennent
   > aussi à un polygone non membre.
7. Contrôle de recouvrement avec les bâtiments OSM existants : refus si recouvrement.
8. Recaler chaque sommet sur un nœud OSM existant **éligible** s'il s'en trouve un à
   portée. Éligible veut dire : sommet d'un bâtiment OSM (way taguée `building`, ou
   membre d'une relation `building`), ou nœud nu n'appartenant à aucune autre way. Un
   nœud taggué qui n'est pas un coin de bâtiment (une adresse, un arbre) et un sommet de
   voirie sont exclus — les happer reviendrait à modifier le sens d'un objet existant, ou
   à rattacher un bâtiment à une route.
9. Créer les nœuds manquants et la way, en une seule opération annulable. Sélectionner le résultat.

Cette règle est **symétrique** : cliquer le porche ou cliquer la maison donne le même bâtiment, puisque l'appartenance du porche ne dépend pas du point cliqué. Un `01` n'est jamais fusionné avec un autre `01`. Un `03` est un bâtiment à part entière, jamais un appendice.

**L'aperçu au survol et le clic appellent la même fonction de composition**, jusqu'à l'étape 6 incluse. C'est une contrainte, pas un détail d'implémentation : l'aperçu est le seul garde-fou contre une annexion erronée, il serait sans valeur s'il pouvait diverger du résultat. Les étapes 7 à 9 ne modifient plus le contour, seulement son rattachement au graphe.

**Recalage sur les nœuds existants.** Tolérance par défaut ~20 cm, réglable. Un nœud existant est **réutilisé en place, jamais déplacé** : c'est le sommet cadastre qui cède. On ne modifie donc aucune géométrie préexistante. Une tolérance serrée est délibérée : elle recoud un bâtiment cadastre voisin déjà importé, mais ne happe pas un bâtiment tracé à main levée sur imagerie et décalé d'un mètre.

## 6. Tags

Sur tout bâtiment créé :

```
building = yes
source   = cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : {millésime}
```

Le millésime est lu sur le jeu Etalab effectivement téléchargé, jamais codé en dur. La Licence Ouverte exige que l'origine et le millésime figurent sur chaque objet.

Sur une **construction légère isolée** uniquement, en plus :

```
wall = no
```

C'est l'usage des imports français ; le wiki de la clé note que cet usage « was initiated by the import of the French cadaster ». Il est assumé comme une transposition pragmatique et discutée, faute de mieux.

`wall=no` ne va **pas** sur une union maison + porche : la maison a des murs, et l'appendice ouvert ne change pas ce fait.

Le champ `nom` du cadastre est ignoré — 34 occurrences sur 50 740, toponymie peu fiable.

## 7. Conformité aux règles françaises

Créer du bâtiment depuis le cadastre relève des règles d'import semi-automatique et du code de conduite des éditions automatisées. Le design les respecte par construction :

- Le commentaire de changeset et le champ source sont préremplis dans le panneau de sauvegarde d'iD, pour que les modifications soient identifiables et réversibles.
- Le geste « un bâtiment par clic » place l'outil dans le régime semi-automatique. C'est structurel : aucun chemin de code ne permet d'en créer mille.
- La v1 ne modifie **aucun objet existant**. Réutiliser un nœud voisin ne modifie pas la way qui le contient.
- Le README renverra explicitement vers les règles d'import et le code de conduite.

Réserve honnête : la couche cadastre affichée dans iD est un WMS raster dont le millésime peut différer de celui du jeu Etalab téléchargé. Les deux dérivent du même PCI, donc l'écart est faible, mais il n'est pas nul. À documenter.

## 8. Refus explicites

Chacun avec son message, et sans jamais laisser de géométrie à moitié créée :

- géométrie à trou (0,4 % des cas)
- polygone dégénéré (surface nulle, moins de trois sommets distincts)
- union produisant un trou ou plusieurs parties
- bâtiment OSM déjà présent au même endroit (v1)
- hors couverture cadastrale, commune introuvable, fichier indisponible
- réseau coupé
- contexte iD non capturé au démarrage

## 9. Tests

`geometry/`, `conflation/` et `tagging/` sont purs et se testent intégralement en Vitest. Les fixtures sont **extraites du fichier réel d'Angers**, pas inventées :

- un porche partageant une frontière avec deux maisons mitoyennes (le cas à 16 %)
- une rangée de bâtiments en dur mitoyens, qui ne doivent jamais fusionner
- une chaîne de constructions légères
- une géométrie à trou
- le plus petit bâtiment réel du fichier, qui doit être accepté et non pris pour dégénéré
- une construction légère isolée

La dégénérescence, elle, se teste sur des anneaux synthétiques : les données réelles n'en contiennent aucun.

Les règles d'union, le départage par plus longue frontière, le traitement par composante et la tolérance de recalage sont exactement le genre de logique qui se casse en silence : c'est là que les tests paient.

`bridge/` ne se teste pas sérieusement hors navigateur. Il a son auto-test au démarrage et une liste de vérification manuelle.

## 10. Inconnues à lever avant d'écrire le reste

Par ordre : le premier point est bloquant, et conditionne tout le projet.

1. **L'interception de `window.iD` fonctionne-t-elle réellement** en `document-start` sous Violentmonkey, avant l'exécution de `id.js` ? Et la capture du contexte via `coreContext` tient-elle ? Sans cela, la forme « userscript » tombe.
2. Le namespace global `iD` exporte-t-il bien `osmNode`, `osmWay` et les actions nécessaires à la création d'entités ?
3. Comment obtenir les bâtiments OSM chargés et les nœuds à proximité depuis le contexte, et comment préremplir le commentaire de changeset ?
4. Comment accéder à la projection et aux événements de déplacement pour caler le calque de survol ?
5. Résolution des arrondissements pour Paris, Lyon et Marseille.
6. Coefficient de simplification par défaut.

## 11. Risques

**Principal, assumé** : une refonte de l'amorçage ou du bundling de iD casse la capture du contexte. Mitigé par l'isolation dans `bridge/` et par l'auto-test, qui désactive proprement plutôt que de produire des données corrompues. Le coût de réparation est faible mais récurrent.

**Secondaire** : l'heuristique de plus longue frontière annexera parfois un porche partagé à la mauvaise maison. Mitigé par l'aperçu au survol, pas par l'algorithme.

## 12. Après la v1

- Remplacement de géométrie sur un bâtiment OSM existant, en préservant identifiant, historique, tags et appartenances aux relations.
- Géométries à trou et multipolygones.
- Éventuellement un mode zone, qui impliquerait alors une vraie conflation automatique et les obligations complètes du régime d'import.
- **Rétention par emprise visible**, si la mémoire devient gênante sur les grandes communes. Mesuré : 63,8 Mo retenus pour Angers, environ 293 Mo extrapolés pour Marseille. Les coordonnées seules y pèseraient 182 Mo, donc aucun jeu d'index ne suffira — seule une rétention partielle changerait l'ordre de grandeur. À ne faire que si quelqu'un constate la gêne : le cycle de vie du cache s'en trouve nettement compliqué, et un rechargement au déplacement introduit une latence là où il n'y en a aujourd'hui aucune.
