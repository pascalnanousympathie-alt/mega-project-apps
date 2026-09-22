'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const i18n = require('../client/js/i18n.js');
const format = require('../client/js/format.js');
const views = require('../client/js/views.js');

const { createDataLayer } = require('../core');
const { buildApiHandlers } = require('../server/api');
const { createHttpServer } = require('../server/http');

const CLIENT_DIR = path.join(__dirname, '..', 'client');

test('i18n normalises and detects supported locales', () => {
  assert.equal(i18n.DEFAULT_LOCALE, 'fr');
  assert.deepEqual(i18n.LOCALES.slice().sort(), ['en', 'fr', 'mg']);
  assert.equal(i18n.normalizeLocale('FR-ca'), 'fr');
  assert.equal(i18n.normalizeLocale('en_US'), 'en');
  assert.equal(i18n.normalizeLocale('mg'), 'mg');
  assert.equal(i18n.normalizeLocale('de'), 'fr');
  assert.equal(i18n.normalizeLocale(null), 'fr');
  assert.equal(i18n.detectLocale({ languages: ['de', 'en-GB'], language: 'de' }), 'en');
  assert.equal(i18n.detectLocale({ language: 'mg-MG' }), 'mg');
  assert.equal(i18n.detectLocale({ acceptLanguage: 'fr,en;q=0.8' }), 'fr');
  assert.equal(i18n.detectLocale({ languages: ['zh', 'de'] }), 'fr');
});

test('i18n dictionaries stay in parity across locales', () => {
  const keys = Object.keys(i18n.DICT.fr);
  assert.ok(keys.length >= 60, 'expected a substantial UI dictionary');
  ['en', 'mg'].forEach((locale) => {
    const table = i18n.DICT[locale];
    keys.forEach((key) => {
      assert.ok(i18n.has(locale, key), locale + ' missing key: ' + key);
      assert.equal(typeof table[key], 'string');
      assert.ok(table[key].length > 0, locale + ' empty value for ' + key);
    });
    // no extra keys that fr does not know about
    Object.keys(table).forEach((key) => {
      assert.ok(Object.prototype.hasOwnProperty.call(i18n.DICT.fr, key), locale + ' unknown key: ' + key);
    });
  });
});

test('i18n translates with interpolation and safe fallback', () => {
  assert.equal(i18n.t('fr', 'home.greeting', { name: 'Ana' }), 'Bonjour, Ana');
  assert.equal(i18n.t('en', 'home.greeting', { name: 'Ana' }), 'Hello, Ana');
  assert.equal(i18n.t('mg', 'home.greeting', { name: 'Ana' }), 'Manao ahoana, Ana');
  // unknown locale falls back to the default dictionary
  assert.equal(i18n.t('xx', 'waiting.start'), 'Démarrer');
  // unknown key returns the key itself so leaks are obvious
  assert.equal(i18n.t('en', 'nope.missing.key'), 'nope.missing.key');
  // interpolation keeps the placeholder when a param is absent
  assert.equal(i18n.t('en', 'game.turn', {}), 'Turn: {who}');
});

test('money stays Ariary-consistent while grouping follows the locale', () => {
  assert.equal(format.formatMilli(1234567, { locale: 'fr' }), '1\u202f234\u202f567 Ar');
  assert.equal(format.formatMilli(1234567, { locale: 'mg' }), '1\u202f234\u202f567 Ar');
  assert.equal(format.formatMilli(1234567, { locale: 'en' }), '1,234,567 Ar');
  // default locale keeps the historical narrow-space grouping
  assert.equal(format.formatMilli(1234567), '1\u202f234\u202f567 Ar');
  assert.equal(format.formatMilli(-1234567, { locale: 'en' }), '\u22121,234,567 Ar');
  assert.equal(format.formatMilli(2500, { locale: 'en', sign: 'force' }), '+2,500 Ar');
  // every locale renders the same integer value and the same currency unit
  ['fr', 'mg', 'en'].forEach((locale) => {
    const digits = format.formatMilli(9876543, { locale }).replace(/[^\d]/g, '');
    assert.equal(digits, '9876543');
    assert.ok(format.formatMilli(9876543, { locale }).endsWith(' Ar'));
  });
  // grouped input parses back to the same amount regardless of separator
  assert.equal(format.parseMilliInput(format.formatMilli(42000, { locale: 'fr' })), 42000);
  assert.equal(format.parseMilliInput(format.formatMilli(42000, { locale: 'en' })), 42000);
});

