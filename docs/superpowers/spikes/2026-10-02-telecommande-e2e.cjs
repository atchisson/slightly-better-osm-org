// Test de bout en bout jetable : MapRoulette (page de remplacement + vrai plugin) -> iD (vrai iD 2.42.2
// servi sous l'origine openstreetmap.org + vrai plugin cadastre-id).
const { chromium } = require('playwright-core');
const fs = require('fs');

const MR_PLUGIN = fs.readFileSync(require('path').join(__dirname, '../../../../maproulette-no-fallback/maproulette-no-map-fallback.user.js'), 'utf8');
const SB_PLUGIN = fs.readFileSync(require('path').join(__dirname, '../../../dist/slightly-better-osm-org.user.js'), 'utf8');
const CDN = 'https://cdn.jsdelivr.net/npm/@openstreetmap/id@2.42.2/dist/';

const MR_PAGE = `<!doctype html><meta charset=utf-8><title>MR stub</title>
<button id=t1>task1</button><button id=t2>task2</button><button id=t3>task3</button>
<script>
// Reproduit Editor.js de MapRoulette : ferme l'éditeur précédent puis window.open.
let editorWindowReference = null;
const TASKS = {
  t1: { z: 19, lat: 48.8566, lon: 2.3522, comment: '#maproulette #defi-un', source: 'defi un', id: '' },
  t2: { z: 18, lat: 47.4784, lon: -0.5632, comment: '#maproulette #defi-deux', source: 'defi deux', id: '' },
  t3: { z: 18, lat: 47.4784, lon: -0.5632, comment: '#maproulette #defi-trois', source: 'defi trois', id: window.__WAY || '' },
};
for (const k of Object.keys(TASKS)) document.getElementById(k).onclick = () => {
  const t = TASKS[k];
  if (editorWindowReference && !editorWindowReference.closed) editorWindowReference.close();
  editorWindowReference = window.open('https://www.openstreetmap.org/edit?editor=id#map=' + [t.z, t.lat, t.lon].join('/') +
    '&comment=' + encodeURIComponent(t.comment) + '&source=' + encodeURIComponent(t.source) + (t.id ? '&id=' + t.id : ''));
  window.__lastOpen = editorWindowReference;
};
</script>`;

const EDIT_PAGE = `<!doctype html><meta charset=utf-8><title>osm edit stub</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe src="/id"></iframe>
<script>document.querySelector('iframe').src = '/id' + location.hash;</script>`;

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

async function newContext(browser, { withIdPlugin, way }) {
  const context = await browser.newContext();
  await context.addInitScript(({ mr, sb, withIdPlugin, way }) => {
    if (location.origin === 'https://maproulette.org') {
      window.__WAY = way;
      // Un gestionnaire de scripts lance « document-start » une fois l'élément racine créé ;
      // Playwright, lui, passe avant. On attend donc la racine, comme le ferait le gestionnaire.
      const lancer = () => window.eval(`(function(GM_getValue,GM_setValue,GM_registerMenuCommand,unsafeWindow){${mr}\n})(function(k,d){return d},function(){},function(){},window)`);
      if (document.documentElement) lancer();
      else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); lancer(); } }).observe(document, { childList: true });
    } else if (withIdPlugin && location.origin === 'https://www.openstreetmap.org') {
      window.eval(sb);
    }
  }, { mr: MR_PLUGIN, sb: SB_PLUGIN, withIdPlugin, way });
  await context.route('https://maproulette.org/**', r => r.fulfill({ contentType: 'text/html', body: MR_PAGE }));
  await context.route('https://www.openstreetmap.org/edit**', r => r.fulfill({ contentType: 'text/html', body: EDIT_PAGE }));
  await context.route('https://www.openstreetmap.org/id**', r => r.fulfill({ contentType: 'text/html', body: ID_PAGE }));
  return context;
}

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

