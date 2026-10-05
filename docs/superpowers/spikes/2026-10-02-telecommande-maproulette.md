# Spike — un seul onglet iD pour plusieurs tâches MapRoulette

Date : 2026-10-02 (corrigé le 2026-10-05). Question : peut-on traiter plusieurs tâches
MapRoulette, de défis différents, dans un seul changeset iD ?

## Correction (COOP)

La première version (v0.3.0, avec le plugin MapRoulette 1.3.1) pilotait l'onglet iD depuis la
page MapRoulette, par la référence rendue par `window.open` et `postMessage`. **Cela ne marche
pas sur le vrai site.** `openstreetmap.org` répond `Cross-Origin-Opener-Policy: same-origin` :
le navigateur coupe le lien d'ouverture entre MapRoulette et l'onglet qu'elle ouvre. Côté iD,
`window.opener` est `null` ; côté MapRoulette, la référence ne permet ni d'écrire à l'onglet
ni de le fermer. Symptôme réel : un nouvel onglet iD à chaque tâche, et rien dans la console.

Le banc d'essai de bout en bout n'avait pas cet en-tête sur ses pages de remplacement
d'openstreetmap.org : d'où un faux succès (16/16). Le banc actuel le pose sur toutes les
réponses `/edit` et `/id`, et c'est ce qui l'a rendu fidèle.

### Conception actuelle : tout du côté iD

MapRoulette est inchangé (un nouvel onglet par tâche, l'objet en paramètre de requête
`way=…`, le reste dans le `#`). Les onglets iD, eux, sont de même origine et se parlent :

- **Verrou** : une fois la navigation prête, chaque onglet tente d'acquérir le verrou Web
  Locks `sb-osm-onglet-principal` (`ifAvailable`). Le gagnant est l'**onglet principal** ; il
  le garde tant qu'il vit (le navigateur le libère à sa mort : un autre onglet le prendra) et
  écoute le `BroadcastChannel` `sb-osm-onglet`.
- **Transmission** : un onglet qui n'obtient pas le verrou et **vient de MapRoulette** (référent
  du cadre principal) construit une commande depuis l'URL de son cadre principal
  (`src/remote/url.ts`), la poste sur le canal, attend l'accusé (3 s au plus), puis **se ferme**
  (`window.top.close()` : un onglet ouvert par un lien peut se fermer lui-même).
- **Exécution** : le principal revalide la commande (`lireCommande`) et l'exécute par
  l'API du contexte d'iD (`map().centerZoom`, `zoomToEntities`, `modeSelect`,
  `src/bridge/capture.ts`, `makeNavigation`), puis répond par l'accusé.
- **1re tâche** : son commentaire et sa source ne sont que dans l'URL de l'onglet principal ;
  à l'obtention du verrou, une commande réduite `comment`/`source` les applique.
- Le tout est dans `src/remote/onglet.ts`, avec ses dépendances injectées (testé sans
  navigateur) ; `window.top` est lisible, le cadre `/edit` et l'iframe `/id` étant de même origine.

### Limites

- L'utilisateur bascule lui-même vers l'onglet principal : un onglet ne peut pas forcer le
  focus d'un autre. L'onglet principal est mis à jour en arrière-plan.
- Si le principal ne répond pas (gelé, ou disparu entre le verrou et l'envoi), l'onglet ne
  ferme rien et reste un onglet iD ordinaire : le comportement d'origine.
- Un onglet iD ouvert à la main (sans référent MapRoulette) n'est jamais fermé et ne transmet
  rien. Sans Web Locks ni `BroadcastChannel`, le greffon ne fait rien de tout cela.
- Le principal est le PREMIER onglet iD à tenir le verrou, y compris un onglet ouvert à la main :
  s'il porte des modifications sans rapport, les tâches MapRoulette y fusionnent leur commentaire
  et leur source (acceptable, par conception).
- L'accusé veut dire « commande reçue et confiée à la navigation », pas « appliquée » : si la
  navigation du principal échoue, le nouvel onglet s'est quand même fermé, la tâche est à rouvrir.
- **Garde-fous** : `document.referrer` survit à F5, à la restauration de session et à « rouvrir
  l'onglet fermé ». Seul un chargement de type `navigate` (lu sur le cadre PRINCIPAL : l'iframe
  `/id` reste `navigate` quand on recharge `/edit`, constaté par le banc) peut donc transmettre
  ou appliquer la commande réduite, et un onglet qui porte des modifications
  (`Navigation.aDesModifications`, `history().hasChanges()`) ne se ferme jamais, ni avant d'envoyer
  ni après l'accusé. Un onglet rechargé ou restauré ne transmet jamais.
