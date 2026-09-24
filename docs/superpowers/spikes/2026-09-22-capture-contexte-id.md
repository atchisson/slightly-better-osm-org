# Spike — capture du contexte iD depuis un userscript

Date : 2026-09-23 · Statut : **concluant — on continue**

Toute la forme « userscript » du projet reposait sur une hypothèse non vérifiée en
navigateur : qu'on puisse intercepter `window.iD` avant l'exécution du bootstrap et
capturer l'instance produite par `coreContext()`.

**L'hypothèse tient.** Deux passages ont été nécessaires, le premier ayant échoué sur un
défaut de la sonde et non de l'approche.

## Conclusion

On continue. La forme userscript est viable, et les quatre corrections de conception
ci-dessous font foi sur le plan.

## Premier passage — la sonde cassait l'éditeur

Console :

```
[spike] injecté à loading /edit
[spike] injecté à loading /id
[spike] window.iD affecté
Uncaught TypeError: setting getter-only property "coreContext"
    set ... cadastre-id.user.js#3:25
    ts https://www.openstreetmap.org/assets/id-71d5cb28….js:69
```

L'injection et l'interception fonctionnaient. La sonde faisait ensuite
`v.coreContext = wrapper` : or `coreContext` est un **getter sans setter**, ce que
produisent les bundlers pour exporter un module. L'affectation lève, l'exception remonte
depuis le setter de `window.iD`, et l'amorçage d'iD meurt avec elle. La sonde a tué
l'éditeur.

## Second passage — concluant

```
document        : /id | top = false
namespace iD    : present
contexte capture: oui
```

| Export du namespace | |
|---|---|
| `osmNode`, `osmWay` | ✅ |
| `actionAddEntity`, `actionChangeTags` | ✅ |
| `modeSelect`, `modeBrowse` | ✅ |
| `coreGraph`, `geoSphericalDistance` | ✅ |
| `osmEntity` | absent — non utilisé par le projet |
| `prefs` | ✅ — remplace `context.storage` |
| 434 exports au total | |

| Primitive du contexte | |
|---|---|
| `graph`, `history`, `map`, `perform`, `enter` | ✅ |
| `projection` (et `projection.invert`) | ✅ |
| `container`, `entity`, `mode` | ✅ |
| **`storage`** | **absent** — voir correction 4 |

Appels réels vérifiés :

- `map.extent().rectangle()` → `[1.3335721, 48.7259112, 1.3661878, 48.7344883]`
- `projection([2.35, 48.85])` → `[47368.97, -8171.38]`
- `projection.invert` → `function`
- `history().intersects(extent)` → **24 611 entités**, exemple `way w1079077012` avec tags `building`

## Les quatre corrections de conception

**1. iD est dans une iframe, servie à `/id`.** La lecture du code de rails
(`id.html.erb`, `<div id="id-container">`) m'avait fait conclure l'inverse. Le script
s'injecte d'abord sur `/edit`, puis à nouveau sur `/id` où vit réellement l'éditeur. Le
bridge, le bouton et le calque de survol appartiennent à ce document. Le `@match` actuel
le couvre déjà, et il ne faut surtout pas ajouter `@noframes`.

Conséquence pratique pour tout diagnostic futur : une commande tapée dans la console
s'exécute dans le document parent, où rien n'est capturé. Il faut basculer le sélecteur
de cadre, ou passer par `contentWindow`.

**2. On n'écrit jamais sur le namespace `iD`.** Ses exports sont des getters non
inscriptibles. La capture passe par un `Proxy` dont le piège `get` renvoie une version
enveloppée de `coreContext` — l'objet d'origine reste intact.

**3. Toute l'interception est sous `try/catch`.** Un plugin qui échoue se désactive ; il
n'empêche jamais l'éditeur de démarrer. Cette exigence était déjà dans la spec sous forme
d'auto-test ; le premier passage a montré qu'elle doit couvrir aussi le setter lui-même,
parce qu'une exception levée là casse le bootstrap d'iD.

**4. `context.storage` n'existe plus — utiliser `iD.prefs`.** Le commentaire de changeset
vit dans `localStorage` sous la clé **`comment`**, sans préfixe. Vérifié en lecture sur
une session réelle. Les clés voisines importent :

- **`commentDate`** : iD périme un commentaire trop ancien. Le préremplir sans mettre
  cette date à jour le ferait ignorer.
- **`hashtags`** : iD dispose d'un stockage dédié aux mots-dièses de changeset. C'est le
  mécanisme prévu pour identifier l'outil auteur d'une contribution — `#maproulette` en
  est le précédent. Voir la question ouverte en §7 de la spec.

## Ce qui reste inconnu, sans gravité

`iD.version` n'existe pas ; le namespace expose `uiVersion`. Le bridge n'en a pas besoin
— son auto-test porte sur la présence des primitives, pas sur un numéro de version, ce
qui est de toute façon plus robuste.

## Relevé complémentaire — géométrie de l'interface d'iD (2026-09-24)

Deux placements du bouton **Cadastre** ont échoué faute de ce relevé. Il est
consigné ici parce qu'aucun test ne peut le produire : seul un navigateur le sait.

```
surface : 400,0 1520x606
y=  5 -> div.top-toolbar        (bas=71)
y= 15 -> button.bar-button      (bas=50)
y= 55 -> span.localized-text    (bas=68)
y= 75 -> svg.surface            (bas=606)
```

**La barre d'outils est posée PAR-DESSUS la carte.** `svg.surface` commence à
`top=0` et s'étend sous le bandeau, qui descend jusqu'à 71 px. Mesurer l'écart
entre le coin de la surface et celui du conteneur donne donc zéro : c'est
l'erreur du deuxième placement. Le panneau latéral, lui, décale bien la carte
(`left=400`).

**`elementFromPoint` voit l'interface d'iD** : la barre renvoie ses propres
éléments, elle n'est pas traversée par les événements de pointeur. C'est ce qui
autorise le placement auto-correcteur de `src/ui/button.ts` — le bouton se pose,
demande au document qui le recouvre, descend sous le gêneur, recommence. Si la
barre avait été en `pointer-events:none`, la méthode aurait déclaré « libre » un
point visuellement caché et il aurait fallu viser `div.top-toolbar` par son nom,
depuis le bridge.

Corollaire pour tout diagnostic d'affichage : « l'élément est dans le DOM » ne
prouve rien. Le premier placement était présent, `visibility:visible`, opacité 1,
et invisible. Le test qui tranche est
`document.elementFromPoint(centre) === element`.