test('views render each locale with translated labels and consistent money', () => {
  const home = (locale) =>
    views.renderHome({
      user: { username: 'ana' },
      wallet: { balance_milli: 2500 },
      games: [{ id: 'g1', kind: 'domino', name: 'D1', entry_fee_milli: 1234567 }],
      locale,
    });
  assert.ok(home('fr').includes('Bonjour, ana'));
  assert.ok(home('en').includes('Hello, ana'));
  assert.ok(home('mg').includes('Manao ahoana, ana'));
  // money is locale-grouped but always Ariary and always the same amount
  assert.ok(home('fr').includes('1\u202f234\u202f567 Ar'));
  assert.ok(home('en').includes('1,234,567 Ar'));
  // structural hooks are identical across locales
  ['fr', 'en', 'mg'].forEach((locale) => {
    const html = home(locale);
    assert.ok(html.includes('data-screen="home"'));
    assert.ok(html.includes('data-testid="balance"'));
    assert.ok(html.includes('#/lobby?game=g1'));
    assert.ok(html.includes('lang="' + locale + '"'));
    assert.ok(!html.includes('home.play'), 'raw key leaked for ' + locale);
  });
  // the play button label actually differs per locale
  assert.match(home('fr'), />Jouer<\/a>/);
  assert.match(home('en'), />Play<\/a>/);
  assert.match(home('mg'), />Hitapila<\/a>/);
});

test('lobby, wallet and profile screens translate status and buttons', () => {
  const lobby = (locale) =>
    views.renderLobby({
      rooms: [
        { id: 'r1', name: 'T1', players: 2, capacity: 2, status: 'waiting' },
        { id: 'r2', name: 'T2', players: 0, capacity: 4, status: 'open' },
      ],
      locale,
    });
  assert.ok(lobby('fr').includes('Complète'));
  assert.ok(lobby('en').includes('Full'));
  assert.ok(lobby('mg').includes('Feno'));
  assert.ok(lobby('en').includes('Rejoindre'.length ? '>Join</button>' : ''));
  assert.ok(lobby('fr').includes('en attente'));
  assert.ok(!lobby('en').includes('status.waiting'));

  const wallet = views.renderWallet({
    wallet: { currency: 'MGA', balance_milli: 1000 },
    entries: [{ id: 'e1', created_at: '2026-09-21T10:00:00Z', tx_type: 'deposit', direction: 'credit', amount_milli: 1234 }],
    locale: 'en',
  });
  assert.ok(wallet.includes('>Deposit</button>'));
  assert.ok(wallet.includes('+1,234 Ar'));
  assert.ok(wallet.includes('>Amount<'));

  const profile = views.renderProfile({ me: { user: { username: 'ana', role: 'player', status: 'active' }, wallet: { balance_milli: 0 } }, locale: 'en' });
  assert.ok(profile.includes('Sign out'));
  assert.ok(profile.includes('>Status<'));
  assert.ok(!profile.includes('profile.logout'));
});

test('game screens translate turn, status and phase consistently', () => {
  const base = {
    match_id: 'm1',
    status: 'active',
    current_user_id: 'u1',
    boneyard_count: 3,
    board: { center: { a: 6, b: 6 }, left: [{ a: 5, b: 6 }], right: [] },
    hands: { u1: [{ a: 6, b: 1 }] },
    players: [{ user_id: 'u1', seat: 1 }, { user_id: 'u2', seat: 2 }],
    winner_user_id: 'u1',
  };
  const dominoEn = views.renderGame({ snapshot: base, userId: 'u1', kind: 'domino', locale: 'en' });
  assert.ok(dominoEn.includes('Turn: u1'));
  assert.ok(dominoEn.includes('Draw (3)'));
  assert.ok(dominoEn.includes('Winner: u1'));
  const dominoMg = views.renderGame({ snapshot: base, userId: 'u1', kind: 'domino', locale: 'mg' });
  assert.ok(dominoMg.includes('An\u2019i : u1'.replace('\u2019', '\u2019')) || dominoMg.includes("An'i : u1"));
  assert.ok(!dominoMg.includes('game.turn'));

  const ramiEn = views.renderGame({
    snapshot: {
      match_id: 'm2', status: 'active', turn_phase: 'discard', current_user_id: 'u1',
      stock_count: 20, last_discard: { key: 'H-7' }, own_hand: ['H-7', 'S-12'],
    },
    userId: 'u1', kind: 'rami', locale: 'en',
  });
  assert.ok(ramiEn.includes('active · discard'));
  assert.ok(ramiEn.includes('>Meld<'));
  assert.ok(ramiEn.includes('>Discard<'));
});