- Une connexion qui passe par osm.org fait perdre le référent MapRoulette : on retrouve alors
  l'ancien comportement (un nouvel onglet par tâche).
- Le plugin MapRoulette (`maproulette-no-fallback`, réutilisation de fenêtre) est devenu
  inutile et a été retiré ; ce greffon-ci n'a plus besoin d'aucun script compagnon.

## Ce que MapRoulette fait (lu dans `maproulette3`, `Editor.js`)

- Il ouvre iD par `window.open('…/edit?editor=id[&way=ID]#map=z/lat/lon&comment=…&source=…')`.
- **Avant chaque nouvelle tâche, il ferme la fenêtre d'éditeur précédente**
  (`editorWindowReference.close()`) — sans effet sur le vrai site à cause du COOP, d'où un
  onglet de plus à chaque tâche.
- Pour iD, les bundles ne servent à rien : le code ne transmet qu'une entité
  (« iD only supports a single selected entity »).

## Choix

Pas de serveur local (un userscript ne peut pas en ouvrir un) et pas de changement du
`#` d'iD (détail d'implémentation d'iD, qui ne relit pas `comment` quand il change). Une
**commande** (aller ici, sélectionner cela, préremplir ceci) ; l'éditeur décide comment
l'exécuter dans la version d'iD qu'il a sous la main.

- **Sécurité** : une commande reçue est toujours revalidée et reconstruite champ par champ
  (`src/remote/protocol.ts`), même venue du canal. Seul un onglet dont le référent est
  `https://*.maproulette.org` transmet.

## Résultat

`2026-10-02-telecommande-e2e.cjs` (Playwright + Chrome sans interface, COOP posé sur toutes les
réponses d'openstreetmap.org) : 30 vérifications sur 30.

- A : la 1re tâche ouvre l'onglet principal ; la 2e ouvre un onglet qui se ferme seul (au plus
  6 s) ; l'onglet principal reste ouvert, sa carte va sur la zone de la 2e tâche, la modification
  est conservée, commentaire et source sont fusionnés ; la 3e tâche sélectionne son objet réel
  dans le principal ; après vidage de l'historique, la tâche suivante REMPLACE.
- B : l'utilisateur ferme le principal : la tâche suivante ouvre un onglet qui devient
  principal et reste ouvert.
- C : un onglet iD ouvert à la main alors qu'un principal existe reste ouvert et ne transmet rien.
- E : un onglet resté « ordinaire » (principal rendu muet) puis rechargé, alors que le principal
  répond, ne transmet rien et reste ouvert. Le garde « modifications en cours » n'est couvert que
  par les tests unitaires (le provoquer avant la décision serait une course).
- D : sans Web Locks, comportement d'origine, aucun onglet fermé.

## Ce que ce test ne prouve pas

- La page MapRoulette est une page de remplacement qui reproduit `Editor.js` : le vrai
  bundle minifié n'a pas été exécuté. Il appelle bien `window.open` (source lue), mais
  c'est à confirmer sur le site.
- `/edit` et `/id` d'openstreetmap.org demandent une connexion : ce sont des pages de
  remplacement servies sous la même origine, avec le même COOP, qui chargent le **vrai iD
  2.42.2** (`@openstreetmap/id`). Le gabarit réel de Rails peut différer (en particulier la
  conversion de `way=` en `id=` dans le hash, reproduite ici).
- Le script est injecté par `eval`, pas par un gestionnaire de scripts.
- Chrome seulement : Firefox et Safari ne sont pas essayés.

## Fusion du commentaire et de la source

Quand des modifications sont en cours (`history().hasChanges()`), le commentaire et la source
d'une tâche s'ajoutent à ceux déjà préparés (réglages `comment` et `source` d'iD, lus comme
`prefillChangeset` les écrit) au lieu de les remplacer : `src/remote/changeset.ts`. Hashtags
dédoublonnés sans tenir compte de la casse et placés en fin, textes joints par « ; », sources
jointes par `;` sans espace (convention OSM), 255 caractères au plus (textes retirés depuis la fin, un
hashtag n'est jamais coupé). Sans modification en cours (rien d'édité, ou changeset déjà envoyé),
la tâche REMPLACE : c'est un nouveau changeset. `hasChanges` absent ou qui lève vaut « aucune ».
Le commentaire de la 1re tâche n'étant que dans l'URL d'ouverture, l'onglet principal l'applique
lui-même en devenant principal (commande réduite `comment`/`source`), ce qui remplit les réglages.

## Limites connues

- Il faut toujours marquer les tâches « corrigées » une par une dans MapRoulette.
- Une tâche qui échoue à sélectionner son objet (non chargé après ~8 s) laisse la carte
  sur la zone sans sélection.
