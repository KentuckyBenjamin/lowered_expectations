#!/usr/bin/env python3
"""
check_catalog.py - health check for ia_media_list.csv

Looks up every title on the Internet Archive and tests every poster link, then
lists what needs attention:

  WON'T PLAY    the Archive item is gone, taken down or restricted, or has nothing
                the app can play
  MAY NOT PLAY  it plays today, but in a way that tends to break (.m4a-only albums,
                MKV-only episodes, a different kind of item than the row says)
  POSTERS       the poster link is broken (the card falls back to the Archive's own
                picture), or is an image-search link that will stop working

Usage:
    python3 check_catalog.py                      check everything
    python3 check_catalog.py --type music         only one type (movie, series, music, audiobook, game)
    python3 check_catalog.py --tag christmas      only titles with this tag
    python3 check_catalog.py --title "tom and"    only titles (or artists) containing this text
    python3 check_catalog.py --no-posters         skip the poster checks (faster)
    python3 check_catalog.py --posters-only       only check posters

It also saves the list as catalog_report.csv (open it in Numbers or Excel); each
problem comes with a suggestion and, for posters, a search link to find a new one.
It only reads: nothing in ia_media_list.csv is changed.

No extra packages needed: uses only Python's standard library. Needs an internet
connection; a full check of ~600 titles takes a few minutes.
"""
import argparse
import csv
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from build_catalog import (TYPE_ALIASES, VALID_TYPES, identifier_from, is_url,
                           split_list, text, unwrap_image_link)

HERE = Path(__file__).resolve().parent
UA_TOOL = "lowered-expectations-check/1.0"
# Poster hosts often refuse requests that don't look like a browser, which would
# show up here as "broken" even though the app (a browser) loads them fine.
UA_BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

# The same rules app.js uses to find tracks and episodes, so this flags what the app would trip on.
AUDIO_FILE = re.compile(r"\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|aiff?)$", re.I)
LOSSY_FILE = re.compile(r"\.(mp3|ogg|oga|opus|m4a|aac)$", re.I)
SKIP_FILE = re.compile(r"(^|/)(__|\.)|spectrogram|_sample\b|\bsample\.", re.I)
VIDEO_FORMAT = re.compile(r"matroska|mpeg4|h\.264|ogg video|avi|quicktime|webm|windows media|flash video|mpeg2|dv video", re.I)
SKIP_DIRS = re.compile(r"(^|/)(commercials?|promos?|trailers?|bumpers?)/", re.I)
FRAGILE_AUDIO = re.compile(r"\.(m4a|aac)$", re.I)          # what broke Brooks & Dunn
NO_CHROME_AUDIO = re.compile(r"\.aiff?$", re.I)
SEARCH_PROXIES = ("duckduckgo", "google", "bing", "yandex")
LENDING = {"inlibrary", "lendinglibrary", "printdisabled", "internetarchivebooks"}
MEDIATYPE = {"movies": "video", "audio": "audio", "etree": "audio", "texts": "text",
             "image": "image", "software": "software", "collection": "collection"}
EXPECTED = {"movie": "video", "series": "video", "music": "audio", "audiobook": "audio"}

WONT, MAYBE, POSTER = "won't play", "may not play", "poster"
SECTIONS = [(WONT, "WON'T PLAY"), (MAYBE, "MAY NOT PLAY"), (POSTER, "POSTERS")]


# ---------- network ----------
def fetch(url, *, browser=False, head_bytes=None, timeout=20):
    """GET a URL; returns (status, content_type, body). Retries once on timeouts and busy servers."""
    headers = {"User-Agent": UA_BROWSER if browser else UA_TOOL}
    if browser:
        headers["Accept"] = "image/avif,image/webp,image/*,*/*;q=0.8"
    if head_bytes:
        headers["Range"] = f"bytes=0-{head_bytes - 1}"
    last = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = res.read(head_bytes) if head_bytes else res.read()
                return res.status, (res.headers.get("Content-Type") or "").lower(), body
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt == 0:
                time.sleep(3)
                continue
            return exc.code, (exc.headers.get("Content-Type") or "").lower() if exc.headers else "", b""
        except Exception as exc:  # timeout, DNS, connection reset, bad certificate...
            last = exc
            if attempt == 0:
                time.sleep(2)
    raise ConnectionError(last.__class__.__name__ if last else "no response")


_meta_cache, _meta_lock = {}, threading.Lock()


def archive_meta(ident):
    """The item's metadata, {} if the Archive has no such item, None if it couldn't be reached."""
    with _meta_lock:
        if ident in _meta_cache:
            return _meta_cache[ident]
    try:
        status, _, body = fetch("https://archive.org/metadata/" + urllib.parse.quote(ident))
        data = json.loads(body or b"{}") if status == 200 else None
    except (ConnectionError, ValueError):
        data = None
    with _meta_lock:
        _meta_cache[ident] = data
    return data


