(function () {
  'use strict';

  // Особое значение мастера: «Любой мастер» — бот сам выберет свободного.
  const ANY_MASTER = 'any';

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  // Демо-данные: только для открытия страницы в браузере без параметра d.
  // В Telegram услуги, мастеров, занятость и записи клиента всегда присылает бот.
  function demoData() {
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return dateKey(d);
    };
    return {
      v: 1,
      d: null, // сегодня
      n: 7,
      h: [10, 19],
      s: [
        ['haircut', 'Мужская стрижка', 1500, 45],
        ['beard', 'Стрижка бороды', 800, 30],
        ['combo', 'Стрижка + борода', 2000, 60],
        ['kids', 'Детская стрижка', 1000, 30],
        ['buzz', 'Стрижка машинкой', 700, 20],
      ],
      m: [
        ['alex', 'Алексей', 'Классика и фейды, 8 лет опыта', [0, 6, 0, 1023, 0, 0, 0]],
        ['boris', 'Борис', 'Бороды и опасная бритва', [3, 0, 0, 0, 0, 0, 0]],
        ['vika', 'Виктория', 'Модные и детские стрижки', [512, 0, 96, 0, 0, 1023, 0]],
      ],
      b: ['Барбершоп «Бритва»', 'ул. Пушкина, 10', '+7 (495) 123-45-67', 'Москва, ул. Пушкина, 10'],
      // Занятые часы самих записей уже стоят в масках мастеров: alex, день 1, бит 1 = 11:00
      u: [[101, 'haircut', 'alex', day(1), '11:00'], [102, 'beard', 'vika', day(2), '15:00']],
      l: ['haircut', 'alex'],
    };
  }

  const tg = window.Telegram && window.Telegram.WebApp;
  // Вне Telegram скрипт тоже создаёт объект WebApp, но platform = 'unknown'.
  const inTelegram = Boolean(tg && tg.platform && tg.platform !== 'unknown');
  // Через инлайн-кнопку приходит query_id, и sendData в этом случае не работает.
  const openedInline = Boolean(inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.query_id);
  const tgVersion = (v) => inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast(v);
  const nativeBack = tgVersion('6.1');

  // tab — раздел: book (запись), my (мои записи), about (о барбершопе); move — запись, которую переносим.
  // Выбор дня и времени хранят «пикеры»: date — номер дня от первого (0 — первый день из данных бота).
  const state = { tab: 'book', step: 1, service: null, master: null, move: null, sent: false };

  const $ = (id) => document.getElementById(id);
  const priceFmt = (n) => n.toLocaleString('ru-RU') + ' ₽';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- Данные от бота ----------

  // Параметр d: JSON → UTF-8 → base64url (без «=»). Формат описан в README.
  function decodeParam(raw) {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const isInt = (x) => Number.isInteger(x) && x >= 0;
  const isStr = (x) => typeof x === 'string';

  // Проверяем форму данных, чтобы испорченный адрес не сломал страницу. null — данные неверные.
  function parseData(raw) {
    if (!raw || raw.v !== 1) return null;
    const { d, n, h, s, m, b, u, l } = raw;
    if (!isInt(n) || n < 1 || n > 31) return null;
    if (!Array.isArray(h) || h.length !== 2 || !isInt(h[0]) || !isInt(h[1]) || h[0] > h[1] || h[1] > 23) return null;
    if (d !== null && !(isStr(d) && /^\d{4}-\d{2}-\d{2}$/.test(d))) return null;
    if (!Array.isArray(s) || !s.length || !Array.isArray(m) || !m.length) return null;
    if (![...s, ...m].every(Array.isArray)) return null;
    // Длительность услуги, b, u и l необязательны: старый бот их не присылает
    const services = s.map(([id, name, price, minutes]) => ({ id, name, price, minutes: minutes ?? null }));
    const masters = m.map(([id, name, description, busy]) => ({ id, name, description, busy }));
    if (!services.every((x) => isStr(x.id) && isStr(x.name) && isInt(x.price)
      && (x.minutes === null || (isInt(x.minutes) && x.minutes > 0)))) return null;
    if (!masters.every((x) => isStr(x.id) && isStr(x.name) && isStr(x.description)
      && Array.isArray(x.busy) && x.busy.length === n && x.busy.every(isInt))) return null;

    const shop = Array.isArray(b) && b.length >= 2 && b.every(isStr)
      ? { name: b[0], address: b[1], phone: b[2] || '', mapQuery: b[3] || b[1] }
      : null;
    const serviceById = (id) => services.find((x) => x.id === id);
    const masterById = (id) => masters.find((x) => x.id === id);

    // Записи клиента: [id, услуга, мастер, дата, время]. Неполные или незнакомые пропускаем
    const bookings = (Array.isArray(u) ? u : []).filter((x) => Array.isArray(x) && x.length >= 5
      && isInt(x[0]) && serviceById(x[1]) && masterById(x[2])
      && isStr(x[3]) && /^\d{4}-\d{2}-\d{2}$/.test(x[3]) && isStr(x[4]) && /^\d{2}:00$/.test(x[4]))
      .map(([id, service, master, date, time]) => ({
        id, service: serviceById(service), master: masterById(master), date, time,
      }));
    const last = Array.isArray(l) && serviceById(l[0]) && masterById(l[1])
      ? { service: serviceById(l[0]), master: masterById(l[1]) }
      : null;
    return { firstDay: d, days: n, firstHour: h[0], lastHour: h[1], services, masters, shop, bookings, last };
  }

  function loadData() {
    const raw = new URLSearchParams(window.location.search).get('d');
    // Без параметра в Telegram записываться некуда, а в браузере показываем демо.
    if (!raw) return inTelegram ? null : parseData(demoData());
    try {
      return parseData(decodeParam(raw));
    } catch (err) {
      return null;
    }
  }

  const data = loadData();

  // ---------- Тема ----------

  // Цвета у страницы свои (style.css). От Telegram берём только светлая тема или тёмная,
  // а шапку, фон окна и MainButton перекрашиваем в наши цвета.
  function applyTheme() {
    if (!inTelegram) return; // в браузере тему выбирает prefers-color-scheme
    document.documentElement.dataset.theme = tg.colorScheme === 'light' ? 'light' : 'dark';
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--bg').trim();
    try {
      if (tgVersion('6.9')) tg.setHeaderColor(bg);
      if (tgVersion('6.1')) tg.setBackgroundColor(bg);
      if (tgVersion('7.10')) tg.setBottomBarColor(bg);
    } catch (err) {
      // Старые клиенты могут не принять цвет — страница от этого не ломается
    }
    tg.MainButton.setParams({
      color: css.getPropertyValue('--brass-fill').trim(),
      text_color: css.getPropertyValue('--on-brass').trim(),
    });
  }

  // ---------- Даты и слоты ----------

  // Дни считаем от первого дня, который прислал бот (по часам сервера), а не от часов телефона.
  function upcomingDays() {
    let first = new Date();
    if (data.firstDay) {
      const [y, m, d] = data.firstDay.split('-').map(Number);
      first = new Date(y, m - 1, d);
    }
    first.setHours(0, 0, 0, 0);
    return Array.from({ length: data.days }, (_, i) => {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      return d;
    });
  }

  function dayIndexOf(key) {
    return upcomingDays().findIndex((d) => dateKey(d) === key);
  }

  function startOf(key, time) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, Number(time.slice(0, 2)), 0, 0, 0);
  }

  // Занятость мастера в день dayIndex — число, бит i которого означает час firstHour + i.
  function isBusy(master, dayIndex, hour) {
    return Boolean((master.busy[dayIndex] >> (hour - data.firstHour)) & 1);
  }

  // Для «Любого мастера» слот свободен, если свободен хотя бы один мастер.
  function mastersFor(choice) {
    return choice === ANY_MASTER ? data.masters : [choice];
  }

  // current — {dayIndex, time} текущей записи при переносе: её час отмечаем отдельно
  function slotsFor(choice, dayIndex, current) {
    const now = new Date();
    const day = upcomingDays()[dayIndex];
    const slots = [];
    for (let h = data.firstHour; h <= data.lastHour; h++) {
      const time = pad(h) + ':00';
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0);
      let reason = null;
      if (current && current.dayIndex === dayIndex && current.time === time) reason = 'current';
      else if (start <= now) reason = 'past';
      else if (mastersFor(choice).every((m) => isBusy(m, dayIndex, h))) reason = 'busy';
      slots.push({ time, available: reason === null, reason });
    }
    return slots;
  }

  function freeCount(choice, dayIndex) {
    return slotsFor(choice, dayIndex).filter((s) => s.available).length;
  }

  function weekFreeCount(choice) {
    let total = 0;
    for (let i = 0; i < data.days; i++) total += freeCount(choice, i);
    return total;
  }

  function isSlotAvailable(choice, dayIndex, time) {
    return slotsFor(choice, dayIndex).some((s) => s.time === time && s.available);
  }

  function dateText(d, index) {
    const text = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    if (index === 0) return 'сегодня, ' + text;
    if (index === 1) return 'завтра, ' + text;
    return text;
  }

  function longDate(index) {
    return dateText(upcomingDays()[index], index);
  }

  function shortDate(index) {
    return upcomingDays()[index].toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'numeric' });
  }

  function masterName(choice) {
    return choice === ANY_MASTER ? 'Любой мастер' : choice.name;
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function freeLabel(n) {
    if (n === 0) return 'нет свободного времени';
    return n + ' ' + plural(n, 'свободный час', 'свободных часа', 'свободных часов') + ' на неделе';
  }

  // 45 → «45 мин», 60 → «1 ч», 90 → «1 ч 30 мин»
  function durationFmt(minutes) {
    if (!minutes) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return [h ? h + ' ч' : '', m ? m + ' мин' : ''].filter(Boolean).join(' ');
  }

  // Часы работы: с первого часа записи до конца последнего
  const openHour = () => data.firstHour;
  const closeHour = () => data.lastHour + 1;

  // «Открыто до 20:00» по часам работы
  function shopStatus() {
    const hour = new Date().getHours();
    if (hour >= openHour() && hour < closeHour()) return { open: true, text: 'Открыто до ' + pad(closeHour()) + ':00' };
    const when = hour < openHour() ? 'в ' : 'завтра в ';
    return { open: false, text: 'Закрыто · откроется ' + when + pad(openHour()) + ':00' };
  }

  // Предстоящие записи клиента (по часам телефона: уже начавшиеся не показываем)
  function upcomingBookings() {
    const now = new Date();
    return data.bookings.filter((b) => startOf(b.date, b.time) > now)
      .sort((a, b) => startOf(a.date, a.time) - startOf(b.date, b.time));
  }

  // ---------- Отрисовка ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    chevron: ['M9 6l6 6-6 6'],
  };

  function icon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    ICONS[name].forEach((d) => {
      const node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', d);
      svg.append(node);
    });
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className) {
    const btn = el('button', className);
    btn.type = 'button';
    return btn;
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?')[0];
    return letters.toUpperCase();
  }

  // Монограмма в тонком латунном кольце
  function monogram(choice, small) {
    const node = el('span', 'mono' + (small ? ' small' : ''));
    node.setAttribute('aria-hidden', 'true');
    if (choice === ANY_MASTER) {
      node.classList.add('any');
      node.textContent = '∗';
    } else {
      node.textContent = initials(choice.name);
    }
    return node;
  }

  function renderShop() {
    if (data.shop) {
      $('shopName').textContent = data.shop.name;
      $('shopAddress').textContent = data.shop.address;
      $('shopAddress').hidden = !data.shop.address;
      document.title = 'Запись · ' + data.shop.name;
    }
    const status = shopStatus();
    $('shopStatus').textContent = status.text;
    $('shopStatus').classList.toggle('open', status.open);
    $('shopStatus').hidden = false;
  }

  // ---------- Запись: шаги 1–4 ----------

  function renderRepeat() {
    const last = data.last;
    $('repeat').hidden = !last;
    if (!last) return;
    $('repeatWhat').textContent = last.service.name + ' · ' + last.master.name;
  }

  function renderServices() {
    renderRepeat();
    const box = $('services');
    box.replaceChildren();
    data.services.forEach((s) => {
      const btn = button('price-row');
      btn.setAttribute('aria-pressed', String(state.service === s));
      const line = el('span', 'price-line');
      line.append(el('span', 'price-name', s.name), el('span', 'price-dots'), el('span', 'price-value', priceFmt(s.price)));
      btn.append(line);
      if (s.minutes) btn.append(el('span', 'price-meta', durationFmt(s.minutes)));
      btn.addEventListener('click', () => {
        state.service = s;
        select(btn);
        go(2, true);
      });
      box.append(btn);
    });
  }

  function masterRow(choice) {
    const free = weekFreeCount(choice);
    const btn = button('master' + (choice === ANY_MASTER ? ' any' : ''));
    btn.disabled = free === 0;
    btn.setAttribute('aria-pressed', String(state.master === choice));
    const body = el('span', 'master-body');
    body.append(el('span', 'master-name', masterName(choice)));
    const description = choice === ANY_MASTER ? 'Запишем к тому, кто свободен в это время' : choice.description;
    if (description) body.append(el('span', 'master-desc', description));
    body.append(el('span', 'master-free' + (free ? ' has' : ''), freeLabel(free)));
    btn.append(monogram(choice), body, icon('chevron', 'chevron'));
    btn.addEventListener('click', () => {
      if (state.master !== choice) {
        bookPicker.date = null;
        bookPicker.time = null;
      }
      state.master = choice;
      select(btn);
      go(3, true);
    });
    return btn;
  }

  function renderMasters() {
    $('masterHint').textContent = state.service.name + ' · ' + priceFmt(state.service.price);
    const noneFree = weekFreeCount(ANY_MASTER) === 0;
    $('noSlots').hidden = !noneFree;
    $('anyMaster').replaceChildren();
    $('masters').replaceChildren();
    $('masters').hidden = noneFree;
    if (noneFree) return;
    $('anyMaster').append(masterRow(ANY_MASTER));
    data.masters.forEach((m) => $('masters').append(masterRow(m)));
  }

  // ---------- Выбор дня и времени (запись и перенос) ----------

  const DAY_PARTS = [
    { title: 'Утро', from: 0, to: 12 },
    { title: 'День', from: 12, to: 17 },
    { title: 'Вечер', from: 17, to: 24 },
  ];

  // Пикер: элементы страницы (ids), мастер, выбранные день и время, текущая запись (при переносе)
  // и onPick — что делать после выбора времени.
  function makePicker(prefix, onPick) {
    const id = (name) => (prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name);
    return {
      ids: {
        days: id('days'), times: id('times'), title: id('dayTitle'),
        empty: id('timesEmpty'), emptyText: id('timesEmptyText'), next: id('nextFree'),
      },
      master: null, date: null, time: null, current: null, onPick,
    };
  }

  function firstFreeDay(p, from) {
    for (let i = from; i < data.days; i++) {
      if (freeCount(p.master, i) > 0) return i;
    }
    return -1;
  }

  function openPicker(p) {
    // По умолчанию открываем ближайший день со свободным временем
    if (p.date === null || freeCount(p.master, p.date) === 0) {
      const first = firstFreeDay(p, 0);
      p.date = first === -1 ? (p.current ? p.current.dayIndex : 0) : first;
      p.time = null;
    }
    renderPickerDays(p);
    renderPickerTimes(p);
    const current = $(p.ids.days).querySelector('[aria-pressed="true"]');
    if (current) current.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderPickerDays(p) {
    const box = $(p.ids.days);
    box.replaceChildren();
    upcomingDays().forEach((d, i) => {
      const free = freeCount(p.master, i);
      const btn = button('day');
      btn.disabled = free === 0;
      btn.setAttribute('aria-pressed', String(p.date === i));
      btn.setAttribute('aria-label', longDate(i) + (free ? '' : ', нет свободного времени'));
      btn.append(
        el('span', 'wd', d.toLocaleDateString('ru-RU', { weekday: 'short' })),
        el('span', 'num', String(d.getDate())),
        el('span', 'mon', d.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')),
      );
      btn.addEventListener('click', () => {
        if (p.date === i) return;
        p.date = i;
        p.time = null;
        haptic();
        box.querySelectorAll('.day').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        btn.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
        renderPickerTimes(p);
        updateControls();
      });
      box.append(btn);
    });
  }

  function renderPickerTimes(p) {
    $(p.ids.title).textContent = longDate(p.date);
    const box = $(p.ids.times);
    box.replaceChildren();
    const slots = slotsFor(p.master, p.date, p.current);
    const hasFree = slots.some((s) => s.available);

    $(p.ids.empty).hidden = hasFree;
    if (!hasFree) {
      const next = firstFreeDay(p, p.date + 1);
      $(p.ids.emptyText).textContent = next === -1
        ? 'В ближайшие дни всё занято. Загляните позже — время может освободиться.'
        : 'На этот день всё занято. Ближайшее свободное время — ' + longDate(next) + '.';
      $(p.ids.next).hidden = next === -1;
      $(p.ids.next).onclick = () => {
        p.date = next;
        haptic();
        openPicker(p);
      };
      // Без свободного времени в дне с текущей записью всё равно показываем её час
      if (!p.current || p.current.dayIndex !== p.date) return;
    }

    DAY_PARTS.forEach((part) => {
      const partSlots = slots.filter((s) => {
        const h = Number(s.time.slice(0, 2));
        return h >= part.from && h < part.to;
      });
      if (!partSlots.length) return;
      const free = partSlots.filter((s) => s.available).length;
      const group = el('div', 'group');
      const head = el('div', 'group-head');
      head.append(el('b', '', part.title), el('span', '', free ? 'свободно: ' + free : 'всё занято'));
      const grid = el('div', 'slots');
      partSlots.forEach((slot) => {
        const btn = button('chip' + (slot.reason ? ' ' + slot.reason : ''));
        btn.textContent = slot.reason === 'current' ? slot.time + ' · сейчас' : slot.time;
        btn.disabled = !slot.available;
        if (slot.reason === 'busy') btn.setAttribute('aria-label', slot.time + ', занято');
        if (slot.reason === 'past') btn.setAttribute('aria-label', slot.time + ', время прошло');
        if (slot.reason === 'current') btn.setAttribute('aria-label', slot.time + ', время вашей записи');
        btn.setAttribute('aria-pressed', String(p.time === slot.time));
        btn.addEventListener('click', () => {
          p.time = slot.time;
          box.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          haptic();
          p.onPick(slot.time);
        });
        grid.append(btn);
      });
      group.append(head, grid);
      box.append(group);
    });
  }

  const bookPicker = makePicker('', (time) => {
    // Короткая пауза, чтобы было видно выбранное время
    setTimeout(() => {
      if (state.tab === 'book' && state.step === 3 && bookPicker.time === time) go(4, true);
    }, 180);
  });

  const movePicker = makePicker('m', () => updateControls());

  function renderSlotsStep() {
    $('slotHint').textContent = state.service.name + ' · ' + masterName(state.master);
    bookPicker.master = state.master;
    openPicker(bookPicker);
  }

  function renderTicket() {
    $('tShop').textContent = data.shop ? data.shop.name : 'Барбершоп';
    $('tDate').textContent = longDate(bookPicker.date);
    $('tTime').textContent = bookPicker.time;
    $('tService').textContent = state.service.name;
    $('tMaster').replaceChildren(
      monogram(state.master, true),
      document.createTextNode(state.master === ANY_MASTER ? 'Любой свободный' : state.master.name),
    );
    $('tDurationRow').hidden = !state.service.minutes;
    $('tDuration').textContent = durationFmt(state.service.minutes);
    $('tAddressRow').hidden = !(data.shop && data.shop.address);
    if (data.shop) $('tAddress').textContent = data.shop.address;
    $('tPrice').textContent = priceFmt(state.service.price);

    $('inlineWarning').hidden = !openedInline;
    $('demoConfirm').hidden = inTelegram;
    state.sent = false;
  }

  const STEP_NAMES = ['Услуга', 'Мастер', 'Дата и время', 'Подтверждение'];

  function renderProgress() {
    $('progress').hidden = state.tab !== 'book' || state.move !== null;
    $('progressText').textContent = 'Шаг ' + state.step + ' из 4 · ' + STEP_NAMES[state.step - 1];
    $('progressFill').style.width = (state.step * 25) + '%';
  }

  // ---------- Мои записи ----------

  function renderMyCount() {
    const count = upcomingBookings().length;
    $('myCount').textContent = String(count);
    $('myCount').hidden = count === 0;
  }

  function renderBookings() {
    const list = upcomingBookings();
    const box = $('bookings');
    box.replaceChildren();
    $('noBookings').hidden = list.length > 0;
    $('myInlineWarning').hidden = !(openedInline && list.length);
    const canAct = !openedInline && !state.sent;

    list.forEach((b) => {
      const index = dayIndexOf(b.date);
      const card = el('article', 'booking');
      const when = el('div', 'booking-when');
      const [y, m, d] = b.date.split('-').map(Number);
      when.append(el('span', 'booking-date', dateText(new Date(y, m - 1, d), index)), el('span', 'booking-time', b.time));
      const what = el('p', 'booking-what', b.service.name + ' · ' + priceFmt(b.service.price));
      const who = el('div', 'booking-who');
      who.append(monogram(b.master, true), document.createTextNode(b.master.name));

      const actions = el('div', 'booking-actions');
      const move = button('btn-move');
      move.textContent = 'Перенести';
      // Перенести можно в пределах дней, расписание которых прислал бот
      move.disabled = !canAct || weekFreeCount(b.master) === 0;
      move.addEventListener('click', () => openMove(b));
      const cancel = button('btn-cancel');
      cancel.textContent = 'Отменить';
      cancel.disabled = !canAct;
      cancel.addEventListener('click', () => askCancel(b));
      actions.append(move, cancel);

      card.append(when, what, who, actions);
      if (canAct && weekFreeCount(b.master) === 0) {
        card.append(el('p', 'booking-note', 'У мастера нет свободного времени на ближайшие дни — перенос пока недоступен.'));
      }
      box.append(card);
    });
  }

  // «завтра, пятница, 16 октября в 11:00»
  function bookingWhen(b) {
    const [y, m, d] = b.date.split('-').map(Number);
    return dateText(new Date(y, m - 1, d), dayIndexOf(b.date)) + ' в ' + b.time;
  }

  function bookingText(b) {
    return b.service.name + ', ' + bookingWhen(b) + ', мастер ' + b.master.name;
  }

  function askCancel(b) {
    haptic('light');
    confirmDialog('Отменить запись: ' + bookingText(b) + '?', (ok) => {
      if (ok) send({ action: 'cancel', id: b.id });
    });
  }

  function openMove(b) {
    haptic('light');
    state.move = b;
    movePicker.master = b.master;
    const index = dayIndexOf(b.date);
    movePicker.current = index === -1 ? null : { dayIndex: index, time: b.time };
    movePicker.date = index === -1 ? null : index;
    movePicker.time = null;
    $('moveHint').textContent = b.service.name + ' · ' + b.master.name + '. Сейчас: ' + bookingWhen(b);
    show('move', true);
  }

  function moveTarget() {
    return shortDate(movePicker.date) + ', ' + movePicker.time;
  }

  function confirmMove() {
    if (!state.move || !movePicker.time || state.sent) return;
    if (!isSlotAvailable(movePicker.master, movePicker.date, movePicker.time)) {
      haptic('error');
      notify('Это время уже недоступно. Выберите другое.');
      movePicker.time = null;
      openPicker(movePicker);
      updateControls();
      return;
    }
    send({
      action: 'reschedule',
      id: state.move.id,
      date: dateKey(upcomingDays()[movePicker.date]),
      time: movePicker.time,
    });
  }

  // ---------- О барбершопе ----------

  function renderAbout() {
    const shop = data.shop;
    $('aboutName').textContent = shop ? shop.name : 'Барбершоп';
    $('aboutAddressRow').hidden = !(shop && shop.address);
    $('aboutPhoneRow').hidden = !(shop && shop.phone);
    if (shop) {
      $('aboutAddress').textContent = shop.address;
      $('aboutMap').href = 'https://yandex.ru/maps/?text=' + encodeURIComponent(shop.mapQuery);
      $('aboutPhone').textContent = shop.phone;
      // В ссылке tel: оставляем только цифры и плюс
      $('aboutPhone').href = 'tel:' + shop.phone.replace(/[^\d+]/g, '');
    }
    $('aboutHours').textContent = 'Ежедневно, ' + pad(openHour()) + ':00–' + pad(closeHour()) + ':00';
    const status = shopStatus();
    $('aboutStatus').textContent = status.text;
    $('aboutStatus').classList.toggle('open', status.open);

    const box = $('aboutMasters');
    box.replaceChildren();
    data.masters.forEach((m) => {
      const row = el('div', 'master');
      const body = el('span', 'master-body');
      body.append(el('span', 'master-name', m.name));
      if (m.description) body.append(el('span', 'master-desc', m.description));
      row.append(monogram(m), body);
      box.append(row);
    });
  }

  // ---------- Переключение экранов ----------

  // Анимация — только в ответ на действие пользователя
  function animate(node, className, extra) {
    node.classList.remove('enter', 'back', 'fade', 'print');
    if (reducedMotion.matches) return;
    void node.offsetWidth; // перезапуск CSS-анимации
    node.classList.add(className);
    if (extra) node.classList.add(extra);
  }

  function select(btn) {
    btn.setAttribute('aria-pressed', 'true');
    haptic();
  }

  // Показывает экран: номер шага записи, 'my', 'move' или 'about'.
  // byUser — по нажатию (только тогда анимация), motion — 'back' или 'fade'
  function show(screen, byUser, motion) {
    if (screen === 'my') renderBookings();
    if (screen === 'move') openPicker(movePicker);
    if (screen === 'about') renderAbout();
    document.querySelectorAll('.screen').forEach((s) => {
      const active = s.dataset.screen === String(screen);
      s.hidden = !active;
      if (active && byUser) animate(s, 'enter', motion);
    });
    $('result').hidden = true;
    document.querySelectorAll('#tabs [role="tab"]').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.tab === state.tab));
    });
    renderProgress();
    updateControls();
    window.scrollTo({ top: 0 });
  }

  function go(step, byUser) {
    const backwards = step < state.step;
    state.step = step;
    if (step === 1) renderServices();
    if (step === 2) renderMasters();
    if (step === 3) renderSlotsStep();
    if (step === 4) renderTicket();
    show(step, byUser, backwards ? 'back' : null);
    if (step === 4 && byUser && !backwards) animate($('ticket'), 'print');
  }

  function setTab(tab, byUser) {
    if (state.tab === tab && state.move === null) return;
    state.tab = tab;
    state.move = null;
    if (byUser) haptic();
    if (tab === 'book') go(state.step, false);
    else show(tab, false);
    if (byUser) animate(document.querySelector('.screen:not([hidden])'), 'enter', 'fade');
  }

  function back() {
    if (state.move) {
      haptic('light');
      state.move = null;
      show('my', true, 'back');
    } else if (state.tab === 'book' && state.step > 1) {
      haptic('light');
      go(state.step - 1, true);
    }
  }

  // ---------- Кнопки Telegram и демо-режим ----------

  function mainAction() {
    if (state.sent || openedInline) return null;
    if (state.move) return movePicker.time ? 'Перенести на ' + moveTarget() : null;
    if (state.tab === 'book' && state.step === 4) return 'Записаться · ' + priceFmt(state.service.price);
    return null;
  }

  function updateControls() {
    const canGoBack = state.move !== null || (state.tab === 'book' && state.step > 1);
    if (nativeBack) {
      canGoBack ? tg.BackButton.show() : tg.BackButton.hide();
    } else {
      $('demoBack').hidden = !canGoBack;
    }

    const text = mainAction();
    if (inTelegram) {
      if (text) tg.MainButton.setParams({ text, is_visible: true, is_active: true });
      else tg.MainButton.hide();
    } else {
      $('demoMove').hidden = !state.move;
      $('demoMove').disabled = !movePicker.time || state.sent;
      $('demoMove').textContent = movePicker.time && state.move ? 'Перенести на ' + moveTarget() : 'Выберите новое время';
    }
  }

  function onMainButton() {
    if (state.move) confirmMove();
    else confirm();
  }

  // Бот получает только коды: услугу и мастера он сверяет со своим списком, цену берёт у себя.
  function buildPayload() {
    const payload = {
      action: 'book',
      service: state.service.id,
      master: state.master === ANY_MASTER ? ANY_MASTER : state.master.id,
      date: dateKey(upcomingDays()[bookPicker.date]),
      time: bookPicker.time,
    };
    // Комментарий необязателен; бот его ещё раз чистит и обрезает до 200 символов
    const comment = $('comment').value.replace(/\s+/g, ' ').trim();
    if (comment) payload.comment = comment.slice(0, 200);
    return payload;
  }

  function showResult(payload) {
    $('resultJson').textContent = JSON.stringify(payload, null, 2);
    $('result').hidden = false;
    $('demoConfirm').hidden = true;
    $('demoMove').hidden = true;
    $('result').scrollIntoView({ block: 'nearest' });
  }

  // Отправка боту. После sendData Telegram сам закрывает мини-приложение,
  // вне Telegram показываем, что получил бы бот.
  function send(payload) {
    state.sent = true;
    haptic('success');
    if (inTelegram && !openedInline) {
      tg.MainButton.hide();
      try {
        tg.sendData(JSON.stringify(payload));
        return;
      } catch (err) {
        notify('Не удалось отправить данные боту. Откройте страницу через кнопку под полем ввода.');
      }
    }
    showResult(payload);
  }

  function confirm() {
    if (state.tab !== 'book' || state.step !== 4 || state.sent) return;

    // Пока клиент смотрел на экран, выбранный час мог уже пройти.
    if (!isSlotAvailable(state.master, bookPicker.date, bookPicker.time)) {
      haptic('error');
      notify('Это время уже недоступно. Выберите другое.');
      bookPicker.time = null;
      go(3, true);
      return;
    }
    send(buildPayload());
  }

  function notify(text) {
    if (tgVersion('6.2') && tg.showAlert) tg.showAlert(text);
    else window.alert(text);
  }

  function confirmDialog(text, callback) {
    if (tgVersion('6.2') && tg.showConfirm) tg.showConfirm(text, callback);
    else callback(window.confirm(text));
  }

  // Без типа — выбор; 'light' — нажатие; 'success' / 'error' — итог действия
  function haptic(type) {
    if (!tgVersion('6.1') || !tg.HapticFeedback) return;
    if (type === 'success' || type === 'error') tg.HapticFeedback.notificationOccurred(type);
    else if (type) tg.HapticFeedback.impactOccurred(type);
    else tg.HapticFeedback.selectionChanged();
  }

  function restart() {
    state.service = null;
    state.master = null;
    state.move = null;
    state.sent = false;
    state.tab = 'book';
    bookPicker.date = null;
    bookPicker.time = null;
    movePicker.time = null;
    $('comment').value = '';
    go(1, true);
  }

  function repeatLast() {
    if (!data.last) return;
    state.service = data.last.service;
    state.master = data.last.master;
    bookPicker.date = null;
    bookPicker.time = null;
    haptic();
    go(3, true);
  }

  // ---------- Запуск ----------

  function init() {
    if (inTelegram) {
      applyTheme();
      tg.onEvent('themeChanged', applyTheme);
      tg.ready();
      tg.expand();
    } else {
      $('demoBadge').hidden = false;
    }

    // Нет данных от бота или адрес испорчен — записаться отсюда не получится.
    if (!data) {
      $('loadError').hidden = false;
      $('progress').hidden = true;
      const action = $('errorAction');
      if (inTelegram) {
        action.addEventListener('click', () => tg.close());
      } else {
        action.textContent = 'Обновить страницу';
        action.addEventListener('click', () => window.location.reload());
      }
      return;
    }

    renderShop();
    renderMyCount();
    $('tabs').hidden = false;

    if (inTelegram) {
      tg.MainButton.onClick(onMainButton);
      if (nativeBack) tg.BackButton.onClick(back);
    }

    document.querySelectorAll('#tabs [role="tab"]').forEach((t) => {
      t.addEventListener('click', () => setTab(t.dataset.tab, true));
    });
    $('demoBack').addEventListener('click', back);
    $('demoConfirm').addEventListener('click', confirm);
    $('demoMove').addEventListener('click', confirmMove);
    $('restart').addEventListener('click', restart);
    $('repeat').addEventListener('click', repeatLast);
    $('toBook').addEventListener('click', () => setTab('book', true));
    $('aboutMap').addEventListener('click', (event) => {
      // В Telegram внешние ссылки открываем через openLink — так надёжнее, чем target=_blank
      if (inTelegram && tg.openLink) {
        event.preventDefault();
        tg.openLink($('aboutMap').href);
      }
    });

    // Бот может сразу открыть нужный раздел: ?t=my или ?t=about
    const tab = new URLSearchParams(window.location.search).get('t');
    state.tab = tab === 'my' || tab === 'about' ? tab : 'book';
    if (state.tab === 'book') go(1, false);
    else {
      renderServices(); // чтобы при переходе на «Запись» был готов первый шаг
      show(state.tab, false);
    }
  }

  init();
})();
