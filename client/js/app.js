(function (root) {
  'use strict';
  var ACEP = (root.ACEP = root.ACEP || {});
  if (typeof document === 'undefined') {
    ACEP.app = { browserOnly: true };
    return;
  }

  var store = ACEP.store.createSessionStore(root.sessionStorage);
  var session = store.load();
  var api = ACEP.api.createApiClient({
    getToken: function () {
      return session && session.token ? session.token : null;
    },
  });
  var views = ACEP.views;
  var router = ACEP.router;
  var esc = ACEP.format.escapeHtml;

  var LOCALE_KEY = 'acep.locale.v1';
  var locale = readLocale();

  function readLocale() {
    try {
      var saved = root.localStorage && root.localStorage.getItem(LOCALE_KEY);
      if (saved) return ACEP.i18n.normalizeLocale(saved);
    } catch (_) {
      // storage unavailable
    }
    return ACEP.i18n.detectLocale(root.navigator);
  }

  function tr(key, params) {
    return ACEP.i18n.t(locale, key, params);
  }

  function setLocale(code) {
    locale = ACEP.i18n.normalizeLocale(code);
    try {
      if (root.localStorage) root.localStorage.setItem(LOCALE_KEY, locale);
    } catch (_) {
      // storage unavailable: keep in memory
    }
    render();
  }

  var appEl = document.getElementById('app');
  var tabsEl = document.getElementById('tabs');

  var data = {
    me: null,
    error: null,
    notice: null,
    rooms: [],
    wallet: null,
    walletDetail: null,
    entries: [],
    cryptoWallets: [],
    cryptoCurrencies: [],
    snapshot: null,
    gameSnapshot: null,
    selectedTile: null,
    selectedSide: null,
    selectedCard: null,
    roomId: null,
  };

  var socket = null;
  var socketLoading = null;

  function setSession(next) {
    session = next;
    if (next && next.token) store.save(next);
    else store.clear();
  }

  function authed() {
    if (!session || !session.token) return false;
    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      setSession(null);
      return false;
    }
    return true;
  }

  function gamesById() {
    var out = {};
    ((data.me && data.me.games) || []).forEach(function (g) {
      out[g.id] = g;
    });
    return out;
  }

  function renderChrome(active) {
    tabsEl.hidden = !authed();
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    var links = tabsEl.querySelectorAll('a');
    for (var i = 0; i < links.length; i += 1) {
      var key = links[i].getAttribute('data-i18n');
      if (key) links[i].textContent = tr(key);
      links[i].className = links[i].getAttribute('href') === '#/' + active ? 'active' : '';
    }
    renderLangPicker();
  }

  function renderLangPicker() {
    var label = document.getElementById('lang-picker');
    if (!label) return;
    label.hidden = !authed();
    var html = '<span class="lang-label">' + esc(tr('lang.label')) + ':</span> ';
    html += '<select data-action="set-locale" aria-label="' + esc(tr('lang.label')) + '">';
    ACEP.i18n.LOCALES.forEach(function (code) {
      html +=
        '<option value="' + esc(code) + '"' + (code === locale ? ' selected' : '') + '>' +
        esc(ACEP.i18n.LOCALE_LABELS[code] || code) +
        '</option>';
    });
    html += '</select>';
    label.innerHTML = html;
  }

  function resolve(msg) {
    if (msg && typeof msg === 'object' && msg.i18n) return tr(msg.i18n, msg.params);
    if (msg && typeof msg === 'string' && ACEP.i18n.has(locale, msg)) return tr(msg);
    return msg;
  }

  function banner() {
    var html = '';
    var err = resolve(data.error);
    var note = resolve(data.notice);
    if (err) html += '<p class="error" role="alert">' + esc(err) + '</p>';
    if (note) html += '<p class="notice">' + esc(note) + '</p>';
    return html;
  }

  function mount(html) {
    appEl.innerHTML = banner() + html;
  }

  function go(hash) {
    if (root.location.hash === hash) render();
    else root.location.hash = hash;
  }

  function currentRoute() {
    return router.resolveRoute(root.location.hash, authed());
  }

  var RENDERERS = {
    login: function () {
      mount(views.renderLogin({ error: resolve(data.error), locale: locale }));
      data.error = null;
    },
    home: function () {
      mount(
        views.renderHome({
          user: (data.me && data.me.user) || (session && session.user) || {},
          wallet: data.me && data.me.wallet,
          games: (data.me && data.me.games) || [],
          locale: locale,
        })
      );
    },
    lobby: function () {
      mount(views.renderLobby({ games: (data.me && data.me.games) || [], rooms: data.rooms, locale: locale }));
    },
    wallet: function () {
      mount(
        views.renderWallet({
          wallet: data.wallet,
          balances: data.walletDetail && data.walletDetail.balances,
          entries: data.entries,
          cryptoWallets: data.cryptoWallets,
          cryptoCurrencies: data.cryptoCurrencies,
          locale: locale,
        })
      );
    },
    room: function () {
      var snapshot = data.snapshot;
      var roomStatus = snapshot && snapshot.room ? snapshot.room.status : null;
      if (roomStatus === 'active' && data.gameSnapshot) {
        var g = gamesById()[(snapshot.room && snapshot.room.game_id) || ''] || {};
        mount(views.renderGame({ snapshot: data.gameSnapshot, userId: userId(), kind: g.kind || 'domino', locale: locale }));
      } else {
        mount(views.renderWaiting({ snapshot: snapshot || { room: {}, players: [] }, userId: userId(), locale: locale }));
      }
    },
    game: function () {
      RENDERERS.room();
    },
    profile: function () {
      mount(views.renderProfile({ me: data.me || { user: (session && session.user) || {} }, locale: locale }));
    },
    not_found: function () {
      mount(views.renderNotFound({ locale: locale }));
    },
  };

  function userId() {
    return (data.me && data.me.user && data.me.user.id) || (session && session.user && session.user.id) || null;
  }

  function render() {
    var route = currentRoute();
    if (route.name === 'login' && authed()) return go('#/home');
    data.roomId = route.params.roomId || data.roomId;
    renderChrome(route.name);
    var view = RENDERERS[route.name] || RENDERERS.not_found;
    if (route.name !== 'login') data.error = null;
    view();
  }

  function refreshMe() {
    return api.me().then(function (me) {
      data.me = me;
      data.cryptoWallets = (me && me.crypto_wallets) || [];
      render();
      return me;
    }, function (err) {
      if (err.code === 'E_UNAUTHORIZED') setSession(null);
      data.error = err.message;
      render();
      return null;
    });
  }

  function loadRooms() {
    return api.listRooms().then(function (rooms) {
      data.rooms = rooms;
      render();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function loadCryptoCurrencies() {
    return api.cryptoCurrencies().then(function (result) {
      data.cryptoCurrencies = (result && result.currencies) || [];
      render();
      return data.cryptoCurrencies;
    }, function () {
      data.cryptoCurrencies = [];
      render();
      return [];
    });
  }

  function loadWallet() {
    if (!data.me || !data.me.wallet) {
      data.wallet = null;
      data.entries = [];
      data.walletDetail = null;
      render();
      return Promise.resolve();
    }
    data.wallet = data.me.wallet;
    return Promise.all([api.wallet(data.wallet.id), api.walletEntries(data.wallet.id, 25)]).then(function (res) {
      data.walletDetail = res[0];
      data.wallet = res[0].wallet;
      data.entries = res[1] || [];
      render();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function ensureSocket() {
    if (socket) return Promise.resolve(socket);
    if (socketLoading) return socketLoading;
    socketLoading = new Promise(function (resolve, reject) {
      if (typeof root.io === 'function') return resolve();
      var tag = document.createElement('script');
      tag.src = '/socket.io/socket.io.js';
      tag.onload = function () {
        resolve();
      };
      tag.onerror = function () {
        reject(new Error('socket.io client unavailable'));
      };
      document.head.appendChild(tag);
    })
      .then(function () {
        if (typeof root.io !== 'function') throw new Error('socket.io client unavailable');
        socket = root.io('/', { auth: { token: session.token } });
        bindSocket(socket);
        return socket;
      })
      .catch(function (err) {
        socketLoading = null;
        data.error = err.message;
        render();
        throw err;
      });
    return socketLoading;
  }

  function bindSocket(sock) {
    sock.on('room:state', function (snapshot) {
      data.snapshot = snapshot;
      render();
    });
    sock.on('room:joined', function (snapshot) {
      data.snapshot = snapshot;
      sendGame({ action: 'status' });
      render();
    });
    sock.on('room:started', function (snapshot) {
      data.snapshot = snapshot;
      sendGame({ action: 'status' });
      render();
    });
    sock.on('room:left', function () {
      data.snapshot = null;
      data.gameSnapshot = null;
    });
    sock.on('room:closed', function () {
      data.notice = { i18n: 'app.room_closed' };
      data.snapshot = null;
      data.gameSnapshot = null;
      go('#/lobby');
      loadRooms();
    });
    ['domino:state', 'domino:started', 'domino:finished', 'loto:state', 'loto:started', 'loto:ball', 'loto:finished',
      'loto:cancelled', 'loto:refunded', 'rami:state', 'rami:started', 'rami:finished', 'rami:cancelled'].forEach(function (evt) {
      sock.on(evt, function (payload) {
        data.gameSnapshot = payload;
        render();
      });
    });
    sock.on('error', function (err) {
      data.error = (err && err.message) || tr('app.realtime_error');
      render();
    });
  }

  function sendGame(payload) {
    if (socket && data.roomId) socket.emit('game:event', payload);
  }

  function enterRoom(roomId) {
    data.snapshot = null;
    data.gameSnapshot = null;
    data.roomId = roomId;
    go('#/room/' + encodeURIComponent(roomId));
    ensureSocket().then(function (sock) {
      sock.emit('room:join', { roomId: roomId });
      sendGame({ action: 'status' });
    }, function () {
      render();
    });
  }

  function formValues(form) {
    var out = {};
    var fields = form.querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].name) out[fields[i].name] = fields[i].value;
    }
    return out;
  }

  function handleLogin(form) {
    var values = formValues(form);
    api.login(values.identity, values.password).then(function (result) {
      setSession(result);
      data.error = null;
      return refreshMe();
    }, function (err) {
      data.error = err.code === 'E_INVALID_CREDENTIALS' ? { i18n: 'app.bad_credentials' } : err.message;
      render();
    });
  }

  function handleRegister(form) {
    var values = formValues(form);
    var body = { username: values.username, password: values.password };
    if (values.phone) body.phone = values.phone;
    if (values.email) body.email = values.email;
    api.register(body).then(function () {
      return api.login(values.username, values.password);
    }).then(function (result) {
      setSession(result);
      data.notice = { i18n: 'app.welcome' };
      return refreshMe();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleDeposit(form) {
    var values = formValues(form);
    var amount = ACEP.format.parseMilliInput(values.amount_milli);
    if (!amount || amount <= 0) {
      data.error = { i18n: 'app.invalid_amount' };
      render();
      return;
    }
    api.createDeposit({ provider: 'mvola', direction: 'payin', amount_milli: amount, currency: 'MGA' },
      'deposit-' + Date.now()).then(function (result) {
      data.notice = { i18n: 'app.deposit_request', params: { status: result.intent && result.intent.status } };
      render();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleCryptoWallet(form) {
    var values = formValues(form);
    var body = {
      provider: values.provider,
      asset: values.asset,
      network: values.network,
      address: values.address,
      address_memo: values.address_memo || undefined,
      label: values.label || undefined,
    };
    api.createCryptoWallet(body).then(function (result) {
      data.notice = { i18n: 'app.crypto_wallet_added', params: { asset: result.wallet && result.wallet.asset } };
      return refreshMe().then(loadWallet);
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleCreateRoom(form) {
    var values = formValues(form);
    var games = (data.me && data.me.games) || [];
    var gameId = new URLSearchParams(root.location.hash.split('?')[1] || '').get('game') || (games[0] && games[0].id);
    if (!gameId) {
      data.error = { i18n: 'app.no_game_for_room' };
      render();
      return;
    }
    api.createRoom({ game_id: gameId, name: values.name, capacity: parseInt(values.capacity, 10) || 2 }).then(
      function (result) {
        enterRoom(result.room.id);
      },
      function (err) {
        data.error = err.message;
        render();
      }
    );
  }

  function connectCryptoWallet(el) {
    var form = el && el.form;
    var set = function (name, value) {
      if (!form || value === undefined || value === null || value === '') return;
      var field = form.elements[name];
      if (field) field.value = String(value);
    };
    var ethereum = root.ethereum;
    if (ethereum && typeof ethereum.request === 'function') {
      ethereum.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
        var address = accounts && accounts[0];
        return ethereum.request({ method: 'eth_chainId' }).then(function (chainId) {
          var network = { '0x1': 'ethereum', '0x89': 'polygon', '0x38': 'bsc', '0xa4b1': 'arbitrum', '0xa': 'optimism', '0x2105': 'base' }[String(chainId).toLowerCase()];
          set('provider', 'other');
          set('address', address);
          if (network) set('network', network);
          data.notice = { i18n: 'app.crypto_wallet_connected' };
          render();
        });
      }).catch(function (err) {
        data.error = (err && err.message) || 'wallet connection failed';
        render();
      });
      return;
    }
    var tron = root.tronLink;
    if (tron && typeof tron.request === 'function') {
      tron.request({ method: 'tron_requestAccounts' }).then(function () {
        var address = root.tronWeb && root.tronWeb.defaultAddress && root.tronWeb.defaultAddress.base58;
        if (!address) throw new Error('TRON wallet address unavailable');
        set('provider', 'other');
        set('network', 'tron');
        set('address', address);
        data.notice = { i18n: 'app.crypto_wallet_connected' };
        render();
      }).catch(function (err) {
        data.error = (err && err.message) || 'wallet connection failed';
        render();
      });
      return;
    }
    var solana = root.solana;
    if (solana && typeof solana.connect === 'function') {
      solana.connect().then(function (result) {
        var address = result && result.publicKey ? String(result.publicKey) : '';
        if (!address) throw new Error('Solana wallet address unavailable');
        set('provider', 'other');
        set('network', 'solana');
        set('address', address);
        data.notice = { i18n: 'app.crypto_wallet_connected' };
        render();
      }).catch(function (err) {
        data.error = (err && err.message) || 'wallet connection failed';
        render();
      });
      return;
    }
    data.error = 'No compatible wallet provider found. Open LudoMada inside your wallet app or enter a public address manually.';
    render();
  }

  var ACTIONS = {
    'connect-wallet': function (el) {
      connectCryptoWallet(el);
    },
    'logout': function () {
      var done = function () {
        setSession(null);
        data.me = null;
        go('#/login');
      };
      api.logout().then(done, done);
    },
    'create-wallet': function () {
      api.createWallet('MGA').then(function (result) {
        data.notice = { i18n: 'app.wallet_opened', params: { currency: result.wallet.currency } };
        return refreshMe().then(loadWallet);
      }, function (err) {
        data.error = err.message;
        render();
      });
    },
    'join-room': function (el) {
      enterRoom(el.getAttribute('data-room-id'));
    },
    'disable-crypto-wallet': function (el) {
      var walletId = el.getAttribute('data-crypto-wallet-id');
      api.disableCryptoWallet(walletId).then(function () {
        data.notice = { i18n: 'app.crypto_wallet_disabled' };
        return refreshMe().then(loadWallet);
      }, function (err) {
        data.error = err.message;
        render();
      });
    },
    'ready': function () {
      if (socket) socket.emit('room:ready', { ready: true });
    },
    'unready': function () {
      if (socket) socket.emit('room:ready', { ready: false });
    },
    'leave-room': function () {
      if (socket) socket.emit('room:leave', {});
      data.snapshot = null;
      go('#/lobby');
      loadRooms();
    },
    'close-room': function () {
      if (socket) socket.emit('room:close', {});
    },
    'start-game': function () {
      var snapshot = data.snapshot;
      var roomStatus = snapshot && snapshot.room ? snapshot.room.status : null;
      if (roomStatus === 'waiting' && socket) {
        socket.emit('room:start', {});
        return;
      }
      sendGame({ action: 'start' });
    },
    'play-tile': function (el) {
      var parts = (el.getAttribute('data-tile') || '').split('-');
      var tile = { a: parseInt(parts[0], 10), b: parseInt(parts[1], 10) };
      var snapshot = data.gameSnapshot || {};
      var actions = views.gameActions(snapshot, userId());
      var match = actions.play.find(function (p) {
        return p.tile.a === tile.a && p.tile.b === tile.b;
      });
      if (!match || !match.sides.length) return;
      var side = data.selectedTile === el.getAttribute('data-tile') && data.selectedSide === 'left' ? 'right' : match.sides[0];
      if (data.selectedTile === el.getAttribute('data-tile')) data.selectedSide = side;
      else {
        data.selectedTile = el.getAttribute('data-tile');
        data.selectedSide = side;
      }
      sendGame({ action: 'play', tile: tile, side: side });
    },
    'draw-tile': function () {
      sendGame({ action: 'draw' });
    },
    'pass-turn': function () {
      sendGame({ action: 'pass' });
    },
    'draw-stock': function () {
      sendGame({ action: 'draw', source: 'stock' });
    },
    'draw-discard': function () {
      sendGame({ action: 'draw', source: 'discard' });
    },
    'select-card': function (el) {
      data.selectedCard = el.getAttribute('data-card');
      render();
    },
    'discard': function () {
      if (!data.selectedCard) return;
      sendGame({ action: 'discard', card: data.selectedCard });
      data.selectedCard = null;
    },
    'meld': function () {
      data.notice = { i18n: 'app.select_cards' };
      render();
    },
    'buy-ticket': function () {
      sendGame({ action: 'buy', grid: null });
    },
    'next-ball': function () {
      sendGame({ action: 'ball' });
    },
    'settle-draw': function () {
      sendGame({ action: 'settle' });
    },
    'refund-draw': function () {
      var snapshot = data.gameSnapshot || {};
      if (snapshot.draw_id) {
        api.refundLotoDraw(snapshot.draw_id).then(function () {
          sendGame({ action: 'status' });
        }, function (err) {
          data.error = err.message;
          render();
        });
      }
    },
  };

  document.addEventListener('submit', function (event) {
    var form = event.target.closest ? event.target.closest('[data-form]') : null;
    if (!form) return;
    event.preventDefault();
    var kind = form.getAttribute('data-form');
    if (kind === 'login') handleLogin(form);
    else if (kind === 'register') handleRegister(form);
    else if (kind === 'deposit') handleDeposit(form);
    else if (kind === 'crypto-wallet') handleCryptoWallet(form);
    else if (kind === 'create-room') handleCreateRoom(form);
  });

  document.addEventListener('click', function (event) {
    var el = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!el || el.tagName !== 'BUTTON') return;
    var action = el.getAttribute('data-action');
    if (ACTIONS[action]) {
      event.preventDefault();
      ACTIONS[action](el);
    }
  });

  document.addEventListener('change', function (event) {
    var el = event.target;
    if (el && el.getAttribute && el.getAttribute('data-action') === 'set-locale') {
      setLocale(el.value);
    }
  });

  root.addEventListener('hashchange', function () {
    var route = currentRoute();
    data.error = null;
    data.notice = null;
    if (!authed()) {
      render();
      return;
    }
    if (route.name === 'wallet') {
      refreshMe().then(function () { return Promise.all([loadWallet(), loadCryptoCurrencies()]); });
    } else if (route.name === 'lobby') {
      loadRooms();
    } else if (route.name === 'room' || route.name === 'game') {
      render();
      if (data.roomId) enterRoom(data.roomId);
    } else {
      refreshMe();
    }
  });

  function boot() {
    if (!authed()) {
      render();
      return;
    }
    refreshMe().then(function () {
      var route = currentRoute();
      if (route.name === 'wallet') Promise.all([loadWallet(), loadCryptoCurrencies()]);
      else if (route.name === 'lobby') loadRooms();
      else if (route.name === 'room' || route.name === 'game') enterRoom(data.roomId);
    });
  }

  ACEP.app = {
    boot: boot,
    api: api,
    actions: ACTIONS,
    render: render,
    enterRoom: enterRoom,
    setLocale: setLocale,
    locale: function () {
      return locale;
    },
  };

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
