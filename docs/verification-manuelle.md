# Vérification manuelle

`src/bridge/capture.ts` est le seul module qui touche aux entrailles d'iD. Il n'est pas
sérieusement testable hors navigateur — aucune suite Vitest ne peut simuler
l'amorçage réel d'`id.js` sur osm.org. Cette liste est le filet qui reste : **à
repasser après toute mise à jour d'iD ou d'osm.org**, pas seulement après une
modification de ce dépôt.

## Ce qu'il faut savoir avant de commencer

**iD tourne dans une iframe, servie à `/id`.** La page `/edit` que vous chargez dans la
barre d'adresse n'est qu'un conteneur ; l'éditeur réel — avec son contexte, son
`window.iD`, son DOM — vit dans une iframe interne dont l'URL est `/id`. Toute
vérification à la console doit cibler ce cadre, pas le document parent : dans les
DevTools Chrome ou Firefox, utilisez le sélecteur de contexte d'exécution (en haut du
panneau Console) pour choisir le cadre `/id` avant de taper quoi que ce soit. Une
commande tapée dans le contexte par défaut (le document parent, `/edit`) s'exécute là
où rien n'est capturé et ne prouvera rien, ni dans un sens ni dans l'autre.

**Ne jamais assigner directement une propriété sur `window.iD` ou sur son contexte
depuis la console pour « vérifier vite ».** C'est précisément ce qui a cassé
l'éditeur pendant le développement de ce greffon (voir
`docs/superpowers/spikes/2026-09-22-capture-contexte-id.md`) : une première sonde
faisait `v.coreContext = wrapper`, alors que `coreContext` est un accesseur
(un getter) sans setter sur le namespace exporté par le bundle d'iD. L'affectation a
levé une `TypeError` qui a remonté depuis le setter d'interception posé sur
`window.iD`, et l'amorçage d'iD est mort avec elle — plus d'éditeur du tout, pas
seulement un greffon inactif. Toute vérification manuelle doit rester **en lecture
seule** sur `window.iD` et sur son contexte (`typeof`, énumération de propriétés,
appel de fonctions sans effet de bord) ; si vous devez tester une hypothèse
d'écriture, faites-le sur une copie (`Object.assign({}, window.iD)`), jamais sur
l'objet réellement intercepté par le greffon.

Si un jour cette classe de défaut réapparaît — l'éditeur refuse de démarrer, une
`TypeError` mentionnant `coreContext` ou un « getter-only property » apparaît en
console — la cause la plus probable est qu'un futur build d'iD a changé la forme de
cet accesseur (par exemple en le gelant avec `Object.freeze`), et que
`src/bridge/capture.ts` doit être ajusté en conséquence (voir `hasFrozenCoreContext`
dans ce fichier, qui détecte déjà une partie de ce risque et se retire proprement le
cas échéant).

## Scénario 1 — chargement direct de `/edit`

Ouvrir directement `https://www.openstreetmap.org/edit` (ou `/edit#map=...`) dans un
nouvel onglet, sans passer par la carte.

- [ ] `[cadastre-id] prêt` apparaît dans la console (cadre `/id`, voir plus haut)
      **après** que l'éditeur est pleinement chargé. Ce message n'apparaît que si la
      capture du contexte a réussi ET que le raccourci a pu être posé — son absence,
      seule, est un signal valide d'échec, pas un faux négatif à ignorer.
- [ ] **Vérifier d'abord QUEL build s'exécute.** La ligne d'injection le nomme :
      `[cadastre-id] injecté — /id (iframe) · build 202609241738`. Ce nombre doit
      correspondre au `@version` du script installé dans le gestionnaire
      (`0.1.0.<build>`). Une session entière a été passée à analyser une pile
      d'appels qui venait de la version précédente, restée installée : ce point
      passe avant tous les autres.
- [ ] **Le greffon n'a aucune interface** : rien n'apparaît à l'écran tant que `Ctrl`
      n'est pas maintenu. Son seul signe de vie au repos est la ligne
      `[cadastre-id] prêt — maintenir Ctrl…` en console.