def first(v):
    return (v[0] if isinstance(v, list) and v else v) or ""


# ---------- item checks ----------
def check_item(row):
    """Problems with the Archive item behind one row: list of (severity, problem, suggestion)."""
    kind, ident, out = row["type"], row["id"], []
    if kind == "game" and row["pico8"]:
        try:
            status, _, _ = fetch(row["link"], browser=True, head_bytes=4096)
        except ConnectionError as exc:
            return [("unchecked", f"couldn't reach Lexaloffle ({exc})", "Run the check again later.")]
        if status >= 400:
            out.append((WONT, f"the Lexaloffle page answers {status}", "Check the cart's link on lexaloffle.com."))
        return out

    meta = archive_meta(ident)
    if meta is None:
        return [("unchecked", "couldn't reach the Archive", "Run the check again later.")]
    md = meta.get("metadata") or {}
    if not md:
        return [(WONT, "the Archive has no item at this link (removed, or a typo in the link)",
                 "Search archive.org for another copy and replace the link.")]
    if meta.get("is_dark"):
        return [(WONT, "the Archive has taken this item down",
                 "Search archive.org for another copy and replace the link.")]
    collections = {c.lower() for c in (md.get("collection") if isinstance(md.get("collection"), list)
                                       else [md.get("collection") or ""])}
    if text(md.get("access-restricted-item")).lower() == "true" or collections & LENDING:
        out.append((WONT, "restricted on the Archive (borrow-only), so it won't stream in the app",
                    "Look for an unrestricted copy on archive.org."))
    if not (meta.get("workable_servers") or meta.get("d1") or meta.get("server")):
        out.append((MAYBE, "the Archive lists no server holding the files right now (often temporary)",
                    "Try it in the app; if it fails, check again in a day."))

    files = meta.get("files") or []
    have = MEDIATYPE.get(text(first(md.get("mediatype"))).lower())
    want = EXPECTED.get(kind)
    if want and have and have != want and have != "collection":
        out.append((MAYBE, f"the row says {kind}, but the Archive item is {text(first(md.get('mediatype')))}",
                    "Check the link points at the right item, or fix the type column."))

    if kind in ("music", "audiobook"):
        out += check_audio(kind, files)
    elif kind == "movie":
        if not any(VIDEO_FORMAT.search(f.get("format") or "") for f in files):
            out.append((WONT, "no video files in this item", "Check the link points at the film itself."))
    elif kind == "series":
        out += check_series(row, files)
    return out


def check_audio(kind, files):
    originals = [f for f in files if f.get("source") == "original"
                 and AUDIO_FILE.search(f.get("name") or "") and not SKIP_FILE.search(f["name"])]
    lossy = [f for f in originals if LOSSY_FILE.search(f["name"])]
    if lossy and len(lossy) < len(originals):
        originals = lossy
    if not originals:
        return [(WONT, "no audio files the app can play (the album falls back to the Archive's own player)",
                 "Look for a copy with MP3 or FLAC files.")]
    plays = []
    for f in originals:  # the file the app's player will actually load, as in loadTracks()
        if kind == "audiobook":
            alt = next((d for d in files if d.get("original") == f["name"] and re.search(r"64kbps mp3", d.get("format") or "", re.I)), None)
        else:
            alt = None if LOSSY_FILE.search(f["name"]) else next(
                (d for d in files if d.get("original") == f["name"] and (d.get("name") or "").lower().endswith(".mp3")), None)
        plays.append((alt or f)["name"])
    out, n = [], len(plays)
    fragile = sum(1 for p in plays if FRAGILE_AUDIO.search(p))
    aiff = sum(1 for p in plays if NO_CHROME_AUDIO.search(p))
    if fragile:
        out.append((MAYBE, f"{fragile} of {n} tracks are .m4a/.aac with no MP3 copy; these break whenever "
                           "the Archive serves them with the wrong label (the Brooks & Dunn problem)",
                    "If it acts up, look for an MP3 or FLAC copy."))
    if aiff:
        out.append((MAYBE, f"{aiff} of {n} tracks are AIFF files with no MP3 copy, which Chrome can't play",
                    "Look for an MP3 or FLAC copy."))
    return out


