# Amélioration de tracé — plan d'attaque

> **Pour qui :** l'auteur du greffon, pour arbitrer avant que la première ligne
> soit écrite. Les décisions à prendre sont rassemblées en §2 ; le reste en
> découle.

**But.** Corriger la géométrie d'une voie existante sans quitter iD : déplacer un
sommet, en insérer un, en supprimer un — ce que fait le mode *Improve Way
Accuracy* de JOSM.

---

## 1. Ce que fait JOSM, vérifié

Source : documentation officielle du mode (`Help/Action/ImproveWayAccuracy`),
consultée le 2026-09-25.

| geste | effet |
|-------|-------|
| activer par `W`, puis sélectionner une voie | entre dans le mode |
| clic simple | **déplace** le nœud le plus proche vers le curseur |
| `Ctrl` + clic | **ajoute** un nœud dans le segment surligné |
| `Alt` + clic | **supprime** le nœud surligné |
| `Shift` maintenu | **verrouille** la cible pendant que la souris bouge |
| `Esc` | désélectionne, pour changer de voie |

Deux règles de fond, à reprendre telles quelles :

- **La cible se recalcule en continu.** « Candidate for deletion/move/addition
  will be changed as many times as you move cursor. » Le retour visuel est donc
  permanent, pas déclenché au clic.
- **La suppression est contrainte.** « You cannot delete nodes that are connected
  to more than one way or that have tags », à l'exception de `FIXME` et `note`.
  C'est ce qui empêche de casser la topologie d'objets voisins.

Un aveu de JOSM qu'il faut connaître : les nœuds ajoutés ou déplacés **ne sont
pas** fusionnés avec les nœuds existants. L'utilisateur doit appliquer un outil
de fusion séparément. Nous pouvons faire mieux (§5).

---

## 2. Les trois décisions à prendre

### 2.1 Quel geste pour quoi — et le conflit avec `Ctrl`

**Le problème.** `Ctrl` maintenu arme déjà la création depuis le cadastre. Si
`Ctrl` sert aussi à améliorer un tracé, les deux modes se recouvrent. Le cas n'est
pas théorique : après chaque création, le greffon sélectionne la voie produite —
une voie est donc sélectionnée précisément au moment où l'on veut en créer une
autre.

**Trois issues, à arbitrer :**

- **(A) La proximité décide.** `Ctrl` maintenu améliore le tracé *si le curseur
  est à moins de N pixels de la voie sélectionnée*, et arme le cadastre sinon.
  Aucun geste nouveau à apprendre, et la règle se voit : le curseur change de
  forme, la cible se surligne. C'est ma recommandation. Risque : à l'intérieur
  d'un bâtiment sélectionné, à quelques pixels de son bord, l'intention est
  ambiguë — mais l'aperçu la lève avant le clic.
- **(B) Calquer JOSM.** Clic nu = déplacer, `Ctrl` = ajouter, `Alt` = supprimer,
  le mode étant armé par un raccourci dédié. Fidèle, mais le clic nu est déjà
  l'outil de sélection d'iD : le détourner dans un greffon est intrusif.
- **(C) Un modificateur libre.** `Alt` maintenu pour tout le mode, `Alt`+clic
  déplaçant, `Alt`+`Shift`+clic ajoutant. Aucun recouvrement, mais deux
  conventions différentes de celles de JOSM à mémoriser.

### 2.2 Jusqu'où aller sans confirmation

Ce mode **modifie et supprime des objets d'autrui**. Le greffon a déjà franchi ce
pas avec la couture des murs mitoyens, mais celle-ci était bornée à 20 cm et
accessoire à une création. Ici, c'est l'objet même de la fonction.

Proposition : aucune confirmation, mais **un aperçu obligatoire avant chaque
clic** (§4) et **une action par clic**, donc un `Ctrl+Z` par geste. C'est le
contrat de JOSM, et il a fait ses preuves.

### 2.3 La portée du greffon

« cadastre-id » est un outil d'import cadastral. Ce mode n'a rien à voir avec le
cadastre : c'est un éditeur de géométrie générique. Deux lectures se défendent —
l'accepter (on corrige un tracé juste après l'avoir importé, le geste est dans la
continuité), ou considérer que le greffon sort de son objet. À trancher une fois,
pas à chaque ajout.

---

## 3. Ce dont on dispose, et ce qui reste à vérifier

