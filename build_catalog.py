#!/usr/bin/env python3
"""
Turn the media list (a CSV file) into catalog.js for the site.

Usage:
    python3 build_catalog.py ia_media_list.csv

CSV columns (first row is the header, order doesn't matter):
    title     - display title (optional: filled in from the Archive if left blank)
    artist    - the artist/band for music; 'n/a' or blank is ignored
                (for music, filled in from the Archive if left blank)
    type      - movie | series | music | audiobook | game (optional: guessed from the Archive if blank)
    link      - an archive.org/details/... link (or just the identifier). REQUIRED.
                For games: a PICO-8 cart link on Lexaloffle, like
                https://www.lexaloffle.com/bbs/?pid=celeste_classic_2-5
    description - optional, a short blurb (used instead of the Archive's own text; left blank, the Archive's is shown)
    embed     - PICO-8 games only: "yes" if the cart's author lets it play inside other sites
                (otherwise the app offers a "Play on Lexaloffle" button)
    platform  - games only: nes, genesis, atari2600 or tg16 (emulated Archive items) or pico8 (a Lexaloffle cart).
                Optional: Lexaloffle links are pico8, Archive links are nes.
    tags      - optional, comma-separated (e.g. "kids, animation")
    year      - optional, overrides what the Archive reports
    featured  - optional, "yes" gives a movie extra chances to be the hero title (a random movie headlines each visit)
    episodes  - optional, series only: comma-separated archive.org links/identifiers
    poster    - optional, a link to an image to use as the poster
    External Poster Link - optional, a link to any image; wins over every other image

Quick add: paste just a link into a new row and run the script. It looks the item
up on the Archive, fills in the blank title, type and (for music) artist, and writes
those back into the CSV so you can see and edit them. Lookups are cached in
archive_cache.json, so later builds are instant and work offline.

No extra packages needed: uses only Python's standard library.
"""
import csv
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

VALID_TYPES = {"movie", "series", "music", "audiobook", "game"}
TYPE_ALIASES = {"movies": "movie", "film": "movie", "show": "series", "shows": "series",
                "tv": "series", "song": "music", "songs": "music", "album": "music", "audio": "music",
                "audiobooks": "audiobook", "audio book": "audiobook", "book": "audiobook", "books": "audiobook",
                "games": "game", "pico-8": "game", "pico8": "game", "cart": "game"}
MEDIATYPE_TO_TYPE = {"movies": "movie", "audio": "music", "etree": "music"}
BLANKS = {"", "n/a", "na", "none", "-", "—"}
HERE = Path(__file__).resolve().parent
CACHE_FILE = HERE / "archive_cache.json"


def identifier_from(link: str) -> str:
    link = (link or "").strip()
    cart = re.search(r"lexaloffle\.com/bbs/(?:widget\.php)?\?(?:[^#]*&)?pid=([^&#\s]+)", link)
    if cart:
        return cart.group(1)
    m = re.search(r"archive\.org/(?:details|embed|download)/([^/?#\s]+)", link)
    return m.group(1) if m else link.strip("/")


def split_list(value) -> list:
    if not value:
        return []
    return [part.strip() for part in str(value).split(",") if part.strip()]


def text(value) -> str:
    return str(value or "").strip()


def is_blank(value) -> bool:
    return text(value).lower() in BLANKS


def is_url(value) -> bool:
    return text(value).lower().startswith(("http://", "https://"))


JUNK = r"(?:vhs|dvd|blu-?ray|bd|hd|sd|rip|web-?dl|webrip|720p|1080p|2160p|4k|x26[45]|hevc|d-theater|hbo|tv|extras?|quality|high|remastered|english|dub(?:bed)?|subs?|full|movie)"


