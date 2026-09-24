(function (root, factory) {
  'use strict';
  var mod = factory();
  root.ACEP = root.ACEP || {};
  root.ACEP.router = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ROUTES = [
    { name: 'login', pattern: /^\/login\/?$/, auth: false },
    { name: 'home', pattern: /^\/(home)?\/?$/, auth: true },
    { name: 'lobby', pattern: /^\/lobby\/?$/, auth: true },
    { name: 'wallet', pattern: /^\/wallet\/?$/, auth: true },
    { name: 'community', pattern: /^\/community\/?$/, auth: true },
    { name: 'profile', pattern: /^\/profile\/?$/, auth: true },
    { name: 'room', pattern: /^\/room\/([^/?#]+)$/, auth: true },
    { name: 'game', pattern: /^\/game\/([^/?#]+)$/, auth: true },
  ];

  function parseHash(hash) {
    var raw = String(hash === null || hash === undefined ? '' : hash).trim();
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    if (raw === '' || raw === '/') return { name: 'home', params: {}, query: {} };
    var query = {};
    var qIndex = raw.indexOf('?');
    if (qIndex >= 0) {
      var pairs = raw.slice(qIndex + 1).split('&');
      raw = raw.slice(0, qIndex);
      for (var i = 0; i < pairs.length; i += 1) {
        if (!pairs[i]) continue;
        var kv = pairs[i].split('=');
        query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      }
    }
    for (var j = 0; j < ROUTES.length; j += 1) {
      var route = ROUTES[j];
      var match = route.pattern.exec(raw);
      if (match) {
        var params = {};
        if (route.name === 'room' || route.name === 'game') {
          params.roomId = decodeURIComponent(match[1]);
        }
        return { name: route.name, params: params, query: query };
      }
    }
    return { name: 'not_found', params: {}, query: query };
  }

  function requiresAuth(routeName) {
    for (var i = 0; i < ROUTES.length; i += 1) {
      if (ROUTES[i].name === routeName) return ROUTES[i].auth;
    }
    return true;
  }

  function resolveRoute(hash, authed) {
    var route = parseHash(hash);
    if (route.name === 'login' && authed) return { name: 'home', params: {} };
    if (route.name !== 'login' && requiresAuth(route.name) && !authed) {
      return { name: 'login', params: {}, redirect: route };
    }
    return route;
  }

  function linkFor(name, params) {
    if (name === 'room' || name === 'game') return '#/' + name + '/' + encodeURIComponent(params.roomId || params.gameId || '');
    return '#/' + name;
  }

  return {
    ROUTES: ROUTES,
    parseHash: parseHash,
    requiresAuth: requiresAuth,
    resolveRoute: resolveRoute,
    linkFor: linkFor,
  };
});
