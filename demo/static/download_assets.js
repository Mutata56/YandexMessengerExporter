// download_assets.js — скачивание байтов вложений БЕЗ подтверждения каждого файла.
// Использует File System Access API: выбираешь папку ОДИН раз → скрипт пишет туда все файлы.
// Резолвит Id2 → files.messenger.yandex.ru/file_shortterm/<Id2> → {url} → байты.
// Вставить в консоль вкладки мессенджера (сессия нужна для доступа к файлам).
//
// Порядок: 1) выбери export/attachments_todo.json  2) «Тест 15»  3) если ок — «Скачать всё».
// Папку выбирай = export/ (файлы лягут в export/threads/.../attachments/ рядом с thread.md).

(() => {
  const FILE_SHORTTERM = 'https://files.messenger.yandex.ru/file_shortterm/';
  const CONC = 4;         // параллельных загрузок
  const PAUSE = 60;       // пауза между пачками, мс
  if (document.getElementById('yws-dl')) document.getElementById('yws-dl').remove();
  if (!window.showDirectoryPicker) { console.error('Нет File System Access API — нужен Chrome/Chromium.'); return; }

  const box = document.createElement('div');
  box.id = 'yws-dl';
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;background:#1e1e1e;color:#ddd;font:13px/1.4 monospace;padding:14px;border:1px solid #444;border-radius:8px;width:320px;box-shadow:0 4px 20px rgba(0,0,0,.5)';
  box.innerHTML = `
    <div style="font-weight:bold;margin-bottom:8px;color:#6cf">YWS загрузчик вложений</div>
    <input id="yws-file" type="file" accept="application/json" style="width:100%;margin-bottom:8px;color:#ddd">
    <div style="display:flex;DEMO_PROJECT:6px;margin-bottom:8px">
      <button id="yws-test" style="flex:1;padding:6px;cursor:pointer">Тест 15</button>
      <button id="yws-all" style="flex:1;padding:6px;cursor:pointer;background:#2a6;color:#fff;border:0;border-radius:4px">Скачать всё</button>
      <button id="yws-stop" style="padding:6px;cursor:pointer">Стоп</button>
    </div>
    <div id="yws-log" style="max-height:120px;overflow:auto;white-space:pre-wrap;color:#9c9">готов. выбери attachments_todo.json</div>`;
  document.body.appendChild(box);

  const logEl = box.querySelector('#yws-log');
  const log = (m) => { logEl.textContent = m + '\n' + logEl.textContent; console.log('[yws-dl]', m); };
  let TODO = null, abort = false;

  box.querySelector('#yws-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    TODO = JSON.parse(await f.text());
    log(`загружено вложений: ${TODO.length}`);
  });
  box.querySelector('#yws-stop').addEventListener('click', () => { abort = true; log('стоп...'); });
  box.querySelector('#yws-test').addEventListener('click', () => run(15));
  box.querySelector('#yws-all').addEventListener('click', () => run(0));

  async function fetchBytesOnce(id2) {
    // ?get_url=1 → сервер отдаёт JSON {url} (читаемый по CORS с куками), без size = оригинал
    const r1 = await fetch(FILE_SHORTTERM + id2 + '?get_url=1',
      { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r1.ok) throw new Error('resolve ' + r1.status);
    const j = await r1.json();
    const d = j && (j.data || j);
    const url = d && (d.url || d.href || d.download_url || d.file_url);
    if (!url) throw new Error('нет url в ответе: ' + JSON.stringify(j).slice(0, 160));
    const r2 = await fetch(url, { credentials: 'omit' });   // подписанный публичный URL — без кук
    if (!r2.ok) throw new Error('dl ' + r2.status);
    return await r2.blob();
  }

  // до 3 попыток: cert/403/сетевые сбои Яндекса лечатся повтором (свежий get_url
  // может вернуть другую storage-ноду). 404 = файла нет на сервере → не повторяем.
  async function fetchBytes(id2) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await fetchBytesOnce(id2); }
      catch (e) {
        lastErr = e;
        if (String(e.message || e).includes('resolve 404')) throw e;
        if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }
    throw lastErr;
  }

  // уже скачан? (идемпотентность: перезапуск не качает заново готовое)
  async function fileExists(root, relPath) {
    const parts = relPath.split('/').filter(Boolean);
    let dir = root;
    try {
      for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: false });
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: false });
      return (await fh.getFile()).size > 0;
    } catch (e) { return false; }
  }

  async function ensureFileHandle(root, relPath) {
    const parts = relPath.split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
    return await dir.getFileHandle(parts[parts.length - 1], { create: true });
  }

  async function one(root, item) {
    if (await fileExists(root, item.target)) return -1;   // -1 = пропущено (уже есть)
    const bytes = await fetchBytes(item.id2);
    const fh = await ensureFileHandle(root, item.target);
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return bytes.size;
  }

  async function run(limit) {
    if (!TODO) { log('сначала выбери attachments_todo.json'); return; }
    abort = false;
    let root;
    try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { log('папка не выбрана'); return; }
    const items = limit ? TODO.slice(0, limit) : TODO;
    log(`старт: ${items.length} файлов → выбранная папка`);
    let done = 0, ok = 0, skip = 0, fail = 0, bytes = 0; const errors = [];
    const t0 = performance.now();
    for (let i = 0; i < items.length && !abort; i += CONC) {
      const chunk = items.slice(i, i + CONC);
      await Promise.all(chunk.map(async (it) => {
        try { const sz = await one(root, it); if (sz === -1) skip++; else { bytes += sz; ok++; } }
        catch (e) { fail++; if (errors.length < 30) errors.push(`${it.name || it.id2}: ${e.message}`); }
        done++;
      }));
      if (done % 200 < CONC || done === items.length)
        log(`${done}/${items.length} | новых ${ok}, пропущено ${skip}, ошибок ${fail}, ${(bytes / 1e6).toFixed(1)} МБ`);
      if (ok || fail) await new Promise(r => setTimeout(r, PAUSE));   // пропуски не тормозим
    }
    const secs = Math.round((performance.now() - t0) / 1000);
    log(`ГОТОВО: новых ${ok}, пропущено ${skip}, ошибок ${fail}, ${(bytes / 1e6).toFixed(1)} МБ, ${secs}s`);
    if (errors.length) console.log('[yws-dl] примеры ошибок:', errors);
  }
  console.log('%c[yws-dl] панель внизу справа. Выбери attachments_todo.json → Тест 15.', 'color:#6cf;font-weight:bold');
})();