- [ ] Aucune erreur inattendue en console, en particulier aucune `TypeError` évoquant
      `coreContext` ou l'amorçage d'iD (voir l'avertissement ci-dessus).
- [ ] **Raccourci Ctrl**, seul déclencheur du greffon.
      - Si la console porte `désactivé : impossible de lire la couche de fond
        affichée`, le greffon est entièrement inerte : `cadastreVisible()`
        (src/bridge/capture.ts) est à reprendre sur un relevé réel.
      - **Sans** couche cadastre affichée, maintenir `Ctrl` ne doit rien armer : aucun
        contour au survol.
      - **Avec** la couche cadastre affichée (fond ou calque superposé), maintenir
        `Ctrl` doit faire apparaître le contour au survol ; le relâcher doit le faire
        disparaître.
      - Maintenir `Ctrl`, faire `Alt+Tab`, revenir, relâcher : aucun contour ne doit
        subsister. Sans le filet posé sur `blur`, le mode resterait armé et le clic
        suivant créerait un bâtiment non demandé.
      - Armer, survoler, **cliquer** : le bâtiment doit être créé et sélectionné.
        Aucune `TypeError` ne doit apparaître — ni `class constructors must be invoked
        with 'new'` (les entités d'iD sont des classes), ni `map().off is not a
        function` (la carte d'iD est un dispatch d3, sans `off`). Ces deux-là ont été
        constatées en session réelle.

## Scénario 2 — entrée dans l'éditeur depuis la carte

Partir de `https://www.openstreetmap.org/` (la carte de consultation, pas
l'éditeur), puis cliquer sur « Modifier » pour entrer dans iD par navigation interne,
**sans recharger la page**.

Deux raisons distinctes justifient de vérifier ce chemin séparément du scénario 1, et
aucune ne remplace l'autre :

- une navigation interne ne redéclenche pas forcément l'injection `document-start` de
  la même façon qu'un chargement direct — c'est le chemin identifié comme le plus
  susceptible de faire échouer l'injection, dès la planification du projet ;
- un incident distinct, constaté en cours de développement (voir la note technique
  plus haut), a fait qu'une sonde qui écrivait sur le namespace `window.iD` a empêché
  l'éditeur de démarrer — cet incident-là s'est produit indépendamment du chemin
  d'entrée dans l'éditeur, pas spécifiquement à cause d'une navigation interne.

- [ ] Le script s'injecte tout de même : mêmes vérifications que le scénario 1
      (`[cadastre-id] prêt — maintenir Ctrl…`, pas d'erreur), effectuées après être
      entré dans l'éditeur par ce chemin.
- [ ] Le comportement est identique à celui obtenu par chargement direct — aucune
      primitive manquante, aucun message d'auto-test qui apparaîtrait dans un
      scénario et pas dans l'autre.

## Fonctionnement du mode cadastre

À vérifier une fois le raccourci confirmé actif dans l'un des deux scénarios
ci-dessus, sur une commune dont la couverture cadastrale est connue (une commune
métropolitaine ordinaire suffit ; Paris, Lyon et Marseille méritent un passage
supplémentaire, voir plus bas).

- [ ] Armer le mode (maintenir `Ctrl`) ne provoque aucune erreur en console.
- [ ] Le survol d'un bâtiment affiche son contour, aligné sur la couche cadastre WMS
      affichée par iD (le calque et le fond de carte doivent se superposer
      visuellement, pas seulement être dans la bonne zone approximative).
- [ ] **Le contour reste aligné une fois le panneau latéral ouvert** (il s'ouvre après
      chaque création, puisque le greffon sélectionne l'objet créé) : survoler un
      bâtiment juste après une création doit dessiner le contour SUR le bâtiment, pas
      décalé horizontalement de la largeur du panneau. C'est le symptôme d'une origine
      de projection erronée — le calque et la conversion écran → coordonnées doivent
      tous deux venir de `surfaceNode()` (voir `src/bridge/capture.ts`). Vérifier aussi
      qu'aucun message `surface de carte (svg.surface) introuvable` n'apparaît en
      console : il signale que le repli a été pris, donc que l'alignement n'est plus
      garanti.
- [ ] Survoler un porche ou un appentis accolé à une maison fait apparaître le
      contour fusionné de la maison entière, porche compris — pas le porche seul.
- [ ] Survoler l'un de deux bâtiments en dur manifestement mitoyens (un mur commun,
      deux numéros de rue différents) montre le contour d'un seul bâtiment à la
      fois : les deux ne doivent jamais apparaître fusionnés en un seul contour.
- [ ] Le clic crée le bâtiment, qui apparaît sélectionné dans iD, avec au minimum les
      tags `building=yes` et `source=...` (vérifiables dans le panneau d'édition des
      tags).
- [ ] `Ctrl+Z` immédiatement après annule la création en une seule fois : le bâtiment
      disparaît complètement (way et nœuds propres), pas par étapes successives.
- [ ] Créer un bâtiment dont un mur touche un bâtiment déjà présent sur la carte
      réutilise les nœuds existants de ce mur commun : vérifiable en sélectionnant un
      des sommets du mur partagé après création, et en confirmant qu'il s'agit du même
      nœud (même identifiant, visible dans le panneau d'inspection) que celui du
      bâtiment voisin déjà présent — pas d'un nœud tout proche mais distinct.
- [ ] Le panneau de sauvegarde d'iD (accessible en cliquant sur « Enregistrer ») montre
      le commentaire de changeset déjà prérempli, mentionnant la commune.
- [ ] **Le champ « source » du même panneau est prérempli** avec
      `cadastre-dgi-fr source : ... Mise à jour : <millésime>`. À vérifier avec une
      attention particulière : contrairement à la clé `comment`, lue sur une session
      réelle pendant le spike, la clé de préférence `source` est **déduite** du code
      d'iD et n'a jamais été confirmée en navigateur. Si le champ reste vide alors que
      le commentaire, lui, est bien prérempli, c'est que la clé a changé ou n'a jamais
      été la bonne : corriger `prefillChangeset` dans `src/bridge/capture.ts`. Le
      README annonce ce préremplissage sous « Règles de contribution françaises » — il
      ne doit pas rester une promesse non tenue.
- [ ] Cliquer sur un bâtiment déjà présent dans OSM (par exemple un bâtiment tracé
      manuellement au préalable) déclenche un refus : pas de création, et un message
      explicite apparaît (boîte de dialogue du navigateur).
- [ ] Si un échec de capture du contexte iD se produit réellement pendant l'un des
      deux scénarios ci-dessus (`Ctrl` n'arme rien malgré un scénario par ailleurs
      normal, ou message `[cadastre-id] désactivé : ...` en console) — ne pas le
      traiter comme un test raté à recommencer, mais comme le signal qu'il faut
      suivre : le raccourci doit être inerte (jamais armé mais inopérant), et le
      message en console doit
      nommer la primitive ou l'étape en cause, pas juste dire « erreur ». C'est
      exactement le comportement attendu en cas de rupture de compatibilité avec une
      nouvelle version d'iD — voir « Fiabilité de l'intégration à iD » dans le
      `README.md`.

## Cas particulier : Paris, Lyon, Marseille

Ces trois communes sont découpées par arrondissement dans le jeu de données Etalab ;
le greffon les recolle automatiquement. Un passage sur l'une d'entre elles confirme
que :

- [ ] Le chargement de la commune ne provoque pas d'erreur « commune introuvable »
      (l'échec observé si le recollement des arrondissements casse).
- [ ] Le survol fonctionne sur un bâtiment proche d'une frontière d'arrondissement,
      pas seulement au centre d'un arrondissement.

## Après le passage

Notez, si vous pouvez la retrouver (menu d'aide d'iD, ou nom du fichier JS servi par
osm.org, par exemple `id-<hash>.js` visible dans l'onglet réseau des DevTools), une
référence de la version d'iD en service au moment du test, à côté de la date de ce
passage — pour qu'une régression future soit datable par rapport à une mise à jour
d'iD précise plutôt que par une date approximative.
