(function (root, factory) {
  'use strict';
  var mod = factory();
  root.ACEP = root.ACEP || {};
  root.ACEP.api = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_BASE = '/api/v1';

  function ApiError(status, code, message, requestId) {
    var err = new Error(message || code || 'api error');
    err.name = 'ApiError';
    err.status = status;
    err.code = code || 'E_NETWORK';
    err.requestId = requestId || null;
    return err;
  }

  function makeIdempotencyKey(random) {
    var rnd = random || Math.random;
    return 'ui-' + Date.now().toString(36) + '-' + String(rnd()).slice(2, 12);
  }

  function createApiClient(deps) {
    var options = deps || {};
    var doFetch = options.fetch;
    if (typeof doFetch !== 'function' && typeof fetch === 'function') doFetch = fetch;
    var baseUrl = options.baseUrl || DEFAULT_BASE;
    var getToken = options.getToken || function () { return null; };
    var newKey = options.newIdempotencyKey || makeIdempotencyKey;

    function request(method, path, opts) {
      var call = opts || {};
      var headers = { accept: 'application/json' };
      var token = getToken();
      if (token) headers.authorization = 'Bearer ' + token;
      if (call.idempotency) headers['idempotency-key'] = call.idempotency === true ? newKey() : String(call.idempotency);
      var init = { method: method, headers: headers };
      if (call.body !== undefined && call.body !== null) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(call.body);
      }
      if (!doFetch) return Promise.reject(ApiError(0, 'E_NETWORK', 'no fetch implementation'));
      return doFetch(baseUrl + path, init).then(function (res) {
        return res.json().catch(function () {
          throw ApiError(res.status || 0, 'E_NETWORK', 'invalid JSON response');
        }).then(function (payload) {
          var requestId = payload && payload.meta ? payload.meta.request_id : null;
          if (!res.ok) {
            var errInfo = (payload && payload.error) || {};
            throw ApiError(res.status, errInfo.code || 'E_NETWORK', errInfo.message || 'request failed', requestId);
          }
          return payload ? payload.data : null;
        });
      }, function () {
        throw ApiError(0, 'E_NETWORK', 'network unreachable');
      });
    }

    return {
      request: request,
      health: function () {
        return request('GET', '/health');
      },
      register: function (form) {
        return request('POST', '/auth/register', { body: form });
      },
      login: function (identity, password) {
        return request('POST', '/auth/login', { body: { identity: identity, password: password } });
      },
      logout: function () {
        return request('POST', '/auth/logout', { body: {} });
      },
      me: function () {
        return request('GET', '/users/me');
      },
      createWallet: function (currency) {
        return request('POST', '/wallets', { body: currency ? { currency: currency } : {}, idempotency: true });
      },
      wallet: function (walletId) {
        return request('GET', '/wallets/' + encodeURIComponent(walletId));
      },
      walletEntries: function (walletId, limit) {
        var q = limit ? '?limit=' + encodeURIComponent(String(limit)) : '';
        return request('GET', '/wallets/' + encodeURIComponent(walletId) + '/entries' + q);
      },
      cryptoWallets: function () {
        return request('GET', '/crypto/wallets');
      },
      createCryptoWallet: function (body, key) {
        return request('POST', '/crypto/wallets', { body: body, idempotency: key || true });
      },
      disableCryptoWallet: function (walletId) {
        return request('DELETE', '/crypto/wallets/' + encodeURIComponent(walletId), { body: {} });
      },
      transfer: function (walletId, body, key) {
        return request('POST', '/wallets/' + encodeURIComponent(walletId) + '/transfers', {
          body: body,
          idempotency: key || true,
        });
      },
      listRooms: function (status) {
        var q = status ? '?status=' + encodeURIComponent(status) : '';
        return request('GET', '/rooms' + q);
      },
      createRoom: function (body) {
        return request('POST', '/rooms', { body: body, idempotency: true });
      },
      paymentProviders: function () {
        return request('GET', '/payments/providers');
      },
      cryptoCurrencies: function () {
        return request('GET', '/crypto/currencies');
      },
      cryptoEconomy: function () {
        return request('GET', '/crypto/economy');
      },
      cryptoConversions: function (limit) {
        var q = limit ? '?limit=' + encodeURIComponent(String(limit)) : '';
        return request('GET', '/crypto/conversions' + q);
      },
      createCryptoConversion: function (body, key) {
        return request('POST', '/crypto/conversions', { body: body, idempotency: key || true });
      },
      cryptoBalances: function () {
        return request('GET', '/crypto/balances');
      },
      cryptoBalanceEntries: function (balanceId, limit) {
        var q = limit ? '?limit=' + encodeURIComponent(String(limit)) : '';
        return request('GET', '/crypto/balances/' + encodeURIComponent(balanceId) + '/entries' + q);
      },
      cryptoWithdrawals: function (limit) {
        var q = limit ? '?limit=' + encodeURIComponent(String(limit)) : '';
        return request('GET', '/crypto/withdrawals' + q);
      },
      createCryptoWithdrawal: function (body, key) {
        return request('POST', '/crypto/withdrawals', { body: body, idempotency: key || true });
      },
      verifyCryptoWithdrawal: function (withdrawalId, verificationCode, key) {
        return request('POST', '/crypto/withdrawals/' + encodeURIComponent(withdrawalId) + '/verify', {
          body: { verification_code: verificationCode }, idempotency: key || true,
        });
      },
      syncCryptoWithdrawal: function (withdrawalId) {
        return request('POST', '/crypto/withdrawals/' + encodeURIComponent(withdrawalId) + '/sync', { body: {}, idempotency: true });
      },
      createDeposit: function (body, key) {
        return request('POST', '/payments/intents', { body: body, idempotency: key || true });
      },
      paymentIntent: function (intentId) {
        return request('GET', '/payments/intents/' + encodeURIComponent(intentId));
      },
      refundLotoDraw: function (drawId) {
        return request('POST', '/loto/draws/' + encodeURIComponent(drawId) + '/refund', { body: {}, idempotency: true });
      },
      chatGroups: function () {
        return request('GET', '/chat/groups');
      },
      chatMessages: function (groupKey, limit) {
        var q = limit ? '?limit=' + encodeURIComponent(String(limit)) : '';
        return request('GET', '/chat/groups/' + encodeURIComponent(groupKey) + '/messages' + q);
      },
      sendChatMessage: function (groupKey, body, key) {
        return request('POST', '/chat/groups/' + encodeURIComponent(groupKey) + '/messages', { body: { body: body }, idempotency: key || true });
      },
      supportTickets: function () {
        return request('GET', '/support/tickets');
      },
      createSupportTicket: function (subject, body, key) {
        return request('POST', '/support/tickets', { body: { subject: subject, body: body }, idempotency: key || true });
      },
      supportTicket: function (ticketId) {
        return request('GET', '/support/tickets/' + encodeURIComponent(ticketId));
      },
      supportMessages: function (ticketId, limit) {
        var q = limit ? '?limit=' + encodeURIComponent(String(limit)) : '';
        return request('GET', '/support/tickets/' + encodeURIComponent(ticketId) + '/messages' + q);
      },
      sendSupportMessage: function (ticketId, body, key) {
        return request('POST', '/support/tickets/' + encodeURIComponent(ticketId) + '/messages', { body: { body: body }, idempotency: key || true });
      },
      setSupportStatus: function (ticketId, status, key) {
        return request('POST', '/support/tickets/' + encodeURIComponent(ticketId) + '/status', { body: { status: status }, idempotency: key || true });
      },
    };
  }

  return {
    DEFAULT_BASE: DEFAULT_BASE,
    ApiError: ApiError,
    makeIdempotencyKey: makeIdempotencyKey,
    createApiClient: createApiClient,
  };
});