| brique | état |
|--------|------|
| lire la sélection (`selectedBuildings`) | **vérifié en session** — la fusion s'en sert |
| insérer un nœud dans un segment (`actionAddMidpoint`) | **vérifié en session** — la couture des murs s'en sert |
| `perform` avec une fonction de graphe maison | **vérifié** — la fusion remplace ainsi la liste de nœuds d'une voie |
| `projection` / `projection.invert` | **vérifié** par le spike |
| déplacer un nœud | **non vérifié** — `iD.actionMoveNode` existe probablement ; à défaut, `graph => graph.replace(graph.entity(id).move(loc))`, `move()` étant déjà utilisé par `actionAddMidpoint` |
| supprimer un nœud | **non vérifié** — `iD.actionDeleteNode` ; repli possible par une fonction de graphe maison, mais elle devrait alors retirer le nœud de TOUTES ses voies parentes, ce que l'action d'iD sait faire |
| savoir si un nœud appartient à plusieurs voies | **non vérifié** — `graph.parentWays(entity)` |

**Conséquence sur l'ordre des étapes :** commencer par ce qui ne modifie rien, et
n'introduire les primitives non vérifiées qu'une à la fois. La leçon de cette
session est constante — chaque hypothèse non mesurée sur les internes d'iD a coûté
un aller-retour en navigateur.

---

## 4. Découpage

Chaque étape est livrable et vérifiable seule.

### Étape 1 — Cible et aperçu, sans rien modifier

Un module pur `src/improve/target.ts` :

```ts
export type Cible =
  | { kind: 'noeud'; index: number; nodeId: string; loc: LonLat }
  | { kind: 'segment'; index: number; a: LonLat; b: LonLat; projection: LonLat }
  | null;

export function cibleSous(
  ecran: [number, number],
  voie: { ring: Ring; nodeIds: string[] },
  project: (p: LonLat) => [number, number],
  seuilPx: number,
): Cible;
```

**En pixels, pas en mètres** : c'est une tâche de pointage, et un seuil métrique
se comporterait différemment à chaque niveau de zoom. Un nœud l'emporte sur un
segment dans le même rayon — c'est la règle de JOSM, et c'est celle qui rend le
déplacement atteignable.

L'aperçu réutilise `src/ui/overlay.ts` : un cercle sur le nœud visé, ou un point
sur le segment visé et le contour qu'il produirait. Entièrement testable en unité
pour le calcul, à l'œil pour le rendu.

**Fin d'étape :** on survole une voie sélectionnée, la cible se surligne, rien
n'est modifié. Le coût est nul si l'on s'arrête là.

### Étape 2 — Déplacer un nœud

Bridge : `moveNode(nodeId, loc)`, une transaction, annotation explicite.

À décider à l'implémentation : refuser de déplacer un nœud qui porte des tags ou
appartient à une autre voie ? JOSM l'autorise (il ne l'interdit qu'à la
suppression). Je propose de l'autoriser aussi mais de **le signaler dans
l'aperçu** — déplacer le coin d'une maison mitoyenne déplace les deux, et ça doit
se voir avant le clic, pas après.

### Étape 3 — Ajouter un nœud

Bridge : déjà écrit. `actionAddMidpoint({loc, edge}, node)` insère le nœud dans
**toutes** les voies portant cette arête, ce qui est exactement le comportement
voulu sur un mur mitoyen.

### Étape 4 — Supprimer un nœud

Reprendre la règle de JOSM **verbatim** : refus si le nœud appartient à plus
d'une voie, ou s'il porte des tags autres que `FIXME` et `note`. Le refus est
explicite, jamais silencieux.

---

## 5. Ce que nous pouvons faire mieux que JOSM

JOSM ne fusionne pas les nœuds ajoutés ou déplacés avec ceux qui existent déjà.
Nous avons `snapToExistingNodes` et `planInsertions`, écrits, testés et en
service. Un nœud déplacé à moins de 20 cm d'un nœud existant pourrait s'y recaler
plutôt que de créer un doublon invisible.

**À ne pas faire à l'étape 1.** C'est un ajout de valeur, pas une condition de
fonctionnement, et il introduit son propre risque : un recalage non voulu est plus
difficile à repérer qu'un doublon. À proposer comme option, une fois le mode sûr.

---

## 6. Risques, par ordre de gravité

1. **Casser un objet d'autrui.** Un nœud partagé déplacé déforme tous ses
   porteurs. Mitigation : l'aperçu le dit avant le clic ; la contrainte de
   suppression de JOSM est reprise telle quelle.
2. **Le clic accidentel.** Un mode armé par un modificateur se déclenche vite.
   Mitigation : une action par clic, un `Ctrl+Z` par action, et pas de
   glisser-déposer en v1 — le glissé est le geste le plus facile à faire par
   mégarde.
3. **La confusion avec le mode cadastre.** Traitée en §2.1.
4. **Une primitive d'iD absente.** Traitée en §3 : une par étape, chacune
   vérifiée en navigateur avant la suivante.

---

## 7. Ce que je demande avant d'écrire une ligne

Les trois arbitrages du §2 — le geste (A, B ou C), l'absence de confirmation, et
la portée du greffon. Le reste en découle et n'appelle pas de décision.
