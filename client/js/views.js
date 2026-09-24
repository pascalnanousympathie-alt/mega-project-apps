(function (root, factory) {
  'use strict';
  var factoryRequire = typeof require === 'function' ? require : null;
  var format = typeof module !== 'undefined' && factoryRequire ? factoryRequire('./format.js') : root.ACEP.format;
  var i18n = typeof module !== 'undefined' && factoryRequire ? factoryRequire('./i18n.js') : root.ACEP.i18n;
  var mod = factory(format, i18n);
  root.ACEP = root.ACEP || {};
  root.ACEP.views = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (format, i18n) {
  'use strict';

  var esc = format.escapeHtml;

  function loc(state) {
    return i18n.normalizeLocale((state && state.locale) || (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || i18n.DEFAULT_LOCALE);
  }

  function tr(l, key, params) {
    return i18n.t(l, key, params);
  }

  function money(l, milli, opts) {
    var options = opts || {};
    var merged = {};
    var k;
    for (k in options) {
      if (Object.prototype.hasOwnProperty.call(options, k)) merged[k] = options[k];
    }
    merged.locale = l;
    return format.formatMilli(milli, merged);
  }

  function statusLabel(l, value) {
    if (value === null || value === undefined || value === '') return '';
    var key = 'status.' + value;
    return i18n.has(l, key) ? i18n.t(l, key) : String(value);
  }

  function phaseLabel(l, value) {
    if (value === null || value === undefined || value === '') return '';
    var key = 'phase.' + value;
    return i18n.has(l, key) ? i18n.t(l, key) : String(value);
  }

  function renderLogin(state) {
    var s = state || {};
    var l = loc(s);
    var error = s.error ? '<p class="error" role="alert">' + esc(s.error) + '</p>' : '';
    return (
      '<section class="screen login" data-screen="login" lang="' + esc(l) + '">' +
      '<h1>LudoMada</h1>' +
      error +
      '<form data-form="login">' +
      '<label>' + esc(tr(l, 'login.identity')) + ' <input name="identity" autocomplete="username" required></label>' +
      '<label>' + esc(tr(l, 'login.password')) + ' <input name="password" type="password" autocomplete="current-password" required minlength="8"></label>' +
      '<button type="submit" data-action="login">' + esc(tr(l, 'login.submit')) + '</button>' +
      '</form>' +
      '<form data-form="register">' +
      '<h2>' + esc(tr(l, 'login.register_title')) + '</h2>' +
      '<label>' + esc(tr(l, 'login.username')) + ' <input name="username" required pattern="[A-Za-z0-9_.]{3,32}"></label>' +
      '<label>' + esc(tr(l, 'login.password')) + ' <input name="password" type="password" required minlength="8"></label>' +
      '<label>' + esc(tr(l, 'login.phone')) + ' <input name="phone" inputmode="tel"></label>' +
      '<label>' + esc(tr(l, 'login.email')) + ' <input name="email" type="email"></label>' +
      '<button type="submit" data-action="register">' + esc(tr(l, 'login.register')) + '</button>' +
      '</form>' +
      '</section>'
    );
  }

  function renderHome(state) {
    var s = state || {};
    var l = loc(s);
    var user = s.user || {};
    var games = s.games || [];
    var balance = s.wallet ? money(l, s.wallet.balance_milli) : '\u2014';
    var cards = games.map(function (game) {
      return (
        '<article class="game-card" data-game-id="' + esc(game.id) + '">' +
        '<h3>' + esc(game.name || game.kind) + '</h3>' +
        '<p class="kind">' + esc(game.kind) + '</p>' +
        '<p class="fee">' + esc(money(l, game.entry_fee_milli || 0)) + '</p>' +
        '<a class="btn" href="#/lobby?game=' + esc(game.id) + '">' + esc(tr(l, 'home.play')) + '</a>' +
        '</article>'
      );
    }).join('');
    return (
      '<section class="screen home" data-screen="home" lang="' + esc(l) + '">' +
      '<header><h2>' + esc(tr(l, 'home.greeting', { name: user.display_name || user.username || tr(l, 'home.default_user') })) + '</h2>' +
      '<p class="balance" data-testid="balance">' + esc(balance) + '</p></header>' +
      '<nav class="quick"><a href="#/lobby">' + esc(tr(l, 'nav.lobby')) + '</a><a href="#/wallet">' + esc(tr(l, 'nav.wallet')) + '</a><a href="#/profile">' + esc(tr(l, 'nav.profile')) + '</a></nav>' +
      '<div class="games" data-testid="games">' + (cards || '<p>' + esc(tr(l, 'home.no_games')) + '</p>') + '</div>' +
      '</section>'
    );
  }

  function renderLobby(state) {
    var s = state || {};
    var l = loc(s);
    var rooms = s.rooms || [];
    var rows = rooms.map(function (room) {
      var full = (room.players || 0) >= (room.capacity || 0);
      return (
        '<li class="room" data-room-id="' + esc(room.id) + '">' +
        '<span class="name">' + esc(room.name) + '</span>' +
        '<span class="players">' + esc(room.players || 0) + '/' + esc(room.capacity || 0) + '</span>' +
        '<span class="status">' + esc(statusLabel(l, room.status)) + '</span>' +
        (full
          ? '<span class="full">' + esc(tr(l, 'lobby.full')) + '</span>'
          : '<button data-action="join-room" data-room-id="' + esc(room.id) + '">' + esc(tr(l, 'lobby.join')) + '</button>') +
        '</li>'
      );
    }).join('');
    return (
      '<section class="screen lobby" data-screen="lobby" lang="' + esc(l) + '">' +
      '<h2>' + esc(tr(l, 'lobby.title')) + '</h2>' +
      '<form data-form="create-room">' +
      '<label>' + esc(tr(l, 'lobby.room_name')) + ' <input name="name" required maxlength="60"></label>' +
      '<label>' + esc(tr(l, 'lobby.capacity')) + ' <input name="capacity" type="number" min="1" max="30" value="2"></label>' +
      '<button type="submit" data-action="create-room">' + esc(tr(l, 'lobby.create')) + '</button>' +
      '</form>' +
      '<ul class="rooms" data-testid="rooms">' + (rows || '<li class="empty">' + esc(tr(l, 'lobby.empty')) + '</li>') + '</ul>' +
      '</section>'
    );
  }

  function renderCryptoWallets(l, wallets, currencies, balances, withdrawals, deposit, cryptoEconomy, conversions) {
    var rows = (wallets || []).map(function (wallet) {
      var shortAddress = wallet.address.length > 18 ? wallet.address.slice(0, 10) + '…' + wallet.address.slice(-8) : wallet.address;
      return '<li class="crypto-wallet" data-crypto-wallet-id="' + esc(wallet.id) + '">' +
        '<strong>' + esc(wallet.asset) + '/' + esc(wallet.network) + '</strong> · ' +
        '<code title="' + esc(wallet.address) + '">' + esc(shortAddress) + '</code> · ' +
        esc(wallet.provider) +
        (wallet.label ? '<small> · ' + esc(wallet.label) + '</small>' : '') +
        '<button type="button" data-action="disable-crypto-wallet" data-crypto-wallet-id="' + esc(wallet.id) + '">' +
        esc(tr(l, 'crypto.disable')) + '</button></li>';
    }).join('');
    var balanceRows = (balances || []).map(function (b) {
      return '<li><strong>' + esc(b.asset) + '/' + esc(b.network) + '</strong> · ' +
        esc(tr(l, 'crypto.available')) + ': ' + esc(b.available_amount) +
        ' · ' + esc(tr(l, 'crypto.reserved')) + ': ' + esc(b.reserved_amount) + '</li>';
    }).join('');
    var known = {
      'BTC/bitcoin': 'btc', 'ETH/ethereum': 'eth', 'USDT/tron': 'usdttrc20',
      'USDT/ethereum': 'usdterc20', 'USDT/bsc': 'usdtbsc', 'USDT/polygon': 'usdtmatic',
      'USDC/ethereum': 'usdc', 'USDC/polygon': 'usdcmatic', 'USDC/solana': 'usdcsol',
      'SOL/solana': 'sol', 'TRX/tron': 'trx'
    };
    var withdrawOptions = (wallets || []).map(function (wallet) {
      var code = known[String(wallet.asset).toUpperCase() + '/' + String(wallet.network).toLowerCase()];
      return code ? '<option value="' + esc(wallet.id) + '" data-payout-currency="' + esc(code) + '">' +
        esc(wallet.asset) + ' / ' + esc(wallet.network) + ' → ' + esc(code.toUpperCase()) + '</option>' : '';
    }).join('');
    var withdrawalRows = (withdrawals || []).map(function (w) {
      var verify = w.status === 'awaiting_2fa'
        ? '<form data-form="crypto-withdraw-verify"><input type="hidden" name="withdrawal_id" value="' + esc(w.id) + '">' +
          '<input name="verification_code" inputmode="numeric" autocomplete="one-time-code" minlength="4" maxlength="12" placeholder="2FA" required>' +
          '<button type="submit">' + esc(tr(l, 'crypto.verify')) + '</button></form>' : '';
      return '<li><strong>' + esc(w.amount) + ' ' + esc(w.payout_currency) + '</strong> · ' + esc(w.status) +
        (w.provider_ref ? ' · #' + esc(w.provider_ref) : '') + verify +
        (w.status === 'processing' ? '<button type="button" data-action="sync-crypto-withdrawal" data-withdrawal-id="' + esc(w.id) + '">' + esc(tr(l, 'crypto.sync')) + '</button>' : '') +
        '</li>';
    }).join('');
    var catalog = (currencies && currencies.length ? currencies : ['btc','eth','usdttrc20','usdterc20','usdtbsc','usdtmatic','usdtsol','usdc','sol','trx']).slice(0, 200);
    var currencyOptions = catalog.map(function (code) {
      return '<option value="' + esc(code) + '">' + esc(code.toUpperCase()) + '</option>';
    }).join('');
    var depositDetails = deposit && deposit.payment_details;
    var depositBox = depositDetails
      ? '<div class="crypto-deposit-result"><strong>' + esc(String(depositDetails.pay_amount || '')) + ' ' + esc(String(depositDetails.pay_currency || '').toUpperCase()) + '</strong>' +
        (depositDetails.pay_address ? '<br><code>' + esc(depositDetails.pay_address) + '</code>' : '') +
        (depositDetails.invoice_url ? '<br><a class="btn" target="_blank" rel="noopener noreferrer" href="' + esc(depositDetails.invoice_url) + '">' + esc(tr(l, 'crypto.open_payment')) + '</a>' : '') +
        '</div>' : '';
    var eco = cryptoEconomy || {};
    var conversionRows = (conversions || []).slice(0, 12).map(function (c) {
      return '<li><strong>' + esc(c.direction) + '</strong> · ' + esc(c.amount_crypto) + ' ' + esc(c.asset) + ' → ' + esc(String(c.amount_mga_milli)) + ' Ar · ' + esc(String(c.created_at || '')) + '</li>';
    }).join('');
    var conversionRate = eco && eco.mga_per_usd ? ' · 1 USD = ' + String(eco.mga_per_usd) + ' Ar' : '';
    return '<section class="crypto-wallets" data-testid="crypto-wallets">' +
      '<h3>' + esc(tr(l, 'crypto.title')) + '</h3>' +
      '<p class="hint">' + esc(tr(l, 'crypto.warning')) + '</p>' + depositBox +
      '<div class="crypto-economy"><h4>' + esc(tr(l, 'crypto.game_stakes')) + '</h4>' +
      '<p class="hint">' + esc(tr(l, 'crypto.game_stakes_hint')) + esc(conversionRate) + '</p>' +
      '<span>$0.10 · $0.50 · $1 · $2 · $5</span></div>' +
      '<h4>' + esc(tr(l, 'crypto.conversion')) + '</h4>' +
      '<form data-form="crypto-conversion">' +
      '<label>' + esc(tr(l, 'crypto.direction')) + ' <select name="direction" required><option value="crypto_to_mga">Crypto → MGA</option><option value="mga_to_crypto">MGA → Crypto</option></select></label>' +
      '<label>' + esc(tr(l, 'crypto.asset')) + ' <input name="asset" list="crypto-currency-catalog" value="USDT" required></label>' +
      '<label>' + esc(tr(l, 'crypto.network')) + ' <select name="network" required><option value="tron">TRON</option><option value="ethereum">Ethereum</option><option value="polygon">Polygon</option><option value="bsc">BSC</option><option value="solana">Solana</option><option value="base">Base</option><option value="bitcoin">Bitcoin</option></select></label>' +
      '<label>' + esc(tr(l, 'crypto.amount')) + ' <input name="amount" inputmode="decimal" placeholder="1" required></label>' +
      '<button type="submit">' + esc(tr(l, 'crypto.convert')) + '</button></form>' +
      '<ul class="crypto-conversions">' + (conversionRows || '<li class="empty">' + esc(tr(l, 'crypto.no_conversions')) + '</li>') + '</ul>' +
      '<h4>' + esc(tr(l, 'crypto.balances')) + '</h4>' +
      '<ul>' + (balanceRows || '<li class="empty">' + esc(tr(l, 'crypto.no_balances')) + '</li>') + '</ul>' +
      '<h4>' + esc(tr(l, 'crypto.deposit')) + '</h4>' +
      '<form data-form="crypto-deposit"><label>USD <input name="amount_milli" inputmode="decimal" placeholder="20" required></label>' +
      '<label>' + esc(tr(l, 'crypto.asset')) + ' <input name="pay_currency" list="crypto-currency-catalog" placeholder="usdttrc20" required></label>' +
      '<datalist id="crypto-currency-catalog">' + currencyOptions + '</datalist>' +
      '<button type="submit">' + esc(tr(l, 'crypto.deposit_submit')) + '</button></form>' +
      '<h4>' + esc(tr(l, 'crypto.withdraw')) + '</h4>' +
      '<form data-form="crypto-withdraw"><label>' + esc(tr(l, 'crypto.wallet_target')) + ' <select name="crypto_wallet_id" required>' +
      (withdrawOptions || '<option value="">' + esc(tr(l, 'crypto.no_supported_payout')) + '</option>') + '</select></label>' +
      '<label>' + esc(tr(l, 'crypto.amount')) + ' <input name="amount" inputmode="decimal" placeholder="0.1" required></label>' +
      '<input type="hidden" name="payout_currency" value="">' +
      '<button type="submit">' + esc(tr(l, 'crypto.withdraw_submit')) + '</button></form>' +
      '<h4>' + esc(tr(l, 'crypto.saved')) + '</h4><ul>' + (rows || '<li class="empty">' + esc(tr(l, 'crypto.none')) + '</li>') + '</ul>' +
      '<h4>' + esc(tr(l, 'crypto.withdrawals')) + '</h4><ul>' + (withdrawalRows || '<li class="empty">' + esc(tr(l, 'crypto.no_withdrawals')) + '</li>') + '</ul>' +
      '<p class="hint">' + esc(tr(l, 'crypto.catalog')) + '</p>' +
      '<form data-form="crypto-wallet">' +
      '<label>' + esc(tr(l, 'crypto.provider')) + ' <select name="provider" required><option value="other">Wallet / injected provider</option><option value="metamask">MetaMask</option><option value="trust_wallet">Trust Wallet</option><option value="coinbase_wallet">Coinbase Wallet</option><option value="walletconnect">WalletConnect</option><option value="ledger">Ledger</option><option value="trezor">Trezor</option></select></label>' +
      '<label>' + esc(tr(l, 'crypto.asset')) + ' <input name="asset" list="crypto-currency-catalog" placeholder="USDT" required pattern="[A-Za-z0-9._-]{2,32}"></label>' +
      '<label>' + esc(tr(l, 'crypto.network')) + ' <select name="network" required><option value="bitcoin">Bitcoin</option><option value="ethereum">Ethereum / EVM</option><option value="tron">TRON</option><option value="polygon">Polygon</option><option value="bsc">BNB Smart Chain</option><option value="arbitrum">Arbitrum</option><option value="optimism">Optimism</option><option value="base">Base</option><option value="solana">Solana</option></select></label>' +
      '<label>' + esc(tr(l, 'crypto.address')) + ' <input name="address" autocomplete="off" required minlength="20" maxlength="160"></label>' +
      '<button type="button" data-action="connect-wallet">' + esc(tr(l, 'crypto.connect')) + '</button>' +
      '<label>' + esc(tr(l, 'crypto.memo')) + ' <input name="address_memo" maxlength="120"></label><label>' + esc(tr(l, 'crypto.label')) + ' <input name="label" maxlength="80"></label>' +
      '<button type="submit">' + esc(tr(l, 'crypto.add')) + '</button></form></section>';
  }

  function renderWallet(state) {
    var s = state || {};
    var l = loc(s);
    var wallet = s.wallet;
    var entries = s.entries || [];
    var cryptoWallets = s.cryptoWallets || [];
    var cryptoSection = renderCryptoWallets(l, cryptoWallets, s.cryptoCurrencies || [], s.cryptoBalances || [], s.cryptoWithdrawals || [], s.cryptoDeposit || null, s.cryptoEconomy || null, s.cryptoConversions || []);
    if (!wallet) {
      return (
        '<section class="screen wallet" data-screen="wallet" lang="' + esc(l) + '"><h2>' + esc(tr(l, 'wallet.title')) + '</h2>' +
        '<p data-testid="no-wallet">' + esc(tr(l, 'wallet.none')) + '</p>' +
        '<button data-action="create-wallet">' + esc(tr(l, 'wallet.open')) + '</button>' + cryptoSection + '</section>'
      );
    }
    var rows = entries.map(function (entry) {
      return (
        '<tr data-entry-id="' + esc(entry.id) + '">' +
        '<td>' + esc(format.formatDateTime(entry.created_at)) + '</td>' +
        '<td>' + esc(entry.label || entry.tx_type) + '</td>' +
        '<td class="' + esc(entry.direction) + '">' + esc(money(l, entry.direction === 'debit' ? -entry.amount_milli : entry.amount_milli, { sign: 'force' })) + '</td>' +
        '</tr>'
      );
    }).join('');
    return (
      '<section class="screen wallet" data-screen="wallet" lang="' + esc(l) + '">' +
      '<h2>' + esc(tr(l, 'wallet.title')) + ' ' + esc(wallet.currency) + '</h2>' +
      '<p class="balance" data-testid="balance">' + esc(money(l, wallet.balance_milli)) + '</p>' +
      '<form data-form="deposit">' +
      '<label>' + esc(tr(l, 'wallet.amount')) + ' <input name="amount_milli" inputmode="numeric" required></label>' +
      '<button type="submit" data-action="deposit">' + esc(tr(l, 'wallet.deposit')) + '</button>' +
      '</form>' +
      '<table class="entries" data-testid="entries"><thead><tr><th>' + esc(tr(l, 'wallet.col_date')) + '</th><th>' + esc(tr(l, 'wallet.col_label')) + '</th><th>' + esc(tr(l, 'wallet.col_amount')) + '</th></tr></thead>' +
      '<tbody>' + (rows || '<tr class="empty"><td colspan="3">' + esc(tr(l, 'wallet.no_entries')) + '</td></tr>') + '</tbody></table>' +
      cryptoSection +
      '</section>'
    );
  }

  function waitingActions(snapshot, userId) {
    var actions = { ready: false, unready: false, start: false, close: false, leave: true };
    if (!snapshot || !snapshot.room || !userId) return actions;
    var room = snapshot.room;
    var players = snapshot.players || [];
    var me = players.find(function (p) {
      return p.user_id === userId;
    });
    if (!me) {
      actions.leave = false;
      return actions;
    }
    actions.ready = !me.ready;
    actions.unready = !!me.ready;
    if (room.status === 'waiting') {
      actions.start = room.host_user_id === userId && players.length >= 2 && players.every(function (p) {
        return p.ready;
      });
      actions.close = room.host_user_id === userId;
    }
    return actions;
  }

  function renderWaiting(state) {
    var s = state || {};
    var l = loc(s);
    var snapshot = s.snapshot || {};
    var room = snapshot.room || {};
    var players = snapshot.players || [];
    var settings = s.gameSettings || {};
    var isCrypto = settings.mode === 'crypto';
    var actions = waitingActions(snapshot, s.userId);
    var rows = players.map(function (p) {
      return (
        '<li data-user-id="' + esc(p.user_id) + '">' +
        '<span class="seat">' + esc(p.seat) + '</span>' +
        '<span class="name">' + esc(p.name || p.user_id) + '</span>' +
        '<span class="presence">' + esc(p.presence || 'offline') + '</span>' +
        '<span class="ready">' + (p.ready ? esc(tr(l, 'waiting.ready_yes')) : '\u2014') + '</span>' +
        '</li>'
      );
    }).join('');
    return (
      '<section class="screen waiting" data-screen="waiting" lang="' + esc(l) + '" data-room-id="' + esc(room.id) + '">' +
      '<h2>' + esc(tr(l, 'waiting.room', { name: esc(room.name) })) + '</h2>' +
      '<p class="status">' + esc(statusLabel(l, room.status)) + ' \u00b7 ' + esc(players.length) + '/' + esc(room.capacity) + '</p>' +
      '<ul class="players" data-testid="players">' + (rows || '<li class="empty">' + esc(tr(l, 'waiting.solo')) + '</li>') + '</ul>' +
      '<form class="game-economy" data-form="game-economy">' +
      '<h3>' + esc(tr(l, 'waiting.mise_title')) + '</h3>' +
      '<label>' + esc(tr(l, 'waiting.mise_mode')) + ' <select name="mode"><option value="mga"' + (!isCrypto ? ' selected' : '') + '>MGA</option><option value="crypto"' + (isCrypto ? ' selected' : '') + '>Crypto</option></select></label>' +
      '<label>' + esc(tr(l, 'waiting.mga_stake')) + ' <select name="entry_fee_milli">' +
        [500,1000,2000,5000,10000,20000].map(function (v) { return '<option value="' + v + '"' + (Number(settings.entryFeeMilli || 1000) === v && !isCrypto ? ' selected' : '') + '>' + v.toLocaleString('fr-FR') + ' Ar</option>'; }).join('') +
      '</select></label>' +
      '<label>' + esc(tr(l, 'waiting.crypto_stake')) + ' <select name="stake_usd_cents">' +
        [10,50,100,200,500].map(function (v) { var selected = Number(settings.stakeUsdCents || 10) === v && isCrypto; var usd = v / 100; return '<option value="' + v + '"' + (selected ? ' selected' : '') + '>$' + usd.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '</option>'; }).join('') +
      '</select></label>' +
      '<label>' + esc(tr(l, 'crypto.asset')) + ' <input name="asset" value="USDT" required></label>' +
      '<label>' + esc(tr(l, 'crypto.network')) + ' <select name="network"><option value="tron">TRON</option><option value="ethereum">Ethereum</option><option value="polygon">Polygon</option><option value="bsc">BSC</option><option value="solana">Solana</option><option value="base">Base</option></select></label>' +
      '<button type="submit">' + esc(tr(l, 'waiting.mise_save')) + '</button></form>' +
      (actions.ready ? '<button data-action="ready">' + esc(tr(l, 'waiting.ready')) + '</button>' : '') +
      (actions.unready ? '<button data-action="unready">' + esc(tr(l, 'waiting.unready')) + '</button>' : '') +
      (actions.start ? '<button data-action="start-game">' + esc(tr(l, 'waiting.start')) + '</button>' : '') +
      (actions.close ? '<button data-action="close-room">' + esc(tr(l, 'waiting.close')) + '</button>' : '') +
      (actions.leave ? '<button data-action="leave-room">' + esc(tr(l, 'waiting.leave')) + '</button>' : '') +
      '</section>'
    );
  }

  function boardEnds(board) {
    if (!board || !board.center) return null;
    var left = board.left && board.left.length ? board.left[board.left.length - 1].a : board.center.a;
    var right = board.right && board.right.length ? board.right[board.right.length - 1].b : board.center.b;
    return { left: left, right: right };
  }

  function boardTiles(board) {
    if (!board || !board.center) return [];
    return board.left.concat([board.center], board.right);
  }

  function gameActions(snapshot, userId) {
    var out = { play: [], draw: false, pass: false, start: false, leave: false };
    if (!snapshot || !userId) return out;
    var players = snapshot.players || [];
    var myTurn = snapshot.current_user_id === userId;
    var me = players.find(function (p) {
      return p.user_id === userId;
    });
    out.leave = snapshot.status !== 'finished';
    if (snapshot.status === 'scheduled' && players.length >= 2) {
      var host = players.reduce(function (a, b) {
        return a && a.seat <= b.seat ? a : b;
      }, null);
      out.start = !!host && host.user_id === userId;
    }
    if (snapshot.status !== 'active' || !myTurn) return out;
    out.draw = (snapshot.boneyard_count || 0) > 0;
    var hand = (snapshot.hands && snapshot.hands[userId]) || [];
    var ends = boardEnds(snapshot.board);
    out.pass = hand.length > 0 && !hand.some(function (tile) {
      return tileMatches(tile, ends);
    });
    out.play = hand.filter(function (tile) {
      return tileMatches(tile, ends);
    }).map(function (tile) {
      return { tile: tile, sides: playSides(tile, ends) };
    });
    return out;
  }

  function tileMatches(tile, ends) {
    if (!ends) return true;
    return tile.a === ends.left || tile.b === ends.left || tile.a === ends.right || tile.b === ends.right;
  }

  function playSides(tile, ends) {
    if (!ends) return ['left', 'right'];
    var sides = [];
    if (tile.a === ends.left || tile.b === ends.left) sides.push('left');
    if (tile.a === ends.right || tile.b === ends.right) sides.push('right');
    return sides;
  }

  function renderDomino(l, snapshot, actions) {
    var tiles = boardTiles(snapshot.board).map(function (tile) {
      return '<span class="tile" data-tile="' + esc(tile.a) + '-' + esc(tile.b) + '">' + esc(tile.a) + '|' + esc(tile.b) + '</span>';
    }).join('');
    var hand = ((snapshot.hands && snapshot.hands[actions.userId]) || []).map(function (tile) {
      var playable = actions.play.some(function (p) {
        return p.tile.a === tile.a && p.tile.b === tile.b;
      });
      return '<button class="tile' + (playable ? ' playable' : '') + '" data-action="play-tile" data-tile="' + esc(tile.a) + '-' + esc(tile.b) + '"' +
        (playable ? '' : ' disabled') + '>' + esc(tile.a) + '|' + esc(tile.b) + '</button>';
    }).join('');
    return (
      '<h2>DominoMada \u00b7 ' + esc(statusLabel(l, snapshot.status)) + '</h2>' +
      '<p class="turn" data-testid="turn">' + esc(tr(l, 'game.turn', { who: snapshot.current_user_id || '\u2014' })) + '</p>' +
      '<div class="board" data-testid="board">' + (tiles || '<span class="empty">' + esc(tr(l, 'game.empty')) + '</span>') + '</div>' +
      '<div class="hand" data-testid="hand">' + hand + '</div>' +
      '<div class="controls">' +
      (actions.draw ? '<button data-action="draw-tile">' + esc(tr(l, 'domino.draw', { count: snapshot.boneyard_count })) + '</button>' : '') +
      (actions.pass ? '<button data-action="pass-turn">' + esc(tr(l, 'domino.pass')) + '</button>' : '') +
      '</div>'
    );
  }

  function renderLoto(l, snapshot, actions) {
    var balls = (snapshot.drawn || []).map(function (ball) {
      return '<span class="ball" data-ball="' + esc(ball) + '">' + esc(ball) + '</span>';
    }).join('');
    var grid = (snapshot.own_grid || []).map(function (row) {
      return '<tr>' + row.map(function (cell) {
        return '<td class="' + (cell ? 'num' : 'blank') + '">' + esc(cell || '') + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return (
      '<h2>LotoMada \u00b7 ' + esc(statusLabel(l, snapshot.status)) + '</h2>' +
      '<p class="cagnotte" data-testid="cagnotte">' + esc(money(l, snapshot.cagnotte_milli || 0)) + '</p>' +
      '<p class="balls" data-testid="balls">' + esc(snapshot.balls_drawn || 0) + '/' + esc(snapshot.balls_total || 0) + '</p>' +
      '<div class="drawn" data-testid="drawn">' + (balls || '<span class="empty">' + esc(tr(l, 'game.none')) + '</span>') + '</div>' +
      '<table class="grid" data-testid="grid">' + (grid || '<tr><td>' + esc(tr(l, 'loto.no_ticket')) + '</td></tr>') + '</table>' +
      '<div class="controls">' +
      (actions.buy ? '<button data-action="buy-ticket">' + esc(tr(l, 'loto.buy')) + '</button>' : '') +
      (actions.ball ? '<button data-action="next-ball">' + esc(tr(l, 'loto.ball')) + '</button>' : '') +
      (actions.settle ? '<button data-action="settle-draw">' + esc(tr(l, 'loto.settle')) + '</button>' : '') +
      (actions.refund ? '<button data-action="refund-draw">' + esc(tr(l, 'loto.refund')) + '</button>' : '') +
      '</div>'
    );
  }

  function renderRami(l, snapshot, actions) {
    var last = snapshot.last_discard;
    var hand = (snapshot.own_hand || []).map(function (card) {
      return '<button class="card" data-action="select-card" data-card="' + esc(card) + '">' + esc(card) + '</button>';
    }).join('');
    return (
      '<h2>RamiMada \u00b7 ' + esc(statusLabel(l, snapshot.status)) + (snapshot.turn_phase ? ' \u00b7 ' + esc(phaseLabel(l, snapshot.turn_phase)) : '') + '</h2>' +
      '<p class="turn" data-testid="turn">' + esc(tr(l, 'game.turn', { who: snapshot.current_user_id || '\u2014' })) + '</p>' +
      '<p class="last-discard" data-testid="last-discard">' + esc(last ? (last.key || (last.suit + '-' + last.rank)) : '\u2014') + '</p>' +
      '<div class="hand" data-testid="hand">' + hand + '</div>' +
      '<div class="controls">' +
      (actions.draw ? '<button data-action="draw-stock">' + esc(tr(l, 'rami.draw_stock', { count: snapshot.stock_count })) + '</button>' : '') +
      (actions.drawDiscard ? '<button data-action="draw-discard">' + esc(tr(l, 'rami.draw_discard')) + '</button>' : '') +
      (actions.meld ? '<button data-action="meld">' + esc(tr(l, 'rami.meld')) + '</button>' : '') +
      (actions.discard ? '<button data-action="discard">' + esc(tr(l, 'rami.discard')) + '</button>' : '') +
      '</div>'
    );
  }

  function ramiTurnActions(snapshot, userId) {
    var out = { draw: false, drawDiscard: false, meld: false, discard: false };
    if (snapshot.status !== 'active' || snapshot.current_user_id !== userId) return out;
    if (snapshot.turn_phase === 'draw') {
      out.draw = (snapshot.stock_count || 0) > 0;
      out.drawDiscard = !!snapshot.last_discard;
    } else if (snapshot.turn_phase === 'discard') {
      out.meld = true;
      out.discard = (snapshot.own_hand || []).length > 1;
    }
    return out;
  }

  function lotoTurnActions(snapshot, userId) {
    var out = { buy: false, ball: false, settle: false, refund: false, start: false };
    var status = snapshot.status;
    if (status === 'scheduled') out.buy = true;
    if (status === 'active') {
      out.buy = true;
      var host = snapshot.user_id || (snapshot.players && snapshot.players[0] && snapshot.players[0].user_id);
      if (host === userId) {
        out.ball = (snapshot.balls_drawn || 0) < (snapshot.balls_total || 0);
        out.settle = (snapshot.balls_drawn || 0) > 0;
      }
    }
    if (status === 'finished' || status === 'cancelled') out.refund = true;
    return out;
  }

  function renderGame(state) {
    var s = state || {};
    var l = loc(s);
    var snapshot = s.snapshot || {};
    var kind = s.kind || 'domino';
    var actions;
    var body;
    if (kind === 'loto') {
      actions = lotoTurnActions(snapshot, s.userId);
      body = renderLoto(l, snapshot, actions);
    } else if (kind === 'rami') {
      actions = ramiTurnActions(snapshot, s.userId);
      body = renderRami(l, snapshot, actions);
    } else {
      actions = gameActions(snapshot, s.userId);
      actions.userId = s.userId;
      body = renderDomino(l, snapshot, actions);
    }
    var id = snapshot.match_id || snapshot.draw_id || snapshot.game_id || '';
    return (
      '<section class="screen game game-' + esc(kind) + '" data-screen="game" lang="' + esc(l) + '" data-kind="' + esc(kind) + '" data-game-id="' + esc(id) + '">' +
      body +
      (actions.start ? '<button data-action="start-game">' + esc(tr(l, 'waiting.start')) + '</button>' : '') +
      (snapshot.winner_user_id ? '<p class="winner" data-testid="winner">' + esc(tr(l, 'game.winner', { who: snapshot.winner_user_id })) + '</p>' : '') +
      '</section>'
    );
  }

  function renderProfile(state) {
    var s = state || {};
    var l = loc(s);
    var me = s.me || {};
    var user = me.user || {};
    var wallet = me.wallet;
    return (
      '<section class="screen profile" data-screen="profile" lang="' + esc(l) + '">' +
      '<h2>' + esc(tr(l, 'profile.title')) + '</h2>' +
      '<dl>' +
      '<dt>' + esc(tr(l, 'profile.username')) + '</dt><dd data-testid="username">' + esc(user.username) + '</dd>' +
      '<dt>' + esc(tr(l, 'profile.phone')) + '</dt><dd>' + esc(user.phone || '\u2014') + '</dd>' +
      '<dt>' + esc(tr(l, 'profile.email')) + '</dt><dd>' + esc(user.email || '\u2014') + '</dd>' +
      '<dt>' + esc(tr(l, 'profile.role')) + '</dt><dd>' + esc(user.role || 'player') + '</dd>' +
      '<dt>' + esc(tr(l, 'profile.status')) + '</dt><dd>' + esc(statusLabel(l, user.status) || 'active') + '</dd>' +
      '<dt>' + esc(tr(l, 'profile.wallet')) + '</dt><dd>' + esc(wallet ? money(l, wallet.balance_milli) : tr(l, 'profile.no_wallet')) + '</dd>' +
      '</dl>' +
      '<button data-action="logout">' + esc(tr(l, 'profile.logout')) + '</button>' +
      '</section>'
    );
  }

  function renderNotFound(state) {
    var s = state || {};
    var l = loc(s);
    return '<section class="screen not-found" data-screen="not_found" lang="' + esc(l) + '"><h2>' + esc(tr(l, 'notfound.title')) + '</h2><a href="#/home">' + esc(tr(l, 'notfound.home')) + '</a></section>';
  }

  return {
    renderLogin: renderLogin,
    renderHome: renderHome,
    renderLobby: renderLobby,
    renderWallet: renderWallet,
    renderWaiting: renderWaiting,
    renderGame: renderGame,
    renderProfile: renderProfile,
    renderNotFound: renderNotFound,
    waitingActions: waitingActions,
    gameActions: gameActions,
    ramiTurnActions: ramiTurnActions,
    lotoTurnActions: lotoTurnActions,
    tileMatches: tileMatches,
    statusLabel: statusLabel,
    phaseLabel: phaseLabel,
  };
});
