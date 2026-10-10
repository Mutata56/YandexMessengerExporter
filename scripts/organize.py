#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
organize.py — Stage 3 of the Yandex Messenger export.

Reads whatever the browser has already pulled into ./raw and lays it out into
./export as a browsable tree: readable transcripts (Markdown), structured JSON,
permalinks back to each message, and a manifest of every attachment.

READ-ONLY and purely local: it never talks to Yandex, only reshapes files that
Stage 1 (yws-fetch.js / DOM collector) and Stage 2 (downloader) produced.

Understands two message shapes and normalizes both:
  * WebSocket (yws-fetch): raw {ServerMessage:{ClientMessage, ServerMessageInfo}, Meta}
    — pristine, includes FileInfo{Name,Size,Id2} for documents and images.
  * DOM (old collector): {ts, author, text, links[], imageSrcs?, reactions}.

Inputs (under ./raw):
  yascrap-root-full.json     (fallback yascrap-root-ckpt3.json) — the root feed (DOM)
  yascrap-threads-part*.json — collected thread histories (WS or DOM), merged by name
"""

import argparse, csv, glob, hashlib, json, os, re, sys
from datetime import datetime, timezone, timedelta

CHAT_NAME_DEFAULT   = "Demo chat"
CHAT_ID_DEFAULT     = ""
INVITE_HASH_DEFAULT = ""
CHAT_UUID           = ""
TOTAL_MESSAGE_COUNT = 0
MESSENGER_BASE      = "https://messenger.360.yandex.ru"
FILE_SHORTTERM      = "https://files.messenger.yandex.ru/file_shortterm/"


# ---------------- helpers ----------------
def ts_to_dt(ts, tz_hours):
    try:
        secs = int(ts) // 1_000_000
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(secs, timezone(timedelta(hours=tz_hours)))


def fmt_dt(dt):
    return dt.strftime("%Y-%m-%d %H:%M") if dt else "????-??-?? ??:??"


def slugify(text, maxlen=48):
    text = (text or "").strip()
    text = re.sub(r'[\\/:*?"<>|]+', "", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_. ")[:maxlen].strip("_. ")
    return text or "no-text"


def sha(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


def clean_text(text, time_str):
    text = (text or "").rstrip()
    if time_str and text.endswith(time_str):
        text = text[: -len(time_str)].rstrip()
    return text


def safe_name(name, fallback):
    name = (name or "").strip().replace("/", "_").replace("\\", "_")
    name = re.sub(r'[:*?"<>|]+', "", name)
    return name[:120] or fallback


# ---------------- normalization ----------------
def _find_fileinfos(node, acc):
    """Recursively collect dicts that look like a FileInfo (have Id2)."""
    if isinstance(node, dict):
        if "Id2" in node:
            acc.append(node)
        for v in node.values():
            _find_fileinfos(v, acc)
    elif isinstance(node, list):
        for v in node:
            _find_fileinfos(v, acc)


def normalize_ws(elem):
    sm = elem.get("ServerMessage") or {}
    plain = ((sm.get("ClientMessage") or {}).get("Plain")) or {}
    info = sm.get("ServerMessageInfo") or {}
    frm = info.get("From") or {}
    ts = info.get("Timestamp")

    text = ""
    if isinstance(plain.get("Text"), dict):
        text = plain["Text"].get("MessageText", "") or ""
    elif isinstance(plain.get("Gallery"), dict):
        text = plain["Gallery"].get("Text", "") or ""

    # which FileInfos are images (under Image/Gallery) vs generic files
    img_fis = []
    if isinstance(plain.get("Image"), dict) and isinstance(plain["Image"].get("FileInfo"), dict):
        img_fis.append(plain["Image"]["FileInfo"])
    for it in (plain.get("Gallery") or {}).get("Items") or []:
        fi = (it.get("Image") or {}).get("FileInfo") if isinstance(it, dict) else None
        if isinstance(fi, dict):
            img_fis.append(fi)
    img_ids = {id(x) for x in img_fis}

    all_fis = []
    _find_fileinfos(plain, all_fis)
    files, images = [], []
    for fi in all_fis:
        rec = {"name": fi.get("Name"), "size": fi.get("Size"), "id2": fi.get("Id2")}
        if id(fi) in img_ids or (fi.get("Name") or "").lower().endswith(
                (".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic")):
            images.append(rec)
        else:
            files.append(rec)

    reactions = [{"type": r.get("Type"), "count": r.get("Count")}
                 for r in (sm.get("Reactions") or [])]

    return {
        "ts": str(ts) if ts is not None else "",
        "author": frm.get("DisplayName") or "",
        "guid": frm.get("Guid"),
        "text": text,
        "time": None,
        "files": files,          # [{name,size,id2}]
        "images": images,        # [{name,size,id2}]
        "reactions": reactions,
        "edited": bool(info.get("LastEditTimestamp")),
        "seqNo": info.get("SeqNo"),
    }


def normalize_dom(m):
    files = [{"name": None, "size": None, "url": u}
             for u in (m.get("links") or []) if isinstance(u, str)]
    images = [{"name": None, "size": None, "url": u}
              for u in (m.get("imageSrcs") or []) if isinstance(u, str)]
    return {
        "ts": str(m.get("ts", "")),
        "author": (m.get("author") or "").strip(),
        "guid": None,
        "text": clean_text(m.get("text", ""), m.get("time")),
        "time": m.get("time"),
        "files": files,
        "images": images,
        "reactions": m.get("reactions") or [],
        "edited": False,
        "seqNo": None,
    }


def normalize(elem):
    if isinstance(elem, dict) and "ServerMessage" in elem:
        return normalize_ws(elem)
    return normalize_dom(elem)


# ---------------- loading ----------------
def load_root(raw_dir):
    for name in ("yascrap-root-full.json", "yascrap-root-ckpt3.json"):
        p = os.path.join(raw_dir, name)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f), name
    return None, None


def load_threads(raw_dir):
    merged, errors, parts = {}, [], []
    for p in sorted(glob.glob(os.path.join(raw_dir, "yascrap-threads*part*.json"))):
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        parts.append(os.path.basename(p))
        for root_ts, tdata in (data.get("threads") or {}).items():
            merged[str(root_ts)] = tdata
        for e in (data.get("errors") or []):
            errors.append(e)
    return merged, errors, parts


def load_threads_list(base_dir):
    p = os.path.join(base_dir, "threads_list.json")
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# ---------------- rendering ----------------
def attachment_ref(a):
    """Human/manifest reference: real download comes from id2 (WS) or url (DOM)."""
    if a.get("id2"):
        return FILE_SHORTTERM + a["id2"]
    return a.get("url") or ""


def render_message_md(nm, tz, indent=False):
    dt = ts_to_dt(nm.get("ts"), tz)
    author = (nm.get("author") or "—").strip()
    text = nm.get("text", "")
    prefix = "> " if indent else ""
    lines = [f"{prefix}**{author}** · {fmt_dt(dt)} · `{nm.get('ts')}`"
             + ("  _(ред.)_" if nm.get("edited") else "")]
    if text:
        for ln in text.split("\n"):
            lines.append(f"{prefix}{ln}")
    for im in nm.get("images", []):
        label = im.get("name") or "image"
        lines.append(f"{prefix}🖼 {label}" + (f" ({im['size']} B)" if im.get('size') else ""))
    for fl in nm.get("files", []):
        label = fl.get("name") or attachment_ref(fl)
        lines.append(f"{prefix}📎 {label}" + (f" ({fl['size']} B)" if fl.get('size') else ""))
    if nm.get("reactions"):
        lines.append(f"{prefix}_reactions: {json.dumps(nm['reactions'], ensure_ascii=False)}_")
    return "\n".join(lines)


def collect_assets(nm, thread_ts, target_dir, tz, rows):
    for kind, arr in (("image", nm.get("images", [])), ("file", nm.get("files", []))):
        for a in arr:
            ref = attachment_ref(a)
            if not ref and not a.get("id2"):
                continue
            base = safe_name(a.get("name"),
                             f"{nm.get('ts')}_{sha(ref or a.get('id2',''))}"
                             + (".jpg" if kind == "image" else ".bin"))
            fname = f"{nm.get('ts')}_{base}"
            rows.append({
                "thread_root_ts": thread_ts or "",
                "msg_ts": nm.get("ts", ""),
                "author": nm.get("author", ""),
                "date": fmt_dt(ts_to_dt(nm.get("ts"), tz)),
                "kind": kind,
                "id2": a.get("id2") or "",
                "url": a.get("url") or "",
                "name": a.get("name") or "",
                "size": a.get("size") if a.get("size") is not None else "",
                "target_rel_path": os.path.join(target_dir, "attachments", fname),
            })


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="raw")
    ap.add_argument("--out", default="export")
    ap.add_argument("--tz", type=float, default=3.0, help="fixed UTC offset (default +3 MSK)")
    ap.add_argument("--base", default=".")
    args = ap.parse_args()

    raw_dir = os.path.join(args.base, args.raw)
    out_dir = os.path.join(args.base, args.out)
    tz = args.tz

    root, root_file = load_root(raw_dir)
    threads, thread_errors, parts = load_threads(raw_dir)
    threads_list = load_threads_list(args.base)

    if root is None and not threads:
        print("Nothing to organize: no yascrap-root-*.json or yascrap-threads*part*.json in", raw_dir)
        sys.exit(1)

    chat_name = (root or {}).get("chat") or CHAT_NAME_DEFAULT
    invite_hash = (root or {}).get("inviteHash") or INVITE_HASH_DEFAULT

    def permalink(ts, thread=False):
        return f"{MESSENGER_BASE}/#/join/{invite_hash}/{ts}/{ts}" if thread \
            else f"{MESSENGER_BASE}/#/join/{invite_hash}/{ts}"

    os.makedirs(out_dir, exist_ok=True)
    manifest_rows = []

    # ---- root feed (DOM) ----
    root_msgs_raw = (root or {}).get("messages", [])
    root_norm = [normalize(m) for m in root_msgs_raw]
    TOTAL_MESSAGE_COUNT = int((root or {}).get("expectedCount") or len(root_norm))
    root_by_ts = {m["ts"]: m for m in root_norm}
    if root_norm:
        msg_dir = os.path.join(out_dir, "messages")
        os.makedirs(msg_dir, exist_ok=True)
        with open(os.path.join(msg_dir, "root.md"), "w", encoding="utf-8") as f:
            f.write(f"# {chat_name} — root feed\n\n")
            f.write(f"{len(root_norm)} top-level messages "
                    f"(reference total = {TOTAL_MESSAGE_COUNT}).\n\n---\n\n")
            for m in root_norm:
                f.write(render_message_md(m, tz))
                f.write(f"\n\n[permalink]({permalink(m['ts'])})")
                f.write(f" · [open thread]({permalink(m['ts'], True)})\n\n---\n\n")
                collect_assets(m, None, "messages", tz, manifest_rows)

    # ---- threads ----
    thr_root = os.path.join(out_dir, "threads")
    per_thread_stats = []
    for root_ts, tdata in threads.items():
        raw_msgs = tdata.get("msgs") or []
        norm = [normalize(x) for x in raw_msgs]
        parent = root_by_ts.get(str(root_ts)) or (norm[0] if norm else {})
        dt = ts_to_dt(root_ts, tz)
        month = dt.strftime("%Y-%m") if dt else "unknown"
        slug = slugify((parent or {}).get("text", ""))
        rel = os.path.join("threads", month, f"{root_ts}__{slug}")
        folder = os.path.join(out_dir, rel)
        os.makedirs(folder, exist_ok=True)

        expected = tdata.get("expected")
        got = tdata.get("got", len(norm))
        gaps = tdata.get("gaps", 0)
        per_thread_stats.append((str(root_ts), expected, got, gaps))

        with open(os.path.join(folder, "thread.json"), "w", encoding="utf-8") as f:
            json.dump(tdata, f, ensure_ascii=False, indent=2)

        with open(os.path.join(folder, "thread.md"), "w", encoding="utf-8") as f:
            f.write(f"# Thread · {fmt_dt(dt)}\n\n")
            f.write(f"- Root permalink: {permalink(root_ts)}\n")
            f.write(f"- Open thread: {permalink(root_ts, True)}\n")
            f.write(f"- Replies expected/collected: {expected}/{got}"
                    + (f"  ⚠️ {gaps} missing" if gaps else "  ✓") + "\n\n")
            if parent and parent.get("text"):
                f.write(f"**Parent:** {clean_text(parent.get('text',''), None)[:200]}\n\n")
            f.write("---\n\n")
            for i, m in enumerate(norm):
                f.write(render_message_md(m, tz, indent=True))
                f.write("\n\n")
                collect_assets(m, str(root_ts), rel, tz, manifest_rows)

    # ---- disambiguate colliding attachment filenames ----
    # Несколько вложений в одном сообщении (галерея из image.png) имеют
    # одинаковые msg_ts + имя -> один и тот же target -> затирают друг друга на
    # диске. Каждому члену конфликтующей группы даём уникальное имя из его
    # (глобально уникального) Id2/url. Неконфликтующие имена НЕ трогаем, чтобы
    # уже скачанные файлы продолжали совпадать.
    from collections import Counter as _Counter
    _counts = _Counter(r["target_rel_path"] for r in manifest_rows)
    for r in manifest_rows:
        if _counts[r["target_rel_path"]] > 1:
            d, fn = os.path.split(r["target_rel_path"])
            stem, ext = os.path.splitext(fn)
            token = sha(r["id2"] or r["url"] or (stem + ext))[:8]
            r["target_rel_path"] = os.path.join(d, f"{stem}__{token}{ext}")

    # ---- manifest ----
    with open(os.path.join(out_dir, "manifest_assets.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["thread_root_ts", "msg_ts", "author", "date",
                                          "kind", "id2", "url", "name", "size", "target_rel_path"])
        w.writeheader()
        w.writerows(manifest_rows)

    # slim to-do list for the in-browser downloader (only WS items with Id2)
    todo = [{"id2": r["id2"], "kind": r["kind"], "name": r["name"],
             "target": r["target_rel_path"]} for r in manifest_rows if r["id2"]]
    with open(os.path.join(out_dir, "attachments_todo.json"), "w", encoding="utf-8") as f:
        json.dump(todo, f, ensure_ascii=False)

    # ---- completeness ----
    listed = {str(ts) for ts, _ in threads_list}
    collected = set(str(k) for k in threads.keys())
    missing = sorted(listed - collected, key=lambda s: int(s)) if listed else []
    incomplete = [(t, e, g, gp) for (t, e, g, gp) in per_thread_stats if gp]

    with_id2 = sum(1 for r in manifest_rows if r["id2"])
    with_url = sum(1 for r in manifest_rows if r["url"] and not r["id2"])

    with open(os.path.join(out_dir, "index.md"), "w", encoding="utf-8") as f:
        f.write(f"# {chat_name} — export index\n\n")
        f.write(f"- Root file: `{root_file}` — {len(root_norm)} messages "
                f"(reference {TOTAL_MESSAGE_COUNT}, {TOTAL_MESSAGE_COUNT - len(root_norm)} not captured)\n")
        f.write(f"- Thread parts merged: {', '.join(parts) or '—'}\n")
        f.write(f"- Threads collected: **{len(collected)} / {len(listed) or '?'}** "
                f"({len(missing)} still to collect)\n")
        f.write(f"- Threads with gaps: {len(incomplete)}\n")
        f.write(f"- Attachments: {len(manifest_rows)} "
                f"(with Id2/WS: {with_id2}, with URL/DOM: {with_url}, "
                f"images: {sum(1 for r in manifest_rows if r['kind']=='image')}, "
                f"files: {sum(1 for r in manifest_rows if r['kind']=='file')})\n")
        f.write(f"- Collection errors: {len(thread_errors)}\n\n")
        if missing:
            f.write("## Threads not yet collected\n\n")
            f.write(f"{len(missing)} thread roots from `threads_list.json` still have no data. "
                    "First 20:\n\n")
            for t in missing[:20]:
                f.write(f"- `{t}` — {fmt_dt(ts_to_dt(t, tz))} — {permalink(t, True)}\n")
            f.write("\n")
        if incomplete:
            f.write("## Threads with missing replies\n\n")
            for t, e, g, gp in incomplete[:40]:
                f.write(f"- `{t}`: {g}/{e} (missing {gp}) — {permalink(t, True)}\n")

    print(f"Chat: {chat_name}")
    print(f"Root feed: {len(root_norm)} messages (reference {TOTAL_MESSAGE_COUNT})")
    print(f"Threads collected: {len(collected)}/{len(listed) or '?'} "
          f"(missing {len(missing)}, with-gaps {len(incomplete)})")
    print(f"Attachments: {len(manifest_rows)} (Id2/WS {with_id2}, URL/DOM {with_url})")
    print(f"Wrote export tree to: {out_dir}/  (index.md, messages/root.md, threads/<month>/…, manifest_assets.csv)")


if __name__ == "__main__":
    main()
