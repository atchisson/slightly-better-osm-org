// Test de bout en bout jetable : plusieurs tâches MapRoulette dans un seul onglet iD, dans les
// conditions RÉELLES d'openstreetmap.org (en-tête `Cross-Origin-Opener-Policy: same-origin`).
//
// Infrastructure : Chrome sans interface (playwright-core), le vrai iD 2.42.2 servi sous l'origine
// https://www.openstreetmap.org (pages de remplacement `/edit` et `/id`), le vrai script construit
// (`npm run build`), une page MapRoulette de remplacement. MapRoulette n'est plus modifié : la page
// de remplacement reproduit seulement `Editor.js` (fermer la fenêtre précédente, puis `window.open`).
//
// Le point que la première version de ce banc n'avait pas, d'où un faux succès : TOUTES les réponses
// d'openstreetmap.org portent le COOP. Le lien d'ouverture est coupé (`opener` nul, pas de `close()`
// depuis MapRoulette) : seul le verrou Web Locks et le BroadcastChannel entre onglets iD fonctionnent.
//
// Lancer : `npm run build`, puis, depuis un dossier où `playwright-core` est installé (ou avec
// NODE_PATH), `node docs/superpowers/spikes/2026-10-02-telecommande-e2e.cjs`.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const SB_PLUGIN = fs.readFileSync(path.join(__dirname, '../../../dist/slightly-better-osm-org.user.js'), 'utf8');
const CDN = 'https://cdn.jsdelivr.net/npm/@openstreetmap/id@2.42.2/dist/';
const COOP = { 'cross-origin-opener-policy': 'same-origin' };
const WAY = '42734284'; // voie réelle près d'Angers (codée en dur : l'API publique limite le débit, 429)

// Reproduit `Editor.js` de MapRoulette : ferme l'éditeur précédent s'il n'est pas fermé (sans effet
// en COOP), puis ouvre un NOUVEL onglet. L'objet à sélectionner est un paramètre de requête.
const MR_PAGE = `<!doctype html><meta charset=utf-8><title>MR stub</title>
<button id=t1>task1</button><button id=t2>task2</button><button id=t3>task3</button>
<script>
let editorWindowReference = null;
const WAY = new URLSearchParams(location.search).get('way') || '';
const TASKS = {
  t1: { z: 19, lat: 48.8566, lon: 2.3522, comment: '#maproulette #defi-un', source: 'defi un', way: '' },
  t2: { z: 18, lat: 47.4784, lon: -0.5632, comment: '#maproulette #defi-deux', source: 'defi deux', way: '' },
  t3: { z: 18, lat: 47.4784, lon: -0.5632, comment: '#maproulette #defi-trois', source: 'defi trois', way: WAY },
};
for (const k of Object.keys(TASKS)) document.getElementById(k).onclick = () => {
  const t = TASKS[k];
  if (editorWindowReference && !editorWindowReference.closed) editorWindowReference.close();
  editorWindowReference = window.open('https://www.openstreetmap.org/edit?editor=id' + (t.way ? '&way=' + t.way : '') +
    '#map=' + [t.z, t.lat, t.lon].join('/') +
    '&comment=' + encodeURIComponent(t.comment) + '&source=' + encodeURIComponent(t.source));
};
</script>`;

// `/edit` de la vraie plateforme : une iframe `/id`, à qui la page passe le hash. Elle convertit aussi
// le paramètre de requête `way=` en `id=w…`, comme le fait le code de la plateforme.
const EDIT_PAGE = `<!doctype html><meta charset=utf-8><title>osm edit stub</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe></iframe>
<script>
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  if (q.get('way')) h.set('id', 'w' + q.get('way'));
  document.querySelector('iframe').src = '/id#' + h.toString().replace(/%2F/g, '/');
</script>`;

