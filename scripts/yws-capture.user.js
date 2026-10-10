// ==UserScript==
// @name         YWS capture — Клиент B ФРЦ (только чтение)
// @namespace    yascrap
// @version      0.1
// @description  Перехват WebSocket-кадров Яндекс Мессенджера (входящих и исходящих) для разбора формата запроса history. Сам ничего не отправляет.
// @match        https://messenger.360.yandex.ru/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// ЗАЧЕМ: снять точный формат ИСХОДЯЩЕГО кадра history, который в доках помечен
// как «не подтверждён». Работает только на document-start (до бандла) и с @grant none
// (скрипт исполняется в контексте страницы, а не в песочнице Tampermonkey) — иначе
// мы патчим не тот window.WebSocket.
//
// ПОСЛЕ УСТАНОВКИ:
//   1. Открой чат «Клиент B. Запуск ФРЦ».
//   2. Открой ОДИН тред по ссылке-перманенту, например из export/index.md:
//        #/join/00000000-0000-4000-8000-00000000000d/<rootTs>/<rootTs>
//   3. В консоли:  __yws.grep('<rootTs>')     — найдёт кадр-запрос с этим ts
//      либо        __yws.dumpOut(15)          — последние исходящие кадры
//      либо        __yws.stats()              — сводка по методам
//   4. Пришли мне вывод grep для этого треда (head40 + json + b64).

(function () {
  'use strict';
  if (window.__yws) { console.log('[__yws] уже установлен'); return; }

  const S = window.__yws = { in: [], out: [], sockets: [], active: null, MAX: 150 };
  const td = new TextDecoder('utf-8');

  // компактный base64 для полного кадра (чанками, чтобы не упереться в стек)
  function b64(u8) {
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  // эвристика: имя метода = самая длинная ASCII-буквенная цепочка в первых 24 байтах
  function methodOf(u8) {
    let best = '', cur = '';
    for (let i = 1; i < Math.min(u8.length, 24); i++) {
      const c = u8[i];
      if (c >= 0x61 && c <= 0x7a) cur += String.fromCharCode(c);
      else { if (cur.length > best.length) best = cur; cur = ''; }
    }
    if (cur.length > best.length) best = cur;
    return best;
  }

  // JSON-хвост: по докам с offset 24, но на всякий случай ищем первую '{'
  function jsonTail(u8) {
    let off = 24;
    if (u8[off] !== 0x7b) { const i = u8.indexOf(0x7b); off = i >= 0 ? i : u8.length; }
    try { return td.decode(u8.subarray(off)); } catch (e) { return ''; }
  }

  function push(list, u8copy) {
    const rec = {
      len: u8copy.length,
      head: Array.from(u8copy.subarray(0, 40)),
      method: methodOf(u8copy),
      json: jsonTail(u8copy),
      bytes: u8copy,
    };
    list.push(rec);
    if (list.length > S.MAX) list.shift();
    return rec;
  }

  function record(list, data) {
    try {
      if (typeof data === 'string') {
        push(list, new TextEncoder().encode(data));
      } else if (data instanceof ArrayBuffer) {
        push(list, new Uint8Array(data.slice(0)));
      } else if (ArrayBuffer.isView(data)) {
        push(list, new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      } else if (data instanceof Blob) {
        data.arrayBuffer().then(b => push(list, new Uint8Array(b)));
      }
    } catch (e) { /* молча: перехват не должен ломать клиент */ }
  }

  const OW = window.WebSocket;
  const protoSend = OW.prototype.send;

  // исходящие — на уровне прототипа (мы первыми, до бандла)
  OW.prototype.send = function (data) {
    record(S.out, data);
    return protoSend.call(this, data);
  };

  // входящие + запоминание активного сокета — через конструктор
  window.WebSocket = new Proxy(OW, {
    construct(Target, args) {
      const ws = new Target(...args);
      S.sockets.push(String(args[0]));
      S.active = ws;
      ws.addEventListener('message', ev => record(S.in, ev.data));
      return ws;
    },
  });

  // ---- помощники для разбора ----
  S.stats = function () {
    const cnt = l => l.reduce((a, r) => (a[r.method] = (a[r.method] || 0) + 1, a), {});
    console.log('OUT методы:', cnt(S.out));
    console.log('IN  методы:', cnt(S.in));
    console.log('сокеты:', S.sockets);
    return { out: S.out.length, in: S.in.length };
  };

  const line = (r) => ({ len: r.len, method: r.method, json: (r.json || '').slice(0, 300) });

  S.dumpOut = function (n = 10) {
    const arr = S.out.slice(-n);
    arr.forEach((r, i) => console.log(`out[-${arr.length - i}]`, line(r)));
    return arr.map(line);
  };

  // найти кадры (in+out), у которых head или json содержит подстроку (например rootTs треда)
  S.grep = function (sub) {
    const hit = (r) => (r.json && r.json.includes(sub)) ||
                       r.head.join(',').includes(sub) ||
                       (r.method && r.method.includes(sub));
    const out = S.out.filter(hit), inp = S.in.filter(hit);
    console.log(`=== OUT совпадений: ${out.length} ===`);
    out.forEach((r) => {
      console.log('method:', r.method, 'len:', r.len);
      console.log('head40:', JSON.stringify(r.head));
      console.log('json:', r.json);
      console.log('b64:', b64(r.bytes));
      console.log('—');
    });
    console.log(`=== IN совпадений: ${inp.length} (для сверки) ===`);
    inp.slice(0, 3).forEach((r) => console.log('IN head40:', JSON.stringify(r.head), 'len:', r.len));
    return { out: out.map(r => ({ head: r.head, json: r.json, b64: b64(r.bytes) })) };
  };

  S.full = (dir, i) => { const r = S[dir][i]; return r && { head: r.head, json: r.json, b64: b64(r.bytes) }; };

  console.log('%c[__yws] перехват установлен. Открой ОДИН тред, затем: __yws.grep("<rootTs>")', 'color:green;font-weight:bold');
})();