def clean_title(raw: str) -> str:
    """Tidy an uploader's title: 'THE LOST BOYS 1987 VHS RIP' -> 'The Lost Boys'."""
    t = text(raw)
    # drop bracketed bits that are years or rip/format notes: (1994) [D-Theater] (High Quality +Extras)
    t = re.sub(r"[\(\[][^\)\]]*[\)\]]",
               lambda m: "" if re.fullmatch(r"[\(\[]\s*(?:\d{4}|[^\)\]]*\b" + JUNK + r"\b[^\)\]]*)\s*[\)\]]", m.group(0), re.I) else m.group(0), t)
    t = re.sub(r"^\s*(?:19|20)\d{2}\s+", "", t)                      # leading year: '2006 Borat'
    words = t.split()
    while words and (re.fullmatch(r"(?:19|20)\d{2}", words[-1]) or re.fullmatch(JUNK, words[-1], re.I) or words[-1] in "-–|+"):
        words.pop()                                                       # trailing year / rip notes
    t = " ".join(words).strip(" -–|_.")
    t = re.sub(r"\s+[-–|]\s*$", "", t)
    if t.isupper():                                                       # ALL CAPS -> Title Case
        small = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"}
        roman = re.compile(r"(?:i{1,3}|iv|v|vi{1,3}|ix|x)", re.I)          # Part II stays II
        t = " ".join(w.upper() if roman.fullmatch(w) and i > 0 else
                     w.capitalize() if i == 0 or w.lower() not in small else w.lower()
                     for i, w in enumerate(t.lower().split()))
    return t or text(raw)


IMAGE_HINT = re.compile(r"\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)|image\.tmdb\.org|upload\.wikimedia\.org|m\.media-amazon\.com/images|i\.pinimg\.com|archive\.org/services/img/", re.I)


