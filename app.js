(function () {
  'use strict';

  // Особое значение мастера: «Любой мастер» — бот сам выберет свободного.
  const ANY_MASTER = 'any';

  // Демо-данные: только для открытия страницы в браузере без параметра d.
  // В Telegram услуги, мастеров и занятость всегда присылает бот.
  const DEMO_DATA = {
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
    b: ['Барбершоп «Бритва»', 'ул. Пушкина, 10'],
  };

  const tg = window.Telegram && window.Telegram.WebApp;
  // Вне Telegram скрипт тоже создаёт объект WebApp, но platform = 'unknown'.
  const inTelegram = Boolean(tg && tg.platform && tg.platform !== 'unknown');
  // Через инлайн-кнопку приходит query_id, и sendData в этом случае не работает.
  const openedInline = Boolean(inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.query_id);
  const tgVersion = (v) => inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast(v);
  const nativeBack = tgVersion('6.1');

  // date — номер дня от первого (0 — первый день из данных бота)
  const state = { step: 1, service: null, master: null, date: null, time: null, sent: false };

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
    const { d, n, h, s, m, b } = raw;
    if (!isInt(n) || n < 1 || n > 31) return null;
    if (!Array.isArray(h) || h.length !== 2 || !isInt(h[0]) || !isInt(h[1]) || h[0] > h[1] || h[1] > 23) return null;
    if (d !== null && !(isStr(d) && /^\d{4}-\d{2}-\d{2}$/.test(d))) return null;
    if (!Array.isArray(s) || !s.length || !Array.isArray(m) || !m.length) return null;
    if (![...s, ...m].every(Array.isArray)) return null;
    // Длительность услуги и b (название и адрес) необязательны: старый бот их не присылает
    const services = s.map(([id, name, price, minutes]) => ({ id, name, price, minutes: minutes ?? null }));
    const masters = m.map(([id, name, description, busy]) => ({ id, name, description, busy }));
    if (!services.every((x) => isStr(x.id) && isStr(x.name) && isInt(x.price)
      && (x.minutes === null || (isInt(x.minutes) && x.minutes > 0)))) return null;
    if (!masters.every((x) => isStr(x.id) && isStr(x.name) && isStr(x.description)
      && Array.isArray(x.busy) && x.busy.length === n && x.busy.every(isInt))) return null;
    const shop = Array.isArray(b) && b.length >= 2 && b.every(isStr) ? { name: b[0], address: b[1] } : null;
    return { firstDay: d, days: n, firstHour: h[0], lastHour: h[1], services, masters, shop };
  }

  function loadData() {
    const raw = new URLSearchParams(window.location.search).get('d');
    // Без параметра в Telegram записываться некуда, а в браузере показываем демо.
    if (!raw) return inTelegram ? null : parseData(DEMO_DATA);
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

  function pad(n) { return String(n).padStart(2, '0'); }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

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

  // Занятость мастера в день dayIndex — число, бит i которого означает час firstHour + i.
  function isBusy(master, dayIndex, hour) {
    return Boolean((master.busy[dayIndex] >> (hour - data.firstHour)) & 1);
  }

  // Для «Любого мастера» слот свободен, если свободен хотя бы один мастер.
  function mastersFor(choice) {
    return choice === ANY_MASTER ? data.masters : [choice];
  }

  function slotsFor(choice, dayIndex) {
    const now = new Date();
    const day = upcomingDays()[dayIndex];
    const slots = [];
    for (let h = data.firstHour; h <= data.lastHour; h++) {
      const time = pad(h) + ':00';
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0);
      let reason = null;
      if (start <= now) reason = 'past';
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

  function longDate(index) {
    const text = upcomingDays()[index].toLocaleDateString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    if (index === 0) return 'сегодня, ' + text;
    if (index === 1) return 'завтра, ' + text;
    return text;
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

  // «Открыто до 20:00» по часам работы (с первого часа записи до конца последнего)
  function shopStatus() {
    const open = data.firstHour;
    const close = data.lastHour + 1;
    const hour = new Date().getHours();
    if (hour >= open && hour < close) return { open: true, text: 'Открыто до ' + pad(close) + ':00' };
    const when = hour < open ? 'в ' : 'завтра в ';
    return { open: false, text: 'Закрыто · откроется ' + when + pad(open) + ':00' };
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

  function renderServices() {
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
        state.date = null;
        state.time = null;
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

  function firstFreeDay(from) {
    for (let i = from; i < data.days; i++) {
      if (freeCount(state.master, i) > 0) return i;
    }
    return -1;
  }

  function renderSlotsStep() {
    $('slotHint').textContent = state.service.name + ' · ' + masterName(state.master);
    // По умолчанию открываем ближайший день со свободным временем
    if (state.date === null || freeCount(state.master, state.date) === 0) {
      const first = firstFreeDay(0);
      state.date = first === -1 ? 0 : first;
      state.time = null;
    }
    renderDays();
    renderTimes();
    const current = $('days').querySelector('[aria-pressed="true"]');
    if (current) current.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderDays() {
    const box = $('days');
    box.replaceChildren();
    upcomingDays().forEach((d, i) => {
      const free = freeCount(state.master, i);
      const btn = button('day');
      btn.disabled = free === 0;
      btn.setAttribute('aria-pressed', String(state.date === i));
      btn.setAttribute('aria-label', longDate(i) + (free ? '' : ', нет свободного времени'));
      btn.append(
        el('span', 'wd', d.toLocaleDateString('ru-RU', { weekday: 'short' })),
        el('span', 'num', String(d.getDate())),
        el('span', 'mon', d.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')),
      );
      btn.addEventListener('click', () => {
        if (state.date === i) return;
        state.date = i;
        state.time = null;
        haptic();
        box.querySelectorAll('.day').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        btn.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
        renderTimes();
      });
      box.append(btn);
    });
  }

  const DAY_PARTS = [
    { title: 'Утро', from: 0, to: 12 },
    { title: 'День', from: 12, to: 17 },
    { title: 'Вечер', from: 17, to: 24 },
  ];

  function renderTimes() {
    $('dayTitle').textContent = longDate(state.date);
    const box = $('times');
    box.replaceChildren();
    const slots = slotsFor(state.master, state.date);
    const hasFree = slots.some((s) => s.available);

    $('timesEmpty').hidden = hasFree;
    if (!hasFree) {
      const next = firstFreeDay(state.date + 1);
      $('timesEmptyText').textContent = next === -1
        ? 'В ближайшие дни всё занято. Загляните позже — время может освободиться.'
        : 'На этот день всё занято. Ближайшее свободное время — ' + longDate(next) + '.';
      $('nextFree').hidden = next === -1;
      $('nextFree').onclick = () => {
        state.date = next;
        haptic();
        renderSlotsStep();
      };
      return;
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
        btn.textContent = slot.time;
        btn.disabled = !slot.available;
        if (slot.reason === 'busy') btn.setAttribute('aria-label', slot.time + ', занято');
        if (slot.reason === 'past') btn.setAttribute('aria-label', slot.time + ', время прошло');
        btn.setAttribute('aria-pressed', String(state.time === slot.time));
        btn.addEventListener('click', () => {
          if (state.step !== 3) return;
          state.time = slot.time;
          box.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          haptic();
          // Короткая пауза, чтобы было видно выбранное время
          setTimeout(() => { if (state.step === 3 && state.time === slot.time) go(4, true); }, 180);
        });
        grid.append(btn);
      });
      group.append(head, grid);
      box.append(group);
    });
  }

  function renderTicket() {
    $('tShop').textContent = data.shop ? data.shop.name : 'Барбершоп';
    $('tDate').textContent = longDate(state.date);
    $('tTime').textContent = state.time;
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
    $('result').hidden = true;
    $('demoConfirm').hidden = inTelegram;
    state.sent = false;
  }

  const STEP_NAMES = ['Услуга', 'Мастер', 'Дата и время', 'Подтверждение'];

  function renderProgress() {
    $('progressText').textContent = 'Шаг ' + state.step + ' из 4 · ' + STEP_NAMES[state.step - 1];
    $('progressFill').style.width = (state.step * 25) + '%';
  }

  // Анимация — только в ответ на действие пользователя
  function animate(node, className, extra) {
    node.classList.remove('enter', 'back', 'print');
    if (reducedMotion.matches) return;
    void node.offsetWidth; // перезапуск CSS-анимации
    node.classList.add(className);
    if (extra) node.classList.add(extra);
  }

  function select(btn) {
    btn.setAttribute('aria-pressed', 'true');
    haptic();
  }

  // byUser — переход по нажатию: только тогда показываем анимацию
  function go(step, byUser) {
    const backwards = step < state.step;
    state.step = step;
    if (step === 1) renderServices();
    if (step === 2) renderMasters();
    if (step === 3) renderSlotsStep();
    if (step === 4) renderTicket();

    document.querySelectorAll('.screen').forEach((s) => {
      const active = Number(s.dataset.screen) === step;
      s.hidden = !active;
      if (active && byUser) animate(s, 'enter', backwards ? 'back' : null);
    });
    if (step === 4 && byUser && !backwards) animate($('ticket'), 'print');
    renderProgress();
    updateControls();
    window.scrollTo({ top: 0 });
  }

  function back() {
    if (state.step > 1) {
      haptic('light');
      go(state.step - 1, true);
    }
  }

  // ---------- Кнопки Telegram и демо-режим ----------

  function updateControls() {
    const canGoBack = state.step > 1;
    if (nativeBack) {
      canGoBack ? tg.BackButton.show() : tg.BackButton.hide();
    } else {
      $('demoBack').hidden = !canGoBack;
    }

    if (inTelegram) {
      if (state.step === 4 && !openedInline && !state.sent) {
        tg.MainButton.setParams({ text: 'Записаться · ' + priceFmt(state.service.price), is_visible: true, is_active: true });
      } else {
        tg.MainButton.hide();
      }
    }
  }

  // Бот получает только коды: услугу и мастера он сверяет со своим списком, цену берёт у себя.
  function buildPayload() {
    return {
      service: state.service.id,
      master: state.master === ANY_MASTER ? ANY_MASTER : state.master.id,
      date: dateKey(upcomingDays()[state.date]),
      time: state.time,
    };
  }

  function showResult(payload) {
    $('resultJson').textContent = JSON.stringify(payload, null, 2);
    $('result').hidden = false;
    $('demoConfirm').hidden = true;
  }

  function confirm() {
    if (state.step !== 4 || state.sent) return;

    // Пока клиент смотрел на экран, выбранный час мог уже пройти.
    if (!isSlotAvailable(state.master, state.date, state.time)) {
      haptic('error');
      notify('Это время уже недоступно. Выберите другое.');
      state.time = null;
      go(3, true);
      return;
    }

    const payload = buildPayload();
    state.sent = true;
    haptic('success');

    if (inTelegram && !openedInline) {
      tg.MainButton.hide();
      try {
        // После sendData Telegram сам закрывает мини-приложение.
        tg.sendData(JSON.stringify(payload));
        return;
      } catch (err) {
        notify('Не удалось отправить данные боту. Откройте страницу через кнопку под полем ввода.');
      }
    }
    showResult(payload);
  }

  function notify(text) {
    if (tgVersion('6.2') && tg.showAlert) tg.showAlert(text);
    else window.alert(text);
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
    state.date = null;
    state.time = null;
    go(1, true);
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

    if (inTelegram) {
      tg.MainButton.onClick(confirm);
      if (nativeBack) tg.BackButton.onClick(back);
    }

    $('demoBack').addEventListener('click', back);
    $('demoConfirm').addEventListener('click', confirm);
    $('restart').addEventListener('click', restart);

    go(1, false);
  }

  init();
})();