const ID_PAGE = `<!doctype html><html><head><meta charset=utf-8><link rel=stylesheet href="${CDN}iD.css">
<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}</style></head>
<body><div id=id-container></div>
<script src="${CDN}iD.min.js"></script>
<script>
  var container = document.getElementById('id-container');
  var context = iD.coreContext().assetPath('${CDN}').containerNode(container);
  window.__ctx = context;                       // test seulement
  context.init();
  context.features().disable('boundaries');
</script></body></html>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? '  ' + extra : '')); };

/** Journaux console de tous les onglets (iframes comprises), avec le numéro d'ordre de l'onglet. */
async function newContext(browser, { sansVerrous = false } = {}) {
  const context = await browser.newContext();
  context.journal = [];
  let n = 0;
  context.on('page', p => {
    const num = ++n;
    p.num = num;
    p.on('console', m => context.journal.push({ num, text: m.text() }));
  });
  await context.addInitScript(({ sb, sansVerrous }) => {
    if (location.origin !== 'https://www.openstreetmap.org') return;
    // Navigateur sans Web Locks : le script ne doit alors rien changer au comportement d'origine.
    if (sansVerrous) Object.defineProperty(Navigator.prototype, 'locks', { value: undefined, configurable: true });
    window.eval(sb);
  }, { sb: SB_PLUGIN, sansVerrous });
  await context.route('https://maproulette.org/**', r => r.fulfill({ contentType: 'text/html', body: MR_PAGE }));
  await context.route('https://www.openstreetmap.org/edit**', r => r.fulfill({ contentType: 'text/html', headers: COOP, body: EDIT_PAGE }));
  await context.route('https://www.openstreetmap.org/id**', r => r.fulfill({ contentType: 'text/html', headers: COOP, body: ID_PAGE }));
  return context;
}

const aLog = (context, num, sous) => context.journal.some(j => j.num === num && j.text.includes(sous));
const attendre = async (cond, ms) => { for (let t = 0; t < ms; t += 250) { if (await cond()) return true; await sleep(250); } return !!(await cond()); };

const idFrame = async popup => {
  await popup.waitForSelector('iframe');
  let frame = null;
  for (let i = 0; i < 60 && !frame; i++) {
    frame = popup.frames().find(f => f !== popup.mainFrame() && f.url().includes('/id'));
    if (!frame) await sleep(250);
  }
  await frame.waitForFunction(() => window.__ctx && window.__ctx.map && document.querySelector('.main-map'), null, { timeout: 90000 });
  await frame.waitForFunction(() => window.__ctx.map().zoom() > 1, null, { timeout: 90000 });
  return frame;
};

const ouvrir = async (context, mr, bouton) => {
  const [popup] = await Promise.all([context.waitForEvent('page'), mr.click(bouton)]);
  return popup;
};
const reglages = frame => frame.evaluate(() => [localStorage.getItem('comment'), localStorage.getItem('source')]);
const modifs = frame => frame.evaluate(() => window.__ctx.history().difference().summary().length);
const centre = frame => frame.evaluate(() => window.__ctx.map().center());
const pres = (c, lat, lon) => Math.abs(c[1] - lat) < 0.01 && Math.abs(c[0] - lon) < 0.01;

async function scenarios(browser) {
  // ---- A : onglet principal, puis tâches suivantes transmises ------------------------------------
  const context = await newContext(browser);
  const mr = await context.newPage();
  await mr.goto('https://maproulette.org/task?way=' + WAY);

  const principal = await ouvrir(context, mr, '#t1');
  const frame1 = await idFrame(principal);
  check('A1 la 1re tâche ouvre l’onglet principal (journal « onglet principal »)',
    await attendre(async () => aLog(context, principal.num, '[sb-osm] onglet principal'), 20000));
  check('A2 la carte est sur la zone de la 1re tâche (Paris)', pres(await centre(frame1), 48.8566, 2.3522));
  check('A2b le commentaire/la source de la 1re tâche sont dans les réglages d’iD',
    await attendre(async () => (await reglages(frame1)).join('|') === '#maproulette #defi-un|defi un', 10000), JSON.stringify(await reglages(frame1)));

  await frame1.evaluate(() => {
    window.__ctx.perform(iD.actionAddEntity(new iD.osmNode({ loc: [2.3522, 48.8566], tags: { amenity: 'bench' } })), 'test');
  });
  check('A3 une modification est en cours dans iD', await modifs(frame1) === 1);

  // 2e tâche : un onglet s'ouvre puis se ferme tout seul.
  const pagesAvant = context.pages().length;
  const nouvel = await ouvrir(context, mr, '#t2');
  check('A4 l’onglet de la 2e tâche se ferme seul (au plus 6 s)', await attendre(async () => nouvel.isClosed(), 6000));
  check('A4b context.pages().length revient à 2', context.pages().length === pagesAvant && pagesAvant === 2, 'pages=' + context.pages().length);
  check('A4c l’onglet a journalisé la transmission', aLog(context, nouvel.num, "commande transmise à l'onglet principal"));
  check('A5 l’onglet principal est resté ouvert', !principal.isClosed());
  check('A6 sa carte est allée sur la zone de la 2e tâche (Angers)',
    await attendre(async () => pres(await centre(frame1), 47.4784, -0.5632), 10000), JSON.stringify(await centre(frame1)));
  check('A7 la modification est conservée', await modifs(frame1) === 1);
  check('A8 commentaire et source fusionnés à deux',
    await attendre(async () => (await reglages(frame1)).join('|') === '#maproulette #defi-un #defi-deux|defi un;defi deux', 10000),
    JSON.stringify(await reglages(frame1)));

  // 3e tâche : avec un objet réel à sélectionner. L'API publique répond 429 si on la sollicite trop :
  // on attend une minute et on retente UNE fois.
  let sel = [];
  for (let essai = 1; essai <= 2 && !sel.includes('w' + WAY); essai++) {
    if (essai === 2) { console.log('  [info] sélection impossible (429 probable) : attente d’une minute, 2e essai'); await sleep(60000); }
    const t3 = await ouvrir(context, mr, '#t3');
    for (let i = 0; i < 60 && !sel.includes('w' + WAY); i++) { sel = await frame1.evaluate(() => window.__ctx.selectedIDs()); await sleep(500); }
    await attendre(async () => t3.isClosed(), 6000);
  }
  check('A9 l’objet de la 3e tâche est sélectionné dans le principal', sel.includes('w' + WAY), JSON.stringify(sel));
  check('A9b commentaire et source fusionnés à trois',
    await attendre(async () => (await reglages(frame1)).join('|') === '#maproulette #defi-un #defi-deux #defi-trois|defi un;defi deux;defi trois', 10000),
    JSON.stringify(await reglages(frame1)));
  check('A10 toujours deux pages (MapRoulette et le principal)', context.pages().length === 2, 'pages=' + context.pages().length);
  check('A11 la modification est toujours là', await modifs(frame1) === 1);

  // Après l'envoi (historique vidé), la tâche suivante REMPLACE.
  await frame1.evaluate(() => window.__ctx.history().reset());
  const t4 = await ouvrir(context, mr, '#t2');
  await attendre(async () => t4.isClosed(), 6000);
  check('A12 après vidage de l’historique, la tâche suivante remplace commentaire et source',
    await attendre(async () => (await reglages(frame1)).join('|') === '#maproulette #defi-deux|defi deux', 10000),
    JSON.stringify(await reglages(frame1)));

  // ---- B : l'utilisateur ferme le principal ----------------------------------------------------
  await principal.close();
  await sleep(1000); // le navigateur libère le verrou à la mort de l'onglet
  const second = await ouvrir(context, mr, '#t2');
  check('B1 après fermeture du principal, la tâche suivante devient le nouvel onglet principal',
    await attendre(async () => aLog(context, second.num, '[sb-osm] onglet principal'), 30000));
  await sleep(6000);
  check('B2 ce nouvel onglet reste ouvert', !second.isClosed());

  // ---- C : onglet iD ouvert à la main alors qu'un principal existe ------------------------------
  const manuel = await context.newPage();
  await manuel.goto('https://www.openstreetmap.org/edit?editor=id#map=18/47.4784/-0.5632');
  await idFrame(manuel);
  await sleep(6000);
  check('C1 l’onglet ouvert à la main reste ouvert', !manuel.isClosed());
  check('C2 il se déclare ordinaire', aLog(context, manuel.num, '[sb-osm] onglet ordinaire'));
  check('C3 il ne transmet rien', !aLog(context, manuel.num, 'commande transmise'));
  check('C4 le principal est resté ouvert', !second.isClosed());
  await context.close();

  // ---- D : sans Web Locks, comportement d'origine ----------------------------------------------
  const ctxD = await newContext(browser, { sansVerrous: true });
  const mrD = await ctxD.newPage();
  await mrD.goto('https://maproulette.org/task');
  const d1 = await ouvrir(ctxD, mrD, '#t1');
  await idFrame(d1);
  const d2 = await ouvrir(ctxD, mrD, '#t2');
  await idFrame(d2);
  await sleep(6000);
  check('D1 sans Web Locks, aucun onglet n’est fermé', !d1.isClosed() && !d2.isClosed());
  check('D2 sans Web Locks, trois pages restent ouvertes', ctxD.pages().length === 3, 'pages=' + ctxD.pages().length);
  check('D3 aucun onglet ne se déclare principal ni ne transmet',
    !ctxD.journal.some(j => j.text.includes('onglet principal') || j.text.includes('commande transmise')));
  await ctxD.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  await scenarios(browser);
  await browser.close();
  const ko = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - ko}/${results.length} vérifications passent`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR', e); process.exit(2); });
