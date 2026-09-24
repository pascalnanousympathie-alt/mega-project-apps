(function (root, factory) {
  'use strict';
  var mod = factory();
  root.ACEP = root.ACEP || {};
  root.ACEP.music = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'acep.music.v1';
  var KINDS = ['ludo', 'domino', 'loto', 'rami'];
  var TRACKS = {
    ludo:   { tempo: 430, notes: [261.63,329.63,392,329.63,293.66,349.23,392,329.63] },
    domino: { tempo: 520, notes: [220,277.18,329.63,277.18,246.94,293.66,329.63,277.18] },
    loto:   { tempo: 610, notes: [329.63,392,493.88,392,349.23,440,493.88,392] },
    rami:   { tempo: 560, notes: [293.66,369.99,440,369.99,329.63,415.30,493.88,415.30] }
  };

  function normalizeKind(kind) {
    var k = String(kind || 'ludo').toLowerCase();
    if (k === 'ludomada') return 'ludo';
    if (k === 'dominomada') return 'domino';
    if (k === 'lotomada') return 'loto';
    if (k === 'ramimada') return 'rami';
    return KINDS.indexOf(k) >= 0 ? k : 'ludo';
  }

  function readSettings(storage) {
    var out = { ludo: true, domino: true, loto: true, rami: true };
    try {
      var raw = storage && storage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        KINDS.forEach(function (k) { if (typeof saved[k] === 'boolean') out[k] = saved[k]; });
      }
    } catch (_) {}
    return out;
  }

  function saveSettings(storage, settings) {
    try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  function createController(rootObj) {
    var host = rootObj || (typeof globalThis !== 'undefined' ? globalThis : {});
    var storage = host.localStorage;
    var settings = readSettings(storage);
    var ctx = null;
    var gain = null;
    var timer = null;
    var currentKind = null;
    var step = 0;

    function stop() {
      if (timer) host.clearInterval(timer);
      timer = null;
      if (gain) gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      currentKind = null;
    }

    function start(kind) {
      kind = normalizeKind(kind);
      if (!settings[kind]) return false;
      var AudioContext = host.AudioContext || host.webkitAudioContext;
      if (!AudioContext) return false;
      if (!ctx) {
        ctx = new AudioContext();
        gain = ctx.createGain();
        gain.gain.value = 0.026;
        gain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      if (currentKind === kind && timer) return true;
      if (timer) stop();
      currentKind = kind;
      step = 0;
      var track = TRACKS[kind];
      function beat() {
        if (!ctx || !gain || !settings[currentKind]) return;
        var now = ctx.currentTime;
        var freq = track.notes[step % track.notes.length];
        var osc = ctx.createOscillator();
        var voice = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        voice.gain.setValueAtTime(0.0001, now);
        voice.gain.exponentialRampToValueAtTime(0.11, now + 0.025);
        voice.gain.exponentialRampToValueAtTime(0.0001, now + track.tempo / 1000 * 0.82);
        osc.connect(voice);
        voice.connect(gain);
        osc.start(now);
        osc.stop(now + track.tempo / 1000 * 0.9);
        step += 1;
      }
      beat();
      timer = host.setInterval(beat, track.tempo);
      return true;
    }

    function toggle(kind) {
      kind = normalizeKind(kind);
      if (settings[kind] && timer && currentKind === kind) {
        settings[kind] = false;
        saveSettings(storage, settings);
        stop();
        return settings[kind];
      }
      settings[kind] = true;
      saveSettings(storage, settings);
      start(kind);
      return settings[kind];
    }

    return {
      normalizeKind: normalizeKind,
      settings: function () { return { ludo: settings.ludo, domino: settings.domino, loto: settings.loto, rami: settings.rami }; },
      enabled: function (kind) { return !!settings[normalizeKind(kind)]; },
      playing: function (kind) { return !!timer && currentKind === normalizeKind(kind); },
      toggle: toggle,
      start: start,
      stop: stop
    };
  }

  return { KINDS: KINDS, TRACKS: TRACKS, normalizeKind: normalizeKind, readSettings: readSettings, createController: createController };
});