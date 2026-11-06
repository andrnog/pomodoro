// Часовой пояс приложения.
// Если в настройках выбран пояс (например, Europe/Moscow), всё «местное время»
// в приложении — даты, «сегодня», часы на графиках — считается в нём,
// независимо от пояса, который стоит на компьютере.
// Работает подменой Date: локальные геттеры/сеттеры и toLocale*String
// пересчитываются через Intl для выбранного пояса.
(function () {
  'use strict';
  let tz = '';
  try { tz = localStorage.getItem('pomodoro.tz') || ''; } catch (e) { /* приватный режим */ }
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  window.APP_TZ = '';
  window.SYSTEM_TZ = system;
  if (!tz || tz === system) return;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
  } catch (e) {
    return; // неизвестный пояс — остаёмся на системном
  }
  window.APP_TZ = tz;

  const Orig = Date;
  const cache = new Map();
  // смещение пояса от UTC в минутах для момента ms
  function offsetAt(ms) {
    const key = Math.floor(ms / 900000);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const p = {};
    for (const x of fmt.formatToParts(new Orig(ms))) p[x.type] = x.value;
    const asUTC = Orig.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    const off = Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
    if (cache.size > 20000) cache.clear();
    cache.set(key, off);
    return off;
  }
  // местные компоненты в выбранном поясе -> момент времени
  function fromLocal(y, mo, d, h, mi, s, ms) {
    const guess = Orig.UTC(y, mo, d, h, mi, s, ms);
    let t = guess - offsetAt(guess) * 60000;
    t = guess - offsetAt(t) * 60000;
    return t;
  }
  const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

  class ZDate extends Orig {
    constructor(...a) {
      if (a.length === 0) {
        super();
      } else if (a.length === 1) {
        const v = a[0];
        const m = typeof v === 'string' ? v.match(LOCAL_ISO) : null;
        if (m) super(fromLocal(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0'))));
        else super(v instanceof Orig ? v.getTime() : v);
      } else {
        const [y, mo, d = 1, h = 0, mi = 0, s = 0, ms = 0] = a;
        super(fromLocal(y, mo, d, h, mi, s, ms));
      }
    }
    _l() { return new Orig(this.getTime() + offsetAt(this.getTime()) * 60000); }
    _set(fn) {
      if (isNaN(this.getTime())) return NaN;
      const l = this._l();
      fn(l);
      return this.setTime(fromLocal(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(),
        l.getUTCHours(), l.getUTCMinutes(), l.getUTCSeconds(), l.getUTCMilliseconds()));
    }
    getFullYear() { return this._l().getUTCFullYear(); }
    getMonth() { return this._l().getUTCMonth(); }
    getDate() { return this._l().getUTCDate(); }
    getDay() { return this._l().getUTCDay(); }
    getHours() { return this._l().getUTCHours(); }
    getMinutes() { return this._l().getUTCMinutes(); }
    getSeconds() { return this._l().getUTCSeconds(); }
    getMilliseconds() { return this._l().getUTCMilliseconds(); }
    getTimezoneOffset() { return -offsetAt(this.getTime()); }
    setFullYear(...a) { return this._set((l) => l.setUTCFullYear(...a)); }
    setMonth(...a) { return this._set((l) => l.setUTCMonth(...a)); }
    setDate(...a) { return this._set((l) => l.setUTCDate(...a)); }
    setHours(...a) { return this._set((l) => l.setUTCHours(...a)); }
    setMinutes(...a) { return this._set((l) => l.setUTCMinutes(...a)); }
    setSeconds(...a) { return this._set((l) => l.setUTCSeconds(...a)); }
    setMilliseconds(...a) { return this._set((l) => l.setUTCMilliseconds(...a)); }
    toLocaleDateString(loc, o) { return super.toLocaleDateString(loc, { ...(o || {}), timeZone: tz }); }
    toLocaleTimeString(loc, o) { return super.toLocaleTimeString(loc, { ...(o || {}), timeZone: tz }); }
    toLocaleString(loc, o) { return super.toLocaleString(loc, { ...(o || {}), timeZone: tz }); }
  }
  window.Date = ZDate;
})();
