(function (root, factory) {
  'use strict';
  var mod = factory();
  root.ACEP = root.ACEP || {};
  root.ACEP.store = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SESSION_KEY = 'acep.session.v1';

  function memoryStorage() {
    var data = Object.create(null);
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function (key, value) {
        data[key] = String(value);
      },
      removeItem: function (key) {
        delete data[key];
      },
    };
  }

  function createSessionStore(storage) {
    var backend = storage || memoryStorage();
    return {
      load: function () {
        try {
          var raw = backend.getItem(SESSION_KEY);
          if (!raw) return null;
          var parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string') return null;
          return parsed;
        } catch (_) {
          return null;
        }
      },
      save: function (session) {
        if (!session || typeof session.token !== 'string') return null;
        var safe = {
          token: session.token,
          expires_at: session.expires_at || null,
          user: session.user || null,
        };
        try {
          backend.setItem(SESSION_KEY, JSON.stringify(safe));
        } catch (_) {
          // storage unavailable: session stays in memory only
        }
        return safe;
      },
      clear: function () {
        try {
          backend.removeItem(SESSION_KEY);
        } catch (_) {
          // already gone
        }
      },
    };
  }

  return {
    SESSION_KEY: SESSION_KEY,
    memoryStorage: memoryStorage,
    createSessionStore: createSessionStore,
  };
});
