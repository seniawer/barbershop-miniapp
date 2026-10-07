(function () {
  'use strict';

  const SERVICES = [
    { id: 'haircut', name: 'Мужская стрижка', price: 1500 },
    { id: 'beard', name: 'Стрижка бороды', price: 800 },
    { id: 'haircut_beard', name: 'Стрижка + борода', price: 2000 },
    { id: 'kids', name: 'Детская стрижка', price: 1000 },
    { id: 'clipper', name: 'Стрижка машинкой', price: 700 },
  ];
  const DAYS_AHEAD = 7;
  const FIRST_HOUR = 10;
  const LAST_HOUR = 19;

  const tg = window.Telegram && window.Telegram.WebApp;
  // Вне Telegram скрипт тоже создаёт объект WebApp, но platform = 'unknown'.
  const inTelegram = Boolean(tg && tg.platform && tg.platform !== 'unknown');
  // Через инлайн-кнопку приходит query_id, и sendData в этом случае не работает.
  const openedInline = Boolean(inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.query_id);
  const nativeBack = inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1');

  const state = { step: 1, service: null, date: null, time: null, sent: false };
  const busy = parseBusy(new URLSearchParams(window.location.search).get('busy'));

  const $ = (id) => document.getElementById(id);
  const priceFmt = (n) => n.toLocaleString('ru-RU') + ' ₽';

  // ---------- Даты и слоты ----------

  function pad(n) { return String(n).padStart(2, '0'); }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseBusy(raw) {
    const set = new Set();
    if (!raw) return set;
    raw.split(',').forEach((item) => {
      const value = item.trim();
      if (/^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/.test(value)) set.add(value);
    });
    return set;
  }

  function upcomingDays() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: DAYS_AHEAD }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      return d;
    });
  }

  function slotsFor(dayKey) {
    const now = new Date();
    const [y, m, d] = dayKey.split('-').map(Number);
    const slots = [];
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
      const time = pad(h) + ':00';
      const start = new Date(y, m - 1, d, h, 0, 0, 0);
      let reason = null;
      if (start <= now) reason = 'past';
      else if (busy.has(dayKey + '_' + time)) reason = 'busy';
      slots.push({ time, available: reason === null, reason });
    }
    return slots;
  }

  function isSlotAvailable(dayKey, time) {
    return slotsFor(dayKey).some((s) => s.time === time && s.available);
  }

  function dayTitle(d, index) {
    if (index === 0) return 'Сегодня';
    if (index === 1) return 'Завтра';
    return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  }

  function longDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
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
    SERVICES.forEach((s) => {
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

  function renderDays() {
    $('serviceHint').textContent = state.service.name + ' · ' + priceFmt(state.service.price);
    const box = $('days');
    box.replaceChildren();
    upcomingDays().forEach((d, i) => {
      const key = dateKey(d);
      const free = slotsFor(key).filter((s) => s.available).length;
      const btn = el('button', 'option day');
      btn.type = 'button';
      btn.disabled = free === 0;
      btn.setAttribute('aria-pressed', String(state.date === key));
      btn.append(
        el('span', 'weekday', dayTitle(d, i)),
        el('span', 'date', d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '')),
        el('span', 'free', freeLabel(free)),
      );
      btn.addEventListener('click', () => {
        if (state.date !== key) state.time = null;
        state.date = key;
        haptic();
        go(3);
      });
      box.append(btn);
    });
  }

  function renderTimes() {
    $('dayHint').textContent = longDate(state.date);
    const box = $('times');
    box.replaceChildren();
    const slots = slotsFor(state.date);
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
        go(4);
      });
      box.append(btn);
    });
    $('timesEmpty').hidden = slots.some((s) => s.available);
  }

  function renderSummary() {
    $('sumService').textContent = state.service.name;
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
    if (step === 2) renderDays();
    if (step === 3) renderTimes();
    if (step === 4) renderSummary();

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
      if (state.step === 4 && !openedInline && !state.sent) {
        tg.MainButton.setParams({ text: 'Подтвердить запись', is_visible: true, is_active: true });
      } else {
        tg.MainButton.hide();
      }
    }
  }

  function buildPayload() {
    return {
      service: state.service.name,
      price: state.service.price,
      date: state.date,
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
    if (!isSlotAvailable(state.date, state.time)) {
      notify('Это время уже недоступно. Выберите другое.');
      state.time = null;
      go(3);
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
    state.date = null;
    state.time = null;
    go(1);
  }

  // ---------- Запуск ----------

  function init() {
    if (inTelegram) {
      tg.ready();
      tg.expand();
      tg.MainButton.onClick(confirm);
      if (nativeBack) tg.BackButton.onClick(back);
    } else {
      $('demoBadge').hidden = false;
    }

    $('demoBack').addEventListener('click', back);
    $('demoConfirm').addEventListener('click', confirm);
    $('restart').addEventListener('click', restart);

    go(1);
  }

  init();
})();
