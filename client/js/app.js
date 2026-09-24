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
    cryptoBalances: [],
    cryptoWithdrawals: [],
    cryptoDeposit: null,
    cryptoEconomy: null,
    cryptoConversions: [],
    communityGroups: [],
    chatGroup: 'ludomada',
    chatMessages: [],
    supportTickets: [],
    supportTicket: null,
    supportMessages: [],
    gameSettings: { mode: 'mga', stakeUsdCents: 0, asset: 'USDT', network: 'tron' },
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
          cryptoBalances: data.cryptoBalances,
          cryptoWithdrawals: data.cryptoWithdrawals,
          cryptoDeposit: data.cryptoDeposit,
          cryptoEconomy: data.cryptoEconomy,
          cryptoConversions: data.cryptoConversions,
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
        var wg = gamesById()[(snapshot && snapshot.room && snapshot.room.game_id) || ''] || {};
        mount(views.renderWaiting({ snapshot: snapshot || { room: {}, players: [] }, userId: userId(), kind: wg.kind || 'domino', gameSettings: data.gameSettings, locale: locale }));
      }
    },
    game: function () {
      RENDERERS.room();
    },
    community: function () {
      mount(views.renderCommunity({
        user: (data.me && data.me.user) || {},
        groups: data.communityGroups,
        chatGroup: data.chatGroup,
        chatMessages: data.chatMessages,
        supportTickets: data.supportTickets,
        supportTicket: data.supportTicket,
        supportMessages: data.supportMessages,
        locale: locale,
      }));
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

  function loadCryptoState() {
    return Promise.all([api.cryptoBalances(), api.cryptoWithdrawals(50), api.cryptoEconomy(), api.cryptoConversions(50)]).then(function (res) {
      data.cryptoBalances = res[0] || [];
      data.cryptoWithdrawals = res[1] || [];
      data.cryptoEconomy = res[2] || null;
      data.cryptoConversions = res[3] || [];
      render();
      return data.cryptoBalances;
    }, function (err) {
      data.error = err.message;
      render();
      return [];
    });
  }

  function loadCommunity() {
    return Promise.all([api.chatGroups(), api.supportTickets()]).then(function (res) {
      data.communityGroups = res[0] || [];
      data.supportTickets = res[1] || [];
      if (!data.chatGroup || !data.communityGroups.some(function (g) { return g.group_key === data.chatGroup; })) {
        data.chatGroup = (data.communityGroups[0] && data.communityGroups[0].group_key) || 'ludomada';
      }
      return api.chatMessages(data.chatGroup, 80).then(function (messages) {
        data.chatMessages = messages || [];
        render();
        return ensureSocket().then(function (sock) {
          sock.emit('chat:join', { group: data.chatGroup });
          if (data.supportTicket) sock.emit('support:join', { ticketId: data.supportTicket.id });
        }, function () {});
      });
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function openChatGroup(groupKey) {
    data.chatGroup = String(groupKey || '').toLowerCase();
    data.chatMessages = [];
    render();
    api.chatMessages(data.chatGroup, 80).then(function (messages) {
      data.chatMessages = messages || [];
      render();
    }, function (err) {
      data.error = err.message;
      render();
    });
    if (socket) socket.emit('chat:join', { group: data.chatGroup });
    else ensureSocket().then(function (sock) { sock.emit('chat:join', { group: data.chatGroup }); }, function () {});
  }

  function openSupportTicket(ticketId) {
    return api.supportTicket(ticketId).then(function (result) {
      data.supportTicket = result.ticket;
      data.supportMessages = result.messages || [];
      render();
      return ensureSocket().then(function (sock) {
        sock.emit('support:join', { ticketId: ticketId });
      }, function () {});
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function loadWallet() {
    data.wallet = data.me && data.me.wallet ? data.me.wallet : null;
    if (!data.wallet) {
      data.entries = [];
      data.walletDetail = null;
      return loadCryptoState();
    }
    return Promise.all([api.wallet(data.wallet.id), api.walletEntries(data.wallet.id, 25), loadCryptoState()]).then(function (res) {
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
      render();
    });
    sock.on('room:started', function (snapshot) {
      data.snapshot = snapshot;
      sendGame({ action: 'status', settings: gameSettingsPayload() });
      render();
    });
    sock.on('room:left', function () {
      data.snapshot = null;
      data.gameSnapshot = null;
    });
    sock.on('chat:joined', function (payload) {
      data.chatMessages = (payload && payload.messages) || [];
      if (payload && payload.group && payload.group.group_key) data.chatGroup = payload.group.group_key;
      render();
    });
    sock.on('chat:message', function (message) {
      if (!message || message.group_key !== data.chatGroup) return;
      var exists = data.chatMessages.some(function (m) { return m.id === message.id; });
      if (!exists) data.chatMessages = data.chatMessages.concat([message]);
      render();
    });
    sock.on('support:joined', function (payload) {
      data.supportTicket = payload && payload.ticket ? payload.ticket : null;
      data.supportMessages = (payload && payload.messages) || [];
      render();
    });
    sock.on('support:message', function (message) {
      if (!message || !data.supportTicket || message.ticket_id !== data.supportTicket.id) return;
      var exists = data.supportMessages.some(function (m) { return m.id === message.id; });
      if (!exists) data.supportMessages = data.supportMessages.concat([message]);
      render();
    });
    sock.on('support:updated', function (payload) {
      if (!payload || !payload.ticket) return;
      if (data.supportTicket && payload.ticket.id === data.supportTicket.id) data.supportTicket = payload.ticket;
      data.supportTickets = data.supportTickets.map(function (t) { return t.id === payload.ticket.id ? payload.ticket : t; });
      render();
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

  function gameSettingsPayload() {
    var s = data.gameSettings || {};
    if (s.mode !== 'crypto') return { mode: 'mga', entryFee: Number(s.entryFeeMilli || 1000) };
    return { mode: 'crypto', stakeUsdCents: Number(s.stakeUsdCents), asset: s.asset || 'USDT', network: s.network || 'tron' };
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
      return refreshMe().then(function () { return Promise.all([loadWallet(), loadCryptoCurrencies()]); });
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleCryptoDeposit(form) {
    var values = formValues(form);
    var amount = ACEP.format.parseMilliInput(values.amount_milli);
    if (!amount || amount <= 0 || !values.pay_currency) {
      data.error = { i18n: 'app.invalid_crypto_deposit' };
      render();
      return;
    }
    api.createDeposit({
      provider: 'nowpayments',
      direction: 'payin',
      amount_milli: amount,
      currency: 'USD',
      pay_currency: values.pay_currency,
      reference: 'crypto-deposit-' + Date.now(),
      description: 'LudoMada crypto deposit',
    }, 'crypto-deposit-' + Date.now()).then(function (result) {
      data.cryptoDeposit = result;
      data.notice = { i18n: 'app.crypto_deposit_created' };
      return loadCryptoState();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleCryptoWithdrawal(form) {
    var values = formValues(form);
    var amount = String(values.amount || '').trim();
    if (!amount || !values.crypto_wallet_id) {
      data.error = { i18n: 'app.invalid_crypto_withdrawal' };
      render();
      return;
    }
    var walletSelect = form.elements.crypto_wallet_id;
    var selected = walletSelect && walletSelect.options[walletSelect.selectedIndex];
    var payoutCurrency = (selected && selected.getAttribute('data-payout-currency')) || values.payout_currency;
    if (!payoutCurrency) {
      data.error = { i18n: 'app.invalid_crypto_withdrawal' };
      render();
      return;
    }
    api.createCryptoWithdrawal({
      provider: 'nowpayments',
      crypto_wallet_id: values.crypto_wallet_id,
      amount: amount,
      payout_currency: payoutCurrency,
    }, 'crypto-withdraw-' + Date.now()).then(function (result) {
      data.notice = { i18n: 'app.crypto_withdrawal_2fa' };
      return loadCryptoState();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleCryptoWithdrawalVerify(form) {
    var values = formValues(form);
    if (!values.withdrawal_id || !values.verification_code) return;
    api.verifyCryptoWithdrawal(values.withdrawal_id, values.verification_code, 'crypto-verify-' + values.withdrawal_id).then(function () {
      data.notice = { i18n: 'app.crypto_withdrawal_verified' };
      return loadCryptoState();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function handleCryptoConversion(form) {
    var values = formValues(form);
    var direction = values.direction;
    var asset = String(values.asset || 'USDT').trim().toUpperCase();
    var network = String(values.network || 'tron').trim().toLowerCase();
    var raw = String(values.amount || '').trim();
    if (!raw || !direction || !asset || !network) {
      data.error = { i18n: 'app.invalid_crypto_conversion' };
      render();
      return;
    }
    var body = { direction: direction, asset: asset, network: network };
    if (direction === 'crypto_to_mga') body.amount_crypto = raw;
    else body.amount_mga_milli = ACEP.format.parseMilliInput(raw);
    if (!body.amount_mga_milli && direction === 'mga_to_crypto') {
      data.error = { i18n: 'app.invalid_crypto_conversion' };
      render();
      return;
    }
    api.createCryptoConversion(body, 'crypto-convert-' + Date.now() + '-' + Math.random().toString(16).slice(2)).then(function (result) {
      data.notice = { i18n: 'app.crypto_conversion_done' };
      return loadWallet();
    }, function (err) {
      data.error = err.message;
      render();
    });
  }

  function applyGameEconomyForm(form) {
    var values = formValues(form);
    var mode = values.mode || 'mga';
    var cents = parseInt(values.stake_usd_cents || '10', 10);
    data.gameSettings = {
      mode: mode === 'crypto' ? 'crypto' : 'mga',
      entryFeeMilli: parseInt(values.entry_fee_milli || '1000', 10),
      stakeUsdCents: cents,
      asset: String(values.asset || 'USDT').toUpperCase(),
      network: String(values.network || 'tron').toLowerCase(),
    };
    if (data.gameSettings.mode !== 'crypto') data.gameSettings.stakeUsdCents = 0;
    data.notice = { i18n: 'app.game_economy_saved' };
    render();
  }

  function handleChatMessage(form) {
    var values = formValues(form);
    var body = String(values.body || '').trim();
    var group = String(values.group_key || data.chatGroup || '').toLowerCase();
    if (!body || !group) return;
    var key = api.makeIdempotencyKey ? api.makeIdempotencyKey() : ('chat-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    if (socket) socket.emit('chat:send', { group: group, body: body, client_ref: key });
    else api.sendChatMessage(group, body, key).then(function (result) {
      if (result && result.message) data.chatMessages = data.chatMessages.concat([result.message]);
      render();
    }, function (err) { data.error = err.message; render(); });
    form.elements.body.value = '';
  }

  function handleSupportCreate(form) {
    var values = formValues(form);
    var subject = String(values.subject || '').trim();
    var body = String(values.body || '').trim();
    if (!subject || !body) return;
    api.createSupportTicket(subject, body).then(function (result) {
      data.supportTicket = result.ticket;
      data.supportMessages = result.messages || [];
      data.notice = { i18n: 'app.support_ticket_created' };
      return loadCommunity();
    }, function (err) { data.error = err.message; render(); });
  }

  function handleSupportReply(form) {
    var values = formValues(form);
    var ticketId = values.ticket_id || (data.supportTicket && data.supportTicket.id);
    var body = String(values.body || '').trim();
    if (!ticketId || !body) return;
    var key = api.makeIdempotencyKey ? api.makeIdempotencyKey() : ('support-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    if (socket) socket.emit('support:message', { ticketId: ticketId, body: body, client_ref: key });
    else api.sendSupportMessage(ticketId, body, key).then(function (result) {
      if (result && result.message) data.supportMessages = data.supportMessages.concat([result.message]);
      return api.supportTicket(ticketId);
    }).then(function (result) {
      if (result) data.supportTicket = result.ticket;
      render();
    }, function (err) { data.error = err.message; render(); });
    form.elements.body.value = '';
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
    'open-chat-group': function (el) {
      openChatGroup(el.getAttribute('data-group-key'));
    },
    'open-support-ticket': function (el) {
      openSupportTicket(el.getAttribute('data-ticket-id'));
    },
    'resolve-ticket': function (el) {
      api.setSupportStatus(el.getAttribute('data-ticket-id'), 'resolved').then(function (result) {
        data.supportTicket = result.ticket;
        return loadCommunity();
      }, function (err) { data.error = err.message; render(); });
    },
    'close-ticket': function (el) {
      api.setSupportStatus(el.getAttribute('data-ticket-id'), 'closed').then(function (result) {
        data.supportTicket = result.ticket;
        return loadCommunity();
      }, function (err) { data.error = err.message; render(); });
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
    'sync-crypto-withdrawal': function (el) {
      var withdrawalId = el.getAttribute('data-withdrawal-id');
      api.syncCryptoWithdrawal(withdrawalId).then(function () {
        data.notice = { i18n: 'app.crypto_withdrawal_synced' };
        return loadCryptoState();
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
    else if (kind === 'crypto-deposit') handleCryptoDeposit(form);
    else if (kind === 'crypto-withdraw') handleCryptoWithdrawal(form);
    else if (kind === 'crypto-withdraw-verify') handleCryptoWithdrawalVerify(form);
    else if (kind === 'crypto-conversion') handleCryptoConversion(form);
    else if (kind === 'game-economy') applyGameEconomyForm(form);
    else if (kind === 'create-room') handleCreateRoom(form);
    else if (kind === 'chat-message') handleChatMessage(form);
    else if (kind === 'support-create') handleSupportCreate(form);
    else if (kind === 'support-reply') handleSupportReply(form);
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
    } else if (route.name === 'community') {
      loadCommunity();
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
      else if (route.name === 'community') loadCommunity();
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
