# Lowered Expectations

Front end for Internet Archive and PICO-8 content.

A static front end for a hand-picked Internet Archive catalog. No server, no build step, no accounts.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | Look and layout |
| `app.js` | Browsing, search, tag filters, the player |
| `catalog.js` | Your titles (generated from the CSV) |
| `build_catalog.py` | Turns `ia_media_list.csv` into `catalog.js` |
| `check_catalog.py` | Checks every title and poster link and lists what needs fixing |
| `ia_media_list.csv` | The media list you edit (plain CSV: any text editor, Numbers or Excel) |

## Adding titles

1. Add a row to `ia_media_list.csv`:
   - **title** – what to show on the card
   - **artist** – optional; the artist or band for music, or the author for audiobooks (shown under the title). Use `n/a` or leave blank for films
   - **type** – `movie`, `series`, `music`, `audiobook` or `game`
   - **link** – the `https://archive.org/details/...` link
   - **tags** – optional, comma-separated (`kids, animation`)
   - optional extra columns: **year**, **featured** (a random movie fills the big banner on every visit; `yes` gives a movie three times the chance), **episodes** (series only: comma-separated Archive links, one per episode)
2. Run `python3 build_catalog.py ia_media_list.csv` (no extra packages needed).
3. Refresh the page.

Posters, year, runtime and descriptions are pulled live from the Archive, so you only need the link.

## Viewing it

Open `index.html` directly in a browser, or run `python3 -m http.server` in this folder and visit http://localhost:8000.

## Hosting

Upload the folder to any static host: GitHub Pages, Netlify (drag the folder onto app.netlify.com/drop), Cloudflare Pages.

## How playback works

Films play in the Archive's own embedded player (`archive.org/embed/<identifier>`).

Albums play in the app's own player: the cover, play / previous / next, a seek bar and the full track list, read from the item's files on the Archive. Tracks are ordered by disc folder and track number, lossless files stream through the Archive's MP3 copy, the next track starts on its own, and a file that won't play is crossed out and skipped. Phone lock screens and keyboard media keys work too. If an item's file list can't be read, the album falls back to the Archive's embedded player. A watch link like `index.html#watch=fantastic-planet__1973` opens straight into the player, so titles can be shared.

## Audiobooks

Audiobooks (type `audiobook`) use the album player with a few extras for long listens. Chapters are the tracks, streamed from the Archive's light 64kbps MP3 copies. The player:
- remembers the chapter and spot where you stopped, per book (stored in the browser), and marks it in the chapter list; the card shows "in progress"
- has 15-second back and 30-second forward buttons (also on phone lock screens)
- has a speed button (0.75× to 2×, remembered across books)
- has a sleep timer: tap to step through 15 / 30 / 45 / 60 minutes or the end of the chapter

LibriVox (`https://archive.org/details/librivoxaudio`) is the best source: free public-domain books, often with several recordings of the same title, so pick a well-rated solo reading.

## Series

Clicking a series opens its own page listing every episode, with a preview frame, the
episode number and its title. Clicking an episode plays it, Previous / Next step through
the season, the next episode starts on its own when one ends, and closing the player goes
back to the episode list.

- **One Archive item holding the whole season** (like Spider-Man): just put the item's link
  in the `link` column. Episodes are read from the item's video files. Titles and numbers
  come from the file names (`... S01E03 - Lizards, Lizards, Everywhere.mkv`), so items whose
  files are named that way look best. Also understood: `1x03`, `01,03`, a leading number
  (`01 - Title`, `10A - Title`), a `Season 2/` folder, and Popeye-style `1933e01-Title`.
  The show's own name is trimmed off the front of episode titles, tags like `[1080p AI]`
  or `SDTV` are dropped, files in `Commercials/` folders are skipped, and anything without
  a season number lands in an **Extras** section at the end (season 0 shows as **Specials**).
  Also understood: `Season 1 Episode 2` and `Disc 1 E01` names. When an item holds at least four full-length
  episodes, clips under 3 minutes (network logos, intros, ads) are hidden. MKV files the Archive never
  converted are played directly; a browser that can't play them gets the Archive's own player instead.
  Preview frames are the stills the Archive makes.
- **Only some of a big item's episodes**: add an `episode filter` column with comma-separated
  words, and only the video files whose names contain one of them are listed. For example
  `Nova 2022-, Nova 2023-` shows just those two years from the 900-episode `nova_collection`.