def unwrap_image_link(url: str) -> str:
    """Image-search results (DuckDuckGo, Google, Bing) often wrap the real image address
    in a redirect or proxy link that can expire. Pull out the real address when we can."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)
    host = parts.netloc.lower()
    for key in ("u", "imgurl", "mediaurl", "url"):
        inner = (query.get(key) or [""])[0]
        if inner.lower().startswith(("http://", "https://")) and any(h in host for h in ("duckduckgo", "google", "bing")):
            return inner
    return url


# ---------- Archive lookups (only for rows with blanks) ----------
def load_cache() -> dict:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def archive_info(ident: str, cache: dict):
    """Title, type and creator for an Archive item, or None if it can't be reached."""
    if ident in cache:
        return cache[ident]
    url = "https://archive.org/metadata/" + urllib.parse.quote(ident)
    req = urllib.request.Request(url, headers={"User-Agent": "lowered-expectations-catalog/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.load(res)
    except Exception as exc:  # offline, blocked, bad id...
        print(f"  couldn't look up {ident} on the Archive ({exc.__class__.__name__})")
        return None
    meta = data.get("metadata") or {}
    if not meta:
        print(f"  the Archive has no item called {ident} (check the link)")
        return None
    first = lambda v: (v[0] if isinstance(v, list) and v else v) or ""
    info = {
        "title": text(first(meta.get("title"))),
        "type": MEDIATYPE_TO_TYPE.get(text(first(meta.get("mediatype"))).lower(), ""),
        "artist": text(first(meta.get("creator")) or first(meta.get("artist"))),
    }
    cache[ident] = info
    return info


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / "ia_media_list.csv")
    out = HERE / "catalog.js"

    # utf-8-sig also reads files saved by Excel ("CSV UTF-8"), which start with a hidden marker.
    with open(src, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows:
        sys.exit(f"{src.name} is empty")
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    header = [text(v).lower() for v in rows[0]]
    col = {name: i for i, name in enumerate(header) if name}

    cache, filled, warnings = load_cache(), [], []
    items, problems = [], []
    for n in range(2, len(rows) + 1):
        row = rows[n - 1]
        rec = {name: row[i] for name, i in col.items()}
        if not any(text(v) for v in rec.values()):
            continue
        ident = identifier_from(text(rec.get("link")))
        if not ident:
            problems.append(f"row {n}: needs a link")
            continue

        title = text(rec.get("title"))
        kind = TYPE_ALIASES.get(text(rec.get("type")).lower(), text(rec.get("type")).lower())
        artist = "" if is_blank(rec.get("artist")) else text(rec.get("artist"))

        # Fill blanks from the Archive, then write them back into the sheet.
        # An empty artist cell gets filled for music; "n/a" means leave it blank on purpose.
        needs_artist = kind in ("music", "") and not text(rec.get("artist"))
        if kind != "game" and (not title or not kind or needs_artist):
            info = archive_info(ident, cache)
            if info:
                info = dict(info, title=clean_title(info["title"]))
                for field, current in (("title", title), ("type", kind)):
                    if not current and info[field] and field in col:
                        row[col[field]] = info[field]
                        filled.append(f"row {n} {field}: {info[field]}")
                title = title or info["title"]
                kind = kind or info["type"]
                if kind == "music" and not artist and info["artist"] and "artist" in col and not text(rec.get("artist")):
                    row[col["artist"]] = info["artist"]
                    filled.append(f"row {n} artist: {info['artist']}")
                    artist = info["artist"]

        if not title:
            problems.append(f"row {n}: no title, and the Archive lookup didn't give one")
            continue
        if kind not in VALID_TYPES:
            problems.append(f"row {n}: type '{rec.get('type')}' should be movie, series, music, audiobook or game")
            continue

        item = {"title": title, "type": kind, "id": ident, "tags": [t.lower() for t in split_list(rec.get("tags"))]}
        if artist:
            item["artist"] = artist
        external, poster = rec.get("external poster link"), rec.get("poster")
        if is_url(external):
            item["poster"] = unwrap_image_link(text(external))
            if not IMAGE_HINT.search(item["poster"]):
                warnings.append(f"row {n} ({title}): the External Poster Link looks like a web page, not an image")
        elif is_url(poster):
            item["poster"] = text(poster)
        if text(rec.get("year")):
            item["year"] = text(rec["year"]).split(".")[0]
        if text(rec.get("description")):
            item["description"] = text(rec["description"])
        if kind == "game":
            link = text(rec.get("link")).lower()
            platform = re.sub(r"[\s_-]", "", text(rec.get("platform")).lower()) or ("pico8" if "lexaloffle" in link else "nes")
            platform = {"megadrive": "genesis", "segagenesis": "genesis", "atari": "atari2600", "2600": "atari2600",
                        "turbografx16": "tg16", "turbografx": "tg16", "pcengine": "tg16"}.get(platform, platform)
            item["platform"] = platform
            if platform == "pico8":
                item["source"] = "https://www.lexaloffle.com/bbs/?pid=" + urllib.parse.quote(ident)
                item["embed"] = text(rec.get("embed")).lower() in {"yes", "y", "true", "1", "x"}
            else:  # emulated on the Internet Archive, always playable in the Archive's player
                item["source"] = "https://archive.org/details/" + urllib.parse.quote(ident)
                item["embed"] = True
        if text(rec.get("featured")).lower() in {"yes", "y", "true", "1", "x"}:
            item["featured"] = True
        eps = [identifier_from(e) for e in split_list(rec.get("episodes"))]
        if kind == "series" and eps:
            item["episodes"] = [{"id": e} for e in eps]
        items.append(item)

    try:
        CACHE_FILE.write_text(json.dumps(cache, indent=1, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass

    if filled:
        try:
            with open(src, "w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerows(rows)
            print(f"Filled in from the Archive and saved to {src.name}:")
            for f in filled:
                print("  " + f)
        except OSError as exc:
            print(f"NOTE: couldn't save the filled-in details to {src.name} ({exc.__class__.__name__}).")
            print("      They were still used for the site. Run the script again to save them.")

    js = ("// Generated by build_catalog.py from " + src.name + ". Edit the CSV, then re-run the script.\n"
          "window.CATALOG = " + json.dumps(items, indent=2, ensure_ascii=False) + ";\n")
    out.write_text(js, encoding="utf-8")
    print(f"Wrote {len(items)} titles to {out.name}")
    for p in problems:
        print("  skipped", p)
    if warnings:
        print("Poster links to check (right-click the image and choose 'Copy Image Address' to get a direct link):")
        for w in warnings:
            print("  " + w)


if __name__ == "__main__":
    main()
