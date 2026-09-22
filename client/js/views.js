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

  function renderWallet(state) {
    var s = state || {};
    var l = loc(s);
    var wallet = s.wallet;
    var entries = s.entries || [];
    if (!wallet) {
      return (
        '<section class="screen wallet" data-screen="wallet" lang="' + esc(l) + '"><h2>' + esc(tr(l, 'wallet.title')) + '</h2>' +
        '<p data-testid="no-wallet">' + esc(tr(l, 'wallet.none')) + '</p>' +
        '<button data-action="create-wallet">' + esc(tr(l, 'wallet.open')) + '</button></section>'
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