test('status and phase helpers translate known values and pass through raw enums', () => {
  assert.equal(views.statusLabel('fr', 'waiting'), 'en attente');
  assert.equal(views.statusLabel('en', 'active'), 'active');
  assert.equal(views.statusLabel('mg', 'finished'), 'vita');
  assert.equal(views.statusLabel('fr', 'mystery_state'), 'mystery_state');
  assert.equal(views.statusLabel('en', null), '');
  assert.equal(views.phaseLabel('en', 'draw'), 'draw');
  assert.equal(views.phaseLabel('fr', 'discard'), 'défausse');
  assert.equal(views.phaseLabel('fr', 'unknown'), 'unknown');
});

test('dictionary text is typographic while dynamic data stays escaped', () => {
  i18n.LOCALES.forEach((locale) => {
    Object.keys(i18n.DICT[locale]).forEach((key) => {
      const value = i18n.DICT[locale][key];
      assert.ok(
        !/[&<>"']/.test(value),
        locale + '.' + key + ' must use typographic punctuation, not html-significant characters'
      );
    });
  });
  const screens = [];
  ['fr', 'mg', 'en'].forEach((locale) => {
    screens.push(
      views.renderHome({ user: { username: 'ana' }, wallet: { balance_milli: 1000 }, games: [], locale })
    );
    screens.push(views.renderLobby({ rooms: [], locale }));
    screens.push(
      views.renderWallet({ wallet: { currency: 'MGA', balance_milli: 1000 }, entries: [], locale })
    );
    screens.push(
      views.renderProfile({ me: { user: { username: 'ana' }, wallet: { balance_milli: 0 } }, locale })
    );
    screens.push(
      views.renderGame({
        snapshot: {
          match_id: 'm1',
          status: 'active',
          current_user_id: 'u1',
          boneyard_count: 1,
          board: { center: { a: 1, b: 1 }, left: [], right: [] },
          hands: { u1: [] },
          players: [{ user_id: 'u1', seat: 1 }],
        },
        userId: 'u1',
        kind: 'domino',
        locale,
      })
    );
    screens.push(
      views.renderWaiting({
        snapshot: { room: { id: 'r1', name: 'T1', status: 'waiting', capacity: 2 }, players: [] },
        userId: 'u1',
        locale,
      })
    );
  });
  screens.forEach((html) => {
    assert.ok(!html.includes('&#39;'), 'escaped apostrophe leaked into translated text');
    assert.ok(!html.includes('&quot;'), 'escaped quote leaked into translated text');
  });
  // user-controlled data must still be html-escaped in every locale
  const hostile = views.renderHome({
    user: { username: "O'Neill<svg>" },
    wallet: { balance_milli: 1000 },
    games: [],
    locale: 'mg',
  });
  assert.ok(hostile.includes('O&#39;Neil'), 'apostrophes in user data must stay escaped');
  assert.ok(!hostile.includes('<svg>'), 'markup in user data must never reach the dom');
});

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p16-'));
  const layer = createDataLayer({ dataDir: dir });
  const server = createHttpServer({ layer, api: buildApiHandlers(layer), clientDir: CLIENT_DIR });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      layer.close();
    } catch (_) {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base };
}

test('server ships the i18n bundle with the same security posture', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/js/i18n.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const body = await res.text();
  assert.ok(body.includes("'mg'"));
  assert.ok(body.includes("'English'"));
  const shell = await fetch(base + '/');
  const html = await shell.text();
  assert.ok(html.includes('./js/i18n.js'), 'shell must load the i18n bundle first');
  assert.ok(html.indexOf('./js/i18n.js') < html.indexOf('./js/format.js'), 'i18n must load before format');
});
