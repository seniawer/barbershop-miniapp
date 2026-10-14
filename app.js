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
      ['haircut', 'Мужская стрижка', 1500],
      ['beard', 'Стрижка бороды', 800],
      ['combo', 'Стрижка + борода', 2000],
    ],
    m: [
      ['alex', 'Алексей', 'Классика и фейды', [0, 6, 0, 1023, 0, 0, 0]],
      ['boris', 'Борис', 'Бороды и опасная бритва', [3, 0, 0, 0, 0, 0, 0]],
    ],
  };

  const tg = window.Telegram && window.Telegram.WebApp;
  // Вне Telegram скрипт тоже создаёт объект WebApp, но platform = 'unknown'.
  const inTelegram = Boolean(tg && tg.platform && tg.platform !== 'unknown');
  // Через инлайн-кнопку приходит query_id, и sendData в этом случае не работает.
  const openedInline = Boolean(inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.query_id);
  const nativeBack = inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1');

  // date — номер дня от первого (0 — первый день из данных бота)
  const state = { step: 1, service: null, master: null, date: null, time: null, sent: false };

  const $ = (id) => document.getElementById(id);
  const priceFmt = (n) => n.toLocaleString('ru-RU') + ' ₽';

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
    const { d, n, h, s, m } = raw;
    if (!isInt(n) || n < 1 || n > 31) return null;
    if (!Array.isArray(h) || h.length !== 2 || !isInt(h[0]) || !isInt(h[1]) || h[0] > h[1] || h[1] > 23) return null;
    if (d !== null && !(isStr(d) && /^\d{4}-\d{2}-\d{2}$/.test(d))) return null;
    if (!Array.isArray(s) || !s.length || !Array.isArray(m) || !m.length) return null;
    if (![...s, ...m].every(Array.isArray)) return null;
    const services = s.map(([id, name, price]) => ({ id, name, price }));
    const masters = m.map(([id, name, description, busy]) => ({ id, name, description, busy }));
    if (!services.every((x) => isStr(x.id) && isStr(x.name) && isInt(x.price))) return null;
    if (!masters.every((x) => isStr(x.id) && isStr(x.name) && isStr(x.description)
      && Array.isArray(x.busy) && x.busy.length === n && x.busy.every(isInt))) return null;
    return { firstDay: d, days: n, firstHour: h[0], lastHour: h[1], services, masters };
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

  function dayTitle(d, index) {
    if (index === 0) return 'Сегодня';
    if (index === 1) return 'Завтра';
    return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  }

  function longDate(index) {
    return upcomingDays()[index].toLocaleDateString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }

  function masterName(choice) {
    return choice === ANY_MASTER ? 'Любой мастер' : choice.name;
  }

  function freeLabel(n) {
    if (n === 0) return 'нет мест';
    const mod10 = n % 10;
    const mod100 = n % 100;
    let word = 'слотов';
    if (mod10 === 1 && mod100 !== 11) word = 'слот';
    else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = 'слота';
    return n + ' ' + word;
  }

  // ---------- Отрисовка ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderServices() {
    const box = $('services');
    box.replaceChildren();
    data.services.forEach((s) => {
      const btn = el('button', 'option service');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(state.service === s));
      btn.append(el('span', 'name', s.name), el('span', 'price', priceFmt(s.price)));
      btn.addEventListener('click', () => {
        state.service = s;
        haptic();
        go(2);
      });
      box.append(btn);
    });
  }

  function renderMasters() {
    $('masterHint').textContent = state.service.name + ' · ' + priceFmt(state.service.price);
    const box = $('masters');
    box.replaceChildren();
    [ANY_MASTER, ...data.masters].forEach((choice) => {
      const free = weekFreeCount(choice);
      const btn = el('button', 'option master');
      btn.type = 'button';
      btn.disabled = free === 0;
      btn.setAttribute('aria-pressed', String(state.master === choice));
      const info = el('span', 'info');
      info.append(el('span', 'name', masterName(choice)));
      const description = choice === ANY_MASTER ? 'Подберём свободного мастера' : choice.description;
      if (description) info.append(el('span', 'description', description));
      btn.append(info, el('span', 'free', freeLabel(free)));
      btn.addEventListener('click', () => {
        if (state.master !== choice) {
          state.date = null;
          state.time = null;
        }
        state.master = choice;
        haptic();
        go(3);
      });
      box.append(btn);
    });
  }

  function renderDays() {
    $('serviceHint').textContent = state.service.name + ' · ' + masterName(state.master);
    const box = $('days');
    box.replaceChildren();
    upcomingDays().forEach((d, i) => {
      const free = freeCount(state.master, i);
      const btn = el('button', 'option day');
      btn.type = 'button';
      btn.disabled = free === 0;
      btn.setAttribute('aria-pressed', String(state.date === i));
      btn.append(
        el('span', 'weekday', dayTitle(d, i)),
        el('span', 'date', d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '')),
        el('span', 'free', freeLabel(free)),
      );
      btn.addEventListener('click', () => {
        if (state.date !== i) state.time = null;
        state.date = i;
        haptic();
        go(4);
      });
      box.append(btn);
    });
  }

  function renderTimes() {
    $('dayHint').textContent = longDate(state.date) + ' · ' + masterName(state.master);
    const box = $('times');
    box.replaceChildren();
    const slots = slotsFor(state.master, state.date);
    slots.forEach((slot) => {
      const btn = el('button', 'option time', slot.time);
      btn.type = 'button';
      btn.disabled = !slot.available;
      if (slot.reason === 'busy') btn.title = 'Занято';
      if (slot.reason === 'past') btn.title = 'Время прошло';
      btn.setAttribute('aria-pressed', String(state.time === slot.time));
      btn.addEventListener('click', () => {
        state.time = slot.time;
        haptic();
        go(5);
      });
      box.append(btn);
    });
    $('timesEmpty').hidden = slots.some((s) => s.available);
  }

  function renderSummary() {
    $('sumService').textContent = state.service.name;
    $('sumMaster').textContent = state.master === ANY_MASTER ? 'Любой свободный' : state.master.name;
    $('sumDate').textContent = longDate(state.date);
    $('sumTime').textContent = state.time;
    $('sumPrice').textContent = priceFmt(state.service.price);
    $('inlineWarning').hidden = !openedInline;
    $('result').hidden = true;
    $('demoConfirm').hidden = inTelegram;
    state.sent = false;
  }

  function renderSteps() {
    document.querySelectorAll('.steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('current', n === state.step);
      li.classList.toggle('done', n < state.step);
    });
  }

  function go(step) {
    state.step = step;
    if (step === 1) renderServices();
    if (step === 2) renderMasters();
    if (step === 3) renderDays();
    if (step === 4) renderTimes();
    if (step === 5) renderSummary();

    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = Number(s.dataset.screen) !== step;
    });
    renderSteps();
    updateControls();
    window.scrollTo({ top: 0 });
  }

  function back() {
    if (state.step > 1) go(state.step - 1);
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
      if (state.step === 5 && !openedInline && !state.sent) {
        tg.MainButton.setParams({ text: 'Подтвердить запись', is_visible: true, is_active: true });
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
    if (state.step !== 5 || state.sent) return;

    // Пока клиент смотрел на экран, выбранный час мог уже пройти.
    if (!isSlotAvailable(state.master, state.date, state.time)) {
      notify('Это время уже недоступно. Выберите другое.');
      state.time = null;
      go(4);
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
    if (inTelegram && tg.showAlert && tg.isVersionAtLeast('6.2')) tg.showAlert(text);
    else window.alert(text);
  }

  function haptic(type) {
    if (!inTelegram || !tg.HapticFeedback || !tg.isVersionAtLeast('6.1')) return;
    if (type) tg.HapticFeedback.notificationOccurred(type);
    else tg.HapticFeedback.selectionChanged();
  }

  function restart() {
    state.service = null;
    state.master = null;
    state.date = null;
    state.time = null;
    go(1);
  }

  // ---------- Запуск ----------

  function init() {
    if (inTelegram) {
      tg.ready();
      tg.expand();
    } else {
      $('demoBadge').hidden = false;
    }

    // Нет данных от бота или адрес испорчен — записаться отсюда не получится.
    if (!data) {
      $('loadError').hidden = false;
      document.querySelector('.steps').hidden = true;
      document.querySelectorAll('.screen').forEach((s) => { s.hidden = true; });
      return;
    }

    if (inTelegram) {
      tg.MainButton.onClick(confirm);
      if (nativeBack) tg.BackButton.onClick(back);
    }

    $('demoBack').addEventListener('click', back);
    $('demoConfirm').addEventListener('click', confirm);
    $('restart').addEventListener('click', restart);

    go(1);
  }

  init();
})();