- **Each episode is its own Archive item**: put the episode links, comma-separated and in
  order, in an `episodes` column. Titles and posters come from each item. To name an episode
  yourself, put the name and a `|` in front of its link: `Zelda II | https://archive.org/details/...`
  (names can't contain commas).

## Icon

`favicon.svg` is the tab icon and the logo in the header (a chart line that blips up once, then trends straight down, on a marquee-amber tile). `favicon-32.png` and `apple-touch-icon.png` are PNG fallbacks for older browsers and iPhone home screens.

## Quick add

Paste just an archive.org link into the `link` column of a new row and run
`python3 build_catalog.py ia_media_list.csv`. The script looks the item up on the
Archive and fills in any blank title, type and (for music) artist, then saves them
into the CSV so you can check or edit them. Add tags yourself if you want them.

- An empty artist cell gets filled for music; write `n/a` to leave it blank on purpose.
- If you edit the CSV in Excel or Numbers, save it as CSV (in Excel, "CSV UTF-8"), not as
  a workbook. If you have it open while the script fills in details, close it without
  saving afterwards, or reopen it, so the filled-in details aren't overwritten.
- Commas inside a cell (like `kids, animation` in tags) need the cell wrapped in double
  quotes when editing by hand: `"kids, animation"`. Excel and Numbers do this for you.
- Lookups are remembered in `archive_cache.json`, so later builds are quick and work offline.

## Checking the catalog

Run `python3 check_catalog.py` now and then (it needs an internet connection and takes a few
minutes). It looks up every title on the Archive and tests every poster link, then lists:

- **Won't play**: the item is gone, taken down or restricted, or has nothing the app can play
  (including an episode filter that matches no files).
- **May not play**: plays today, but in a way that tends to break, such as albums that are only
  `.m4a` files, or MKV-only episodes (Safari).
- **Posters**: broken poster links (the card falls back to the Archive's picture) and
  image-search links that will expire, with a search link to find a replacement.

The same list is saved to `catalog_report.csv`. It only reads; nothing in the media list is
changed. Narrow it down with `--type music`, `--tag christmas`, `--title "lost boys"`,
`--no-posters` or `--posters-only`.

## Posters

Each title shows the best picture it can find, in this order:

1. **External Poster Link** column: paste a link to any image and it's used for that title, over everything else.
2. **poster** column: the public-domain or openly licensed posters from Wikimedia Commons.
3. A poster or cover image uploaded inside the Archive item itself.
4. The Archive's automatic thumbnail.

If a link in either poster column stops working, the card falls back to the next option on its own.

## Games

Games get one shelf per console: **NES**, **Sega Genesis**, **TurboGrafx-16** and **Atari 2600** games emulated
on the Internet Archive (the Genesis, TurboGrafx and Atari ones come from its Console Living Room), and
**PICO-8** carts from Lexaloffle. Set **platform** to `nes`, `genesis`, `tg16`, `atari2600` or `pico8`
(Lexaloffle links are guessed as `pico8`, Archive links as `nes`). Each Archive console opens on a TV above
that console's deck, with its own controller drawn beside it and the keys listed underneath. Atari keys follow
the Archive's own instructions (2 = Reset to start a game, 1 = Select, Ctrl/Space = fire); the rest use MAME's standard keys.

### NES

Add a row with **type** `game`, **platform** `nes`, the Archive **link** (an item that plays in the Archive's
NES emulator), the publisher in **artist**, a **year**, a **description** and box art in **External Poster Link**.
Each one opens on a TV above a grey NES-style deck (Reset and Fullscreen) with a controller diagram showing
the keys: arrows to move, 1 = Start, 5 = Select, Ctrl = B, Alt/Option = A (MAME's defaults). Gamepads work too.

### PICO-8

The Games shelf holds PICO-8 carts from Lexaloffle's forum (the BBS). Add one as a row with:

- **type** – `game`
- **link** – the cart's BBS link, like `https://www.lexaloffle.com/bbs/?pid=celeste_classic_2-5`
- **artist** – the developer
- **External Poster Link** – the cart label, `https://www.lexaloffle.com/bbs/thumbs/pico8_<cart>.png`
- **description** – a one-line blurb
- **embed** – `yes` only if the cart's author lets it play on other sites

Each game opens in a little PICO-8 console with the controls laid out beside it. Carts marked
`embed` play right inside it (with Reset and Fullscreen buttons), using Lexaloffle's own player.
The rest show their label and a "Play on Lexaloffle" button, because their authors keep them on the BBS.
To check a cart: open `https://www.lexaloffle.com/bbs/widget.php?pid=<cart>` and press play.
If it starts there, it can be embedded. If it sends you to the BBS, it can't.
