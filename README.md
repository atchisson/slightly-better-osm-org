# cadastre-id

Userscript qui ajoute à l'éditeur iD, sur `openstreetmap.org`, la création d'un
bâtiment OSM à partir du cadastre français, en un clic.

En mode cadastre, survoler un bâtiment cadastral affiche son contour final tel qu'il
sera créé. Cliquer le crée dans iD, tagué et sélectionné, prêt à être complété à la
main.

## Ce que ce greffon ne fait pas

- **Pas d'import en lot.** Un clic crée un bâtiment, jamais plus. Aucun chemin de code
  ne permet d'en créer mille d'un coup ; c'est structurel, pas une limite de
  configuration.
- **Le mur mitoyen est réellement partagé, ce qui modifie le bâtiment voisin.** Sur
  un mur mitoyen, le greffon réutilise des nœuds OSM déjà présents — il ne les crée
  jamais en double — **en place, sans jamais les déplacer**. Et quand un coin du
  nouveau bâtiment tombe au MILIEU du mur du voisin, là où aucun nœud n'existe, ce
  nœud est **inséré dans le mur du voisin** : les deux bâtiments partagent alors
  vraiment leur paroi, au lieu de superposer deux murs sans nœud commun.

  Cette insertion **modifie un objet existant** : le mur du voisin passe désormais
  par notre point, donc sa géométrie bouge — d'au plus 20 cm, la tolérance de
  recalage. C'est pourquoi cette tolérance reste serrée : au-delà, on ne recoudrait
  plus un mur commun, on déformerait le bâtiment de quelqu'un d'autre. Un bâtiment
  tracé sur imagerie et décalé d'un mètre reste hors de portée, délibérément.

  Création et coutures forment **une seule opération** : `Ctrl+Z` défait l'ensemble.

  Seuls sont réutilisables les sommets d'un bâtiment OSM
  (way taguée `building`, ou membre d'une relation `building`) et les nœuds nus
  n'appartenant à aucune autre way : un nœud porteur de tags — une adresse, un arbre,
  du mobilier urbain — et un sommet de voirie sont écartés, pour ne jamais leur faire
  porter un coin de maison ni raccrocher un bâtiment à une route. Ce n'est pas un cas rare : 70,3 % des bâtiments en
  dur du cadastre (mesuré sur Angers) sont mitoyens d'un autre bâtiment en dur, donc
  la mitoyenneté est la norme, pas l'exception — sans cette réutilisation, la plupart
  des créations dupliqueraient un mur déjà tracé.
- **Refus, pas remplacement, face à un bâtiment déjà cartographié.** Si un bâtiment OSM
  existe déjà à l'endroit cliqué, la création est refusée avec un message. Rien n'est
  écrasé ni fusionné.

  Le critère est la **part de l'empreinte déjà couverte** par du bâti OSM, pas le
  simple contact : au-delà de 10 %, refus. Un voisin dont le coin mord le contour ne
  bloque donc plus rien — mesuré sur la commune de Chargé, l'ancienne règle refusait
  ainsi 26 bâtiments qui n'étaient pas cartographiés, dont un à cause d'un bâtiment
  situé à 23 mètres. À l'inverse, la couverture est calculée sur l'ENSEMBLE du bâti
  existant : un bâtiment qu'un vieil import a découpé en cinq morceaux est reconnu
  comme déjà présent, ce qu'un test morceau par morceau ne voyait pas.
- Hors périmètre de cette version : les adresses, les parcelles, un mode « zone », et
  plus généralement tout ce qui ressemblerait à un import automatisé plutôt qu'à un
  geste unitaire décidé par une personne.

## Installation

Il n'y a pas de fichier `.user.js` hébergé publiquement pour l'instant — `dist/` est
dans `.gitignore` et n'est pas versionné. Le script se construit localement :

```bash
git clone <url-de-ce-dépôt>
cd cadastre-id
npm install
npm run build
```

`npm run build` produit `dist/cadastre-id.user.js`, un fichier unique (bandeau de
métadonnées Tampermonkey inclus, cf. `src/meta.ts`). Ouvrez ce fichier dans le
navigateur, ou glissez-le dans le tableau de bord de l'extension : Violentmonkey et
Tampermonkey détectent tous les deux l'extension `.user.js` et proposent
l'installation.

Le script s'active uniquement sur `https://www.openstreetmap.org/*`, en
`document-start`, sans permission particulière (`@grant none`) — il ne fait rien
d'autre que lire et manipuler la page d'édition elle-même.

## Utilisation

- Le greffon se déclenche **en maintenant `Ctrl`** sur la carte d'iD, et seulement
  quand une couche cadastre y est affichée. Il n'y a pas de bouton : tant que `Ctrl`
  est enfoncé, le mode est armé ; relâché, il ne l'est plus.
- Cette condition sur la couche n'a rien à voir avec l'exactitude du tracé — la
  géométrie vient toujours de l'API GeoJSON du cadastre, jamais de la couche
  affichée. Elle garantit que vous **regardez** la source que vous tracez, ce qu'on
  exige d'un déclencheur sans affordance visible.
- Le mode armé fait apparaître, au survol, le contour du bâtiment cadastral sous le
  curseur, aligné sur la couche cadastre. C'est le seul retour visuel : si le contour
  s'affiche, le greffon est armé.
- Cliquer crée le bâtiment dans iD, sélectionné, prêt à recevoir ses tags — comme pour
  tout objet tracé à la main.
- **Les piscines aussi.** Elles ne sont pas dans la couche des bâtiments du cadastre
  mais dans celle des surfaces topographiques (`tsurf`), d'où elles sont reconnues à
  leur code symbole. Survolez-en une, cliquez : elle est créée avec
  `leisure=swimming_pool` + `access=private`, et la même attribution que tout le reste.
  Une piscine ne fusionne jamais avec rien — ni avec un bâtiment, ni avec l'abri de
  jardin qui la borde — et son contrôle de doublon la compare aux piscines déjà
  cartographiées, pas aux maisons voisines.

  `access=private` est un **choix**, pas une déduction : le cadastre ne dit rien du
  régime d'accès et ne distingue pas la piscine d'un particulier de celle d'un camping.
  C'est l'usage majoritaire du gisement, et ce tag sera faux sur une petite minorité
  d'objets.

  Le code symbole a été vérifié contre les piscines déjà présentes dans OSM, sur deux
  communes de profils opposés : 73,5 % de correspondance au Lavandou, 65,1 % à Angers.
  Un second code semblait tout aussi convaincant dans le Var (81 %) et s'effondrait à
  Angers (1 %) — un artefact de densité, écarté. Le quart d'objets sans correspondance
  est vraisemblablement constitué de piscines non encore cartographiées : c'est
  précisément ce que cet outil sert à ajouter.

- **Fusionner deux bâtiments.** Un bâtiment à cheval sur deux parcelles est découpé
  en deux par le cadastre, alors que c'est un seul bâtiment — un seul toit traversé
  par une limite de propriété. Sélectionnez les deux dans iD, puis **clic droit →
  « Fusionner (cadastre-id) »**, ou **`Alt+F`**. iD ne sait pas le faire : son
  opération « Combiner » produit un multipolygone, pas une voie unique.

  La plus grande des deux voies est **conservée** — son identifiant, son historique et
  ses appartenances à des relations survivent —, la seconde est supprimée, et les
  nœuds du mur devenu intérieur disparaissent avec elle *sauf* ceux qu'un autre objet
  utilise encore. Aucun nœud n'est créé ni déplacé. Les tags sont réunis ; si une même
  clé portait deux valeurs différentes, celle du plus grand est retenue **et la clé
  vous est nommée**. Un seul `Ctrl+Z` défait l'ensemble.

  Le raccourci clavier n'est pas un pis-aller : l'entrée de menu se greffe sur le menu
  d'iD, donc elle dépend de la structure interne de l'éditeur. `Alt+F`, non.
- `Ctrl+Z` annule la création (nœuds éventuellement créés + way) en une seule
  opération.
- Le commentaire de changeset et la source sont préremplis dans le panneau de
  sauvegarde d'iD ; ils restent modifiables avant l'envoi. Le préremplissage du champ
  source passe par les préférences d'iD ; sa clé n'a pas encore été confirmée en
  session réelle (voir `docs/verification-manuelle.md`) — sans rapport avec le tag
  `source` posé sur l'objet créé lui-même, indépendant et vérifié par les tests.

## Attribution des données

Les bâtiments proviennent des fichiers cadastre par commune publiés par Etalab/DINUM
sur [data.gouv.fr](https://www.data.gouv.fr/), la plateforme des données publiques
françaises — lus directement sur le stockage objet qui les héberge, car la
redirection de `cadastre.data.gouv.fr` ne porte pas les en-têtes CORS qu'exige un
navigateur. Ils sont eux-mêmes issus du Plan
Cadastral Informatisé de la Direction Générale des Finances Publiques (DGFiP),
diffusés sous [Licence Ouverte](https://github.com/etalab/licence-ouverte) (« Open
Licence », publiée par Etalab et recommandée pour la publication des données
publiques françaises). La Licence Ouverte exige que l'origine et le millésime des
données figurent sur chaque objet qui en dérive.

Chaque bâtiment créé porte donc, verbatim :

```
building = yes
source   = cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : {millésime}
```

Le millésime n'est **jamais codé en dur** : il est lu sur le chemin de redirection du
fichier effectivement téléchargé pour la commune concernée (le jeu Etalab expose sa
date de publication dans son URL de stockage), donc traçable jusqu'à la version exacte
utilisée pour créer chaque objet donné.

Sur une **construction légère isolée** (sans bâtiment en dur adjacent) uniquement, le
tag additionnel :

```
wall = no
```

est posé. C'est un usage discuté : le wiki de la clé
[`wall`](https://wiki.openstreetmap.org/wiki/Key:wall) note que cet usage « was
initiated by the import of the French cadaster ». Il est repris ici comme une
transposition pragmatique, faute de mieux — pas comme un choix au-dessus de la
critique. Il n'est **pas** posé quand une construction légère est fusionnée dans un
bâtiment en dur : la maison a des murs, l'appentis ouvert qui lui est rattaché ne
change pas ce fait.

Le champ `nom` du cadastre est ignoré (34 occurrences sur 50 740 bâtiments mesurés sur
Angers — une toponymie trop rare pour être fiable).

## Règles de contribution françaises

Créer du bâti depuis le cadastre relève des règles de la communauté OSM France :

- [France/Cadastre/Import semi-automatique des bâtiments](https://wiki.openstreetmap.org/wiki/France/Cadastre/Import_semi-automatique_des_b%C3%A2timents)
- [Automated Edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct)

Ce que ce greffon fait pour s'y conformer, par construction et pas seulement par
intention :

- **Un bâtiment par clic.** Aucune fonction du code ne compose ni ne crée plus d'un
  bâtiment à la fois. Le régime reste celui d'une décision humaine, geste par geste —
  pas un import.
- **Le commentaire de changeset et la source sont préremplis**, pour que les
  modifications restent identifiables et attribuables sans effort de la part de la
  personne qui édite. Précision honnête : la clé de préférence iD utilisée pour le
  champ source du changeset a été déduite du code d'iD, pas confirmée en session
  réelle comme celle du commentaire — une vérification manuelle le couvre (voir
  `docs/verification-manuelle.md`). Ça ne concerne que ce préremplissage : le tag
  `source` posé sur l'objet créé, l'obligation de conformité elle-même, est écrit
  indépendamment et testé.
- **Un objet existant PEUT être modifié**, et c'est le point à signaler en premier à
  qui audite ces contributions. La réutilisation d'un nœud ne touche jamais à la way
  qui le porte ; en revanche l'insertion d'un sommet dans un mur mitoyen ajoute un
  nœud à la way du voisin et déplace sa géométrie d'au plus 20 cm. C'est ce que fait
  déjà un import semi-automatique sous JOSM, et c'est ce qui donne un mur réellement
  partagé plutôt que deux murs superposés — mais cela place ces contributions sous les
  exigences applicables aux édits touchant à l'existant, pas seulement à la création.
  Chaque insertion est bornée, visible dans l'aperçu avant clic, et annulable avec la
  création par un seul `Ctrl+Z`.

Voir aussi la lacune connue sur les mots-dièse de changeset, plus bas — c'est le point
le plus important à connaître si vous voulez auditer les contributions de cet outil en
tant que classe.

## Le cadastre n'est pas une vérité de terrain

Le PCI est une source administrative, pas un relevé de terrain à jour en continu. Il
contient des erreurs et peut être en retard sur la réalité — un bâtiment démoli
n'en disparaît pas immédiatement, une extension récente peut y être absente. Ce
greffon affiche un contour et laisse la décision de le créer à la personne qui clique ;
il ne dispense de rien vérifier sur imagerie ou sur place.

**Réserve sur le millésime affiché.** La couche cadastre visible dans iD (fond de
carte WMS) et le jeu Etalab téléchargé par ce greffon dérivent tous deux du même PCI,
mais pas forcément du même instantané : leurs millésimes peuvent différer. L'écart est
en général faible, mais il n'est pas nul — le tag `source` posé sur l'objet reflète le
millésime du fichier Etalab réellement utilisé pour la géométrie, pas nécessairement
celui du rendu que vous voyez à l'écran.

## L'heuristique de fusion des constructions légères — et son taux d'erreur connu

Le cadastre français distingue le bâtiment « en dur » (type `01`, fondations et fermé
sur 4 côtés, ou industriel) de la construction légère (type `02` : sans fondations, ou
ouverte sur au moins un côté — porche, auvent, appentis...). Un léger seul n'est
généralement pas un bâtiment au sens OSM ; ce greffon le fusionne dans le bâtiment en
dur avec lequel il partage une frontière, pour ne pas créer un porche comme objet
indépendant de la maison à laquelle il est physiquement rattaché.

Règle exacte : les constructions légères connectées entre elles par une arête partagée
forment une composante, traitée comme un tout (une chaîne d'appentis n'est jamais
coupée en deux). Quand une composante touche plusieurs bâtiments en dur, elle est
attribuée à celui avec lequel la **somme** des longueurs de frontière partagée est la
plus grande.

**C'est une heuristique, pas une certitude, et voici sa marge d'erreur mesurée** (sur
le fichier réel d'Angers, 50 740 bâtiments) :

- 16 % des constructions légères (2 063 polygones sur 12 892) touchent au moins deux
  bâtiments en dur — c'est le cas ambigu où l'heuristique doit trancher.
- Une mesure séparée, à l'échelle des **composantes** (un groupe de légers connectés
  entre eux, l'unité que l'heuristique attribue effectivement — pas le polygone
  individuel du point précédent) : sur 2 072 composantes ambiguës mesurées, **255
  (12,3 %) sont décidées à moins de cinq centimètres d'écart** entre les deux
  frontières candidates, certaines par une égalité exacte départagée uniquement par
  l'ordre des identifiants. Un porche réellement partagé entre deux maisons
  mitoyennes sera annexé au mauvais bâtiment dans une partie de ces cas — il n'y a pas
  de règle géométrique qui tranche ça correctement à chaque fois.

**La mitigation n'est pas algorithmique, elle est visuelle : l'aperçu au survol.** Le
contour affiché au survol et celui créé au clic sont produits par exactement la même
fonction de composition — ce n'est pas deux implémentations qui pourraient diverger,
c'est un seul calcul dont le survol montre le résultat avant que le clic ne le
matérialise. Concrètement : si le porche est annexé à la mauvaise maison, ça se voit
avant de cliquer, à condition de regarder. Ce n'est pas un garde-fou qui empêche
l'erreur ; c'est un garde-fou qui la rend visible.

## Refus explicites

Le greffon refuse plutôt que de créer une géométrie approximative ou à moitié
construite, dans chacun des cas suivants (chacun avec son propre message) :

| Cas | Mesuré sur Angers |
|---|---|
| Géométrie source à trou (cour intérieure cadastrale, avant toute composition) | 186 / 50 740 bâtiments (0,4 %), tous types confondus |
| Polygone dégénéré (aire nulle, ou moins de trois sommets distincts) | 0 dans ce jeu — garde défensive, se teste sur anneaux synthétiques |
| Ancre ou membre absorbé porteur d'un trou (refus `trou-source` à la composition) | 176 / 37 848 bâtiments en dur |
| Union des composantes produisant un trou (refus `trou`) | 55 / 37 848 |
| Union produisant plusieurs parties séparées (refus `parties-multiples`) | 0 / 37 848 |
| Contour qui se pince sur lui-même après union (refus `pincement`) | 76 / 37 848 |
| Bâtiment OSM déjà présent à l'endroit cliqué | non mesuré à l'échelle d'une commune |
| Commune introuvable ou hors couverture du cadastre français | — |
| Réseau coupé / données cadastre indisponibles | — |
| Clic pendant le chargement des données d'une commune (rien n'est créé sans qu'un contour ait été montré au survol) | — |
| Contexte iD non capturé au démarrage (voir plus bas) | — |

Au total, sur les 37 848 bâtiments en dur d'Angers pris comme ancre, la composition
(les quatre refus géométriques ci-dessus : `trou-source`, `trou`, `parties-multiples`,
`pincement`) échoue pour 307 d'entre eux — environ **0,8 %**. Ce chiffre ne couvre pas
les refus « bâtiment déjà présent », qui dépendent de ce qui est déjà cartographié
autour, ni les échecs réseau ou de couverture. Cliquer en dehors de tout bâtiment
cadastral n'est pas compté comme un refus : c'est le cas le plus courant d'un clic qui
ne visait rien, traité silencieusement plutôt que par un message d'erreur.

Si le contexte iD n'est pas capturé au démarrage (voir la note de fiabilité plus bas),
le greffon entier ne s'active pas : `Ctrl` n'arme rien, et un message en console
explique pourquoi. Il ne reste jamais à moitié fonctionnel.

## Fiabilité de l'intégration à iD

iD ne s'expose pas de lui-même à un script tiers : sur osm.org, le contexte
d'édition (`coreContext`) est construit en portée locale par le code de rails, jamais
publié sur `window`. Ce greffon intercepte sa construction via un `Proxy` posé sur le
seul objet global disponible (`window.iD`, le namespace de la bibliothèque), sans
jamais écrire sur ce namespace — ses exports sont des accesseurs non inscriptibles, et
y écrire romprait l'amorçage d'iD lui-même (voir
`docs/superpowers/spikes/2026-09-22-capture-contexte-id.md` pour l'incident constaté
en cours de développement).

Toute cette interception est isolée dans un seul module (`src/bridge/`) et protégée
par un auto-test : si la capture échoue, ou si une primitive attendue du contexte
manque, le greffon se désactive proprement — `Ctrl` n'arme plus rien, un message en
console le dit —
plutôt que de risquer une donnée corrompue. C'est la partie la plus fragile du projet
face à une future mise à jour d'iD ; voir `docs/verification-manuelle.md` pour la
vérifier après chaque mise à jour d'iD ou d'osm.org.

## Limites connues de cette version

- **Géométries à trou refusées, pas converties.** Une cour intérieure cadastrale
  (0,4 % des bâtiments d'Angers) est refusée avec un message plutôt que transformée en
  multipolygone OSM. À tracer à la main.
- **Aucun remplacement de géométrie sur un bâtiment OSM existant.** Cette version
  refuse systématiquement plutôt que de proposer une mise à jour de contour — voir
  « après la v1 » dans le document de conception pour l'évolution prévue.
- **Millésime WMS potentiellement différent du jeu téléchargé** (voir plus haut).
- **Rétention mémoire non négligeable sur les grandes communes.** Le jeu de données
  d'une commune reste entièrement en mémoire une fois chargé (index spatial inclus) :
  environ 64 Mo mesurés pour Angers (50 740 bâtiments), et de l'ordre de 293 Mo
  extrapolés pour une commune de la taille de Marseille (ses seize arrondissements
  pesant environ 4,6 fois plus). Ce n'est pas dangereux — il s'agit de données longues
  à vivre, sans effet mesuré sur la fluidité — mais c'est réel, et cette version ne
  décharge pas les données d'une commune quittée.
- **Cas limite documenté sur le test point-dans-polygone** : un point exactement porté
  par une arête (cas de mesure quasi nulle en pratique) peut faire afficher un message
  de refus inexact (« plusieurs morceaux séparés » au lieu de « cour intérieure »,
  par exemple) sans jamais produire de géométrie fausse. Non observé sur les 37 848
  bâtiments réels d'Angers testés.
- **Le contrôle « bâtiment déjà présent » ne voit que ce qu'iD a déjà chargé.** Juste
  après un déplacement de carte, et tant que la réponse de l'API OSM n'est pas arrivée,
  le greffon ne connaît aucun bâtiment existant dans la nouvelle zone : l'aperçu
  s'affiche alors en vert, ce qui est une affirmation positive (« il n'y a rien ici »)
  fondée sur un graphe encore vide. Concrètement : **attendre que les données OSM soient
  affichées avant de cliquer**, comme pour n'importe quel tracé à la main. Le contexte
  d'iD capturé par ce greffon n'expose pas de signal vérifié disant qu'un chargement est
  en cours ; plutôt que de le deviner, la limite est écrite ici.
- **Recouvrement par chevauchement exactement colinéaire non détecté.** Un cas de
  mesure nulle en pratique (il faudrait un alignement au flottant près) qu'il serait
  dangereux de corriger naïvement : le correctif évident ferait refuser une grande
  partie des bâtiments mitoyens légitimes, puisqu'un mur mitoyen partage lui aussi des
  arêtes colinéaires sur une longueur non nulle.
- **Notifications par `window.alert()`.** Les refus s'affichent dans une boîte de
  dialogue bloquante du navigateur ; il n'y a pas encore de notification intégrée à
  l'interface d'iD.

## Lacune connue : les changesets de ce greffon ne se distinguent pas des autres

iD dispose d'un mécanisme dédié aux mots-dièse de changeset (`hashtags`), le même qui
permet par exemple de retrouver toutes les contributions MapRoulette via
`#maproulette`. Un mot-dièse équivalent (`#cadastre-id`) a été proposé au mainteneur du
projet à deux reprises pendant le développement ; la question reste sans réponse à ce
jour, et **le mot-dièse n'a donc pas été ajouté**.

Concrètement : les changesets créés par ce greffon ne portent, dans leur commentaire,
que le nom de la commune (`Bâtiments depuis le cadastre (<commune>)`) et sortent sous
le compte OSM de la personne qui a cliqué. **Rien ne les distingue aujourd'hui, en tant
que classe, des autres modifications faites depuis iD.** Une recherche par mot-dièse ne
les retrouvera pas. Si un défaut de l'outil devait être découvert après coup, il n'y a
pas de moyen automatique de lister toutes les contributions qui en proviennent.

## Vérifier par soi-même

Les changesets produits par ce greffon sont des changesets iD ordinaires, sans rien
d'exotique : ils se lisent et se révertent comme n'importe quel autre changeset (par
exemple via l'outil de reversion de JOSM). Un révert n'affecte que ce que le changeset a
réellement créé ou modifié — les nœuds OSM réutilisés sur un mur mitoyen n'étant ni
créés ni modifiés par ce greffon, ils ne sont pas concernés par la reversion d'une
création qui les référence.

## Développement

```bash
npm install
npm test        # 237 tests, 19 fichiers, à la date de cette version
npm run typecheck
npm run build
```

Les modules purs (`geometry/`, `conflation/`, `tagging/`) sont intégralement testés en
Vitest, avec des fixtures **extraites du fichier réel d'Angers** plutôt qu'inventées
(`tests/fixtures/angers.json`, produit par `tools/extract-fixtures.mjs`) : un porche
partagé entre deux maisons mitoyennes, une rangée de bâtiments en dur qui ne doivent
jamais fusionner, une chaîne de constructions légères, une géométrie à trou, le plus
petit bâtiment réel du fichier, une construction légère isolée.

`src/bridge/` — le seul module qui connaît les entrailles d'iD — ne se teste pas
sérieusement hors navigateur : voir `docs/verification-manuelle.md`.

Le document de conception complet, avec ses mesures et ses décisions motivées, est
dans `docs/superpowers/specs/2026-09-22-cadastre-id-design.md`.
