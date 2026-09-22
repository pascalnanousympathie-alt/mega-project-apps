(function (root, factory) {
  'use strict';
  var factoryRequire = typeof require === 'function' ? require : null;
  var i18n = typeof module !== 'undefined' && factoryRequire ? factoryRequire('./i18n.js') : root.ACEP && root.ACEP.i18n;
  var mod = factory(i18n);
  root.ACEP = root.ACEP || {};
  root.ACEP.format = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (i18n) {
  'use strict';

  var DEFAULT_GROUP = '\u202f';
  var DEFAULT_SYMBOL = 'Ar';

  var HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      return HTML_ESCAPES[ch];
    });
  }

  function moneyStyle(locale) {
    if (i18n && typeof i18n.moneyFor === 'function') return i18n.moneyFor(locale);
    return { group: DEFAULT_GROUP, symbol: DEFAULT_SYMBOL, position: 'suffix' };
  }

  function groupDigits(intStr, sep) {
    var group = sep === undefined ? DEFAULT_GROUP : sep;
    var out = '';
    var count = 0;
    for (var i = intStr.length - 1; i >= 0; i -= 1) {
      out = intStr[i] + out;
      count += 1;
      if (count % 3 === 0 && i > 0) out = group + out;
    }
    return out;
  }

  function formatMilli(milli, opts) {
    var options = opts || {};
    var style = moneyStyle(options.locale);
    var value = Number.isSafeInteger(milli) ? milli : 0;
    var negative = value < 0;
    var whole = groupDigits(String(Math.abs(value)), style.group);
    var sign = negative ? '\u2212' : '';
    var unit = style.symbol || DEFAULT_SYMBOL;
    var text =
      style.position === 'prefix' ? sign + unit + ' ' + whole : sign + whole + ' ' + unit;
    if (options.sign === 'force' && !negative) text = '+' + text;
    return text;
  }

  function parseMilliInput(text) {
    var raw = String(text === null || text === undefined ? '' : text).replace(/[^\d.-]/g, '');
    if (!raw) return null;
    var value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.round(value);
  }

  function formatDateTime(value) {
    if (!value) return '';
    var date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    );
  }

  return {
    escapeHtml: escapeHtml,
    groupDigits: groupDigits,
    formatMilli: formatMilli,
    parseMilliInput: parseMilliInput,
    formatDateTime: formatDateTime,
  };
});