def check_series(row, files):
    if row["episodes"]:
        gone = []
        for ident, file, _ in row["episodes"]:
            m = archive_meta(ident)
            if m is None:
                continue
            if not m.get("metadata") or m.get("is_dark"):
                gone.append(ident)
            elif file and not any(f.get("name") == file for f in m.get("files") or []):
                gone.append(f"{ident}/{file}")
        if gone:
            return [(WONT, f"{len(gone)} of {len(row['episodes'])} episode links point at missing items: "
                           + ", ".join(gone[:5]) + (" ..." if len(gone) > 5 else ""),
                     "Replace those links in the episodes column.")]
        return []
    originals = [f for f in files if f.get("source") == "original"
                 and VIDEO_FORMAT.search(f.get("format") or "") and not SKIP_DIRS.search(f.get("name") or "")]
    if row["filter"]:
        want = [w.lower() for w in row["filter"]]
        originals = [f for f in originals if any(w in f["name"].lower() for w in want)]
    if not originals:
        why = "no video files match the episode filter" if row["filter"] else "no video files in this item"
        return [(WONT, why, "Check the link, or the words in the episode filter column.")]
    mkv_only = 0
    for f in originals:  # as in episodesFromFiles(): MKV with no MP4 copy is played as-is
        kids = [d for d in files if d.get("original") == f["name"]]
        mp4 = any(re.search(r"h\.264|mpeg4", d.get("format") or "", re.I) and (d.get("name") or "").lower().endswith(".mp4") for d in kids)
        if not mp4 and not re.search(r"\.(mp4|m4v|webm|ogv)$", f["name"], re.I) and f["name"].lower().endswith(".mkv"):
            mkv_only += 1
    if mkv_only:
        return [(MAYBE, f"{mkv_only} of {len(originals)} episodes are MKV files the Archive never converted; "
                        "Safari can't play those (the app switches to the Archive's player)",
                 "Fine in Chrome and Firefox; nothing to do unless you watch in Safari.")]
    return []


# ---------- poster checks ----------
def search_link(row):
    q = urllib.parse.quote_plus(f"{row['title']} {row['artist']}".strip() if row["type"] == "music" else row["title"])
    if row["type"] in ("movie", "series"):
        return "https://www.themoviedb.org/search?query=" + q
    if row["type"] == "music":
        return "https://musicbrainz.org/search?type=release&query=" + q
    return "https://duckduckgo.com/?iax=images&ia=images&q=" + q


def image_ok(url):
    """True / False, or None if the site couldn't be reached."""
    try:
        status, ctype, body = fetch(url, browser=True, head_bytes=2048, timeout=15)
    except ConnectionError:
        return None
    is_image = ctype.startswith("image/") or body[:4] in (b"\x89PNG", b"GIF8", b"RIFF") or body[:3] == b"\xff\xd8\xff"
    return status < 400 and is_image


def check_poster(row):
    out = []
    bad = [img for _, _, img in row["episodes"] if img and image_ok(img) is False]
    if bad:
        out.append((POSTER, f"{len(bad)} episode image link(s) are broken (those tiles show the Archive's picture): "
                            + ", ".join(bad[:3]) + (" ..." if len(bad) > 3 else ""),
                    "Replace the image after the second | in those episodes."))
    raw = row["external"] if is_url(row["external"]) else row["poster"] if is_url(row["poster"]) else ""
    if not raw:
        return out
    url = unwrap_image_link(raw) if raw == row["external"] else raw
    host = urllib.parse.urlsplit(raw).netloc.lower()
    wrapped = any(p in host for p in SEARCH_PROXIES)
    try:
        status, ctype, body = fetch(url, browser=True, head_bytes=2048, timeout=15)
    except ConnectionError as exc:
        return out + [("unchecked", f"couldn't reach the poster's site ({exc})", "Run the check again later.")]
    is_image = ctype.startswith("image/") or body[:4] in (b"\x89PNG", b"GIF8", b"RIFF") or body[:3] == b"\xff\xd8\xff"
    if status >= 400 or not is_image:
        what = f"answers {status}" if status >= 400 else f"returns a web page ({ctype or 'no type'}), not an image"
        out.append((POSTER, f"poster link is broken: {what}; the card shows the Archive's picture instead",
                    "Find a new poster: " + search_link(row)))
    elif wrapped:
        out.append((POSTER, "poster is an image-search link (" + host + "); it works today but these expire",
                    "Swap in the direct image address: " + url))
    return out


def parse_episode(entry):
    """'link', 'name | link' or 'name | link | image' -> (identifier, file inside it or '', image or '')."""
    parts = [p.strip() for p in entry.split("|")]
    link = parts[0] if len(parts) == 1 else parts[1]
    image = parts[2] if len(parts) > 2 and is_url(parts[2]) else ""
    m = re.search(r"archive\.org/(?:details|download)/[^/?#\s]+/([^?#\s]+)", link)
    return identifier_from(link), urllib.parse.unquote(m.group(1)) if m else "", image