(async () => {
  // Un identifiant de voie réel (un bâtiment) près d'Angers, lu sur l'API publique.
  const bbox = '-0.5640,47.4778,-0.5626,47.4790';
  const way = '42734284'; // voie réelle près d'Angers (relevée à la main : l'API limite le débit)
  console.log('way de test:', way);

  const browser = await chromium.launch({ headless: true });

  // ---- Scénario A : les deux plugins sont là -------------------------------------
  {
    const context = await newContext(browser, { withIdPlugin: true, way: 'w' + way });
    const mr = await context.newPage();
    const logs = [];
    mr.on('console', m => logs.push(m.text()));
    await mr.goto('https://maproulette.org/task');

    const [popup1] = await Promise.all([context.waitForEvent('page'), mr.click('#t1')]);
    const frame1 = await idFrame(popup1);
    for (let i = 0; i < 40 && !logs.some(l => l.includes('iD window is ready')); i++) await sleep(250);
    check('A1 le plugin iD annonce « prêt » à la page MapRoulette', logs.some(l => l.includes('iD window is ready')));

    const centre1 = await frame1.evaluate(() => window.__ctx.map().center());
    check('A2 la 1re tâche centre iD sur sa zone (Paris)', Math.abs(centre1[1] - 48.8566) < 0.01 && Math.abs(centre1[0] - 2.3522) < 0.01, JSON.stringify(centre1));

    // une modification dans iD
    await frame1.evaluate(() => {
      const n = new iD.osmNode({ loc: [2.3522, 48.8566], tags: { amenity: 'bench' } });
      window.__ctx.perform(iD.actionAddEntity(n), 'test');
    });
    const nbAvant = await frame1.evaluate(() => window.__ctx.history().difference().summary().length);
    check('A3 une modification est en cours dans iD', nbAvant === 1, 'summary=' + nbAvant);

    // 2e tâche : ne doit ni fermer ni rouvrir d'onglet
    const pagesAvant = context.pages().length;
    await mr.click('#t2');
    await sleep(3000);
    check('A4 pas de nouvel onglet à la 2e tâche', context.pages().length === pagesAvant, 'pages=' + context.pages().length);
    check('A5 l’onglet iD n’a pas été fermé', !popup1.isClosed());
    const centre2 = await frame1.evaluate(() => window.__ctx.map().center());
    check('A6 la carte est allée sur la 2e zone (Angers)', Math.abs(centre2[1] - 47.4784) < 0.01 && Math.abs(centre2[0] + 0.5632) < 0.01, JSON.stringify(centre2));
    const nbApres = await frame1.evaluate(() => window.__ctx.history().difference().summary().length);
    check('A7 la modification de la 1re tâche est conservée', nbApres === 1, 'summary=' + nbApres);
    const comment = await frame1.evaluate(() => localStorage.getItem('comment'));
    check('A8 le commentaire de changeset est celui de la 2e tâche', comment === '#maproulette #defi-deux', JSON.stringify(comment));

    // 3e tâche : avec un objet à sélectionner
    await mr.click('#t3');
    let sel = [];
    for (let i = 0; i < 60; i++) {
      sel = await frame1.evaluate(() => window.__ctx.selectedIDs());
      if (sel.length) break;
      await sleep(500);
    }
    check('A9 l’objet de la 3e tâche est sélectionné', sel.includes('w' + way), JSON.stringify(sel));
    check('A10 toujours un seul onglet iD', context.pages().length === pagesAvant);
    const nbFin = await frame1.evaluate(() => window.__ctx.history().difference().summary().length);
    check('A11 la modification est toujours là après 3 tâches', nbFin === 1);

    // L'utilisateur ferme l'onglet iD : la tâche suivante doit en ouvrir un nouveau.
    await popup1.close();
    await sleep(500);
    console.log('  [debug] mr.url =', mr.url(), 'closed =', mr.isClosed(), 'pages =', context.pages().map(p => p.url()));
    const [popup2] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }).catch(() => null), mr.click('#t2')]);
    check('A12 après fermeture manuelle, la tâche suivante rouvre un onglet', !!popup2);
    await context.close();
  }

  // ---- Scénario B : le plugin iD est absent -> comportement d'origine --------------
  {
    const context = await newContext(browser, { withIdPlugin: false, way: '' });
    const mr = await context.newPage();
    await mr.goto('https://maproulette.org/task');
    const [popup1] = await Promise.all([context.waitForEvent('page'), mr.click('#t1')]);
    await popup1.waitForLoadState('domcontentloaded');
    await sleep(1500);
    const [popup2] = await Promise.all([context.waitForEvent('page'), mr.click('#t2')]);
    await sleep(500);
    check('B1 sans plugin iD, l’ancien onglet est fermé (comportement d’origine)', popup1.isClosed());
    check('B2 sans plugin iD, un nouvel onglet est ouvert', !!popup2 && !popup2.isClosed());
    await context.close();
  }

  await browser.close();
  const ko = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - ko}/${results.length} vérifications passent`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR', e); process.exit(2); });
