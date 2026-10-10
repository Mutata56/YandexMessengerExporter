// yws-test-thread.js — диагностика ОДНОГО треда перед большим прогоном.
// Тред 1767261600000000 (268 ответов). Проверяет: сколько собрали, порядок,
// постраничную выдачу и — главное — ловятся ли картинки/файлы (Name/Size/Id2).
// Только чтение (метод history). Вставить в консоль при открытом чате.
(async () => {
  const S = window.__yws;
  if (!S) { console.warn('нет __yws — userscript не сработал'); return; }
  const CHAT = window.YWS_CONFIG?.chatUuid; const INVITE = window.YWS_CONFIG?.inviteHash;
  if (!CHAT || !INVITE) throw new Error("Set local YWS_CONFIG before collecting history");
  const ROOT_TS = window.YWS_CONFIG?.rootTimestamp, EXPECTED = 268;

  // живой сокет
  const proto = WebSocket.prototype, orig = proto.send; let tx = S.active;
  proto.send = function (d) { tx = this; return orig.call(this, d); };
  const t0 = performance.now();
  while ((!tx || tx.readyState !== 1) && performance.now() - t0 < 4000) await new Promise(r => setTimeout(r, 50));
  proto.send = orig;
  if (!tx || tx.readyState !== 1) { console.warn('нет живого сокета — открой чат'); return; }

  const enc = (p, seq) => { const m = 'history', j = new TextEncoder().encode(JSON.stringify(p)); const h = [1, 0x93, 0];
    if (seq < 0x80) h.push(seq); else h.push(0xCC, seq & 0xff); h.push(0xA0 | m.length); for (const c of m) h.push(c.charCodeAt(0));
    h.push(5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); const o = new Uint8Array(h.length + j.length); o.set(h, 0); o.set(j, h.length); return o; };
  const rid = () => { const x = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join(''); return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,24)}`; };
  const nextSeq = () => { let mx = 0; for (const r of S.out) { const b = r.head[3]; const s = b < 0x80 ? b : (b === 0xCC ? r.head[4] : 0); if (s > mx) mx = s; } return mx + 1; };
  const when = t => new Date(Math.floor(Number(t) / 1e6 + 3 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16);
  async function ask(params) {
    const id = rid(); params.RequestId = id; const before = S.in.length;
    tx.send(enc(params, nextSeq()));
    const tw = performance.now();
    while (performance.now() - tw < 12000) {
      for (let i = Math.max(0, before - 3); i < S.in.length; i++) { const r = S.in[i]; if (r.method === 'history' && r.json.includes(id)) return JSON.parse(r.json); }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('timeout');
  }

  const byTs = new Map(); let cursor = 2_000_000_000_000_000, pages = 0, counters = null;
  console.log(`=== тест треда ${ROOT_TS} (ожидаем ${EXPECTED}) ===`);
  while (byTs.size < EXPECTED && pages < 30) {
    pages++;
    const resp = await ask({ ChatId: `100/0/${CHAT}_${ROOT_TS}`, InviteHash: INVITE, Limit: 300,
      MaxTimestamp: cursor, ChatDataFilter: {} });
    const chat = resp.Chats && resp.Chats[0]; const msgs = (chat && chat.Messages) || []; if (chat && chat.Counters) counters = chat.Counters;
    const prev = byTs.size; let mn = cursor, mx = 0;
    for (const x of msgs) { const ts = x.ServerMessage && x.ServerMessage.ServerMessageInfo && x.ServerMessage.ServerMessageInfo.Timestamp;
      if (ts == null) continue; byTs.set(String(ts), x); if (ts < mn) mn = ts; if (ts > mx) mx = ts; }
    console.log(`страница ${pages}: пришло ${msgs.length}, всего ${byTs.size} | окно ${when(mn)} … ${when(mx)}`);
    await new Promise(r => setTimeout(r, 150));
    if (byTs.size === prev || mn >= cursor) break;
    cursor = mn;
  }

  const all = [...byTs.values()].sort((a, b) => { const ta = a.ServerMessage.ServerMessageInfo.Timestamp, tb = b.ServerMessage.ServerMessageInfo.Timestamp; return ta < tb ? -1 : ta > tb ? 1 : 0; });
  let nText = 0, nImg = 0, nFile = 0, imgTotal = 0, fileTotal = 0; const imgSamples = [], fileSamples = [];
  for (const x of all) {
    const plain = (x.ServerMessage.ClientMessage && x.ServerMessage.ClientMessage.Plain) || {};
    if (plain.Text && plain.Text.MessageText) nText++;
    const imgs = [];
    if (plain.Image && plain.Image.FileInfo) imgs.push(plain.Image.FileInfo);
    for (const it of (plain.Gallery && plain.Gallery.Items) || []) if (it.Image && it.Image.FileInfo) imgs.push(it.Image.FileInfo);
    const imgSet = new Set(imgs);
    const fis = []; (function walk(n) { if (n && typeof n === 'object') { if (n.Id2) fis.push(n); for (const k in n) walk(n[k]); } })(plain);
    const files = fis.filter(f => !imgSet.has(f) && !/\.(jpe?g|png|gif|webp|heic)$/i.test(f.Name || ''));
    if (imgs.length) { nImg++; imgTotal += imgs.length; for (const f of imgs) if (imgSamples.length < 6) imgSamples.push({ Name: f.Name, Size: f.Size, Id2: f.Id2 }); }
    if (files.length) { nFile++; fileTotal += files.length; for (const f of files) if (fileSamples.length < 6) fileSamples.push({ Name: f.Name, Size: f.Size, Id2: f.Id2 }); }
  }
  const f = all[0], l = all[all.length - 1];
  const nm = x => (x && x.ServerMessage.ServerMessageInfo.From && x.ServerMessage.ServerMessageInfo.From.DisplayName) || '?';
  console.log('%c=== ИТОГ ===', 'font-weight:bold;color:#06c');
  console.log(`собрано ${all.length} / ожидалось ${EXPECTED} | страниц ${pages}`);
  console.log('Counters:', counters);
  console.log(`первое: ${nm(f)} @ ${when(f.ServerMessage.ServerMessageInfo.Timestamp)} | последнее: ${nm(l)} @ ${when(l.ServerMessage.ServerMessageInfo.Timestamp)}`);
  console.log(`с текстом: ${nText} | сообщений с картинками: ${nImg} (всего картинок ${imgTotal}) | с файлами: ${nFile} (всего файлов ${fileTotal})`);
  console.log('🖼 ПРИМЕРЫ КАРТИНОК (Name / Size / Id2):', imgSamples);
  console.log('📎 ПРИМЕРЫ ФАЙЛОВ:', fileSamples);
  window.__t268 = { all, counters, imgSamples, fileSamples, got: all.length };
  console.log('%cполный результат в window.__t268', 'color:#888');
})();