# ---------- main ----------
def load_rows(src):
    with open(src, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    header = [text(v).lower() for v in rows[0]]
    col = {name: i for i, name in enumerate(header) if name}
    out = []
    for n, row in enumerate(rows[1:], start=2):
        get = lambda k: text(row[col[k]]) if k in col and col[k] < len(row) else ""
        if not get("link"):
            continue
        kind = TYPE_ALIASES.get(get("type").lower(), get("type").lower())
        out.append({
            "n": n, "title": get("title") or identifier_from(get("link")), "artist": get("artist") if get("artist").lower() != "n/a" else "",
            "type": kind if kind in VALID_TYPES else kind or "?", "link": get("link"), "id": identifier_from(get("link")),
            "tags": [t.lower() for t in split_list(get("tags"))], "external": get("external poster link"),
            "poster": get("poster"), "episodes": [parse_episode(e) for e in split_list(get("episodes"))],
            "filter": split_list(get("episode filter")), "pico8": "lexaloffle" in get("link").lower(),
        })
    return out


def main():
    ap = argparse.ArgumentParser(description="Check every title and poster link in the media list.")
    ap.add_argument("csv", nargs="?", default=str(HERE / "ia_media_list.csv"))
    ap.add_argument("--type", help="only this type: movie, series, music, audiobook or game")
    ap.add_argument("--tag", help="only titles with this tag")
    ap.add_argument("--title", help="only titles (or artists) containing this text")
    ap.add_argument("--no-posters", action="store_true", help="skip the poster checks")
    ap.add_argument("--posters-only", action="store_true", help="only check posters")
    ap.add_argument("--report", default=str(HERE / "catalog_report.csv"), help="where to save the report")
    ap.add_argument("--workers", type=int, default=6, help="checks run at once (default 6)")
    args = ap.parse_args()

    rows = load_rows(Path(args.csv))
    if args.type:
        rows = [r for r in rows if r["type"] == TYPE_ALIASES.get(args.type.lower(), args.type.lower())]
    if args.tag:
        rows = [r for r in rows if args.tag.lower() in r["tags"]]
    if args.title:
        rows = [r for r in rows if args.title.lower() in (r["title"] + " " + r["artist"]).lower()]
    if not rows:
        sys.exit("No titles match.")

    print(f"Checking {len(rows)} titles" + (" (posters only)" if args.posters_only else
                                           " (skipping posters)" if args.no_posters else "") + " ...")
    jobs, results = [], []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for r in rows:
            if not args.posters_only:
                jobs.append(pool.submit(lambda r=r: (r, check_item(r))))
            if not args.no_posters:
                jobs.append(pool.submit(lambda r=r: (r, check_poster(r))))
        for done, job in enumerate(as_completed(jobs), 1):
            try:
                r, problems = job.result()
            except Exception:  # a surprise in one item shouldn't stop the whole check
                continue
            results += [(r, *p) for p in problems]
            if done % 50 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)} checks done", end="\r" if done < len(jobs) else "\n", flush=True)

    results.sort(key=lambda x: x[0]["n"])
    for key, heading in SECTIONS + [("unchecked", "COULDN'T CHECK")]:
        hits = [x for x in results if x[1] == key]
        if not hits:
            continue
        print(f"\n{heading} ({len(hits)})")
        for r, _, problem, tip in hits:
            print(f"  row {r['n']}  {r['title']}" + (f" ({r['artist']})" if r["artist"] else "") + f" [{r['type']}]")
            print(f"      {problem}")
            print(f"      -> {tip}")

    counts = {k: sum(1 for x in results if x[1] == k) for k, _ in SECTIONS}
    unchecked = sum(1 for x in results if x[1] == "unchecked")
    if not results:
        print("\nEverything checks out.")
    else:
        label = {WONT: "won't play", MAYBE: "may not play", POSTER: "poster problems"}
        print("\nSummary: " + ", ".join(f"{counts[k]} {label[k]}" for k, _ in SECTIONS)
              + (f", {unchecked} couldn't be checked" if unchecked else ""))
    try:
        with open(args.report, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["row", "title", "artist", "type", "link", "issue", "problem", "suggestion"])
            for r, sev, problem, tip in results:
                w.writerow([r["n"], r["title"], r["artist"], r["type"], r["link"], sev, problem, tip])
        print(f"Saved the list to {Path(args.report).name}")
    except OSError as exc:
        print(f"Couldn't save {args.report} ({exc.__class__.__name__})")
    sys.exit(1 if counts[WONT] else 0)


if __name__ == "__main__":
    main()
