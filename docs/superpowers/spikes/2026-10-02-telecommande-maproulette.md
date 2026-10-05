# Spike — un seul onglet iD pour plusieurs tâches MapRoulette

Date : 2026-10-02. Question : peut-on traiter plusieurs tâches MapRoulette, de défis
différents, dans un seul changeset iD, par une « télécommande » à la JOSM ?

## Ce que MapRoulette fait (lu dans `maproulette3`, `Editor.js`)

- Il ouvre iD par `window.open('…/edit?editor=id#map=z/lat/lon&comment=…&source=…')`.
- **Avant chaque nouvelle tâche, il ferme la fenêtre d'éditeur précédente**
  (`editorWindowReference.close()`). C'est la cause des modifications qui ne suivent pas.
- Pour iD, les bundles ne servent à rien : le code ne transmet qu'une entité
  (« iD only supports a single selected entity »).

## Choix

Pas de serveur local (un userscript ne peut pas en ouvrir un) et pas de changement du
`#` d'iD (détail d'implémentation d'iD, qui ne relit pas `comment` quand il change). La
page MapRoulette envoie un **message** à l'onglet iD qu'elle a ouvert ; l'éditeur décide
comment l'exécuter.

- **MapRoulette → iD** : `postMessage` vers la fenêtre obtenue par `window.open`, qui est
  la seule à laquelle une page peut parler d'une autre origine.
- **Dans iD** : le cadre `/edit` relaie à l'iframe `/id` (`src/remote/receiver.ts`),
  qui exécute par l'API du contexte (`map().centerZoom`, `zoomToEntities`, `modeSelect`,
  `src/bridge/capture.ts`, `makeNavigation`).
- **« Prêt »** : l'iframe annonce à la page MapRoulette qu'elle sait recevoir. Tant que
  cette annonce n'est pas arrivée, la page garde le comportement d'origine.
- **Sécurité** : le récepteur n'accepte que la fenêtre qui l'a ouvert, depuis
  `https://*.maproulette.org`, et reconstruit chaque champ (`src/remote/protocol.ts`).
- **Plugin MapRoulette** (dépôt `maproulette-no-fallback`, branche
  `feat/keep-editor-window`) : remplace `window.open` pour les URL d'iD ; une fois l'onglet
  prêt, il y envoie la commande et rend à MapRoulette une poignée dont `close()` ne fait rien.

## Résultat

`2026-10-02-telecommande-e2e.cjs` (Playwright + Chrome) : 14 vérifications sur 14.
Avec les deux plugins : une seule fenêtre iD pour trois tâches, la modification faite dans
la 1re est conservée, la carte va à la zone de chaque tâche, l'objet de la 3e est
sélectionné, le commentaire du changeset est celui de la dernière tâche. Après fermeture
manuelle de l'onglet, la tâche suivante en rouvre un. **Sans** le plugin iD, MapRoulette
ferme et rouvre comme avant.

## Ce que ce test ne prouve pas

- La page MapRoulette est une page de remplacement qui reproduit `Editor.js` : le vrai
  bundle minifié n'a pas été exécuté. Il appelle bien `window.open` (source lue), mais
  c'est à confirmer sur le site.
- `/edit` et `/id` d'openstreetmap.org demandent une connexion : ce sont des pages de
  remplacement servies sous la même origine, qui chargent le **vrai iD 2.42.2**
  (`@openstreetmap/id`). Le gabarit réel de Rails peut différer.
- Les plugins sont injectés par `eval`, pas par un gestionnaire de scripts.
- Les `@grant` du plugin MapRoulette (`unsafeWindow`) sont déjà ceux qu'il utilise.

## Fusion du commentaire et de la source

Quand des modifications sont en cours (`history().hasChanges()`), le commentaire et la source
d'une tâche s'ajoutent à ceux déjà préparés (réglages `comment` et `source` d'iD, lus comme
`prefillChangeset` les écrit) au lieu de les remplacer : `src/remote/changeset.ts`. Hashtags
dédoublonnés sans tenir compte de la casse et placés en fin, textes joints par « ; », sources
jointes par « ; » (`;` côté OSM), 255 caractères au plus (textes retirés depuis la fin, un
hashtag n'est jamais coupé). Sans modification en cours (rien d'édité, ou changeset déjà envoyé),
la tâche REMPLACE : c'est un nouveau changeset. `hasChanges` absent ou qui lève vaut « aucune ».
Le commentaire de la 1re tâche n'étant que dans l'URL d'ouverture, le plugin MapRoulette le
renvoie au message `pret` (commande réduite `comment`/`source`), ce qui remplit les réglages.

## Limites connues

- Il faut toujours marquer les tâches « corrigées » une par une dans MapRoulette.
- Une tâche qui échoue à sélectionner son objet (non chargé après ~8 s) laisse la carte
  sur la zone sans sélection.
