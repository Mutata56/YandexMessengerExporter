// yws-probe.js — решающий тест «прямой отправки» history-кадра.
// Вставить в консоль вкладки мессенджера (чат должен быть ОТКРЫТ, чтобы сокет был живой).
// Шлёт ОДИН history-запрос по треду и ждёт ответ. Ничего не пишет в чат — только метод history (чтение).
(async () => {
  const S = window.__yws;
  if (!S) { console.warn('нет __yws — userscript не установлен/не сработал'); return; }

  const CHAT   = window.YWS_CONFIG?.chatUuid;
  const INVITE = window.YWS_CONFIG?.inviteHash;
  if (!CHAT || !INVITE) throw new Error("Set local YWS_CONFIG before collecting history");
  const ROOT_TS = window.YWS_CONFIG?.rootTimestamp;   // тестовый тред (в threads_list у него 7 ответов)

  // 1) поймать ЖИВОЙ сокет: временно перехватываем следующий client-send (heartbeat/marker)
  const proto = WebSocket.prototype, orig = proto.send;
  let tx = S.active;
  proto.send = function (d) { tx = this; return orig.call(this, d); };
  const t0 = performance.now();
  while ((!tx || tx.readyState !== 1) && performance.now() - t0 < 4000)
    await new Promise(r => setTimeout(r, 50));
  proto.send = orig; // вернуть перехват userscript'а как был
  if (!tx || tx.readyState !== 1) { console.warn('нет живого сокета — открой чат и повтори'); return; }
  console.log('живой сокет:', tx.url, 'readyState=', tx.readyState);

  // 2) энкодер history-кадра (метод жёстко "history" — только чтение)
  const enc = (params, seq) => {
    const m = 'history', j = new TextEncoder().encode(JSON.stringify(params));
    const h = [1, 0x93, 0];
    if (seq < 0x80) h.push(seq); else h.push(0xCC, seq & 0xff);
    h.push(0xA0 | m.length);
    for (const c of m) h.push(c.charCodeAt(0));
    h.push(5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const o = new Uint8Array(h.length + j.length);
    o.set(h, 0); o.set(j, h.length);
    return o;
  };
  const rid = (() => {
    const x = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,24)}`;
  })();
  // seq = максимальный клиентский + 1 (минимальное возмущение потока)
  let mx = 0;
  for (const r of S.out) { const b = r.head[3]; const s = b < 0x80 ? b : (b === 0xCC ? r.head[4] : 0); if (s > mx) mx = s; }
  const seq = mx + 1;

  const params = { RequestId: rid, ChatId: `100/0/${CHAT}_${ROOT_TS}`, InviteHash: INVITE, Limit: 200, ChatDataFilter: {} };
  const before = S.in.length;
  tx.send(enc(params, seq));
  console.log('→ отправлен history seq=', seq, 'RequestId=', rid, '— жду ответ (до 8с)...');

  // 3) ждём входящий history-кадр с нашим RequestId
  const tw = performance.now(); let hit = null;
  while (performance.now() - tw < 8000) {
    for (let i = Math.max(0, before - 3); i < S.in.length; i++) {
      const r = S.in[i];
      if (r.method === 'history' && r.json.includes(rid)) { hit = r; break; }
    }
    if (hit) break;
    await new Promise(r => setTimeout(r, 60));
  }

  if (!hit) {
    console.warn('❌ ответ НЕ пришёл за 8с. Прямая отправка, похоже, не проходит — откатимся на навигацию.');
    console.log('   (проверь: чат открыт? сокет OPEN? см. __yws.stats())');
    return;
  }
  const data = JSON.parse(hit.json);
  const chats = data.Chats || [];
  const msgs = (chats[0] && chats[0].Messages) || [];
  const cnt = chats[0] && chats[0].Counters;
  console.log(`✅ УСПЕХ. Ответ ${hit.len} байт. Сообщений в треде: ${msgs.length} (ожидалось ~7).`);
  if (cnt) console.log('   Counters:', cnt);
  console.log('   Пример сообщения (сырой ServerMessage):', msgs[0]);
  window.__probe = data; // положим ответ в window, чтобы можно было посмотреть
})();
