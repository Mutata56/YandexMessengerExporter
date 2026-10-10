// yws-fetch.js — быстрый рассыльщик history по всем тредам (Клиент B ФРЦ).
// Требует установленный userscript-перехватчик (window.__yws).
// РЕЖИМ ТОЛЬКО ЧТЕНИЕ: шлём исключительно метод "history" (запрос истории). Никаких записей.
//
// ЗАПУСК: открой чат «Клиент B. Запуск ФРЦ», вставь весь этот файл в консоль, затем:
//    yfetch.run()                 — с начала (или с сохранённого места)
//    yfetch.run(0)                — принудительно с самого начала
//    yfetch.stop()                — мягко остановить (текущий тред дозавершится)
//    yfetch.status()              — где мы сейчас
// Файлы yascrap-threads-partNN.json будут скачиваться сами; autocollect.sh перенесёт их в raw/.
// Если браузер спросит про «скачивание нескольких файлов» — разреши.

const yfetch = (() => {
  const S = window.__yws;
  if (!S) { console.error('нет window.__yws — сначала установи userscript-перехватчик'); return {}; }

  const CHAT   = window.YWS_CONFIG?.chatUuid;
  const INVITE = window.YWS_CONFIG?.inviteHash;
  if (!CHAT || !INVITE) throw new Error("Set local YWS_CONFIG before collecting history");
  const CHAT_NAME = window.YWS_CONFIG?.chatName || "My chat";

  // список тредов: [[rootTs, replyCount], ...] — вшит из threads_list.json
  const THREADS = window.YWS_CONFIG?.threads || [];

  // ---- настройки ----
  const CFG = {
    batchSize: 150,        // тредов на один part-файл
    pauseMs: 140,          // пауза между тредами (не выглядеть как нагрузка)
    pageLimit: 1500,       // сервер отдаёт большой Limit целиком → любой тред за 1 запрос (макс. тред ~1137)
    timeoutMs: 12000,      // ожидание ответа на один history-запрос
    maxPages: 60,          // предохранитель против бесконечной пагинации
    retries: 1,            // повторов при таймауте на тред
  };
  const MAX_TS = 2_000_000_000_000_000; // выше любого реального ts, но < 2^53 (точно)

  // ---- состояние ----
  const LS_KEY = 'yfetch_idx';
  let abort = false, running = false;
  let partNo = 0, batch = {}, batchCount = 0;

  // ---- живой сокет ----
  if (!S.__txHooked) {
    const proto = WebSocket.prototype, prev = proto.send;
    proto.send = function (d) { S.tx = this; return prev.call(this, d); };
    S.__txHooked = true;
  }
  async function getSocket() {
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      const ws = (S.tx && S.tx.readyState === 1) ? S.tx : (S.active && S.active.readyState === 1 ? S.active : null);
      if (ws) return ws;
      await sleep(150);
    }
    throw new Error('нет живого сокета (открой чат, дождись подключения)');
  }

  // ---- seq (монотонно, всегда впереди клиента) ----
  let mySeq = 0;
  function clientMaxSeq() {
    let mx = 0;
    for (const r of S.out) { const b = r.head[3]; const s = b < 0x80 ? b : (b === 0xCC ? r.head[4] : (b === 0xCD ? ((r.head[4] << 8) | r.head[5]) : 0)); if (s > mx) mx = s; }
    return mx;
  }
  function nextSeq() { mySeq = Math.max(mySeq + 1, clientMaxSeq() + 1); return mySeq; }

  // ---- кодер history-кадра (метод жёстко "history") ----
  function encode(params, seq) {
    const m = 'history', j = new TextEncoder().encode(JSON.stringify(params));
    const h = [1, 0x93, 0];
    if (seq < 0x80) h.push(seq);
    else if (seq < 0x100) h.push(0xCC, seq);
    else h.push(0xCD, (seq >> 8) & 0xff, seq & 0xff);
    h.push(0xA0 | m.length);
    for (const c of m) h.push(c.charCodeAt(0));
    h.push(5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const o = new Uint8Array(h.length + j.length);
    o.set(h, 0); o.set(j, h.length);
    return o;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function rid() {
    const x = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 24)}`;
  }

  // ---- один history-запрос с ожиданием ответа по RequestId ----
  async function ask(params) {
    const ws = await getSocket();
    const id = rid();
    params.RequestId = id;
    const before = S.in.length;
    ws.send(encode(params, nextSeq()));
    const t0 = performance.now();
    while (performance.now() - t0 < CFG.timeoutMs) {
      for (let i = Math.max(0, before - 3); i < S.in.length; i++) {
        const r = S.in[i];
        if (r.method === 'history' && r.json.includes(id)) return JSON.parse(r.json);
      }
      await sleep(50);
    }
    throw new Error('timeout');
  }

  // ---- собрать один тред целиком (с пагинацией) ----
  async function fetchThread(rootTs, expected) {
    const chatId = `100/0/${CHAT}_${rootTs}`;
    const byTs = new Map();
    let cursor = MAX_TS, pages = 0, counters = null;
    while (byTs.size < expected && pages < CFG.maxPages) {
      pages++;
      const params = {
        ChatId: chatId, InviteHash: INVITE, Limit: CFG.pageLimit,
        MaxTimestamp: cursor, ChatDataFilter: {},
      };
      const resp = await ask(params);
      const chat = resp.Chats && resp.Chats[0];
      const msgs = (chat && chat.Messages) || [];
      if (chat && chat.Counters) counters = chat.Counters;
      const prevSize = byTs.size;
      let minTs = cursor;
      for (const x of msgs) {
        const ts = x.ServerMessage && x.ServerMessage.ServerMessageInfo && x.ServerMessage.ServerMessageInfo.Timestamp;
        if (ts == null) continue;
        byTs.set(String(ts), x);
        if (ts < minTs) minTs = ts;
      }
      if (byTs.size === prevSize) break;   // страница не дала нового — конец
      if (minTs >= cursor) break;
      cursor = minTs;                      // следующая страница — старше
    }
    const msgs = [...byTs.values()].sort((a, b) => {
      const ta = a.ServerMessage.ServerMessageInfo.Timestamp, tb = b.ServerMessage.ServerMessageInfo.Timestamp;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return { expected, got: msgs.length, gaps: Math.max(0, expected - msgs.length), pages, counters, msgs };
  }

  // ---- сохранение part-файла (скачивание) ----
  function flush(finished) {
    if (batchCount === 0 && !finished) return;
    partNo++;
    const lastTs = Object.keys(batch).slice(-1)[0] || '';
    const payload = { chat: CHAT_NAME, inviteHash: INVITE, source: 'websocket',
                      threads: batch, errors: yfetch._errors.slice(), count: batchCount, lastTs, finished: !!finished };
    const name = `yascrap-threads-part${String(partNo).padStart(2, '0')}.json`;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    console.log(`%c💾 сохранён ${name}: тредов ${batchCount}`, 'color:#0a0;font-weight:bold');
    batch = {}; batchCount = 0;
  }

  const api = {
    _errors: [],
    async run(startIndex) {
      if (running) { console.warn('уже идёт'); return; }
      running = true; abort = false; this._errors = [];
      let i = (startIndex != null) ? startIndex : (parseInt(localStorage.getItem(LS_KEY) || '0', 10) || 0);
      partNo = 0; batch = {}; batchCount = 0;
      console.log(`%cСтарт: тредов ${THREADS.length}, с индекса ${i}`, 'color:#06c;font-weight:bold');
      const t0 = performance.now();
      for (; i < THREADS.length; i++) {
        if (abort) { console.log('остановлено пользователем на индексе', i); break; }
        const [rootTs, cnt] = THREADS[i];
        let res = null;
        for (let attempt = 0; attempt <= CFG.retries; attempt++) {
          try { res = await fetchThread(rootTs, cnt); break; }
          catch (e) { if (attempt === CFG.retries) { this._errors.push({ rootTs, error: String(e) }); console.warn(`тред ${rootTs} ошибка: ${e}`); } else { await sleep(600); } }
        }
        if (res) {
          batch[rootTs] = res; batchCount++;
          const flag = res.gaps ? `⚠️${res.got}/${res.expected}` : `${res.got}/${res.expected}`;
          if (i % 10 === 0 || res.gaps) console.log(`[${i + 1}/${THREADS.length}] ${rootTs} ${flag}`);
        }
        localStorage.setItem(LS_KEY, String(i + 1));
        if (batchCount >= CFG.batchSize) flush(false);
        await sleep(CFG.pauseMs);
      }
      flush(true);
      running = false;
      const secs = Math.round((performance.now() - t0) / 1000);
      console.log(`%c✅ Готово. Индекс ${i}/${THREADS.length}, ошибок ${this._errors.length}, время ${secs}s`, 'color:#0a0;font-weight:bold');
      if (this._errors.length) console.log('ошибки:', this._errors);
    },
    stop() { abort = true; console.log('останавливаю после текущего треда...'); },
    status() {
      const idx = parseInt(localStorage.getItem(LS_KEY) || '0', 10) || 0;
      console.log(`тредов всего: ${THREADS.length}, обработано: ${idx}, идёт: ${running}, part: ${partNo}, в батче: ${batchCount}`);
      return { total: THREADS.length, done: idx, running };
    },
    reset() { localStorage.removeItem(LS_KEY); console.log('прогресс сброшен'); },
    _fetchThread: fetchThread, THREADS,
  };
  console.log('%cyfetch готов. Запусти: yfetch.run()', 'color:#06c;font-weight:bold');
  return api;
})();
