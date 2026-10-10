#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
download_local.py — локальная докачка вложений (в обход CORS).

Браузер блокирует скачивание file_shortterm по CORS. Локальный процесс CORS не
знает, поэтому с твоей сессионной кукой качает файлы напрямую:
    GET files.messenger.yandex.ru/file_shortterm/<Id2>  (с Cookie)
        → 302 на подписанный downloader.disk.yandex.ru → байты файла.

Кладёт файлы прямо в export/<target> (рядом с thread.md), с настоящими именами.
Идемпотентно: уже скачанные (непустые) файлы пропускает — можно перезапускать.

КУКА (нужна один раз):
  1. В браузере на вкладке мессенджера открой DevTools → вкладка Network.
  2. В фильтре набери  file_shortterm  (такие запросы уже есть от прошлых попыток;
     если нет — открой в чате любую картинку, чтобы запрос появился).
  3. Клик по запросу → Headers → Request Headers → строка "Cookie:" →
     скопируй ВСЁ её значение.
  4. Вставь в файл  cookie.txt  рядом со скриптами (или задай env YWS_COOKIE).

ЗАПУСК:
  python3 scripts/download_local.py
  python3 scripts/download_local.py --workers 6 --limit 15     # тест на 15
Куку берёт из: --cookie-file / env YWS_COOKIE / файла cookie.txt.
"""

import argparse, json, os, sys, time, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

FILE_SHORTTERM = "https://files.messenger.yandex.ru/file_shortterm/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def load_cookie(args, base):
    if os.environ.get("YWS_COOKIE"):
        return os.environ["YWS_COOKIE"].strip()
    for p in (args.cookie_file, os.path.join(base, "cookie.txt")):
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return f.read().strip()
    return None


def fetch(id2, cookie, timeout):
    req = urllib.request.Request(
        FILE_SHORTTERM + id2,
        headers={"Cookie": cookie, "User-Agent": UA, "Accept": "*/*"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:   # urllib сам идёт по 302
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=".")
    ap.add_argument("--out", default="export")
    ap.add_argument("--todo", default=None, help="по умолчанию export/attachments_todo.json")
    ap.add_argument("--cookie-file", default=None)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="скачать только первые N (тест)")
    ap.add_argument("--timeout", type=int, default=40)
    args = ap.parse_args()

    out_dir = os.path.join(args.base, args.out)
    todo_path = args.todo or os.path.join(out_dir, "attachments_todo.json")
    if not os.path.exists(todo_path):
        print("Нет", todo_path, "— сначала прогони organize.py"); sys.exit(1)
    todo = json.load(open(todo_path, encoding="utf-8"))
    if args.limit:
        todo = todo[: args.limit]

    cookie = load_cookie(args, args.base)
    if not cookie or "Session_id" not in cookie and "sessionid2" not in cookie.lower():
        print("Кука не найдена или подозрительная. Положи Cookie-заголовок в cookie.txt "
              "(см. инструкцию вверху скрипта). Проверка ищет 'Session_id'.")
        if not cookie:
            sys.exit(1)
        print("Продолжаю с тем, что есть...")

    lock = threading.Lock()
    stat = {"ok": 0, "skip": 0, "fail": 0, "bytes": 0, "done": 0}
    errors = []
    total = len(todo)
    print(f"К скачиванию: {total} вложений, воркеров: {args.workers}")

    def work(item):
        target = os.path.join(out_dir, item["target"])
        if os.path.exists(target) and os.path.getsize(target) > 0:
            with lock: stat["skip"] += 1; stat["done"] += 1
            return
        os.makedirs(os.path.dirname(target), exist_ok=True)
        for attempt in range(2):
            try:
                data = fetch(item["id2"], cookie, args.timeout)
                if not data:
                    raise ValueError("пустой ответ")
                tmp = target + ".part"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, target)
                with lock:
                    stat["ok"] += 1; stat["bytes"] += len(data); stat["done"] += 1
                return
            except Exception as e:
                if attempt == 0:
                    time.sleep(0.8); continue
                with lock:
                    stat["fail"] += 1; stat["done"] += 1
                    if len(errors) < 30:
                        errors.append(f"{item.get('name') or item['id2']}: {e}")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(work, it) for it in todo]
        for i, _ in enumerate(as_completed(futs), 1):
            if i % 50 == 0 or i == total:
                s = stat
                print(f"[{s['done']}/{total}] ок {s['ok']}, пропущено {s['skip']}, "
                      f"ошибок {s['fail']}, {s['bytes']/1e6:.1f} МБ")

    dt = int(time.time() - t0)
    s = stat
    print(f"\nГОТОВО: ок {s['ok']}, пропущено {s['skip']}, ошибок {s['fail']}, "
          f"{s['bytes']/1e6:.1f} МБ, {dt}s")
    if errors:
        print("Примеры ошибок:")
        for e in errors[:15]:
            print("  ", e)
        print("Если много 403 — кука устарела, скопируй свежую и перезапусти "
              "(уже скачанное пропустится).")


if __name__ == "__main__":
    main()
