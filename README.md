# slightly better osm org

Userscript qui ajoute à l'éditeur iD d'openstreetmap.org des outils pour cartographier le
bâti français depuis le cadastre. Inspiré de [better-osm-org](https://github.com/deevroman/better-osm-org).

1. Installer [Violentmonkey](https://violentmonkey.github.io/) (libre) ou [Tampermonkey](https://www.tampermonkey.net)
2. [Installer le script](https://github.com/atchisson/slightly-better-osm-org/releases/latest/download/slightly-better-osm-org.user.js)

Sous Firefox avec Violentmonkey, activer **Synchronous page mode** (Paramètres → Paramètres
avancés) : sans lui, le script arrive parfois trop tard et l'éditeur doit être rechargé.

Les mises à jour sont automatiques.

### Bâtiments et piscines depuis le cadastre

Affichez une couche cadastre dans iD, maintenez **`Ctrl`** : le contour du bâtiment sous le
curseur apparaît. Un clic le crée, tagué et sélectionné.

- Murs mitoyens partagés avec les bâtiments voisins, sans nœud en double
- Porches et appentis rattachés à leur maison
- Cours intérieures créées en multipolygone
- Piscines et autres surfaces du cadastre
- Refus si le bâtiment est déjà cartographié
- Clic possible pendant le chargement de la commune : l'objet est créé dès que les données arrivent

### Fusion de deux bâtiments

Un bâtiment coupé en deux par une limite de parcelle redevient une seule voie : sélectionnez
les deux, puis **clic droit → « Fusionner »** ou **`Alt+F`**.

### Correction de tracé

Sans fond cadastre, une voie sélectionnée, maintenez **`Ctrl`** : un clic déplace le sommet le
plus proche vers le curseur. **`Maj`** insère un nœud à la place.

### Plusieurs tâches MapRoulette dans un seul changeset

Les tâches ouvertes depuis MapRoulette sont regroupées dans le premier onglet iD : chaque
nouvel onglet se ferme et sa tâche s'y affiche, avec commentaire et source ajoutés au
changeset en cours.

### Changeset prérempli

Commentaire et source sont remplis automatiquement dans le panneau d'envoi d'iD.

### Raccourcis

- `Ctrl` (fond cadastre) — créer un bâtiment ou une piscine
- `Ctrl` (une voie sélectionnée) — corriger le tracé ; `Ctrl` + `Maj` pour insérer un nœud
- `Alt+F` — fusionner deux bâtiments sélectionnés
- `Ctrl+Z` — tout annuler en une fois

## Données

Bâtiments issus du cadastre DGFiP publié par Etalab sur [data.gouv.fr](https://www.data.gouv.fr/),
sous [Licence Ouverte](https://github.com/etalab/licence-ouverte). Chaque objet créé porte :

```
source = cadastre-dgi-fr source : Direction Générale des Impôts - Cadastre. Mise à jour : {millésime}
```

Un clic crée un bâtiment, jamais plus : l'outil reste un geste manuel, pas un import. Voir
les règles [OSM France sur le cadastre](https://wiki.openstreetmap.org/wiki/France/Cadastre/Import_semi-automatique_des_b%C3%A2timents).

## Développement

```bash
npm install
npm test
npm run build       # dist/slightly-better-osm-org.user.js
npm run build:dev   # dist/slightly-better-osm-org.dev.user.js
```

La version dev s'installe à côté de la version publiée sans la remplacer. N'en activer
qu'une à la fois.

## Licence

Code sous [licence ISC](LICENSE) — © 2026 Antoine Lenoir. Les objets écrits dans
OpenStreetMap relèvent de l'[ODbL](https://opendatacommons.org/licenses/odbl/).
