(function () {
  'use strict';

  // ================= Данные =================
  const DEFAULTS = {
    version: 1,
    settings: {
      focus: 25, short: 5, long: 15, perRound: 4,
      autoBreak: true, autoFocus: false, chime: true, notify: true, timezone: '',
    },
    categories: [
      { id: 'dev', name: 'Разработка', color: '#ff6b5b' },
      { id: 'meet', name: 'Созвоны', color: '#60a5fa' },
      { id: 'learn', name: 'Обучение', color: '#a78bfa' },
      { id: 'docs', name: 'Документация', color: '#34d399' },
      { id: 'review', name: 'Код-ревью', color: '#fbbf24' },
      { id: 'other', name: 'Другое', color: '#94a3b8' },
    ],
    pomodoros: [],
    goals: [], // [{ category, target }] — одни на все дни
    habits: [], // [{ id, name, color, created: 'YYYY-MM-DD' }]
    habitLog: {}, // { 'YYYY-MM-DD': [habitId, ...] }
    timer: null,
  };

  let data = structuredClone(DEFAULTS);
  const $ = (id) => document.getElementById(id);
  let IS_DEV = false;
  fetch('/api/info').then((r) => r.json()).then((i) => {
    IS_DEV = i.channel !== 'prod';
    $('devBadge').hidden = !IS_DEV;
  }).catch(() => {});
  // ---------- выбор цвета из фиксированной палитры ----------
  const PALETTE = [
    '#ff6b5b', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#2dd4bf',
    '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa', '#f472b6', '#94a3b8',
  ];
  let openSwatchPop = null;
  function closeSwatchPop() {
    if (!openSwatchPop) return;
    openSwatchPop.pop.remove();
    openSwatchPop.btn.setAttribute('aria-expanded', 'false');
    openSwatchPop = null;
  }
  // превращает <button class="swatch-btn"> в выбор цвета; у кнопки появляется свойство .value
  function swatchPicker(btn, initial, onChange) {
    let value = initial || PALETTE[0];
    const paint = () => { btn.style.setProperty('--sw', value); btn.dataset.color = value; };
    Object.defineProperty(btn, 'value', { get: () => value, set: (v) => { value = v; paint(); }, configurable: true });
    btn.classList.add('swatch-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    paint();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openSwatchPop && openSwatchPop.btn === btn) { closeSwatchPop(); return; }
      closeSwatchPop();
      const pop = document.createElement('div');
      pop.className = 'swatch-pop';
      pop.setAttribute('role', 'listbox');
      PALETTE.forEach((c) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'swatch' + (c.toLowerCase() === value.toLowerCase() ? ' sel' : '');
        sw.style.setProperty('--sw', c);
        sw.setAttribute('aria-label', c);
        sw.addEventListener('click', (ev) => {
          ev.stopPropagation();
          value = c; paint();
          closeSwatchPop();
          btn.focus();
          if (onChange) onChange(c);
        });
        pop.appendChild(sw);
      });
      // в открытом диалоге — внутри него (top layer), иначе в body
      (btn.closest('dialog') || document.body).appendChild(pop);
      const r = btn.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      let top = r.bottom + 8;
      if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 8;
      pop.style.top = top + 'px';
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left)) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      openSwatchPop = { pop, btn };
      (pop.querySelector('.sel') || pop.firstChild).focus();
    });
    return btn;
  }
  document.addEventListener('click', (e) => { if (openSwatchPop && !openSwatchPop.pop.contains(e.target)) closeSwatchPop(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSwatchPop) { e.preventDefault(); e.stopPropagation(); const b = openSwatchPop.btn; closeSwatchPop(); b.focus(); }
  }, true);
  document.addEventListener('scroll', closeSwatchPop, true);

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- сохранение ----------
  let saveTimer = null;
  let dirty = false;
  function save(immediate) {
    dirty = true;
    clearTimeout(saveTimer);
    if (immediate) return flush();
    saveTimer = setTimeout(flush, 400);
  }
  async function flush(keepalive) {
    if (!dirty) return;
    dirty = false;
    clearTimeout(saveTimer);
    const body = JSON.stringify(data);
    try {
      const r = await fetch('/api/data', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
        keepalive: !!keepalive && body.length < 60000,
      });
      if (!r.ok) throw new Error(r.status);
      setSaveState('Сохранено', false);
    } catch (e) {
      dirty = true;
      setSaveState('Нет связи с сервером — данные не сохранены', true);
      saveTimer = setTimeout(flush, 3000);
    }
  }
  let saveStateTimer;
  function setSaveState(text, err) {
    const el = $('saveState');
    el.textContent = text;
    el.classList.toggle('err', err);
    el.style.opacity = 1;
    clearTimeout(saveStateTimer);
    if (!err) saveStateTimer = setTimeout(() => (el.style.opacity = 0), 1500);
  }

  async function load() {
    try {
      const r = await fetch('/api/data');
      const d = await r.json();
      data = {
        ...structuredClone(DEFAULTS), ...d,
        settings: { ...DEFAULTS.settings, ...(d.settings || {}) },
      };
      // фоновые звуки удалены — чистим старые поля
      delete data.mixer;
      delete data.settings.ambientFocusOnly; delete data.settings.ambientAutoStart;
      if (!Array.isArray(d.categories)) data.categories = structuredClone(DEFAULTS.categories);
      data.goals = (Array.isArray(d.goals) ? d.goals : [])
        .filter((g) => g && typeof g.category === 'string')
        .map((g) => ({ category: g.category, target: Math.min(50, Math.max(1, Math.round(Number(g.target) || 1))) }));
      data.habits = (Array.isArray(d.habits) ? d.habits : []).filter((h) => h && h.id && typeof h.name === 'string');
      data.habitLog = d.habitLog && typeof d.habitLog === 'object' && !Array.isArray(d.habitLog) ? d.habitLog : {};
    } catch (e) {
      setSaveState('Не удалось загрузить данные', true);
    }
  }

  // ================= Таймер =================
  const MODES = {
    focus: { label: 'Фокус' },
    short: { label: 'Короткий перерыв' },
    long: { label: 'Длинный перерыв' },
  };
  const S = () => data.settings;
  const durationOf = (mode) => Math.round(S()[mode] * 60000);

  // timer: { mode, done, running, endAt, remaining, duration, startedAt }
  function freshTimer(mode = 'focus', done = 0) {
    return { mode, done, running: false, endAt: null, remaining: durationOf(mode), duration: durationOf(mode), startedAt: null };
  }
  const T = () => data.timer;

  function remainingMs() {
    const t = T();
    return t.running ? Math.max(0, t.endAt - Date.now()) : t.remaining;
  }

  function startTimer() {
    const t = T();
    if (t.running) return;
    if (!t.startedAt) t.startedAt = Date.now();
    t.endAt = Date.now() + t.remaining;
    t.running = true;
    if (S().notify && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    save();
    render();
  }
  function pauseTimer() {
    const t = T();
    if (!t.running) return;
    t.remaining = Math.max(0, t.endAt - Date.now());
    t.running = false;
    t.endAt = null;
    save();
    render();
  }
  function toggleTimer() { T().running ? pauseTimer() : startTimer(); }

  function resetTimer() {
    const t = T();
    data.timer = freshTimer(t.mode, t.done);
    save();
    render();
  }

  function nextMode(fromMode, done) {
    if (fromMode === 'focus') return done >= S().perRound ? 'long' : 'short';
    return 'focus';
  }

  function skip() {
    const t = T();
    // начатая помидорка при пропуске засчитывается с фактическим временем
    if (t.mode === 'focus' && t.startedAt && t.duration - remainingMs() >= 1000) {
      complete(true);
      return;
    }
    let done = t.done;
    if (t.mode === 'long') done = 0;
    const next = nextMode(t.mode, t.mode === 'focus' ? done + 1 : done);
    data.timer = freshTimer(next, done);
    save();
    render();
  }

  function complete(skipped) {
    const t = T();
    const endAt = skipped ? Date.now() : (t.endAt || Date.now());
    const elapsed = skipped ? t.duration - remainingMs() : t.duration;
    let done = t.done;
    if (t.mode === 'focus') {
      done += 1;
      const entry = {
        id: uid(),
        start: new Date(endAt - elapsed).toISOString(),
        end: new Date(endAt).toISOString(),
        minutes: Math.max(1, Math.round(elapsed / 60000)),
        category: '',
        description: '',
      };
      data.pomodoros.push(entry);
      viewOffset = 0;
      renderLog(entry.id);
      toast('🍅 Помидорка готова! Отметь, чем занимался.');
      if (!skipped) notify('Помидорка готова 🍅', done >= S().perRound ? 'Раунд завершён — время длинного перерыва.' : 'Время короткого перерыва.');
    } else {
      if (t.mode === 'long') done = 0;
      toast('Перерыв закончился — пора за работу.');
      if (!skipped) notify('Перерыв окончен', 'Начинаем следующую помидорку?');
    }
    if (S().chime && !skipped) chime(t.mode);
    const next = nextMode(t.mode, done);
    const auto = next === 'focus' ? S().autoFocus : S().autoBreak;
    data.timer = freshTimer(next, done);
    save(true);
    render();
    if (auto) startTimer();
  }

  // Короткий сигнал окончания (выключается в настройках)
  let audioCtx = null;
  function chime(mode) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + 0.05;
      const notes = mode === 'focus' ? [784, 988, 1175] : [1175, 988, 784];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        const t = t0 + i * 0.16;
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.15, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
        o.connect(g).connect(audioCtx.destination);
        o.start(t); o.stop(t + 1.3);
      });
    } catch (e) {}
  }

  function notify(title, body) {
    if (!S().notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, icon: 'favicon.svg', silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {}
  }

  // ---------- отрисовка таймера ----------
  const C = 2 * Math.PI * 132;
  const ring = $('ringProgress');
  const dot = $('ringDot');
  ring.style.strokeDasharray = C;

  function fmt(ms) {
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function renderTick() {
    const t = T();
    const rem = remainingMs();
    const frac = t.duration ? Math.min(1, Math.max(0, rem / t.duration)) : 0;
    ring.style.strokeDashoffset = C * (1 - frac);
    const a = 2 * Math.PI * frac;
    dot.setAttribute('cx', 150 + 132 * Math.cos(a));
    dot.setAttribute('cy', 150 + 132 * Math.sin(a));
    const text = fmt(rem);
    const timeEl = $('time');
    if (timeEl.textContent !== text) timeEl.textContent = text;
    const title = (IS_DEV ? 'DEV · ' : '') + (t.running || rem !== t.duration ? `${text} · ${MODES[t.mode].label}` : 'Pomodoro');
    if (document.title !== title) document.title = title;
  }

  function render() {
    const t = T();
    document.body.dataset.mode = t.mode;
    // SVG-градиент не всегда подхватывает смену CSS-переменных — задаём цвета явно
    const cs = getComputedStyle(document.body);
    document.querySelector('.grad-a').setAttribute('stop-color', cs.getPropertyValue('--accent').trim());
    document.querySelector('.grad-b').setAttribute('stop-color', cs.getPropertyValue('--accent-2').trim());
    document.body.classList.toggle('running', t.running);
    $('modeLabel').textContent = MODES[t.mode].label;
    $('startLabel').textContent = t.running ? 'Пауза' : (t.remaining < t.duration ? 'Дальше' : 'Старт');
    const per = S().perRound;
    const shown = t.mode === 'long' ? per : Math.min(t.done + 1, per);
    $('roundLabel').textContent = t.mode === 'focus'
      ? `Помидорка ${shown} из ${per}`
      : t.mode === 'long' ? 'Раунд завершён 🎉' : `Готово ${t.done} из ${per}`;
    const dots = $('roundDots');
    dots.innerHTML = '';
    for (let i = 0; i < per; i++) {
      const s = document.createElement('span');
      if (i < t.done || t.mode === 'long') s.className = 'done';
      else if (i === t.done && t.mode === 'focus') s.className = 'current';
      dots.appendChild(s);
    }
    renderTick();
  }

  function loop() {
    if (!T()) return;
    if (T().running && Date.now() >= T().endAt) complete();
    renderTick();
  }
  // rAF для плавности, setInterval — чтобы таймер доходил до конца в фоновой вкладке
  (function frame() { loop(); requestAnimationFrame(frame); })();
  setInterval(loop, 500);

  // ================= Журнал помидорок =================
  let viewOffset = 0; // 0 = сегодня, -1 = вчера ...
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const viewDate = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + viewOffset); return d; };
  const catById = (id) => data.categories.find((c) => c.id === id);
  const timeStr = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function fmtMinutes(min) {
    if (min < 60) return `${min} мин`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }

  function dayEntries(key) {
    return data.pomodoros.filter((p) => dayKey(new Date(p.end)) === key)
      .sort((a, b) => new Date(a.end) - new Date(b.end));
  }

  function streak() {
    const days = new Set(data.pomodoros.map((p) => dayKey(new Date(p.end))));
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function renderLog(highlightId) {
    const vd = viewDate();
    const key = dayKey(vd);
    const list = dayEntries(key);
    $('dayTitle').textContent = viewOffset === 0 ? 'Сегодня' : viewOffset === -1 ? 'Вчера'
      : vd.toLocaleDateString('ru-RU', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
    $('daySub').textContent = vd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
    $('nextDay').disabled = viewOffset >= 0;

    const ul = $('entries');
    ul.innerHTML = '';
    list.slice().reverse().forEach((p) => {
      const idx = list.indexOf(p) + 1;
      ul.appendChild(entryEl(p, idx, p.id === highlightId));
    });
    $('empty').style.display = list.length ? 'none' : 'block';
    renderStats();
  }

  function renderStats() {
    renderGoals();
    const list = dayEntries(dayKey(viewDate()));
    const total = list.reduce((s, p) => s + (p.minutes || 0), 0);
    $('statCount').textContent = list.length;
    $('statCount').nextElementSibling.textContent = plural(list.length, 'помидорка', 'помидорки', 'помидорок');
    $('statTime').textContent = fmtMinutes(total);
    const st = streak();
    $('statStreak').textContent = st;
    $('statStreak').nextElementSibling.textContent = plural(st, 'день подряд', 'дня подряд', 'дней подряд');

    const byCat = new Map();
    list.forEach((p) => {
      const k = catById(p.category) ? p.category : '';
      byCat.set(k, (byCat.get(k) || 0) + (p.minutes || 0));
    });
    const bar = $('catBar'), legend = $('catLegend');
    bar.innerHTML = ''; legend.innerHTML = '';
    if (!total) return;
    [...byCat.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, min]) => {
      const c = catById(k);
      const color = c ? c.color : 'rgba(255,255,255,0.18)';
      const seg = document.createElement('span');
      seg.style.width = (min / total) * 100 + '%';
      seg.style.background = color;
      seg.title = `${c ? c.name : 'Без категории'}: ${fmtMinutes(min)}`;
      bar.appendChild(seg);
      const l = document.createElement('span');
      l.innerHTML = `<i style="background:${color}"></i>`;
      l.append(`${c ? c.name : 'Без категории'} · ${fmtMinutes(min)}`);
      legend.appendChild(l);
    });
  }

  function entryEl(p, idx, highlight) {
    const li = document.createElement('li');
    li.className = 'entry';
    const cat = catById(p.category);
    if (cat) li.style.setProperty('--cat', cat.color);
    li.classList.toggle('no-cat', !cat);

    const num = document.createElement('div');
    num.className = 'entry-num';
    num.textContent = idx;

    const main = document.createElement('div');
    main.className = 'entry-main';
    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${timeStr(p.start)} – ${timeStr(p.end)}`;
    const dur = document.createElement('span');
    dur.textContent = `${p.minutes} мин`;

    meta.append(t, dur);

    const combo = categoryCombo(p, (c) => {
      if (c) li.style.setProperty('--cat', c.color); else li.style.removeProperty('--cat');
      li.classList.toggle('no-cat', !c);
    }, (open) => li.classList.toggle('combo-open', open));

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Что делал в эту помидорку?';
    ta.value = p.description || '';
    ta.maxLength = 2000;
    ta.addEventListener('input', () => { p.description = ta.value; save(); });

    main.append(meta, combo, ta);

    const del = document.createElement('button');
    del.className = 'entry-del';
    del.title = 'Удалить';
    del.setAttribute('aria-label', 'Удалить помидорку');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    del.addEventListener('click', () => {
      if (!confirm('Удалить эту помидорку?')) return;
      data.pomodoros = data.pomodoros.filter((x) => x.id !== p.id);
      save();
      renderLog();
    });

    li.append(num, main, del);
    return li;
  }

  // ---------- поле категории: выбор из списка или ввод новой ----------
  function nextCatColor() {
    const used = new Set(data.categories.map((c) => c.color.toLowerCase()));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[data.categories.length % PALETTE.length];
  }
  function findCatByName(name) {
    const n = name.trim().toLowerCase();
    return data.categories.find((c) => c.name.trim().toLowerCase() === n);
  }

  function categoryCombo(p, onChange, onToggle, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'combo';
    const dotEl = document.createElement('i');
    dotEl.className = 'combo-dot';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = opts.placeholder || 'Выбери или впиши категорию';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');
    const chev = document.createElement('span');
    chev.className = 'combo-chev';
    chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
    const list = document.createElement('ul');
    list.className = 'combo-list';
    list.setAttribute('role', 'listbox');
    wrap.append(dotEl, input, chev, list);

    let items = [];
    let active = -1;
    let isOpen = false;

    function showCurrent() {
      const c = catById(p.category);
      input.value = c ? c.name : '';
      dotEl.style.background = c ? c.color : 'transparent';
      dotEl.classList.toggle('is-unset', !c);
    }

    function choose(cat) {
      if (cat && opts.canChoose && !opts.canChoose(cat)) { showCurrent(); return; }
      p.category = cat ? cat.id : '';
      showCurrent();
      onChange(cat);
      save();
      renderStats();
    }

    function commitText() {
      const text = input.value.trim();
      if (!text) return opts.allowNone === false ? showCurrent() : choose(null);
      const existing = findCatByName(text);
      if (existing) return choose(existing);
      const cat = { id: uid(), name: text, color: nextCatColor() };
      data.categories.push(cat);
      choose(cat);
      toast(`Категория «${text}» добавлена`);
    }

    function build(filter) {
      const q = filter.trim().toLowerCase();
      items = [];
      data.categories.forEach((c) => {
        if (!q || c.name.toLowerCase().includes(q)) items.push({ type: 'cat', cat: c });
      });
      if (q && !findCatByName(filter)) items.push({ type: 'new', text: filter.trim() });
      if (!q && p.category && opts.allowNone !== false) items.push({ type: 'none' });
      list.innerHTML = '';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        if (it.type === 'cat') {
          li.innerHTML = `<i style="background:${it.cat.color}"></i>`;
          li.append(it.cat.name);
          if (it.cat.id === p.category) li.classList.add('current');
        } else if (it.type === 'new') {
          li.className = 'combo-new';
          li.append(`+ Добавить «${it.text}»`);
        } else {
          li.className = 'combo-none';
          li.append('Убрать категорию');
        }
        li.addEventListener('mousedown', (e) => e.preventDefault()); // не терять фокус
        li.addEventListener('click', () => pick(i));
        li.addEventListener('mousemove', () => setActive(i));
        list.appendChild(li);
      });
      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'combo-empty';
        li.textContent = 'Категорий пока нет — впиши название';
        list.appendChild(li);
      }
      setActive(q ? 0 : items.findIndex((it) => it.type === 'cat' && it.cat.id === p.category));
    }

    function setActive(i) {
      active = i;
      [...list.children].forEach((el, k) => el.classList.toggle('active', k === i));
      const el = list.children[i];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function pick(i) {
      const it = items[i];
      if (!it) return;
      if (it.type === 'cat') choose(it.cat);
      else if (it.type === 'new') { input.value = it.text; commitText(); }
      else choose(null);
      close();
      input.blur();
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      wrap.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
      onToggle(true);
      build('');
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      wrap.classList.remove('open');
      input.setAttribute('aria-expanded', 'false');
      onToggle(false);
    }

    input.addEventListener('focus', () => { open(); input.select(); });
    input.addEventListener('mousedown', () => { if (document.activeElement === input) open(); });
    input.addEventListener('input', () => { open(); build(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); open(); setActive(Math.min(items.length - 1, active + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (isOpen && active >= 0 && items[active]) pick(active);
        else { commitText(); close(); input.blur(); }
      } else if (e.key === 'Escape') { showCurrent(); close(); input.blur(); }
    });
    input.addEventListener('blur', () => {
      // ушли из поля — сохраняем введённое (существующую категорию или новую)
      if (!isOpen) return;
      const c = catById(p.category);
      if (input.value.trim() !== (c ? c.name : '')) commitText();
      else showCurrent();
      close();
    });
    chev.addEventListener('mousedown', (e) => { e.preventDefault(); if (isOpen) { close(); input.blur(); } else input.focus(); });

    showCurrent();
    return wrap;
  }

  $('prevDay').onclick = () => { viewOffset--; renderLog(); };
  $('nextDay').onclick = () => { if (viewOffset < 0) { viewOffset++; renderLog(); } };
  $('addManual').onclick = () => {
    const end = viewDate();
    const now = new Date();
    end.setHours(now.getHours(), now.getMinutes(), 0, 0);
    const minutes = S().focus;
    const p = {
      id: uid(), start: new Date(end - minutes * 60000).toISOString(), end: end.toISOString(),
      minutes, category: '', description: '',
    };
    data.pomodoros.push(p);
    save();
    renderLog(p.id);
  };

  // ================= Цели =================
  function goalProgress(key) {
    const list = dayEntries(key);
    return data.goals
      .filter((g) => catById(g.category))
      .map((g) => {
        const done = list.filter((p) => p.category === g.category).length;
        return { goal: g, cat: catById(g.category), done, complete: done >= g.target };
      });
  }

  let goalsDoneToday = null; // для уведомления о свежевыполненной цели
  function renderGoals() {
    const box = $('goals');
    const prog = goalProgress(dayKey(viewDate()));
    box.innerHTML = '';
    if (prog.length) {
      const doneCount = prog.filter((x) => x.complete).length;
      const head = document.createElement('div');
      head.className = 'goals-head';
      const h = document.createElement('span');
      h.className = 'goals-title';
      h.textContent = 'Цели на день';
      const sum = document.createElement('span');
      sum.className = 'goals-sum' + (doneCount === prog.length ? ' all' : '');
      sum.textContent = doneCount === prog.length ? 'Все выполнены 🎉' : `${doneCount} из ${prog.length}`;
      const edit = document.createElement('button');
      edit.className = 'goals-edit';
      edit.textContent = 'Изменить';
      edit.onclick = openGoals;
      head.append(h, sum, edit);
      box.appendChild(head);
      prog.forEach(({ goal, cat, done, complete }) => {
        const row = document.createElement('div');
        row.className = 'goal' + (complete ? ' complete' : '');
        row.style.setProperty('--c', cat.color);
        const name = document.createElement('span');
        name.className = 'goal-name';
        name.innerHTML = '<i></i>';
        name.append(cat.name);
        const bar = document.createElement('div');
        bar.className = 'goal-bar';
        const fill = document.createElement('span');
        fill.style.width = Math.min(100, (done / goal.target) * 100) + '%';
        bar.appendChild(fill);
        const cnt = document.createElement('span');
        cnt.className = 'goal-count';
        cnt.textContent = `${done} / ${goal.target}`;
        if (complete) cnt.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>');
        row.append(name, bar, cnt);
        box.appendChild(row);
      });
    }
    // уведомляем, когда цель на сегодня только что выполнена
    const today = goalProgress(dayKey(new Date()));
    const nowDone = new Set(today.filter((x) => x.complete).map((x) => x.goal.category));
    if (goalsDoneToday) {
      today.forEach((x) => {
        if (x.complete && !goalsDoneToday.has(x.goal.category)) toast(`🎯 Цель «${x.cat.name}» выполнена!`);
      });
    }
    goalsDoneToday = nowDone;
  }

  const goalsDlg = $('goalsDlg');
  function openGoals() {
    renderGoalEditor();
    goalsDlg.showModal();
  }
  $('openGoals').onclick = openGoals;
  goalsDlg.addEventListener('click', (e) => { if (e.target === goalsDlg) goalsDlg.close(); });
  goalsDlg.addEventListener('close', () => {
    // цели без категории не сохраняем
    const before = data.goals.length;
    data.goals = data.goals.filter((g) => catById(g.category));
    if (data.goals.length !== before) save();
    goalsDoneToday = null;
    renderLog();
  });

  function goalsChanged() {
    save();
    const total = data.goals.filter((g) => catById(g.category)).reduce((s, g) => s + g.target, 0);
    $('goalTotal').textContent = total
      ? `Всего за день: ${total} ${plural(total, 'помидорка', 'помидорки', 'помидорок')} · ${fmtMinutes(total * S().focus)}`
      : '';
  }

  function renderGoalEditor() {
    const ul = $('goalEditor');
    ul.innerHTML = '';
    if (!data.goals.length) {
      const li = document.createElement('li');
      li.className = 'goal-editor-empty';
      li.textContent = 'Целей пока нет — добавь первую.';
      ul.appendChild(li);
    }
    data.goals.forEach((g) => {
      const li = document.createElement('li');
      li.className = 'goal-row';
      const combo = categoryCombo(g, () => goalsChanged(), (open) => li.classList.toggle('combo-open', open), {
        allowNone: false,
        placeholder: 'Категория',
        canChoose: (cat) => {
          const dup = data.goals.some((x) => x !== g && x.category === cat.id);
          if (dup) toast(`«${cat.name}» уже есть в целях`);
          return !dup;
        },
      });

      const step = document.createElement('div');
      step.className = 'stepper';
      const minus = document.createElement('button');
      minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'Меньше');
      const num = document.createElement('input');
      num.type = 'number'; num.min = 1; num.max = 50; num.value = g.target;
      num.setAttribute('aria-label', 'Помидорок в день');
      const plus = document.createElement('button');
      plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Больше');
      const setT = (v) => {
        g.target = Math.min(50, Math.max(1, Math.round(Number(v) || 1)));
        num.value = g.target;
        minus.disabled = g.target <= 1;
        goalsChanged();
      };
      minus.onclick = () => setT(g.target - 1);
      plus.onclick = () => setT(g.target + 1);
      num.addEventListener('change', () => setT(num.value));
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setT(num.value); } });
      minus.disabled = g.target <= 1;
      step.append(minus, num, plus);
      const unit = document.createElement('span');
      unit.className = 'goal-unit';
      unit.textContent = '🍅 в день';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn small goal-del';
      del.title = 'Удалить цель';
      del.setAttribute('aria-label', 'Удалить цель');
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
      del.onclick = () => {
        data.goals = data.goals.filter((x) => x !== g);
        goalsChanged();
        renderGoalEditor();
      };
      li.append(combo, step, unit, del);
      ul.appendChild(li);
    });
    goalsChanged();
  }

  $('addGoal').onclick = () => {
    const used = new Set(data.goals.map((g) => g.category));
    const free = data.categories.find((c) => !used.has(c.id));
    data.goals.push({ category: free ? free.id : '', target: 4 });
    renderGoalEditor();
    if (!free) {
      // свободных категорий нет — сразу ставим курсор, чтобы вписать новую
      const inputs = $('goalEditor').querySelectorAll('.combo input');
      inputs[inputs.length - 1].focus();
    }
  };

  // ================= Привычки =================
  const habitsDlg = $('habitsDlg');
  let hbOffset = 0; // 0 = сегодня
  swatchPicker($('hbColor'), '#34d399');
  swatchPicker($('newCatColor'), '#fbbf24');

  const habitDone = (id, key) => (data.habitLog[key] || []).includes(id);
  function toggleHabit(id, key) {
    const list = data.habitLog[key] || [];
    data.habitLog[key] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    if (!data.habitLog[key].length) delete data.habitLog[key];
    save();
  }
  // серия подряд, заканчивающаяся днём `date` (если сегодня ещё не отмечено — считаем со вчера)
  function habitStreak(id, date) {
    let d = new Date(date);
    if (!habitDone(id, dayKey(d)) && dayKey(d) === dayKey(new Date())) d = addDays(d, -1);
    let n = 0;
    while (habitDone(id, dayKey(d))) { n++; d = addDays(d, -1); }
    return n;
  }
  const habitsOnDay = (key) => data.habits.filter((h) => !h.created || h.created <= key);

  function hbDate() { const d = startOfDay(new Date()); return addDays(d, hbOffset); }

  function renderHabits() {
    const date = hbDate();
    const key = dayKey(date);
    $('hbDayTitle').textContent = hbOffset === 0 ? 'Сегодня' : hbOffset === -1 ? 'Вчера'
      : date.toLocaleDateString('ru-RU', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
    $('hbDaySub').textContent = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    $('hbNext').disabled = hbOffset >= 0;

    const list = data.habits;
    const active = habitsOnDay(key);
    const doneN = active.filter((h) => habitDone(h.id, key)).length;
    const sum = $('hbSummary');
    sum.innerHTML = '';
    if (active.length) {
      const pct = Math.round((doneN / active.length) * 100);
      sum.innerHTML = `<div class="hb-sum-text"><b>${doneN} из ${active.length}</b><span>${doneN === active.length ? 'Всё сделано 🎉' : 'сделано'}</span></div>
        <div class="hb-sum-bar"><span style="width:${pct}%"></span></div>`;
    }

    const ul = $('hbList');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="hb-empty">Привычек пока нет. Добавь первую ниже — например «Зарядка», «Чтение 20 минут» или «Без сладкого».</li>';
    }
    list.forEach((h) => {
      const done = habitDone(h.id, key);
      const notYet = h.created && h.created > key;
      const li = document.createElement('li');
      li.className = 'hb' + (done ? ' done' : '') + (notYet ? ' not-yet' : '');
      li.style.setProperty('--hc', h.color);

      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'hb-check';
      check.setAttribute('role', 'checkbox');
      check.setAttribute('aria-checked', done);
      check.setAttribute('aria-label', h.name);
      check.disabled = !!notYet;
      check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2L18.5 8"/></svg>';
      check.onclick = () => { toggleHabit(h.id, key); renderHabits(); };

      const main = document.createElement('div');
      main.className = 'hb-main';
      const name = document.createElement('div');
      name.className = 'hb-name';
      name.textContent = h.name;
      name.onclick = () => { if (!notYet) { toggleHabit(h.id, key); renderHabits(); } };
      const meta = document.createElement('div');
      meta.className = 'hb-meta';
      const st = habitStreak(h.id, date);
      meta.textContent = notYet ? 'ещё не была создана в этот день'
        : st ? `🔥 ${st} ${plural(st, 'день', 'дня', 'дней')} подряд` : 'серии пока нет';
      main.append(name, meta);

      // последние 7 дней до выбранного
      const week = document.createElement('div');
      week.className = 'hb-week';
      for (let i = 6; i >= 0; i--) {
        const d = addDays(date, -i);
        const k = dayKey(d);
        const dot = document.createElement('span');
        const before = h.created && h.created > k;
        dot.className = 'hb-dot' + (habitDone(h.id, k) ? ' on' : '') + (before ? ' before' : '') + (i === 0 ? ' cur' : '');
        dot.title = d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
        dot.textContent = d.toLocaleDateString('ru-RU', { weekday: 'short' }).slice(0, 2);
        week.appendChild(dot);
      }

      const actions = document.createElement('div');
      actions.className = 'hb-actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'hb-act'; edit.title = 'Переименовать';
      edit.setAttribute('aria-label', `Переименовать «${h.name}»`);
      edit.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>';
      edit.onclick = () => {
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'hb-rename'; input.value = h.name; input.maxLength = 60;
        name.replaceWith(input);
        input.focus(); input.select();
        const done = (commit) => {
          if (commit && input.value.trim()) { h.name = input.value.trim(); save(); }
          renderHabits();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(true); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        });
        input.addEventListener('blur', () => done(true));
      };
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'hb-act danger'; del.title = 'Удалить';
      del.setAttribute('aria-label', `Удалить «${h.name}»`);
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
      del.onclick = () => {
        if (!confirm(`Удалить привычку «${h.name}» вместе со всей её историей?`)) return;
        data.habits = data.habits.filter((x) => x.id !== h.id);
        Object.keys(data.habitLog).forEach((k) => {
          data.habitLog[k] = data.habitLog[k].filter((x) => x !== h.id);
          if (!data.habitLog[k].length) delete data.habitLog[k];
        });
        save(); renderHabits();
      };
      actions.append(edit, del);

      li.append(check, main, week, actions);
      ul.appendChild(li);
    });
  }

  function addHabit() {
    const name = $('hbName').value.trim();
    if (!name) { $('hbName').focus(); return; }
    data.habits.push({ id: uid(), name, color: $('hbColor').value, created: dayKey(new Date()) });
    $('hbName').value = '';
    const used = new Set(data.habits.map((h) => h.color.toLowerCase()));
    $('hbColor').value = PALETTE.find((c) => !used.has(c)) || PALETTE[data.habits.length % PALETTE.length];
    save();
    renderHabits();
  }
  $('hbAdd').onclick = addHabit;
  $('hbName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addHabit(); } });
  $('hbPrev').onclick = () => { hbOffset--; renderHabits(); };
  $('hbNext').onclick = () => { if (hbOffset < 0) { hbOffset++; renderHabits(); } };
  $('openHabits').onclick = () => {
    hbOffset = 0;
    const used = new Set(data.habits.map((h) => h.color.toLowerCase()));
    $('hbColor').value = PALETTE.find((c) => !used.has(c)) || PALETTE[0];
    renderHabits();
    habitsDlg.showModal();
  };
  $('closeHabits').onclick = () => habitsDlg.close();
  habitsDlg.addEventListener('click', (e) => { if (e.target === habitsDlg) habitsDlg.close(); });

  // ================= Статистика =================
  const statsDlg = $('statsDlg');
  let statsRange = 30;
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const fmtDay = (d, withWeekday) => d.toLocaleDateString('ru-RU', withWeekday
    ? { weekday: 'short', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long' });

  // агрегат по дням: key -> { count, minutes, byCat: Map(catKey -> count) }
  function dayIndex() {
    const idx = new Map();
    data.pomodoros.forEach((p) => {
      const k = dayKey(new Date(p.end));
      if (!idx.has(k)) idx.set(k, { count: 0, minutes: 0, byCat: new Map() });
      const d = idx.get(k);
      const ck = catById(p.category) ? p.category : '';
      d.count++;
      d.minutes += p.minutes || 0;
      d.byCat.set(ck, (d.byCat.get(ck) || 0) + 1);
    });
    return idx;
  }
  const catName = (k) => (catById(k) ? catById(k).name : 'Без категории');
  const catColor = (k) => (catById(k) ? catById(k).color : '#6b6474');
  // порядок категорий фиксирован (как в списке категорий), «без категории» — в конце
  const catOrder = (keys) => {
    const order = data.categories.map((c) => c.id).filter((id) => keys.has(id));
    if (keys.has('')) order.push('');
    return order;
  };

  function allGoalsMet(dayData) {
    const goals = data.goals.filter((g) => catById(g.category));
    if (!goals.length || !dayData) return false;
    return goals.every((g) => (dayData.byCat.get(g.category) || 0) >= g.target);
  }

  let statsDay = startOfDay(new Date());
  function openStatsDay(date) {
    statsRange = 1;
    statsDay = startOfDay(date);
    hideTip();
    renderStatsDlg();
    statsDlg.querySelector('.modal-body').scrollTop = 0;
  }

  function renderStatsDlg() {
    document.querySelectorAll('#statsRange button').forEach((b) => {
      const on = Number(b.dataset.range) === statsRange;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
    const dayMode = statsRange === 1;
    $('stDay').hidden = !dayMode;
    $('stPeriod').hidden = dayMode;
    if (dayMode) { renderStatsDay(); return; }
    const idx = dayIndex();
    const today = startOfDay(new Date());
    const from = addDays(today, -(statsRange - 1));
    const days = [];
    for (let d = new Date(from); d <= today; d = addDays(d, 1)) days.push({ date: new Date(d), key: dayKey(d), data: idx.get(dayKey(d)) });

    // ---- плитки ----
    const total = days.reduce((s, d) => s + (d.data ? d.data.count : 0), 0);
    const minutes = days.reduce((s, d) => s + (d.data ? d.data.minutes : 0), 0);
    const active = days.filter((d) => d.data && d.data.count);
    const best = active.reduce((b, d) => (!b || d.data.count > b.data.count ? d : b), null);
    // рекордная серия за всё время
    const allKeys = [...idx.keys()].sort();
    let record = 0, run = 0, prev = null;
    allKeys.forEach((k) => {
      const d = new Date(k + 'T12:00:00');
      run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
      record = Math.max(record, run);
      prev = d;
    });
    const tiles = [
      { v: total, l: plural(total, 'помидорка', 'помидорки', 'помидорок') },
      { v: minutes >= 600 ? `${Math.round(minutes / 60)} ч` : fmtMinutes(minutes), l: 'в фокусе' },
      { v: active.length ? (total / active.length).toFixed(1).replace('.0', '').replace('.', ',') : '0', l: 'в среднем за рабочий день' },
      { v: best ? best.data.count : '—', l: best ? `лучший день · ${fmtDay(best.date)}` : 'лучший день' },
      { v: streak(), l: `серия · рекорд ${record}` },
    ];
    if (data.goals.some((g) => catById(g.category))) {
      const met = days.filter((d) => allGoalsMet(d.data)).length;
      tiles.push({ v: `${met} / ${statsRange}`, l: 'дней с выполненными целями' });
    }
    if (data.habits.length) {
      let possible = 0, done = 0;
      days.forEach((d) => habitsOnDay(d.key).forEach((h) => { possible++; if (habitDone(h.id, d.key)) done++; }));
      tiles.push({ v: possible ? `${Math.round((done / possible) * 100)}%` : '—', l: 'выполнение привычек' });
    }
    if (SCR && SCR.days) {
      const withData = days.filter((d) => SCR.days[d.key] && SCR.days[d.key].total > 0);
      if (withData.length) {
        const avg = withData.reduce((s, d) => s + SCR.days[d.key].total, 0) / withData.length;
        tiles.push({ v: fmtSec(avg), l: 'в телефоне в среднем за день' });
      }
    }
    $('stTiles').innerHTML = tiles.map((t) => `<div class="st-tile"><div class="st-v">${esc(t.v)}</div><div class="st-l">${esc(t.l)}</div></div>`).join('');

    // ---- столбики (для года — по неделям) ----
    let buckets;
    if (statsRange === 365) {
      buckets = [];
      for (let i = 0; i < days.length; i += 7) {
        const chunk = days.slice(i, i + 7);
        const byCat = new Map();
        let count = 0, mins = 0;
        chunk.forEach((d) => {
          if (!d.data) return;
          count += d.data.count; mins += d.data.minutes;
          d.data.byCat.forEach((n, k) => byCat.set(k, (byCat.get(k) || 0) + n));
        });
        buckets.push({ from: chunk[0].date, to: chunk[chunk.length - 1].date, count, minutes: mins, byCat });
      }
      $('stChartTitle').textContent = 'Помидорки по неделям';
    } else {
      buckets = days.map((d) => ({ from: d.date, to: d.date, count: d.data ? d.data.count : 0, minutes: d.data ? d.data.minutes : 0, byCat: d.data ? d.data.byCat : new Map() }));
      $('stChartTitle').textContent = 'Помидорки по дням';
    }
    renderBarChart(buckets);

    // ---- легенда и категории за период ----
    const periodCats = new Map();
    days.forEach((d) => d.data && d.data.byCat.forEach((n, k) => periodCats.set(k, (periodCats.get(k) || 0) + n)));
    const order = catOrder(new Set(periodCats.keys()));
    $('stLegend').innerHTML = order.length > 1
      ? order.map((k) => `<span><i style="background:${catColor(k)}"></i>${esc(catName(k))}</span>`).join('')
      : '';
    const sorted = [...periodCats.entries()].sort((a, b) => b[1] - a[1]);
    const maxCat = sorted.length ? sorted[0][1] : 1;
    const focusMin = new Map();
    data.pomodoros.forEach((p) => {
      const t = startOfDay(new Date(p.end));
      if (t < from || t > today) return;
      const k = catById(p.category) ? p.category : '';
      focusMin.set(k, (focusMin.get(k) || 0) + (p.minutes || 0));
    });
    $('stCats').innerHTML = sorted.length ? sorted.map(([k, n]) => `
      <div class="st-cat">
        <span class="st-cat-name"><i style="background:${catColor(k)}"></i>${esc(catName(k))}</span>
        <span class="st-cat-bar"><span style="width:${(n / maxCat) * 100}%;background:${catColor(k)}"></span></span>
        <span class="st-cat-n">${n}</span>
        <span class="st-cat-t">${fmtMinutes(focusMin.get(k) || 0)}</span>
        <span class="st-cat-p">${Math.round((n / total) * 100)}%</span>
      </div>`).join('') : '<div class="st-empty">За этот период помидорок нет</div>';

    renderHabitStats(days);
    renderHeatmap(idx, today);
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    const steps = [5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200];
    return steps.find((s) => s >= v) || Math.ceil(v / 50) * 50;
  }

  function renderBarChart(buckets) {
    const el = $('stChart');
    const max = niceMax(Math.max(0, ...buckets.map((b) => b.count)));
    const ticks = [0, max / 2, max].map((t) => Math.round(t));
    const n = buckets.length;
    const labelEvery = n <= 7 ? 1 : n <= 31 ? 5 : n <= 53 ? 8 : 15;
    const cols = buckets.map((b, i) => {
      const keys = catOrder(new Set(b.byCat.keys()));
      const segs = keys.map((k) => `<span class="seg-fill" style="flex-grow:${b.byCat.get(k)};background:${catColor(k)}"></span>`).join('');
      const h = (b.count / max) * 100;
      const isToday = dayKey(b.to) === dayKey(new Date()) && statsRange !== 365;
      let label = '';
      if (n <= 7) label = b.from.toLocaleDateString('ru-RU', { weekday: 'short' });
      else if ((n - 1 - i) % labelEvery === 0) label = `${b.from.getDate()} ${MONTHS_SHORT[b.from.getMonth()]}`;
      return `<div class="bar-col${isToday ? ' today' : ''}" data-i="${i}">
        <div class="bar-track"><div class="bar" style="height:${h}%">${segs}</div></div>
        <div class="bar-x">${label}</div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="chart-grid">${ticks.slice().reverse().map((t) => `<div class="gl"><span>${t}</span></div>`).join('')}</div>
      <div class="chart-cols" style="--n:${n}">${cols}</div>`;
    el.querySelectorAll('.bar-col').forEach((col) => {
      const b = buckets[Number(col.dataset.i)];
      col.addEventListener('mouseenter', () => {
        const title = b.from.getTime() === b.to.getTime() ? fmtDay(b.from, true) : `${fmtDay(b.from)} — ${fmtDay(b.to)}`;
        const keys = [...b.byCat.entries()].sort((a, c) => c[1] - a[1]);
        showTip(col, `<div class="tip-t">${esc(title)}</div>
          <div class="tip-sum">${b.count} ${plural(b.count, 'помидорка', 'помидорки', 'помидорок')} · ${fmtMinutes(b.minutes)}</div>
          ${keys.map(([k, v]) => `<div class="tip-row"><i style="background:${catColor(k)}"></i><span>${esc(catName(k))}</span><b>${v}</b></div>`).join('')}`);
      });
      col.addEventListener('mouseleave', hideTip);
      col.addEventListener('click', () => openStatsDay(b.from));
    });
  }

  const HEAT_LEVELS = [0, 1, 3, 5, 8]; // пороги: 1–2, 3–4, 5–7, 8+
  function heatLevel(n) { let l = 0; HEAT_LEVELS.forEach((t, i) => { if (n >= t && t > 0) l = i; }); return n ? l : 0; }

  function renderHeatmap(idx, today) {
    // 53 недели, колонки с понедельника
    const dow = (today.getDay() + 6) % 7;
    const start = addDays(today, -dow - 52 * 7);
    let html = '<div class="heat-days"><span></span><span>Пн</span><span></span><span>Ср</span><span></span><span>Пт</span><span></span></div>';
    let monthsHtml = '';
    let lastMonth = -1;
    for (let w = 0; w < 53; w++) {
      const weekStart = addDays(start, w * 7);
      if (weekStart.getMonth() !== lastMonth && weekStart.getDate() <= 7) {
        monthsHtml += `<span style="grid-column:${w + 2}">${MONTHS_SHORT[weekStart.getMonth()]}</span>`;
        lastMonth = weekStart.getMonth();
      }
      html += '<div class="heat-week">';
      for (let d = 0; d < 7; d++) {
        const day = addDays(weekStart, d);
        if (day > today) { html += '<span class="hc future"></span>'; continue; }
        const k = dayKey(day);
        const dd = idx.get(k);
        const c = dd ? dd.count : 0;
        html += `<span class="hc l${heatLevel(c)}${allGoalsMet(dd) ? ' goal' : ''}" data-k="${k}"></span>`;
      }
      html += '</div>';
    }
    const el = $('stHeat');
    el.innerHTML = `<div class="heat-months">${monthsHtml}</div><div class="heat-grid">${html}</div>`;
    el.querySelectorAll('.hc[data-k]').forEach((cell) => {
      cell.addEventListener('mouseenter', () => {
        const k = cell.dataset.k;
        const dd = idx.get(k);
        const date = new Date(k + 'T12:00:00');
        showTip(cell, `<div class="tip-t">${esc(fmtDay(date, true))}</div>
          <div class="tip-sum">${dd ? `${dd.count} ${plural(dd.count, 'помидорка', 'помидорки', 'помидорок')} · ${fmtMinutes(dd.minutes)}` : 'Нет помидорок'}</div>
          ${allGoalsMet(dd) ? '<div class="tip-goal">🎯 Все цели выполнены</div>' : ''}
          ${habitTipLine(k)}`);
      });
      cell.addEventListener('mouseleave', hideTip);
      cell.addEventListener('click', () => openStatsDay(new Date(cell.dataset.k + 'T12:00:00')));
    });
    $('stHeatScale').innerHTML = 'Меньше <span class="hc l0"></span><span class="hc l1"></span><span class="hc l2"></span><span class="hc l3"></span><span class="hc l4"></span> Больше'
      + (data.goals.length ? '<span class="heat-goal-key"><span class="hc l2 goal"></span> все цели выполнены</span>' : '');
    // прокрутить к сегодняшнему дню на узких экранах
    const wrap = el.parentElement;
    wrap.scrollLeft = wrap.scrollWidth;
  }

  function habitTipLine(k) {
    const hs = habitsOnDay(k);
    if (!hs.length) return '';
    const n = hs.filter((h) => habitDone(h.id, k)).length;
    return `<div class="tip-sum">Привычки: ${n} из ${hs.length}</div>`;
  }

  function renderHabitStats(days) {
    const sec = $('stHabitsSec');
    sec.hidden = !data.habits.length;
    if (!data.habits.length) return;
    const weekly = statsRange === 365;
    const box = $('stHabits');
    box.innerHTML = '';
    data.habits.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'sth';
      row.style.setProperty('--hc', h.color);
      const relevant = days.filter((d) => !h.created || h.created <= d.key);
      const doneDays = relevant.filter((d) => habitDone(h.id, d.key)).length;
      const pct = relevant.length ? Math.round((doneDays / relevant.length) * 100) : 0;
      const strip = document.createElement('div');
      strip.className = 'sth-strip' + (weekly ? ' weekly' : '');
      if (weekly) {
        for (let i = 0; i < days.length; i += 7) {
          const chunk = days.slice(i, i + 7);
          const rel = chunk.filter((d) => !h.created || h.created <= d.key);
          const n = rel.filter((d) => habitDone(h.id, d.key)).length;
          const c = document.createElement('span');
          c.className = 'sth-c' + (!rel.length ? ' before' : '');
          if (rel.length) c.style.setProperty('--a', n / 7);
          c.title = `${fmtDay(chunk[0].date)} — ${fmtDay(chunk[chunk.length - 1].date)}: ${n} из ${rel.length}`;
          c.addEventListener('click', () => openStatsDay(chunk[0].date));
          strip.appendChild(c);
        }
      } else {
        days.forEach((d) => {
          const c = document.createElement('span');
          const before = h.created && h.created > d.key;
          const on = habitDone(h.id, d.key);
          c.className = 'sth-c' + (before ? ' before' : '') + (on ? ' on' : '');
          c.title = `${fmtDay(d.date, true)}: ${before ? 'привычки ещё не было' : on ? 'сделано' : 'не сделано'}`;
          c.addEventListener('click', () => openStatsDay(d.date));
          strip.appendChild(c);
        });
      }
      strip.style.setProperty('--n', strip.children.length);
      const st = habitStreak(h.id, startOfDay(new Date()));
      row.innerHTML = `<span class="sth-name"><i></i>${esc(h.name)}</span>`;
      row.appendChild(strip);
      row.insertAdjacentHTML('beforeend', `<span class="sth-n">${doneDays} / ${relevant.length}</span>
        <span class="sth-p">${pct}%</span>
        <span class="sth-s" title="Текущая серия">${st ? '🔥 ' + st : '—'}</span>`);
      box.appendChild(row);
    });
  }

  // ---------- один день ----------
  let sdPhoneAll = false;

  // «Как прошёл день»: помидорки блоками по времени + телефон по часам
  function dayTimelineHTML(date, list, scrDay) {
    const dayStart = startOfDay(date).getTime();
    const minOf = (t) => Math.max(0, Math.min(1440, (t - dayStart) / 60000));
    const poms = list.map((p, idx) => ({ p, idx, s: minOf(new Date(p.start).getTime()), e: minOf(new Date(p.end).getTime()) })).filter((x) => x.e > x.s);
    const hourSec = scrDay ? scrDay.hours.map((h) => Object.values(h).reduce((a, v) => a + v, 0)) : Array(24).fill(0);
    let lo = 24, hi = 0;
    poms.forEach((x) => { lo = Math.min(lo, Math.floor(x.s / 60)); hi = Math.max(hi, Math.ceil(x.e / 60)); });
    hourSec.forEach((v, i) => { if (v > 0) { lo = Math.min(lo, i); hi = Math.max(hi, i + 1); } });
    if (lo >= hi) return '';
    if (hi - lo < 8) { hi = Math.min(24, lo + 8); lo = Math.max(0, hi - 8); }
    const span = (hi - lo) * 60;
    const pct = (m) => ((m - lo * 60) / span) * 100;
    const step = hi - lo > 14 ? 3 : 2;
    const ticks = [];
    for (let h = Math.ceil(lo / step) * step; h <= hi; h += step) ticks.push(h);
    const now = new Date();
    const nowLine = dayKey(now) === dayKey(date) && now.getHours() >= lo && now.getHours() < hi
      ? `<span class="tl-now" style="left:${pct(now.getHours() * 60 + now.getMinutes())}%"></span>` : '';
    const blocks = poms.map((x) => {
      const k = catById(x.p.category) ? x.p.category : '';
      return `<span class="tl-pom" data-i="${x.idx}" style="left:${pct(x.s)}%;width:${Math.max(0.6, pct(x.e) - pct(x.s))}%;background:${catColor(k)}"></span>`;
    }).join('');
    const phoneCols = [];
    for (let h = lo; h < hi; h++) {
      const m = new Map(scrDay ? Object.entries(scrDay.hours[h]) : []);
      phoneCols.push(`<span class="tl-ph" data-h="${h}"><span class="bar" style="height:${Math.min(100, (hourSec[h] / 3600) * 100)}%">${stackSegs(m)}</span></span>`);
    }
    const focusMin = list.reduce((a, p) => a + (p.minutes || 0), 0);
    return `<section class="st-section"><div class="st-head"><h3>Как прошёл день</h3>
        <span class="tl-legend"><span><i class="f"></i>помидорки</span>${scrDay ? '<span><i class="p"></i>телефон, минут в час</span>' : ''}</span></div>
      <div class="tl">
        <div class="tl-lane"><span class="tl-label">Фокус<small>${fmtMinutes(focusMin)}</small></span>
          <div class="tl-track focus">${ticks.map((h) => `<span class="tl-grid" style="left:${pct(h * 60)}%"></span>`).join('')}${blocks}${nowLine}</div></div>
        ${scrDay ? `<div class="tl-lane"><span class="tl-label">Телефон<small>${fmtSec(scrDay.total)}</small></span>
          <div class="tl-track phone" style="--n:${hi - lo}">${ticks.map((h) => `<span class="tl-grid" style="left:${pct(h * 60)}%"></span>`).join('')}${phoneCols.join('')}${nowLine}</div></div>` : ''}
        <div class="tl-lane axis"><span class="tl-label"></span><div class="tl-track">${ticks.map((h) => `<span class="tl-tick" style="left:${pct(h * 60)}%">${String(h % 24).padStart(2, '0')}:00</span>`).join('')}</div></div>
      </div></section>`;
  }

  function renderStatsDay() {
    const today = startOfDay(new Date());
    if (statsDay > today) statsDay = today;
    const date = statsDay;
    const key = dayKey(date);
    const list = dayEntries(key);
    const minutes = list.reduce((s, p) => s + (p.minutes || 0), 0);
    const diff = Math.round((today - date) / 86400000);
    const rel = diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : `${diff} ${plural(diff, 'день', 'дня', 'дней')} назад`;
    const title = date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (c) => c.toUpperCase());
    const year = date.getFullYear() !== today.getFullYear() ? ` ${date.getFullYear()}` : '';

    const habits = habitsOnDay(key);
    const habitsDone = habits.filter((h) => habitDone(h.id, key));
    const goals = goalProgress(key);
    const goalsDone = goals.filter((g) => g.complete).length;
    const scrDay = SCR && SCR.days && SCR.days[key] && SCR.days[key].total ? SCR.days[key] : null;

    const tiles = [
      { v: list.length, l: plural(list.length, 'помидорка', 'помидорки', 'помидорок') },
      { v: fmtMinutes(minutes), l: 'в фокусе' },
    ];
    if (scrDay) tiles.push({ v: fmtSec(scrDay.total), l: 'в телефоне' });
    if (habits.length) tiles.push({ v: `${habitsDone.length} / ${habits.length}`, l: 'привычек сделано' });
    if (goals.length) tiles.push({ v: `${goalsDone} / ${goals.length}`, l: 'целей выполнено' });

    let html = `<div class="sd-nav">
        <button type="button" class="icon-btn small" id="sdPrev" aria-label="Предыдущий день"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="sd-title"><small>Сводка дня</small><div>${esc(title + year)}</div><span>${rel}</span></div>
        <button type="button" class="icon-btn small" id="sdNext" aria-label="Следующий день" ${diff === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
      <div class="st-tiles">${tiles.map((t) => `<div class="st-tile"><div class="st-v">${esc(t.v)}</div><div class="st-l">${esc(t.l)}</div></div>`).join('')}</div>`;

    html += dayTimelineHTML(date, list, scrDay);

    if (goals.length) {
      html += `<section class="st-section"><div class="st-head"><h3>Цели</h3></div>${goals.map(({ goal, cat, done, complete }) => `
        <div class="goal${complete ? ' complete' : ''}" style="--c:${cat.color}">
          <span class="goal-name"><i></i>${esc(cat.name)}</span>
          <div class="goal-bar"><span style="width:${Math.min(100, (done / goal.target) * 100)}%"></span></div>
          <span class="goal-count">${complete ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : ''}${done} / ${goal.target}</span>
        </div>`).join('')}</section>`;
    }

    if (habits.length) {
      html += `<section class="st-section"><div class="st-head"><h3>Привычки</h3><span class="st-hint-inline">${habitsDone.length} из ${habits.length}</span></div><div class="sd-habits">${habits.map((h) => {
        const ok = habitDone(h.id, key);
        return `<div class="sd-habit${ok ? ' on' : ''}" style="--hc:${h.color}">
          <span class="sd-hcheck">${ok ? '<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2L18.5 8"/></svg>' : ''}</span>
          <span class="sd-hname">${esc(h.name)}</span>
          <span class="sd-hstate">${ok ? 'сделано' : 'не сделано'}</span>
        </div>`;
      }).join('')}</div></section>`;
    }

    if (list.length) {
      const byCat = new Map();
      list.forEach((p) => {
        const k = catById(p.category) ? p.category : '';
        const v = byCat.get(k) || { n: 0, m: 0 };
        v.n++; v.m += p.minutes || 0;
        byCat.set(k, v);
      });
      const sorted = [...byCat.entries()].sort((a, b) => b[1].n - a[1].n);
      const maxN = sorted[0][1].n;
      html += `<section class="st-section"><div class="st-head"><h3>Помидорки по категориям</h3></div><div class="st-cats">${sorted.map(([k, v]) => `
        <div class="st-cat">
          <span class="st-cat-name"><i style="background:${catColor(k)}"></i>${esc(catName(k))}</span>
          <span class="st-cat-bar"><span style="width:${(v.n / maxN) * 100}%;background:${catColor(k)}"></span></span>
          <span class="st-cat-n">${v.n}</span>
          <span class="st-cat-t">${fmtMinutes(v.m)}</span>
          <span class="st-cat-p">${Math.round((v.n / list.length) * 100)}%</span>
        </div>`).join('')}</div></section>`;

      html += `<section class="st-section"><div class="st-head"><h3>Помидорки</h3></div><ol class="sd-poms">${list.map((p) => {
        const k = catById(p.category) ? p.category : '';
        return `<li style="--c:${catColor(k)}">
          <span class="sd-time">${timeStr(p.start)} – ${timeStr(p.end)}<small>${p.minutes} мин</small></span>
          <span class="sd-body"><span class="sd-cat"><i></i>${esc(catName(k))}</span>
          ${p.description ? `<span class="sd-desc">${esc(p.description)}</span>` : ''}</span>
        </li>`;
      }).join('')}</ol></section>`;
    }

    if (scrDay) {
      const apps = Object.entries(scrDay.apps).filter(([, a]) => a.s >= 30).sort((a, b) => b[1].s - a[1].s);
      const shown = sdPhoneAll ? apps : apps.slice(0, 8);
      const max = apps.length ? apps[0][1].s : 1;
      const cats = catTotals(scrDay.apps).sort((a, b) => b.sec - a.sec);
      html += `<section class="st-section"><div class="st-head"><h3>Телефон</h3>
          <button type="button" class="link-btn" id="sdScreen">Открыть экранное время →</button></div>
        <div class="sd-phone-cats">${cats.map((c) => `<span class="sd-pcat" style="--c:${c.color}"><i></i>${esc(c.name)} <b>${fmtSec(c.sec)}</b></span>`).join('')}</div>
        <div class="sd-phone">${shown.map(([b, a]) => `
          <div class="sd-app">${scrIcon(b)}<span class="sd-app-name">${esc(scrApp(b).name)}<small>${a.o} ${plural(a.o, 'открытие', 'открытия', 'открытий')}</small></span>
            <span class="sd-app-bar"><span style="width:${(a.s / max) * 100}%;background:${scrCat(scrApp(b).cat).color}"></span></span>
            <span class="sd-app-t">${fmtSec(a.s)}</span></div>`).join('')}</div>
        ${apps.length > 8 ? `<button type="button" class="scr-more" id="sdPhoneMore">${sdPhoneAll ? 'Свернуть' : `Показать все приложения (${apps.length})`}</button>` : ''}
      </section>`;
    }

    if (!list.length && !habitsDone.length && !scrDay) {
      html += '<div class="sd-empty">В этот день ничего не отмечено.</div>';
    }

    const box = $('stDay');
    box.innerHTML = html;
    if ($('sdScreen')) $('sdScreen').onclick = () => { statsDlg.close(); openScreen('day', date); };
    if ($('sdPhoneMore')) $('sdPhoneMore').onclick = () => { sdPhoneAll = !sdPhoneAll; renderStatsDay(); };
    $('sdPrev').onclick = () => { sdPhoneAll = false; openStatsDay(addDays(date, -1)); };
    $('sdNext').onclick = () => { if (diff > 0) { sdPhoneAll = false; openStatsDay(addDays(date, 1)); } };
    // подсказки на ленте дня
    box.querySelectorAll('.tl-pom').forEach((el) => {
      const p = list[Number(el.dataset.i)];
      el.addEventListener('mouseenter', () => {
        const k = catById(p.category) ? p.category : '';
        showTip(el, `<div class="tip-t">${timeStr(p.start)} – ${timeStr(p.end)}</div>
          <div class="tip-row"><i style="background:${catColor(k)}"></i><span>${esc(catName(k))}</span><b>${p.minutes} мин</b></div>
          ${p.description ? `<div class="tip-sum" style="margin-top:6px">${esc(p.description)}</div>` : ''}`);
      });
      el.addEventListener('mouseleave', hideTip);
    });
    box.querySelectorAll('.tl-ph').forEach((el) => {
      const h = Number(el.dataset.h);
      el.addEventListener('mouseenter', () => {
        const entries = Object.entries(scrDay.hours[h]).sort((a, b) => b[1] - a[1]);
        const tot = entries.reduce((a, [, v]) => a + v, 0);
        showTip(el, `<div class="tip-t">${String(h).padStart(2, '0')}:00 – ${String((h + 1) % 24).padStart(2, '0')}:00</div>
          <div class="tip-sum">${tot ? `в телефоне ${fmtSec(tot)}` : 'телефоном не пользовались'}</div>
          ${entries.slice(0, 5).map(([b, v]) => `<div class="tip-row"><i style="background:${scrCat(scrApp(b).cat).color}"></i><span>${esc(scrApp(b).name)}</span><b>${fmtSec(v)}</b></div>`).join('')}`);
      });
      el.addEventListener('mouseleave', hideTip);
    });
  }

  const tip = $('stTip');
  function showTip(target, html) {
    tip.innerHTML = html;
    tip.classList.add('show');
    const r = target.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2;
    x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x));
    let y = r.top - tr.height - 10;
    if (y < 8) y = r.bottom + 10;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.classList.remove('show'); }

  $('openDaySummary').onclick = () => {
    statsDlg.showModal();
    openStatsDay(viewDate());
    scrLoad(false).then(() => { if (statsDlg.open) renderStatsDlg(); });
  };

  $('openStats').onclick = () => {
    renderStatsDlg();
    statsDlg.showModal();
    // подтягиваем экранное время для плиток и дня — без ожидания
    scrLoad(false).then(() => { if (statsDlg.open) renderStatsDlg(); });
  };
  $('closeStats').onclick = () => statsDlg.close();
  statsDlg.addEventListener('click', (e) => { if (e.target === statsDlg) statsDlg.close(); });
  statsDlg.addEventListener('close', hideTip);
  $('statsDlg').querySelector('.modal-body').addEventListener('scroll', hideTip);
  document.querySelectorAll('#statsRange button').forEach((b) => {
    b.onclick = () => {
      statsRange = Number(b.dataset.range);
      if (statsRange === 1) statsDay = startOfDay(new Date());
      renderStatsDlg();
    };
  });

  // ================= Настройки =================
  const dlg = $('settings');
  const form = $('settingsForm');

  // ---------- часовой пояс ----------
  const TZ_POPULAR = [
    ['Europe/Kaliningrad', 'Калининград'], ['Europe/Moscow', 'Москва'], ['Europe/Samara', 'Самара'],
    ['Asia/Yekaterinburg', 'Екатеринбург'], ['Asia/Omsk', 'Омск'], ['Asia/Novosibirsk', 'Новосибирск'],
    ['Asia/Krasnoyarsk', 'Красноярск'], ['Asia/Irkutsk', 'Иркутск'], ['Asia/Yakutsk', 'Якутск'],
    ['Asia/Vladivostok', 'Владивосток'], ['Asia/Magadan', 'Магадан'], ['Asia/Kamchatka', 'Камчатка'],
    ['Europe/Minsk', 'Минск'], ['Europe/Kyiv', 'Киев'], ['Asia/Tbilisi', 'Тбилиси'], ['Asia/Yerevan', 'Ереван'],
    ['Asia/Baku', 'Баку'], ['Asia/Almaty', 'Алматы'], ['Asia/Tashkent', 'Ташкент'], ['Europe/Istanbul', 'Стамбул'],
    ['Asia/Dubai', 'Дубай'], ['Europe/Berlin', 'Берлин, Франкфурт'], ['Europe/London', 'Лондон'],
    ['Asia/Bangkok', 'Бангкок'], ['Asia/Makassar', 'Бали'], ['America/New_York', 'Нью-Йорк'],
  ];
  function tzOffsetLabel(zone) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
      const v = (p.find((x) => x.type === 'timeZoneName') || {}).value || '';
      return v.replace('GMT', 'UTC') || 'UTC';
    } catch (e) { return ''; }
  }
  function tzTimeIn(zone) {
    try { return new Intl.DateTimeFormat('ru-RU', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date()); } catch (e) { return ''; }
  }
  function fillTz() {
    const sel = $('tzSelect');
    const cur = S().timezone || '';
    const sys = window.SYSTEM_TZ;
    const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    let all = [];
    try { all = Intl.supportedValuesOf('timeZone'); } catch (e) {}
    const popular = new Set(TZ_POPULAR.map(([z]) => z));
    sel.innerHTML = opt('', `Как на компьютере — ${sys} (${tzOffsetLabel(sys)})`)
      + `<optgroup label="Популярные">${TZ_POPULAR.map(([z, n]) => opt(z, `${n} (${tzOffsetLabel(z)})`)).join('')}</optgroup>`
      + `<optgroup label="Все пояса">${all.filter((z) => !popular.has(z)).map((z) => opt(z, `${z.replace(/_/g, ' ')} (${tzOffsetLabel(z)})`)).join('')}</optgroup>`;
    if (cur && ![...sel.options].some((o) => o.value === cur)) sel.insertAdjacentHTML('afterbegin', opt(cur, cur));
    const zone = cur || sys;
    $('tzHint').innerHTML = `Сейчас там <b>${tzTimeIn(zone)}</b>${cur && cur !== sys ? ` · на Маке ${tzTimeIn(sys)}` : ''}`;
  }
  $('tzSelect').addEventListener('change', async (e) => {
    const zone = e.target.value;
    S().timezone = zone;
    await save(true);
    try { localStorage.setItem('pomodoro.tz', zone); } catch (err) {}
    try { await fetch('/api/screentime/settings', { method: 'POST', body: JSON.stringify({ Timezone: zone }) }); } catch (err) {}
    toast('Часовой пояс изменён — перезагружаю…');
    setTimeout(() => location.reload(), 600);
  });

  function fillSettings() {
    fillTz();
    const s = S();
    ['focus', 'short', 'long', 'perRound'].forEach((k) => (form.elements[k].value = s[k]));
    ['autoBreak', 'autoFocus', 'chime', 'notify'].forEach((k) => (form.elements[k].checked = !!s[k]));
    renderCatEditor();
  }

  form.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.name || !(el.name in S())) return;
    const s = S();
    if (el.type === 'checkbox') {
      s[el.name] = el.checked;
      if (el.name === 'notify' && el.checked && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } else {
      const v = Math.round(Number(el.value));
      const min = Number(el.min), max = Number(el.max);
      if (!Number.isFinite(v)) { el.value = s[el.name]; return; }
      s[el.name] = Math.min(max, Math.max(min, v));
      el.value = s[el.name];
      // если таймер не запускался — подхватываем новую длительность
      const t = T();
      if (!t.running && t.remaining === t.duration && t.mode === el.name) {
        data.timer = freshTimer(t.mode, t.done);
      }
      if (el.name === 'perRound' && T().done > s.perRound) T().done = s.perRound;
    }
    save();
    render();
  });

  function renderCatEditor() {
    const ul = $('catEditor');
    ul.innerHTML = '';
    data.categories.forEach((c) => {
      const li = document.createElement('li');
      const color = swatchPicker(document.createElement('button'), c.color, (v) => { c.color = v; save(); renderLog(); });
      color.setAttribute('aria-label', `Цвет категории «${c.name}»`);
      const name = document.createElement('input');
      name.type = 'text'; name.value = c.name; name.maxLength = 40;
      name.addEventListener('input', () => { c.name = name.value; save(); });
      name.addEventListener('change', () => { if (!c.name.trim()) { c.name = 'Без названия'; name.value = c.name; } renderLog(); });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'btn danger'; del.textContent = 'Удалить';
      del.onclick = () => {
        const used = data.pomodoros.filter((p) => p.category === c.id).length;
        if (used && !confirm(`Категория используется в ${used} ${plural(used, 'помидорке', 'помидорках', 'помидорках')}. Удалить? Эти помидорки станут «без категории».`)) return;
        data.categories = data.categories.filter((x) => x.id !== c.id);
        data.goals = data.goals.filter((g) => g.category !== c.id);
        save(); renderCatEditor(); renderLog();
      };
      li.append(color, name, del);
      ul.appendChild(li);
    });
  }

  $('addCat').onclick = () => {
    const name = $('newCatName').value.trim();
    if (!name) { $('newCatName').focus(); return; }
    data.categories.push({ id: uid(), name, color: $('newCatColor').value });
    $('newCatName').value = '';
    const usedC = new Set(data.categories.map((x) => x.color.toLowerCase()));
    $('newCatColor').value = PALETTE.find((x) => !usedC.has(x)) || PALETTE[data.categories.length % PALETTE.length];
    save(); renderCatEditor(); renderLog();
  };
  $('newCatName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('addCat').click(); } });

  $('openSettings').onclick = () => {
    fillSettings();
    dlg.showModal();
    fetch('/api/info').then((r) => r.json()).then((i) => {
      $('dataPath').textContent = i.dataFile;
      $('backupPath').textContent = i.backups || '—';
      $('appVersion').textContent = `${i.version}${i.channel === 'prod' ? '' : ' (разработка)'}`;
    }).catch(() => {});
  };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('exportBtn').onclick = () => download(`pomodoro-${dayKey(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
  $('exportCsvBtn').onclick = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Дата', 'Начало', 'Конец', 'Минут', 'Категория', 'Описание']];
    data.pomodoros.slice().sort((a, b) => new Date(a.end) - new Date(b.end)).forEach((p) => {
      rows.push([dayKey(new Date(p.end)), timeStr(p.start), timeStr(p.end), p.minutes, catById(p.category)?.name || '', p.description || '']);
    });
    download(`pomodoro-${dayKey(new Date())}.csv`, '﻿' + rows.map((r) => r.map(esc).join(';')).join('\n'), 'text/csv');
  };
  $('quitBtn').onclick = async () => {
    if (!confirm('Остановить сервер? Страница перестанет работать, пока не запустишь приложение снова.')) return;
    if (T().running) pauseTimer();
    await flush();
    try { await fetch('/api/quit', { method: 'POST' }); } catch (e) {}
    dlg.close();
    document.body.innerHTML = '<div style="display:grid;place-items:center;min-height:100vh;color:#b9b0c2;font-family:-apple-system,sans-serif;text-align:center">Сервер остановлен.<br>Запусти Pomodoro.app, чтобы продолжить.</div>';
  };

  // ================= Прочее =================
  let toastTimer;
  function toast(text) {
    const el = $('toast');
    // открытое модальное окно рисуется поверх всего — переносим сообщение внутрь него
    const host = document.querySelector('dialog[open]') || document.body;
    if (el.parentElement !== host) host.appendChild(el);
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  $('startBtn').onclick = toggleTimer;
  $('resetBtn').onclick = resetTimer;
  $('skipBtn').onclick = skip;

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select', 'button'].includes(tag) && !(tag === 'button' && e.code !== 'Space')) return;
    if (e.code === 'Space') { e.preventDefault(); toggleTimer(); }
    else if (e.code === 'KeyS') skip();
    else if (e.code === 'KeyR') resetTimer();
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', () => flush(true));

  // Обновляем «Сегодня» после полуночи
  let lastDay = dayKey(new Date());
  setInterval(() => {
    const k = dayKey(new Date());
    if (k !== lastDay) { lastDay = k; renderLog(); }
  }, 60000);


  // ================= Экранное время iPhone =================
  const scrDlg = $('scrDlg');
  const SCR_CATS = [
    { id: 'social', name: 'Общение', color: '#3987e5' },
    { id: 'games', name: 'Игры', color: '#d95926' },
    { id: 'entertainment', name: 'Развлечения', color: '#199e70' },
    { id: 'info', name: 'Чтение и браузер', color: '#c98500' },
    { id: 'shopping', name: 'Покупки и финансы', color: '#d55181' },
    { id: 'health', name: 'Здоровье и спорт', color: '#008300' },
    { id: 'productivity', name: 'Работа и учёба', color: '#9085e9' },
    { id: 'other', name: 'Другое', color: '#7d7686' },
  ];
  const scrCat = (id) => SCR_CATS.find((c) => c.id === id) || SCR_CATS[SCR_CATS.length - 1];
  let SCR = null;
  let scrMode = 'day';
  let scrDate = startOfDay(new Date());
  let scrExpanded = null;
  let scrShowAll = false;
  let scrFilter = null;
  let scrSyncing = false;
  let scrTimer = null;

  function fmtSec(sec) {
    if (!sec || sec < 30) return sec ? '<1 мин' : '0 мин';
    return fmtMinutes(Math.round(sec / 60));
  }
  const scrApp = (b) => (SCR && SCR.apps && SCR.apps[b]) || { name: b.split('.').pop(), cat: 'other' };
  function scrIcon(b, cls = '') {
    const a = scrApp(b);
    const letter = esc((a.name || '?').trim().charAt(0).toUpperCase());
    const color = scrCat(a.cat).color;
    if (a.icon) {
      return `<img class="app-ic ${cls}" src="/api/screentime/icon?b=${encodeURIComponent(b)}" alt="" loading="lazy" data-l="${letter}" data-c="${color}">`;
    }
    return `<span class="app-ic letter ${cls}" style="background:${color}">${letter}</span>`;
  }

  async function scrLoad(sync) {
    try {
      const r = await fetch(sync ? '/api/screentime/sync' : '/api/screentime', { method: sync ? 'POST' : 'GET' });
      if (r.ok) SCR = await r.json();
      const want = (data.settings && data.settings.timezone) || '';
      if (SCR && (SCR.timezone || '') !== want) {
        await fetch('/api/screentime/settings', { method: 'POST', body: JSON.stringify({ Timezone: want }) });
        const r2 = await fetch('/api/screentime/sync', { method: 'POST' });
        if (r2.ok) SCR = await r2.json();
      }
    } catch (e) { /* сервер недоступен — покажем последнее */ }
    return SCR;
  }

  async function scrRefresh(manual) {
    if (scrSyncing) return;
    scrSyncing = true;
    $('scrRefresh').classList.add('spin');
    const before = SCR ? SCR.lastEvent : 0;
    // крутим значок хотя бы полсекунды, чтобы было видно, что обновление прошло
    await Promise.all([scrLoad(true), new Promise((r) => setTimeout(r, 600))]);
    if (manual && SCR) {
      const ev = SCR.lastEvent ? new Date(SCR.lastEvent * 1000) : null;
      const at = ev ? ev.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
      if (SCR.status === 'no_access') toast('Нет доступа к данным iPhone — проверь Full Disk Access');
      else if (SCR.lastEvent > before) toast(`Обновлено · данные iPhone до ${at}`);
      else toast(`Новых данных с iPhone пока нет · последние от ${at}. Айфон присылает их с задержкой`);
    }
    // названия и иконки догружаются в фоне — заберём их чуть позже
    setTimeout(async () => { if (scrDlg.open) { await scrLoad(false); scrRender(); } }, 4000);
    scrSyncing = false;
    $('scrRefresh').classList.remove('spin');
    scrRender();
  }

  function openScreen(mode, date) {
    if (mode) scrMode = mode;
    scrDate = startOfDay(date || new Date());
    scrExpanded = null; scrShowAll = false; scrFilter = null;
    scrRender();
    scrDlg.showModal();
    scrRefresh();
    clearInterval(scrTimer);
    scrTimer = setInterval(() => { if (scrDlg.open) scrRefresh(); }, 60000);
  }
  $('openScreen').onclick = () => openScreen(scrMode, new Date());
  $('scrClose').onclick = () => scrDlg.close();
  $('scrRefresh').onclick = () => scrRefresh(true);
  scrDlg.addEventListener('click', (e) => { if (e.target === scrDlg) scrDlg.close(); });
  scrDlg.addEventListener('close', () => { clearInterval(scrTimer); hideTip(); });
  document.querySelectorAll('#scrMode button').forEach((b) => {
    b.onclick = () => { scrMode = b.dataset.mode; scrExpanded = null; scrShowAll = false; scrRender(); };
  });

  const weekStart = (d) => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
  const scrDayData = (d) => (SCR && SCR.days ? SCR.days[dayKey(d)] : null);
  function scrEarliest() {
    const ks = SCR && SCR.days ? Object.keys(SCR.days).sort() : [];
    return ks.length ? new Date(ks[0] + 'T12:00:00') : null;
  }
  function ago(unix) {
    if (!unix) return 'никогда';
    const m = Math.round((Date.now() / 1000 - unix) / 60);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
    return new Date(unix * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  // ---- состояния без данных ----
  function scrSetup(kind) {
    const iphoneStep = `<li><b>На iPhone:</b> Настройки → Экранное время → включи <b>«Учитывать на всех устройствах»</b> (Share Across Devices). Айфон должен быть в том же Apple ID, что и Мак.</li>`;
    if (kind === 'no_access') {
      return `<div class="scr-setup">
        <div class="scr-setup-ic"><svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg></div>
        <h3>Нужен доступ к данным iPhone</h3>
        <p>macOS хранит экранное время айфона в защищённой папке. Чтобы Pomodoro мог его читать:</p>
        <ol>${iphoneStep}
          <li><b>На Маке:</b> System Settings → Privacy &amp; Security → <b>Full Disk Access</b> → добавь и включи <b>Pomodoro</b>.</li>
          <li>Перезапусти Pomodoro: в настройках «Остановить сервер», потом снова открой приложение.</li></ol>
        <button type="button" class="btn primary-btn" id="scrRetry">Проверить снова</button></div>`;
    }
    return `<div class="scr-setup">
      <div class="scr-setup-ic"><svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/></svg></div>
      <h3>Данных с iPhone пока нет</h3>
      <p>На этом Маке не нашлось истории экранного времени айфона.</p>
      <ol>${iphoneStep}<li>Подожди немного: данные приходят на Мак в течение нескольких минут после использования телефона.</li></ol>
      <button type="button" class="btn primary-btn" id="scrRetry">Проверить снова</button></div>`;
  }

  // ---- общие куски ----
  function catTotals(appsMap) {
    const m = new Map();
    Object.entries(appsMap).forEach(([b, a]) => {
      const c = scrApp(b).cat;
      m.set(c, (m.get(c) || 0) + a.s);
    });
    return SCR_CATS.filter((c) => m.get(c.id)).map((c) => ({ ...c, sec: m.get(c.id) }));
  }

  function chipsHTML(cats) {
    if (!cats.length) return '';
    const total = cats.reduce((s, c) => s + c.sec, 0);
    return `<div class="scr-cats">${cats.slice().sort((a, b) => b.sec - a.sec).map((c) => `
      <button type="button" class="scr-chip${scrFilter === c.id ? ' on' : ''}${scrFilter && scrFilter !== c.id ? ' dim' : ''}" data-cat="${c.id}" style="--c:${c.color}">
        <i></i><span>${esc(c.name)}</span><b>${fmtSec(c.sec)}</b><small>${Math.round((c.sec / total) * 100)}%</small>
      </button>`).join('')}</div>`;
  }

  function stackSegs(appsBySec) {
    // appsBySec: Map(bundle -> sec); сегменты по категориям в фиксированном порядке
    const byCat = new Map();
    appsBySec.forEach((sec, b) => { const c = scrApp(b).cat; byCat.set(c, (byCat.get(c) || 0) + sec); });
    return SCR_CATS.filter((c) => byCat.get(c.id)).map((c) =>
      `<span class="seg-fill${scrFilter && scrFilter !== c.id ? ' dim' : ''}" style="flex-grow:${byCat.get(c.id)};background:${c.color}"></span>`).join('');
  }

  function appListHTML(apps, opts) {
    // apps: [{b, s, o}] отсортированы
    let list = apps;
    if (scrFilter) list = list.filter((a) => scrApp(a.b).cat === scrFilter);
    const max = list.length ? list[0].s : 1;
    const LIMIT = 10;
    const shown = scrShowAll ? list : list.slice(0, LIMIT);
    const rows = shown.map((a) => {
      const info = scrApp(a.b);
      const cat = scrCat(info.cat);
      const open = scrExpanded === a.b;
      const sub = [cat.name];
      if (a.o) sub.push(`${a.o} ${plural(a.o, 'открытие', 'открытия', 'открытий')}`);
      if (opts.perDay && a.s) sub.push(`${fmtSec(a.s / opts.perDay)} в день`);
      return `<li class="sta${open ? ' open' : ''}" data-b="${esc(a.b)}">
        <button type="button" class="sta-row" aria-expanded="${open}">
          ${scrIcon(a.b)}
          <span class="sta-main">
            <span class="sta-top"><span class="sta-name">${esc(info.name)}</span><span class="sta-time">${fmtSec(a.s)}</span></span>
            <span class="sta-bar"><span style="width:${Math.max(1.5, (a.s / max) * 100)}%;background:${cat.color}"></span></span>
            <span class="sta-sub">${sub.map(esc).join(' · ')}</span>
          </span>
          <svg class="sta-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        ${open ? appDetailHTML(a.b) : ''}
      </li>`;
    }).join('');
    const more = list.length > LIMIT
      ? `<button type="button" class="scr-more" id="scrMore">${scrShowAll ? 'Свернуть' : `Показать все (${list.length})`}</button>` : '';
    const filterNote = scrFilter
      ? `<div class="scr-filter-note">Только «${esc(scrCat(scrFilter).name)}» · <button type="button" class="link-btn" id="scrClearFilter">показать все категории</button></div>` : '';
    return `${filterNote}<ul class="sta-list">${rows || '<li class="scr-none">Нет приложений</li>'}</ul>${more}`;
  }

  function appDetailHTML(b) {
    // последние 14 дней этого приложения, заканчивая выбранным днём (или концом недели)
    const end = scrMode === 'week' ? addDays(weekStart(scrDate), 6) : scrDate;
    const today = startOfDay(new Date());
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(end, -i);
      if (d > today) continue;
      const dd = scrDayData(d);
      days.push({ d, s: dd && dd.apps[b] ? dd.apps[b].s : 0, has: !!dd });
    }
    const withData = days.filter((x) => x.has);
    const avg = withData.length ? withData.reduce((s, x) => s + x.s, 0) / withData.length : 0;
    const max = Math.max(60, ...days.map((x) => x.s));
    const info = scrApp(b);
    const color = scrCat(info.cat).color;
    return `<div class="sta-detail">
      <div class="sta-d-head"><span>Последние 2 недели</span><span>в среднем <b>${fmtSec(avg)}</b> в день</span></div>
      <div class="sta-spark">${days.map((x) => `
        <button type="button" class="spark-col${dayKey(x.d) === dayKey(scrDate) && scrMode === 'day' ? ' cur' : ''}" data-day="${dayKey(x.d)}"
          title="${esc(fmtDay(x.d, true))}: ${fmtSec(x.s)}">
          <span class="spark-bar" style="height:${x.s ? Math.max(4, (x.s / max) * 100) : 0}%;background:${color}"></span>
          <span class="spark-x">${x.d.getDate()}</span>
        </button>`).join('')}</div>
      <div class="sta-d-cat"><span>Название</span><div class="sta-rename">
        <input type="text" class="sta-name-input" value="${esc(info.name)}" maxlength="40" aria-label="Название приложения">
      </div></div>
      <div class="sta-d-cat"><span>Категория</span><div class="sta-cats">${SCR_CATS.map((c) => `
        <button type="button" class="cat-pick${c.id === info.cat ? ' on' : ''}" data-cat="${c.id}" style="--c:${c.color}"><i></i>${esc(c.name)}</button>`).join('')}</div></div>
    </div>`;
  }

  function hourChartHTML(d, isToday) {
    const nowH = new Date().getHours();
    const cols = d.hours.map((h, i) => {
      const m = new Map(Object.entries(h));
      const tot = [...m.values()].reduce((s, v) => s + v, 0);
      return `<div class="hb-col${isToday && i === nowH ? ' now' : ''}${isToday && i > nowH ? ' future' : ''}" data-h="${i}">
        <div class="hb-track"><div class="bar" style="height:${Math.min(100, (tot / 3600) * 100)}%">${stackSegs(m)}</div></div>
        <div class="bar-x">${i % 6 === 0 ? String(i).padStart(2, '0') : ''}</div></div>`;
    }).join('');
    return `<div class="scr-chart hours">
      <div class="chart-grid"><div class="gl"><span>60 мин</span></div><div class="gl"><span>30</span></div><div class="gl"><span>0</span></div></div>
      <div class="chart-cols" style="--n:24">${cols}</div></div>`;
  }

  function weekChartHTML(start, avg) {
    const today = startOfDay(new Date());
    const days = [...Array(7)].map((_, i) => addDays(start, i));
    const totals = days.map((d) => (scrDayData(d) || {}).total || 0);
    const maxH = Math.max(1, ...totals) / 3600;
    const top = Math.max(1, Math.ceil(maxH));
    const cols = days.map((d, i) => {
      const dd = scrDayData(d);
      const m = new Map(dd ? Object.entries(dd.apps).map(([b, a]) => [b, a.s]) : []);
      const label = d.toLocaleDateString('ru-RU', { weekday: 'short' });
      return `<button type="button" class="wk-col${d > today ? ' future' : ''}${dayKey(d) === dayKey(today) ? ' today' : ''}" data-day="${dayKey(d)}" ${d > today ? 'disabled' : ''}>
        <div class="hb-track"><div class="bar" style="height:${(totals[i] / 3600 / top) * 100}%">${stackSegs(m)}</div></div>
        <div class="bar-x">${label}<small>${d.getDate()}</small></div></button>`;
    }).join('');
    const avgLine = avg ? `<div class="avg-line" style="bottom:calc(36px + (100% - 36px) * ${(avg / 3600 / top).toFixed(4)})"><span>среднее ${fmtSec(avg)}</span></div>` : '';
    return `<div class="scr-chart week">
      <div class="chart-grid"><div class="gl"><span>${top} ч</span></div><div class="gl"><span>${top / 2 % 1 ? (top / 2).toFixed(1).replace('.', ',') : top / 2} ч</span></div><div class="gl"><span>0</span></div></div>
      <div class="chart-cols" style="--n:7">${cols}</div>${avgLine}</div>`;
  }

  function compareHTML(cur, base, what) {
    if (!base || !cur) return '';
    const diff = cur - base;
    const pct = Math.round((Math.abs(diff) / base) * 100);
    if (pct < 5) return `<div class="scr-cmp same">примерно как ${what}</div>`;
    return `<div class="scr-cmp ${diff > 0 ? 'up' : 'down'}">
      <svg viewBox="0 0 24 24"><path d="${diff > 0 ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6'}"/></svg>
      на ${fmtSec(Math.abs(diff))} ${diff > 0 ? 'больше' : 'меньше'}, чем ${what}</div>`;
  }

  function footerHTML() {
    const ev = SCR && SCR.lastEvent ? new Date(SCR.lastEvent * 1000) : null;
    const evText = ev ? (dayKey(ev) === dayKey(new Date()) ? `сегодня в ${ev.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
      : ev.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })) : '—';
    return `<div class="scr-foot">
      <p>Считается время, когда приложение открыто на экране iPhone. Видео под опущенной шторкой, в маленьком окне или в фоне сюда не попадает — поэтому YouTube и музыка могут показывать меньше, чем «Экранное время» на телефоне.</p>
      <div class="scr-foot-row">
        <span>Последняя активность на iPhone: ${evText} · обновлено ${ago(SCR && SCR.lastSync)}</span>
        <label class="toggle small-toggle" title="Названия и иконки приложений берутся из App Store: в Apple уходят только идентификаторы приложений">
          <input type="checkbox" id="scrLookup" ${SCR && SCR.lookup ? 'checked' : ''}><span class="sw"></span><span>Иконки из App Store</span>
        </label>
      </div></div>`;
  }

  // ---- отрисовка ----
  function scrRender() {
    document.querySelectorAll('#scrMode button').forEach((b) => {
      const on = b.dataset.mode === scrMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
    const body = $('scrBody');
    if (!SCR) { body.innerHTML = '<div class="scr-loading">Загружаю данные iPhone…</div>'; return; }
    const hasDays = SCR.days && Object.keys(SCR.days).length;
    if (!hasDays && (SCR.status === 'no_access' || SCR.status === 'no_device' || SCR.status === 'no_data')) {
      body.innerHTML = scrSetup(SCR.status);
      $('scrRetry').onclick = () => scrRefresh();
      return;
    }
    if (!hasDays) { body.innerHTML = '<div class="scr-loading">Загружаю данные iPhone…</div>'; return; }
    const warn = SCR.status === 'no_access'
      ? '<div class="scr-warn">Нет доступа к свежим данным iPhone — показываю сохранённые. Проверь «Full Disk Access» для Pomodoro.</div>' : '';
    body.innerHTML = warn + (scrMode === 'week' ? scrWeekHTML() : scrDayHTML()) + footerHTML();
    scrBind();
  }

  function scrDayHTML() {
    const today = startOfDay(new Date());
    if (scrDate > today) scrDate = today;
    const d = scrDayData(scrDate);
    const diff = Math.round((today - scrDate) / 86400000);
    const title = diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера'
      : scrDate.toLocaleDateString('ru-RU', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
    const nav = `<div class="sd-nav">
      <button type="button" class="icon-btn small" id="scrPrev" aria-label="Предыдущий день"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="sd-title"><div>${esc(title)}</div><span>${esc(scrDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: scrDate.getFullYear() !== today.getFullYear() ? 'numeric' : undefined }))}</span>
        <button type="button" class="link-btn day-summary" id="scrDaySummary">Сводка дня <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>
      <button type="button" class="icon-btn small" id="scrNext" aria-label="Следующий день" ${diff === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>`;
    if (!d || !d.total) {
      const earliest = scrEarliest();
      const msg = earliest && scrDate < earliest
        ? `Истории за этот день нет. macOS хранит экранное время iPhone около месяца, а Pomodoro сохраняет его у себя начиная с ${esc(fmtDay(earliest))}.`
        : diff === 0 ? 'Сегодня айфоном ещё не пользовались — или данные пока не пришли на Мак.' : 'В этот день айфоном не пользовались.';
      return nav + `<div class="scr-empty">${msg}</div>`;
    }
    // среднее за предыдущие 7 дней; для сегодняшнего дня — сколько обычно набегает к этому же времени
    const isToday = diff === 0;
    const now = new Date();
    const upToNow = (x) => {
      if (!isToday) return x.total;
      const h = now.getHours();
      let sum = 0;
      for (let i = 0; i < h; i++) sum += Object.values(x.hours[i]).reduce((a, v) => a + v, 0);
      return sum + Object.values(x.hours[h]).reduce((a, v) => a + v, 0) * (now.getMinutes() / 60);
    };
    const prev = [];
    for (let i = 1; i <= 7; i++) { const x = scrDayData(addDays(scrDate, -i)); if (x && x.total && !x.partial) prev.push(upToNow(x)); }
    const avg = prev.length ? prev.reduce((s, v) => s + v, 0) / prev.length : 0;
    const apps = Object.entries(d.apps).map(([b, a]) => ({ b, s: a.s, o: a.o })).filter((a) => a.s >= 30).sort((a, b) => b.s - a.s);
    const hero = `<div class="scr-hero">
      <div><div class="scr-total">${fmtSec(d.total)}</div>
        ${compareHTML(d.total, avg, isToday ? 'обычно к этому времени' : 'в среднем за неделю')}
        ${d.partial ? '<div class="scr-cmp same">данные за этот день неполные</div>' : ''}</div>
      <div class="scr-facts">
        <div><b>${d.opens}</b><span>${plural(d.opens, 'открытие', 'открытия', 'открытий')} приложений</span></div>
        <div><b>${d.first || '—'}</b><span>первое открытие</span></div>
        <div><b>${d.last || '—'}</b><span>последнее</span></div>
      </div></div>`;
    return nav + hero
      + `<section class="st-section"><div class="st-head"><h3>По часам</h3></div>${hourChartHTML(d, isToday)}</section>`
      + `<section class="st-section"><div class="st-head"><h3>Категории</h3></div>${chipsHTML(catTotals(d.apps))}</section>`
      + `<section class="st-section"><div class="st-head"><h3>Приложения</h3></div>${appListHTML(apps, {})}</section>`;
  }

  function scrWeekHTML() {
    const today = startOfDay(new Date());
    const start = weekStart(scrDate);
    const end = addDays(start, 6);
    const isCurrent = dayKey(start) === dayKey(weekStart(today));
    const fmt = (d, o) => d.toLocaleDateString('ru-RU', o);
    const range = start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${fmt(end, { day: 'numeric', month: 'long' })}`
      : `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short' })}`;
    const nav = `<div class="sd-nav">
      <button type="button" class="icon-btn small" id="scrPrev" aria-label="Предыдущая неделя"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="sd-title"><div>${isCurrent ? 'Эта неделя' : dayKey(start) === dayKey(addDays(weekStart(today), -7)) ? 'Прошлая неделя' : 'Неделя'}</div><span>${esc(range)}</span></div>
      <button type="button" class="icon-btn small" id="scrNext" aria-label="Следующая неделя" ${isCurrent ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>`;
    const sumWeek = (s0) => {
      let total = 0, n = 0, opens = 0;
      const apps = new Map();
      for (let i = 0; i < 7; i++) {
        const dd = scrDayData(addDays(s0, i));
        if (!dd || !dd.total) continue;
        total += dd.total; n++; opens += dd.opens;
        Object.entries(dd.apps).forEach(([b, a]) => {
          const x = apps.get(b) || { b, s: 0, o: 0 };
          x.s += a.s; x.o += a.o; apps.set(b, x);
        });
      }
      // среднее считаем по завершённым дням: сегодняшний ещё не закончился
      const td = scrDayData(new Date());
      const inWeek = dayKey(weekStart(new Date())) === dayKey(s0) && td && td.total;
      const full = inWeek && n > 1 ? { t: total - td.total, n: n - 1 } : { t: total, n };
      return { total, n, opens, apps, avg: full.n ? full.t / full.n : 0, avgDays: full.n };
    };
    const w = sumWeek(start);
    if (!w.n) return nav + '<div class="scr-empty">За эту неделю данных нет.</div>';
    const pw = sumWeek(addDays(start, -7));
    const apps = [...w.apps.values()].filter((a) => a.s >= 60).sort((a, b) => b.s - a.s);
    const appsObj = Object.fromEntries([...w.apps.entries()].map(([b, a]) => [b, a]));
    const hero = `<div class="scr-hero">
      <div><div class="scr-total">${fmtSec(w.avg)} <small>в день</small></div>
        ${compareHTML(w.avg, pw.avg, 'на прошлой неделе')}
        ${w.avgDays < w.n ? '<div class="scr-note">среднее по завершённым дням, без сегодняшнего</div>' : ''}</div>
      <div class="scr-facts">
        <div><b>${fmtSec(w.total)}</b><span>всего за ${w.n} ${plural(w.n, 'день', 'дня', 'дней')}</span></div>
        <div><b>${Math.round(w.opens / w.n)}</b><span>открытий в день</span></div>
      </div></div>`;
    return nav + hero
      + `<section class="st-section"><div class="st-head"><h3>По дням</h3><span class="st-hint-inline">нажми на день, чтобы открыть его</span></div>${weekChartHTML(start, w.avg)}</section>`
      + `<section class="st-section"><div class="st-head"><h3>Категории</h3></div>${chipsHTML(catTotals(appsObj))}</section>`
      + `<section class="st-section"><div class="st-head"><h3>Приложения</h3></div>${appListHTML(apps, { perDay: w.n })}</section>`;
  }

  function scrBind() {
    const body = $('scrBody');
    const step = scrMode === 'week' ? 7 : 1;
    if ($('scrPrev')) $('scrPrev').onclick = () => { scrDate = addDays(scrDate, -step); scrExpanded = null; scrRender(); };
    if ($('scrNext')) $('scrNext').onclick = () => {
      const n = addDays(scrDate, step);
      scrDate = n > startOfDay(new Date()) ? startOfDay(new Date()) : n;
      scrExpanded = null; scrRender();
    };
    if ($('scrDaySummary')) $('scrDaySummary').onclick = () => {
      const d = scrDate;
      scrDlg.close();
      statsDlg.showModal();
      openStatsDay(d);
    };
    if ($('scrMore')) $('scrMore').onclick = () => { scrShowAll = !scrShowAll; scrRender(); };
    if ($('scrClearFilter')) $('scrClearFilter').onclick = () => { scrFilter = null; scrRender(); };
    if ($('scrLookup')) $('scrLookup').onchange = async (e) => {
      try {
        const r = await fetch('/api/screentime/settings', { method: 'POST', body: JSON.stringify({ Lookup: e.target.checked }) });
        if (r.ok) SCR = await r.json();
      } catch (err) {}
      if (e.target.checked) setTimeout(async () => { await scrLoad(false); if (scrDlg.open) scrRender(); }, 4000);
      scrRender();
    };
    body.querySelectorAll('.scr-chip').forEach((c) => {
      c.onclick = () => { scrFilter = scrFilter === c.dataset.cat ? null : c.dataset.cat; scrShowAll = false; scrRender(); };
    });
    body.querySelectorAll('.sta-row').forEach((row) => {
      row.onclick = () => {
        const b = row.parentElement.dataset.b;
        scrExpanded = scrExpanded === b ? null : b;
        scrRender();
      };
    });
    body.querySelectorAll('.cat-pick').forEach((c) => {
      c.onclick = async () => {
        const b = c.closest('.sta').dataset.b;
        const cat = c.dataset.cat;
        SCR.apps[b] = { ...scrApp(b), cat };
        scrRender();
        try {
          const r = await fetch('/api/screentime/category', { method: 'POST', body: JSON.stringify({ Bundle: b, Cat: cat }) });
          if (r.ok) SCR = await r.json();
        } catch (err) {}
        toast(`«${scrApp(b).name}» → ${scrCat(cat).name}`);
      };
    });
    body.querySelectorAll('.sta-name-input').forEach((inp) => {
      const commit = async () => {
        const b = inp.closest('.sta').dataset.b;
        const name = inp.value.trim();
        if (name === scrApp(b).name) return;
        try {
          const r = await fetch('/api/screentime/category', { method: 'POST', body: JSON.stringify({ Bundle: b, Name: name }) });
          if (r.ok) SCR = await r.json();
        } catch (err) {}
        scrRender();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = scrApp(inp.closest('.sta').dataset.b).name; inp.blur(); }
      });
      inp.addEventListener('blur', commit);
    });
    body.querySelectorAll('.spark-col, .wk-col').forEach((c) => {
      c.onclick = () => {
        if (c.disabled) return;
        scrMode = 'day'; scrDate = new Date(c.dataset.day + 'T00:00:00'); scrFilter = null; scrShowAll = false;
        scrRender();
        $('scrBody').scrollTop = 0;
      };
    });
    // подсказки на графиках
    body.querySelectorAll('.hb-col').forEach((col) => {
      const d = scrDayData(scrDate);
      const h = Number(col.dataset.h);
      col.addEventListener('mouseenter', () => {
        const entries = Object.entries(d.hours[h]).sort((a, b) => b[1] - a[1]);
        const tot = entries.reduce((s, [, v]) => s + v, 0);
        const hh = String(h).padStart(2, '0');
        showTip(col, `<div class="tip-t">${hh}:00 – ${String((h + 1) % 24).padStart(2, '0')}:00</div>
          <div class="tip-sum">${tot ? fmtSec(tot) : 'телефоном не пользовались'}</div>
          ${entries.slice(0, 5).map(([b, v]) => `<div class="tip-row"><i style="background:${scrCat(scrApp(b).cat).color}"></i><span>${esc(scrApp(b).name)}</span><b>${fmtSec(v)}</b></div>`).join('')}`);
      });
      col.addEventListener('mouseleave', hideTip);
    });
    body.querySelectorAll('.wk-col').forEach((col) => {
      const dd = scrDayData(new Date(col.dataset.day + 'T12:00:00'));
      col.addEventListener('mouseenter', () => {
        if (col.disabled) return;
        const entries = dd ? Object.entries(dd.apps).sort((a, b) => b[1].s - a[1].s) : [];
        showTip(col, `<div class="tip-t">${esc(fmtDay(new Date(col.dataset.day + 'T12:00:00'), true))}</div>
          <div class="tip-sum">${dd ? fmtSec(dd.total) : 'нет данных'}</div>
          ${entries.slice(0, 5).map(([b, a]) => `<div class="tip-row"><i style="background:${scrCat(scrApp(b).cat).color}"></i><span>${esc(scrApp(b).name)}</span><b>${fmtSec(a.s)}</b></div>`).join('')}`);
      });
      col.addEventListener('mouseleave', hideTip);
    });
  }
  // данные для статистики подтягиваем заранее
  scrLoad(false);
  // если иконка не загрузилась — показываем букву
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('app-ic')) return;
    const sp = document.createElement('span');
    sp.className = img.className + ' letter';
    sp.textContent = img.dataset.l || '?';
    sp.style.background = img.dataset.c || '#7d7686';
    img.replaceWith(sp);
  }, true);

  // Если окно открыли мышью — после закрытия не оставляем «залипшую» обводку на кнопке
  let openedByPointer = false;
  document.querySelectorAll('.topbar-actions .icon-btn').forEach((b) => {
    b.addEventListener('click', (e) => { openedByPointer = e.detail > 0; });
  });
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('close', () => {
      if (!openedByPointer) return;
      setTimeout(() => {
        const a = document.activeElement;
        if (a && a.closest && a.closest('.topbar-actions')) a.blur();
      }, 0);
    });
  });
  // вернулись на вкладку — тоже без случайной обводки на кнопках шапки
  window.addEventListener('focus', () => {
    const a = document.activeElement;
    if (a && a.closest && a.closest('.topbar-actions') && !document.querySelector('dialog[open]')) a.blur();
  });

  // ================= Старт =================
  (async function init() {
    await load();
    // пояс из данных — главный; если в этом браузере применён другой, применяем и перезагружаемся (один раз)
    const wantTz = S().timezone || '';
    const effective = wantTz && wantTz !== window.SYSTEM_TZ ? wantTz : '';
    try { localStorage.setItem('pomodoro.tz', wantTz); } catch (e) {}
    if (effective !== (window.APP_TZ || '')) {
      let tried = false;
      try { tried = sessionStorage.getItem('pomodoro.tzReload') === wantTz; sessionStorage.setItem('pomodoro.tzReload', wantTz); } catch (e) { tried = true; }
      if (!tried) { location.reload(); return; }
    }
    if (!data.timer || !MODES[data.timer.mode]) data.timer = freshTimer();
    render();
    renderLog();
  })();
})();
