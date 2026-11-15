/* Lowered Expectations — front end for a curated Internet Archive catalog.
   Data comes from catalog.js (window.CATALOG). Extra details (year, runtime,
   description) are fetched live from the Archive's public metadata API. */
(function () {
  "use strict";

  const IA = {
    details: (id) => `https://archive.org/details/${encodeURIComponent(id)}`,
    embed: (id, playlist) => `https://archive.org/embed/${encodeURIComponent(id)}${playlist ? "?playlist=1" : ""}`,
    thumb: (id) => `https://archive.org/services/img/${encodeURIComponent(id)}`,
    meta: (id) => `https://archive.org/metadata/${encodeURIComponent(id)}`,
    file: (id, name) => `https://archive.org/download/${encodeURIComponent(id)}/${name.split("/").map(encodeURIComponent).join("/")}`,
  };

  // Poster priority: a poster link from the media list, then a poster/cover image
  // uploaded inside the Archive item, then the Archive's automatic thumbnail.
  const posterOf = (item) => item.poster || item.art || IA.thumb(item.id);
  // Games live on Lexaloffle's PICO-8 forum, everything else on the Internet Archive.
  const sourceOf = (item) => item.source || IA.details(item.id);
  const sourceLabel = (item) => (item.platform === "pico8" ? "Open on Lexaloffle ↗" : "Open on the Internet Archive ↗");
  function pickArt(id, files) {
    const imgs = files.filter((f) =>
      f.source === "original" && /\.(jpe?g|png|webp|gif)$/i.test(f.name || "") &&
      !/(^|\/)(__ia_thumb|.*_itemimage|.*spectrogram|.*\.thumbs\/)/i.test(f.name));
    if (!imgs.length) return null;
    const named = imgs.find((f) => /poster|one.?sheet/i.test(f.name)) ||
                  imgs.find((f) => /cover|folder|front|box|art/i.test(f.name));
    const tall = imgs.find((f) => Number(f.height) > Number(f.width) * 1.2);
    const biggest = imgs.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
    const pick = named || tall || biggest;
    return IA.file(id, pick.name);
  }
  // Swap in a better image when one turns up; fall back to the thumbnail if it fails.
  function setArt(img, item) {
    const want = posterOf(item);
    if (img.dataset.src === want) return;
    img.dataset.src = want;
    img.onerror = () => {
      if (want !== IA.thumb(item.id) && (item.type !== "game" || item.platform !== "pico8")) { item.art = null; item.poster = null; setArt(img, item); }
      else if (img.onfail) img.onfail();
    };
    img.src = want;
  }

  // Archive file formats that are video (used to find a series' episodes inside one item).
  const VIDEO_FORMAT = /matroska|mpeg4|h\.264|ogg video|avi|quicktime|webm|windows media|flash video|mpeg2|dv video/i;

  const TYPES = {
    movie: { label: "Movies", one: "Feature film", square: false },
    series: { label: "Series", one: "Series", square: false },
    music: { label: "Music", one: "Album", square: true },
    game: { label: "Games", one: "PICO-8 game", square: true },
  };

  const items = (window.CATALOG || []).map((it, i) => ({
    ...it, tags: it.tags || [], order: i,
    episodeCount: it.episodes && it.episodes.length ? it.episodes.length : undefined,
  }));
  const byId = new Map(items.map((it) => [it.id, it]));
  const state = { type: "all", tag: null, query: "" };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null) node.append(kid);
    return node;
  };
  const playIcon = () => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 12 14"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = '<path d="M0 0l12 7-12 7z"/>';
    return s;
  };

  /* ---------- Metadata enrichment ---------- */
  const CACHE_KEY = "le-meta-v4";
  let cache = {};
  try { cache = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "{}"); } catch (_) { cache = {}; }

  function cleanText(html) {
    const d = document.createElement("div");
    d.innerHTML = String(html || "").replace(/<br\s*\/?>/gi, "\n");
    return (d.textContent || "").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  }
  function formatRuntime(r) {
    if (!r) return null;
    if (/^\d+(\.\d+)?$/.test(String(r))) {
      const mins = Math.round(Number(r) / 60);
      return mins >= 1 ? `${mins} min` : null;
    }
    const parts = String(r).split(":").map(Number);
    if (parts.length >= 2 && parts.every((n) => !isNaN(n))) {
      const secs = parts.reduce((a, n) => a * 60 + n, 0);
      return `${Math.round(secs / 60)} min`;
    }
    return String(r);
  }
  async function enrich(item) {
    if (item.type === "game") return item; // games carry their own details; nothing to look up on the Archive
    if (cache[item.id]) return Object.assign(item, cache[item.id]);
    try {
      const res = await fetch(IA.meta(item.id));
      if (!res.ok) return item;
      const data = await res.json();
      const m = data.metadata || {};
      const first = (v) => (Array.isArray(v) ? v[0] : v);
      let runtime = formatRuntime(first(m.runtime));
      if (!runtime && Array.isArray(data.files)) {
        const vid = data.files.find((f) => f.length && /mpeg4|h\.264|matroska|ogg video/i.test(f.format || ""));
        if (vid) runtime = formatRuntime(vid.length);
      }
      let tracks = null;
      if (item.type === "music" && Array.isArray(data.files)) {
        const audio = data.files.filter((f) => f.source === "original" && /mp3|flac|ogg vorbis|wave|aiff|m4a|aac/i.test(f.format || ""));
        if (audio.length) {
          tracks = `${audio.length} track${audio.length === 1 ? "" : "s"}`;
          const secs = audio.reduce((a, f) => a + (parseFloat(f.length) || 0), 0);
          if (!runtime && secs > 60) runtime = formatRuntime(secs);
        }
      }
      let episodeCount = item.episodeCount;
      if (item.type === "series" && !episodeCount && Array.isArray(data.files)) {
        episodeCount = data.files.filter((f) => f.source === "original" && VIDEO_FORMAT.test(f.format || "")).length || undefined;
      }
      const extra = {
        tracks,
        episodeCount,
        art: Array.isArray(data.files) ? pickArt(item.id, data.files) : null,
        year: item.year || (String(first(m.year) || first(m.date) || "").match(/\d{4}/) || [])[0] || null,
        runtime,
        description: cleanText(first(m.description)).slice(0, 900),
        creator: first(m.creator) || first(m.director) || null,
      };
      cache[item.id] = extra;
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
      return Object.assign(item, extra);
    } catch (_) {
      return item; // offline or blocked: the card still works with title + poster
    }
  }

  /* ---------- Rendering ---------- */
  function art(item, cls) {
    const box = el("button", {
      class: `card-art${cls ? " " + cls : ""}`,
      type: "button",
      "aria-label": item.type === "series" ? `Episodes of ${item.title}` : `Play ${item.title}`,
      onclick: () => openTitle(item),
    });
    const fallback = el("span", { class: "fallback-art", "aria-hidden": "true" }, item.title);
    const img = el("img", { alt: "", loading: "lazy", decoding: "async", "data-art": item.id });
    img.onfail = () => img.replaceWith(fallback);
    setArt(img, item);
    box.append(img, el("span", { class: "play-badge", "aria-hidden": "true" }, playIcon()));
    return box;
  }

  function subline(item) {
    if (item.type === "music") return [item.year, item.tracks, item.runtime, TYPES.music.one].filter(Boolean);
    if (item.type === "game" && RETRO[item.platform]) return [item.year, RETRO[item.platform].one].filter(Boolean);
    if (item.type === "game") return [TYPES.game.one, item.embed ? "Plays right here" : "Plays on Lexaloffle"];
    if (item.type === "series") {
      const eps = item.episodeCount ? `${item.episodeCount} episode${item.episodeCount === 1 ? "" : "s"}` : null;
      return [item.year, eps, TYPES.series.one].filter(Boolean);
    }
    return [item.year, item.runtime, TYPES[item.type] && TYPES[item.type].one].filter(Boolean);
  }
  // Artist from the media list wins; otherwise fall back to the Archive's creator field for music.
  const byline = (item) => item.artist || (item.type === "music" ? item.creator : null) || null;

  function card(item) {
    const square = item.type === "game" ? !RETRO[item.platform] : TYPES[item.type] && TYPES[item.type].square;
    const sub = el("p", { class: "card-sub", "data-sub": item.id }, subline(item).join(" · "));
    return el("article", { class: "card" },
      art(item, square ? "square" : ""),
      el("div", {},
        el("h3", { class: "card-title" }, item.title),
        el("p", { class: "card-artist", "data-artist": item.id, hidden: !byline(item) }, byline(item) || ""),
        sub,
        item.tags.length ? el("div", { class: "card-tags" },
          item.tags.map((t) => el("span", { class: `tag ${t}` }, t))) : null
      )
    );
  }

  function renderHero() {
    const hero = $("#hero");
    const item = items.find((i) => i.featured) || items[0];
    hero.replaceChildren();
    if (!item) { hero.hidden = true; return; }

    const meta = el("p", { class: "meta-line" }, subline(item).map((s) => el("span", {}, s)));
    const desc = el("p", { class: "hero-desc" }, item.description || "");
    const heroArtist = el("p", { class: "hero-artist", hidden: !byline(item) }, byline(item) || "");
    const backdrop = el("div", { class: "hero-backdrop" });
    const paintBackdrop = () => { backdrop.style.backgroundImage = `url("${posterOf(item)}"), url("${IA.thumb(item.id)}")`; };
    paintBackdrop();
    hero.append(
      backdrop,
      el("div", { class: "hero-inner" },
        el("div", { class: "hero-copy" },
          el("p", { class: "kicker" }, "Now showing"),
          el("h1", {}, item.title),
          heroArtist,
          meta,
          desc,
          el("div", { class: "hero-actions" },
            el("button", { class: "btn btn-primary", type: "button", onclick: () => openTitle(item) }, playIcon(), item.type === "series" ? "Episodes" : "Play"),
            el("a", { class: "btn", href: sourceOf(item), target: "_blank", rel: "noopener" }, item.platform === "pico8" ? "On Lexaloffle ↗" : "On the Archive ↗")
          )
        ),
        (() => {
          const b = el("button", { class: "hero-poster", type: "button", "aria-label": `Play ${item.title}`, onclick: () => openTitle(item) });
          const img = el("img", { alt: "", "data-art": item.id });
          img.onfail = () => b.replaceWith(document.createTextNode(""));
          setArt(img, item);
          b.append(img);
          return b;
        })()
      )
    );
    enrich(item).then(() => {
      meta.replaceChildren(...subline(item).map((s) => el("span", {}, s)));
      heroArtist.textContent = byline(item) || ""; heroArtist.hidden = !byline(item);
      desc.textContent = item.description || "";
      paintBackdrop();
      document.querySelectorAll(`.hero-poster img`).forEach((img) => setArt(img, item));
    });
  }

  function renderTags() {
    // Alphabetical, so a tag is always easy to find.
    const all = [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
    const box = $("#tags");
    box.replaceChildren(
      ...["all", ...all].map((t) => el("button", {
        class: "chip", type: "button",
        "aria-pressed": String((state.tag || "all") === t),
        onclick: () => { state.tag = t === "all" ? null : t; renderTags(); renderShelves(); },
      }, t === "all" ? "all tags" : t))
    );
    box.hidden = all.length === 0;
  }

  function matches(item) {
    if (state.type !== "all" && item.type !== state.type) return false;
    if (state.tag && !item.tags.includes(state.tag)) return false;
    if (state.query) {
      const hay = [item.title, item.artist, item.year, item.creator, item.type, ...item.tags].join(" ").toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  // Alphabetical within each shelf, ignoring a leading "The", "A" or "An" and stray punctuation.
  // Music sorts by artist first, then album title.
  const shelfCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sortKey = (s) => String(s || "").trim().replace(/^[^\p{L}\p{N}]+/u, "").replace(/^(the|a|an)\s+/i, "");
  function byShelfOrder(a, b) {
    if (a.type === "music") {
      const d = shelfCollator.compare(sortKey(a.artist), sortKey(b.artist));
      if (d) return d;
    }
    return shelfCollator.compare(sortKey(a.title), sortKey(b.title));
  }

  function renderShelves() {
    const shown = items.filter(matches);
    const box = $("#shelves");
    box.replaceChildren();
    $("#count").textContent = `${shown.length} of ${items.length} title${items.length === 1 ? "" : "s"}`;

    if (!shown.length) {
      box.append(el("div", { class: "empty" },
        el("strong", {}, items.length ? "Nothing on this bill" : "The catalog is empty"),
        items.length ? "Try another tag or clear the search." : "Add titles to ia_media_list.csv and run build_catalog.py."));
      return;
    }
    const groups = state.type === "all" ? Object.keys(TYPES) : [state.type];
    const shelves = [];
    for (const type of groups) {
      const list = shown.filter((i) => i.type === type).sort(byShelfOrder);
      if (type !== "game") { shelves.push([TYPES[type].label, list, TYPES[type].square]); continue; }
      // Games get one shelf per console: NES box art is tall, PICO-8 cart labels are square.
      // Games get one shelf per console: box art is tall, PICO-8 cart labels are square.
      for (const [key, r] of Object.entries(RETRO)) shelves.push([r.shelf, list.filter((i) => i.platform === key), false]);
      shelves.push(["PICO-8 games", list.filter((i) => !RETRO[i.platform]), true]);
    }
    for (const [label, list, square] of shelves) {
      if (!list.length) continue;
      box.append(el("section", { class: "shelf", "aria-label": label },
        el("div", { class: "shelf-head" },
          el("h2", {}, label),
          el("span", { class: "mono" }, String(list.length).padStart(2, "0"))),
        el("div", { class: `grid${square ? " square" : ""}` }, list.map(card))
      ));
    }
  }

  function refreshSublines() {
    document.querySelectorAll("[data-sub]").forEach((node) => {
      const it = byId.get(node.getAttribute("data-sub"));
      if (it) node.textContent = subline(it).join(" · ");
    });
    document.querySelectorAll("img[data-art]").forEach((img) => {
      const it = byId.get(img.getAttribute("data-art"));
      if (it) setArt(img, it);
    });
    document.querySelectorAll("[data-artist]").forEach((node) => {
      const it = byId.get(node.getAttribute("data-artist"));
      if (it) { node.textContent = byline(it) || ""; node.hidden = !byline(it); }
    });
  }

  /* ---------- Navigation ----------
     #series=<id>              a series' episode page
     #watch=<id>               play a film or album
     #watch=<id>&ep=<episode>  play one episode of a series */
  const enc = encodeURIComponent;
  const seriesHash = (id) => `#series=${enc(id)}`;
  const watchHash = (id, ep) => `#watch=${enc(id)}${ep ? "&ep=" + enc(ep) : ""}`;
  function go(hash) {
    history.pushState(null, "", hash || location.pathname + location.search);
    route();
  }
  const openTitle = (item) => go(item.type === "series" ? seriesHash(item.id) : watchHash(item.id));

  /* ---------- Episodes ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const epLabel = (ep) => ep.number == null ? "Extra" :
    ep.season != null ? `S${pad(ep.season)} · E${pad(ep.number)}` : `Episode ${ep.number}`;

  // "Spider-Man 5000 - 1981 - S01E03 - Lizards, Lizards, Everywhere.mkv"
  //   -> { season: 1, number: 3, title: "Lizards, Lizards, Everywhere" }
  function parseEpisode(name, fileTitle, show) {
    const path = String(name || "");
    const base = path.replace(/^.*\//, "").replace(/\.[a-z0-9]{2,4}$/i, "");
    const src = (String(fileTitle || "").trim() || base).replace(/_+/g, " ");
    const PATTERNS = [
      [/(?<![A-Za-z0-9])S(\d{1,2})\s*[._-]?\s*E(\d{1,3})(?![0-9])/i, (m) => [+m[1], +m[2]]], // S01E03
      [/(?<![0-9])(\d{1,2})x(\d{2,3})(?![0-9])/, (m) => [+m[1], +m[2]]],                     // 1x03
      [/(?<![0-9])(\d{1,2}),(\d{2,3})(?![0-9])/, (m) => [+m[1], +m[2]]],                      // 01,03
      [/^((?:19|20)\d\d)e\d{2,3}\b/i, (m) => [null, null, m[1]]],                              // 1933e00- (Popeye)
      [/^(\d{1,3})[A-Za-z]?(?:\s*[-.)]\s*|\s+)(?=\S)/, (m) => [null, +m[1]]],                  // "01 Title", "10A - Title"
      [/\b(?:ep(?:isode)?|chapter|part)\.?\s*(\d{1,3})\b/i, (m) => [null, +m[1]]],
    ];
    const find = (t) => {
      for (const [re, f] of PATTERNS) {
        const m = t.match(re);
        if (m) { const [season, number, year] = f(m); return { m, t, season, number, year }; }
      }
      return null;
    };
    const hit = find(src) || find(base);
    const tidy = (t) => {
      if (!/\s/.test(t)) t = t.replace(/[._]+/g, " ");              // Show.Name.S01E03.Title
      return t.replace(/\s{3,}/g, "… ").replace(/\s{2,}/g, " ")      // "Speaks   People" (a dropped "...")
              .replace(/^[\s\-–—_.:|,]+|[\s\-–—_.:|,]+$/g, "").trim();
    };
    const junk = (t) => t
      .replace(/\s*[\[(][^\])]*\b(?:\d{3,4}p|AI|upscale[d]?|x26[45]|HEVC|DVD(?:rip)?|SDTV|HDTV)\b[^\])]*[\])]/gi, "")
      .replace(/\s+\b(?:SDTV|HDTV|DVDrip|WEB-?DL|\d{3,4}p)\b\s*$/i, "");
    let title = hit && hit.t === src
      ? tidy(src.slice(hit.m.index + hit.m[0].length)) || tidy(src.slice(0, hit.m.index))
      : tidy(src);
    title = tidy(junk(title));
    // "Powerpuff Girls - Insect Inside" → "Insect Inside" (only when something is left)
    if (show && title) {
      const words = (s) => s.toLowerCase().replace(/^(the|a|an)\s+/, "").split(/[^a-z0-9]+/).filter(Boolean);
      const want = words(show).join(" ");
      const parts = title.split(/\s+/);
      if (hit && hit.number != null && words(title).join(" ") === want) title = "";                     // "Dexter s Laboratory" says nothing
      // "Money to Burn - DuckTales 1987" → "Money to Burn"
      const tail = title.match(/\s+[-–—]\s+(.+?)(?:\s*\(?(?:19|20)\d\d\)?)?$/);
      if (tail && words(tail[1]).join(" ") === want) title = tidy(title.slice(0, tail.index));
      for (let i = 1; i < parts.length; i++) {
        if (words(parts.slice(0, i).join(" ")).join(" ") === want) {
          const rest = tidy(parts.slice(i).join(" "));
          if (rest && !rest.startsWith("(")) title = rest;
          break;
        }
      }
    }
    if (hit && hit.year && !title.includes(hit.year)) title = `${title} (${hit.year})`;
    let season = hit ? hit.season : null;
    if (season == null) { const f = path.match(/(?:^|\/)season\s*(\d{1,2})\b[^/]*\//i); if (f) season = +f[1]; }
    return {
      season,
      number: hit ? hit.number : null,
      title: title || (hit && hit.number != null ? `Episode ${hit.number}` : base),
    };
  }

  const episodeCache = new Map();
  function loadEpisodes(item) {
    if (!episodeCache.has(item.id)) {
      const job = (item.episodes && item.episodes.length ? episodesFromItems(item) : episodesFromFiles(item));
      job.catch(() => episodeCache.delete(item.id)); // let a later visit retry
      episodeCache.set(item.id, job);
    }
    return episodeCache.get(item.id);
  }

  // One Archive item holding every episode as its own video file.
  async function episodesFromFiles(item) {
    const res = await fetch(IA.meta(item.id));
    if (!res.ok) throw new Error("metadata " + res.status);
    const files = (await res.json()).files || [];
    const originals = files.filter((f) => f.source === "original" && VIDEO_FORMAT.test(f.format || "") &&
      !/(^|\/)(commercials?|promos?|trailers?|bumpers?)\//i.test(f.name));
    const eps = originals.map((f) => {
      const kids = files.filter((d) => d.original === f.name);
      // Prefer the Archive's browser-friendly MP4 copy; fall back to the upload itself if a browser can play it.
      const play = kids.find((d) => /h\.264|mpeg4/i.test(d.format || "") && /\.mp4$/i.test(d.name)) ||
                   (/\.(mp4|m4v|webm|ogv)$/i.test(f.name) ? f : null);
      // The Archive saves a frame every couple of minutes; skip the first few (titles, black frames).
      const frames = kids.filter((d) => /thumbnail/i.test(d.format || "")).map((d) => d.name).sort();
      return {
        key: f.name,
        ...parseEpisode(f.name, f.title, item.title),
        length: formatRuntime(f.length || (play && play.length)),
        thumb: frames.length ? IA.file(item.id, frames[Math.min(3, frames.length - 1)]) : null,
        src: play ? IA.file(item.id, play.name) : null,
        source: `${IA.details(item.id)}/${enc(f.name)}`,
      };
    });
    eps.sort((a, b) =>
      (a.season ?? 1e9) - (b.season ?? 1e9) ||
      (a.number ?? 1e9) - (b.number ?? 1e9) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }));
    // Number unnumbered files only when the whole set is unnumbered; otherwise they're extras.
    if (eps.every((ep) => ep.season == null && ep.number == null)) eps.forEach((ep, i) => { ep.number = i + 1; });
    if (!item.episodeCount) { item.episodeCount = eps.length; refreshSublines(); }
    return eps;
  }

  // An "episodes" column in the media list: every episode is its own Archive item.
  async function episodesFromItems(item) {
    const eps = item.episodes.map((ep, n) => ({
      key: ep.id, season: null, number: n + 1, title: ep.title || `Episode ${n + 1}`,
      thumb: IA.thumb(ep.id), embed: ep.id, source: IA.details(ep.id), length: null,
    }));
    const queue = eps.slice();
    const worker = async () => {
      while (queue.length) {
        const ep = queue.shift();
        try {
          const m = (await (await fetch(IA.meta(ep.key))).json()).metadata || {};
          const first = (v) => (Array.isArray(v) ? v[0] : v);
          if (first(m.title)) ep.title = parseEpisode("", first(m.title)).title;
          ep.length = formatRuntime(first(m.runtime));
        } catch (_) { /* keep "Episode N" */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return eps;
  }

  /* ---------- Series page ---------- */
  const seriesView = $("#series-view");
  let currentSeries = null;
  let homeScroll = 0;

  function showHome() {
    if (document.body.dataset.view === "home") return;
    document.body.dataset.view = "home";
    currentSeries = null;
    window.scrollTo(0, homeScroll);
  }

  function showSeries(item) {
    if (document.body.dataset.view !== "series") homeScroll = window.scrollY;
    document.body.dataset.view = "series";
    if (currentSeries === item.id) return;
    currentSeries = item.id;
    window.scrollTo(0, 0);
    renderSeries(item);
  }

  function renderSeries(item) {
    const meta = el("p", { class: "meta-line" }, subline(item).map((s) => el("span", {}, s)));
    const desc = el("p", { class: "series-desc" }, item.description || "");
    const count = el("span", { class: "mono" });
    const list = el("div", { class: "ep-list", "aria-busy": "true" },
      el("p", { class: "ep-status" }, "Loading episodes…"));
    const playFirst = el("button", { class: "btn btn-primary", type: "button", disabled: true }, playIcon(), "Play episode 1");
    const backdrop = el("div", { class: "series-backdrop" });
    const paintBackdrop = () => { backdrop.style.backgroundImage = `url("${posterOf(item)}"), url("${IA.thumb(item.id)}")`; };
    const poster = el("div", { class: "series-poster" });
    const img = el("img", { alt: "", "data-art": item.id });
    img.onfail = () => poster.remove();
    setArt(img, item);
    poster.append(img);
    paintBackdrop();

    seriesView.replaceChildren(
      backdrop,
      el("div", { class: "series-inner" },
        el("button", { class: "back-link", type: "button", onclick: () => go("") }, "← All titles"),
        el("div", { class: "series-head" },
          poster,
          el("div", { class: "series-copy" },
            el("p", { class: "kicker" }, "Series"),
            el("h1", {}, item.title),
            meta,
            desc,
            el("div", { class: "hero-actions" },
              playFirst,
              el("a", { class: "btn", href: IA.details(item.id), target: "_blank", rel: "noopener" }, "On the Archive ↗")
            )
          )
        ),
        el("div", { class: "shelf-head ep-head" }, el("h2", {}, "Episodes"), count),
        list
      )
    );

    enrich(item).then(() => {
      if (currentSeries !== item.id) return;
      meta.replaceChildren(...subline(item).map((s) => el("span", {}, s)));
      desc.textContent = item.description || "";
      setArt(img, item);
      paintBackdrop();
    });

    loadEpisodes(item).then((eps) => {
      if (currentSeries !== item.id) return;
      list.removeAttribute("aria-busy");
      count.textContent = pad(eps.length);
      meta.replaceChildren(...subline(item).map((s) => el("span", {}, s)));
      if (!eps.length) {
        list.replaceChildren(el("p", { class: "ep-status" }, "This Archive item doesn't list any video files."));
        return;
      }
      playFirst.disabled = false;
      playFirst.lastChild.textContent = `Play ${eps[0].number != null ? "episode " + eps[0].number : "first episode"}`;
      playFirst.onclick = () => go(watchHash(item.id, eps[0].key));
      const seasons = [...new Set(eps.map((e) => e.season))];
      if (seasons.length > 1) {
        list.replaceChildren(...seasons.map((s) => el("section", { class: "ep-season" },
          el("h3", { class: "ep-season-title" }, s == null ? "Extras" : s === 0 ? "Specials" : `Season ${s}`),
          el("div", { class: "ep-grid" }, eps.filter((e) => e.season === s).map((e) => episodeCard(item, e))))));
      } else {
        list.replaceChildren(el("div", { class: "ep-grid" }, eps.map((e) => episodeCard(item, e))));
      }
    }).catch(() => {
      if (currentSeries !== item.id) return;
      list.removeAttribute("aria-busy");
      list.replaceChildren(el("p", { class: "ep-status" },
        "Couldn't get the episode list from the Internet Archive. Check your connection and refresh the page."));
    });
  }

  function episodeCard(item, ep) {
    const label = epLabel(ep);
    const art = el("button", {
      class: "ep-art", type: "button",
      "aria-label": `Play ${label ? label + ", " : ""}${ep.title}`,
      onclick: () => go(watchHash(item.id, ep.key)),
    }, el("span", { class: "ep-num", "aria-hidden": "true" }, ep.number != null ? pad(ep.number) : "+"));
    if (ep.thumb) {
      const img = el("img", { alt: "", loading: "lazy", decoding: "async", src: ep.thumb });
      img.onerror = () => img.remove();
      art.append(img);
    }
    art.append(el("span", { class: "play-badge", "aria-hidden": "true" }, playIcon()));
    return el("article", { class: "ep-card" },
      art,
      el("div", {},
        el("p", { class: "ep-label" }, [label, ep.length].filter(Boolean).join(" · ")),
        el("h3", { class: "ep-title" }, ep.title)
      )
    );
  }

  /* ---------- Player ---------- */
  const dlg = $("#player");
  let playing = null; // "<id>|<episode>" of what's on screen

  const embedFrame = (title, id, playlist) => el("iframe", {
    src: IA.embed(id, playlist),
    title: `${title} player`,
    allow: "autoplay; fullscreen; picture-in-picture; gamepad",
    allowfullscreen: true,
    referrerpolicy: "no-referrer-when-downgrade",
  });

  function setPlayerText(kicker, title, desc) {
    $("#player-kicker").textContent = kicker || "";
    $("#player-title").textContent = title || "";
    $("#player-desc").textContent = desc || "";
  }

  function openPlayer(id, epKey) {
    const item = byId.get(id);
    if (!item) return;
    const key = `${id}|${epKey || ""}`;
    if (dlg.open && playing === key) return;
    playing = key;

    const stage = $("#player-stage");
    const nav = $("#episodes");
    nav.hidden = true;
    nav.className = "episodes";
    nav.replaceChildren();

    if (item.type === "series" && epKey) {
      stage.className = "player-stage";
      stage.replaceChildren();
      setPlayerText(item.title, "Loading…");
      if (!dlg.open) dlg.showModal();
      loadEpisodes(item).catch(() => []).then((eps) => {
        if (playing !== key) return;
        const i = eps.findIndex((e) => e.key === epKey);
        if (i < 0) { // unknown episode: fall back to the Archive's own playlist for the item
          setPlayerText(subline(item).join(" · "), item.title, item.description);
          stage.replaceChildren(embedFrame(item.title, item.id, true));
          $("#player-source").href = IA.details(item.id);
          $("#player-source").textContent = sourceLabel(item);
          return;
        }
        playEpisode(item, eps, i);
      });
      return;
    }

    if (item.type === "game") {
      if (RETRO[item.platform]) renderRetro(item); else renderGame(item);
    } else if (item.type === "music") {
      stage.className = "player-stage album-stage";
      stage.replaceChildren(el("p", { class: "ep-status album-loading" }, "Loading tracks…"));
      renderAlbum(item, key);
    } else {
      stage.className = "player-stage";
      stage.replaceChildren(embedFrame(item.title, item.id, item.type === "series"));
    }
    $("#player-source").href = sourceOf(item);
    $("#player-source").textContent = sourceLabel(item);
    const fill = () => setPlayerText(subline(item).join(" · "),
      byline(item) ? `${item.title} — ${byline(item)}` : item.title, item.type === "game" ? "" : item.description);
    fill();
    if (!dlg.open) dlg.showModal();
    enrich(item).then(() => { if (playing === key) fill(); });
  }

  function playEpisode(item, eps, i) {
    const ep = eps[i], prev = eps[i - 1], next = eps[i + 1];
    const stage = $("#player-stage");
    setPlayerText([item.title, epLabel(ep), ep.length].filter(Boolean).join(" · "), ep.title);
    $("#player-source").href = ep.source;
    $("#player-source").textContent = sourceLabel(item);

    if (ep.src) {
      const video = el("video", {
        src: ep.src, poster: ep.thumb, controls: true, autoplay: true, playsinline: true, preload: "metadata",
      });
      // When an episode ends, roll straight on to the next one.
      video.addEventListener("ended", () => { if (next) go(watchHash(item.id, next.key)); });
      stage.replaceChildren(video);
    } else {
      stage.replaceChildren(embedFrame(ep.title, ep.embed || item.id, !ep.embed));
    }

    const nav = $("#episodes");
    const step = (target, text, cls) => el("button", {
      class: `btn ep-step ${cls}`, type: "button", disabled: !target,
      onclick: () => target && go(watchHash(item.id, target.key)),
    }, text);
    nav.className = "ep-nav";
    nav.replaceChildren(
      step(prev, "← Previous", "prev"),
      el("span", { class: "mono ep-pos" }, `Episode ${i + 1} of ${eps.length}`),
      step(next, "Next episode →", "next")
    );
    nav.hidden = false;
  }

  /* ---------- Album player: the track list lives in the page ---------- */
  const AUDIO_FILE = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|aiff?)$/i;
  const LOSSY_FILE = /\.(mp3|ogg|oga|opus|m4a|aac)$/i;
  const SKIP_FILE = /(^|\/)(__|\.)|spectrogram|_sample\b|\bsample\./i;
  let albumAudio = null;

  function secsOf(len) {
    if (len == null || len === "") return null;
    const str = String(len);
    if (str.includes(":")) return str.split(":").reduce((a, n) => a * 60 + (parseFloat(n) || 0), 0);
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : null;
  }
  function clock(secs) {
    if (!Number.isFinite(secs) || secs < 0) return "–:––";
    secs = Math.round(secs);
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = String(secs % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }
  function trackTitle(f) {
    if (f.title && String(f.title).trim()) return String(f.title).trim();
    const base = f.name.split("/").pop().replace(/\.[^.]+$/, "");
    return base.replace(/[_+]+/g, " ")
      .replace(/^\s*(?:disc\s*\d+\s*[-_.]\s*)?\d{1,3}\s*[-_.)]?\s*(?:-\s*)?/i, "")
      .replace(/\s+/g, " ").trim() || base;
  }

  // Read an item's file list and turn it into an ordered, playable track list.
  async function loadTracks(item) {
    if (item.trackList) return item.trackList;
    const res = await fetch(IA.meta(item.id));
    if (!res.ok) throw new Error("metadata " + res.status);
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    let originals = files.filter((f) => f.source === "original" && AUDIO_FILE.test(f.name || "") && !SKIP_FILE.test(f.name));
    // Items that hold the album twice (FLAC and MP3) keep the lighter copy.
    const lossy = originals.filter((f) => LOSSY_FILE.test(f.name));
    if (lossy.length && lossy.length < originals.length) originals = lossy;

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const dirOf = (f) => (f.name.includes("/") ? f.name.slice(0, f.name.lastIndexOf("/")) : "");
    const numOf = (f) => { const n = parseInt(String(f.track || ""), 10); return Number.isFinite(n) ? n : null; };
    // Group by folder and album tag (an item can hold two discs, or a bonus album),
    // order the groups by where their files fall by name, then by track number inside.
    const groupOf = (f) => `${dirOf(f)}\u0000${f.album || ""}`;
    const groupFirst = new Map();
    originals.slice().sort((a, b) => collator.compare(a.name, b.name)).forEach((f, i) => {
      if (!groupFirst.has(groupOf(f))) groupFirst.set(groupOf(f), i);
    });
    originals.sort((a, b) => {
      const g = groupFirst.get(groupOf(a)) - groupFirst.get(groupOf(b));
      if (g) return g;
      const ta = numOf(a), tb = numOf(b);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      return collator.compare(a.name, b.name);
    });
    const manyDirs = new Set(originals.map(dirOf)).size > 1;

    const albumArtist = (byline(item) || item.creator || "").toLowerCase();
    const tracks = originals.map((f) => {
      // Big lossless files stream through the Archive's MP3 copy when there is one.
      const mp3 = LOSSY_FILE.test(f.name) ? null :
        files.find((d) => d.original === f.name && /\.mp3$/i.test(d.name || ""));
      const artist = f.artist && String(f.artist).toLowerCase() !== albumArtist ? String(f.artist) : null;
      return {
        title: trackTitle(f), artist, disc: groupOf(f),
        discLabel: (manyDirs ? dirOf(f).split("/").pop() : "") || f.album || dirOf(f).split("/").pop() || "Disc",
        src: IA.file(item.id, (mp3 || f).name),
        length: secsOf(f.length) ?? secsOf(mp3 && mp3.length),
      };
    });
    if (!tracks.length) throw new Error("no tracks");
    item.trackList = tracks;
    return tracks;
  }

  const svg = (d, box = "0 0 16 16") => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", box); s.setAttribute("aria-hidden", "true");
    s.innerHTML = d;
    return s;
  };
  const ICON = {
    play: '<path d="M4 2l10 6-10 6z"/>',
    pause: '<path d="M3 2h3.5v12H3zM9.5 2H13v12H9.5z"/>',
    prev: '<path d="M2 2h2v12H2zM14 2v12L5 8z"/>',
    next: '<path d="M12 2h2v12h-2zM2 2v12l9-6z"/>',
  };

  function stopAlbum() {
    if (albumAudio) { albumAudio.pause(); albumAudio.removeAttribute("src"); albumAudio.load(); }
    albumAudio = null;
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  }

  async function renderAlbum(item, key) {
    const stage = $("#player-stage");
    let tracks;
    try {
      [tracks] = await Promise.all([loadTracks(item), enrich(item)]);
    } catch (_) {
      if (playing !== key) return;
      // No usable file list: fall back to the Archive's own player.
      stage.className = "player-stage audio";
      stage.replaceChildren(embedFrame(item.title, item.id, true));
      return;
    }
    if (playing !== key) return;
    stopAlbum();

    const audio = el("audio", { preload: "none" });
    albumAudio = audio;
    let cur = -1;

    const cover = el("img", { class: "album-cover", alt: `${item.title} cover`, loading: "lazy" });
    setArt(cover, item);
    const npTitle = el("p", { class: "np-title" }, "Pick a track, or press play");
    const npSub = el("p", { class: "np-sub mono" }, `${tracks.length} track${tracks.length === 1 ? "" : "s"}`);
    const playBtn = el("button", { class: "t-btn t-play", type: "button", "aria-label": "Play" }, svg(ICON.play));
    const prevBtn = el("button", { class: "t-btn", type: "button", "aria-label": "Previous track" }, svg(ICON.prev));
    const nextBtn = el("button", { class: "t-btn", type: "button", "aria-label": "Next track" }, svg(ICON.next));
    const seek = el("input", { type: "range", min: 0, max: 0, step: "any", value: 0, "aria-label": "Seek" });
    const tCur = el("span", {}, "0:00"), tDur = el("span", {}, "–:––");

    const list = el("ol", { class: "tracklist" });
    const rows = [];
    // Section headings only when the item really holds several discs or albums
    // (a single stray file with its own album tag shouldn't get a heading).
    const groupSizes = tracks.reduce((m, t) => m.set(t.disc, (m.get(t.disc) || 0) + 1), new Map());
    const multiDisc = groupSizes.size > 1 && [...groupSizes.values()].every((c) => c > 1);
    let lastDisc = null, n = 0;
    tracks.forEach((t, i) => {
      if (multiDisc && t.disc !== lastDisc) {
        lastDisc = t.disc; n = 0;
        list.append(el("li", { class: "disc-head mono" }, String(t.discLabel).replace(/[_+]+/g, " ")));
      }
      n += 1;
      const btn = el("button", { class: "track", type: "button", onclick: () => (i === cur ? toggle() : play(i)) },
        el("span", { class: "track-num mono" }, el("span", { class: "n" }, String(n)),
          el("span", { class: "eq", "aria-hidden": "true" }, el("i"), el("i"), el("i"))),
        el("span", { class: "track-main" },
          el("span", { class: "track-title" }, t.title),
          t.artist ? el("span", { class: "track-artist" }, t.artist) : null),
        el("span", { class: "track-len mono" }, t.length ? clock(t.length) : ""));
      rows.push(btn);
      list.append(el("li", {}, btn));
    });

    const root = el("div", { class: "album" },
      el("div", { class: "album-side" },
        cover,
        el("div", { class: "np" }, el("p", { class: "np-label mono" }, "Now playing"), npTitle, npSub),
        el("div", { class: "transport" }, prevBtn, playBtn, nextBtn),
        el("div", { class: "seek mono" }, tCur, seek, tDur)),
      list, audio);
    stage.replaceChildren(root);

    function setPlayingUI() {
      const on = !audio.paused;
      root.classList.toggle("is-playing", on);
      playBtn.replaceChildren(svg(on ? ICON.pause : ICON.play));
      playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
    }
    function play(i) {
      if (i < 0 || i >= tracks.length) return;
      cur = i;
      const t = tracks[i];
      rows.forEach((r, j) => r.setAttribute("aria-current", String(j === i)));
      rows[i].scrollIntoView({ block: "nearest", behavior: "smooth" });
      npTitle.textContent = t.title;
      npSub.textContent = `Track ${i + 1} of ${tracks.length}${t.artist ? " · " + t.artist : ""}`;
      prevBtn.disabled = false; nextBtn.disabled = i >= tracks.length - 1;
      audio.src = t.src;
      seek.value = 0; tCur.textContent = "0:00"; tDur.textContent = t.length ? clock(t.length) : "–:––";
      audio.play().catch(() => setPlayingUI());
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: t.title, artist: t.artist || byline(item) || "", album: item.title,
          artwork: [{ src: cover.src || IA.thumb(item.id) }],
        });
      }
    }
    function toggle() {
      if (cur < 0) return play(0);
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    }

    playBtn.addEventListener("click", toggle);
    prevBtn.addEventListener("click", () => (audio.currentTime > 3 || cur <= 0 ? (audio.currentTime = 0) : play(cur - 1)));
    nextBtn.addEventListener("click", () => play(cur + 1));
    audio.addEventListener("play", setPlayingUI);
    audio.addEventListener("pause", setPlayingUI);
    audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audio.duration)) { seek.max = audio.duration; tDur.textContent = clock(audio.duration); }
    });
    let dragging = false;
    seek.addEventListener("input", () => { dragging = true; tCur.textContent = clock(Number(seek.value)); });
    seek.addEventListener("change", () => { audio.currentTime = Number(seek.value); dragging = false; });
    audio.addEventListener("timeupdate", () => {
      if (dragging) return;
      seek.value = audio.currentTime; tCur.textContent = clock(audio.currentTime);
    });
    // Roll on to the next track; skip any file the Archive won't serve.
    audio.addEventListener("ended", () => { if (cur < tracks.length - 1) play(cur + 1); else setPlayingUI(); });
    audio.addEventListener("error", () => {
      if (cur < 0 || !audio.getAttribute("src")) return;
      rows[cur].classList.add("err");
      if (cur < tracks.length - 1) play(cur + 1); else setPlayingUI();
    });

    if ("mediaSession" in navigator) {
      const ms = navigator.mediaSession;
      try {
        ms.setActionHandler("play", () => toggle());
        ms.setActionHandler("pause", () => audio.pause());
        ms.setActionHandler("previoustrack", () => play(Math.max(0, cur - 1)));
        ms.setActionHandler("nexttrack", () => play(cur + 1));
      } catch (_) {}
    }
    prevBtn.disabled = true;
    nextBtn.disabled = tracks.length < 2;
  }

  /* ---------- Game player: a little PICO-8 console around Lexaloffle's own cart player ---------- */
  // Lexaloffle only lets a cart run inside other sites when its author allows it ("embed" in the
  // media list). Other carts get the same console, with their label art and a button to play on the BBS.
  const widgetUrl = (cart) => `https://www.lexaloffle.com/bbs/widget.php?pid=${encodeURIComponent(cart)}`;
  const KEYS = [
    ["Move", ["←", "↑", "→", "↓"], "or E S D F"],
    ["O button", ["Z"], "or C, N"],
    ["X button", ["X"], "or V, M"],
    ["Pause menu", ["Enter"], "or P"],
  ];

  function renderGame(item) {
    const stage = $("#player-stage");
    stage.className = "player-stage game-stage";

    const screen = el("div", { class: "screen" });
    const label = el("img", { class: "cart-label", alt: "", src: posterOf(item) });
    label.onerror = () => label.remove();

    const playHere = () => {
      const frame = el("iframe", {
        src: widgetUrl(item.id), title: `${item.title} (PICO-8)`, scrolling: "no",
        allow: "autoplay; fullscreen; gamepad", allowfullscreen: true,
      });
      frame.addEventListener("load", () => { try { frame.contentWindow.focus(); } catch (_) {} });
      screen.replaceChildren(frame);
      shell.classList.add("on");
    };

    if (!item.embed) {
      screen.append(label, el("div", { class: "screen-note" },
        el("p", {}, "This cart's maker keeps it on Lexaloffle."),
        el("a", { class: "btn btn-primary", href: sourceOf(item), target: "_blank", rel: "noopener" },
          playIcon(), "Play on Lexaloffle ↗")));
    }

    const fullBtn = el("button", { class: "btn console-btn", type: "button", disabled: !item.embed,
      onclick: () => { const f = screen.querySelector("iframe") || screen; (f.requestFullscreen || f.webkitRequestFullscreen || (() => {})).call(f); } },
      "Fullscreen");
    const resetBtn = el("button", { class: "btn console-btn", type: "button", disabled: !item.embed,
      onclick: () => { const f = screen.querySelector("iframe"); if (f) f.src = f.src; else playHere(); } },
      "Reset");

    const shell = el("div", { class: "console" },
      el("div", { class: "console-top" },
        el("span", { class: "console-brand mono" }, "PICO", el("b", {}, "·"), "8"),
        el("span", { class: "console-led", "aria-hidden": "true" })),
      el("div", { class: "screen-wrap" }, screen),
      item.embed ? el("div", { class: "console-controls" }, resetBtn, fullBtn) : null);

    const side = el("aside", { class: "game-side" },
      el("p", { class: "np-label mono" }, "Cartridge"),
      el("h3", { class: "game-title" }, item.title),
      byline(item) ? el("p", { class: "game-by mono" }, `by ${byline(item)}`) : null,
      item.description ? el("p", { class: "game-desc" }, item.description) : null,
      item.tags.length ? el("div", { class: "card-tags" }, item.tags.map((t) => el("span", { class: "tag" }, t))) : null,
      el("p", { class: "np-label mono keys-head" }, "Controls"),
      el("dl", { class: "keys" }, KEYS.map(([what, caps, alt]) => [
        el("dt", {}, what),
        el("dd", {}, caps.map((c) => el("kbd", {}, c)), el("span", { class: "keys-alt mono" }, alt)),
      ])),
      el("p", { class: "game-hint" }, item.embed
        ? "Click the screen first so it hears your keyboard. Gamepads work too."
        : "Lexaloffle's page opens in a new tab with the full player."));

    stage.replaceChildren(el("div", { class: "game" }, shell, side));
    // Playable carts load straight away; Lexaloffle's player shows the label and its own start button.
    if (item.embed) playHere();
  }

  /* ---------- Retro consoles: a TV on top of each console, plus that console's controller ---------- */
  // Every console here runs in the Internet Archive's emulator (MAME). Atari keys come from the
  // Archive's own instructions; the others are MAME's standard keys.
  const RETRO = {
    nes: {
      shelf: "NES games", one: "NES game", badge: "NES", pad: "nes",
      keys: [["←↑→↓", "Move"], ["5", "Select"], ["1", "Start"], ["Ctrl", "B"], ["Alt / Option", "A"]],
      hint: "Press the power button on the screen to boot, then click the game so it hears your keyboard.",
    },
    genesis: {
      shelf: "Sega Genesis games", one: "Genesis game", badge: "GENESIS", pad: "genesis",
      keys: [["←↑→↓", "Move"], ["1", "Start"], ["Ctrl", "A"], ["Alt / Option", "B"], ["Space", "C"]],
      hint: "Press the power button on the screen to boot, then click the game so it hears your keyboard.",
    },
    tg16: {
      shelf: "TurboGrafx-16 games", one: "TurboGrafx-16 game", badge: "TURBOGRAFX-16", pad: "tg16",
      keys: [["←↑→↓", "Move"], ["5", "Select"], ["1", "Run"], ["Alt / Option", "II"], ["Ctrl", "I"]],
      hint: "Press the power button on the screen to boot, then click the game so it hears your keyboard. Run is the TurboGrafx's Start button.",
    },
    atari2600: {
      shelf: "Atari 2600 games", one: "Atari 2600 game", badge: "ATARI 2600", pad: "atari",
      keys: [["←↑→↓", "Joystick"], ["Ctrl / Space", "Fire"], ["2", "Reset (start)"], ["1", "Select"], ["C", "Color / B&W"]],
      hint: "Press the power button on the screen to boot, click the game, then press 2 (the console's Reset switch) to start playing.",
    },
  };

  // Controller drawings. Each one returns the pad face; the key map is shown underneath.
  const PADS = {
    nes: () => el("div", { class: "pad-face pad-nes" },
      el("div", { class: "pad-dpad" }, el("i"), el("i")),
      el("div", { class: "pad-mid" },
        el("div", { class: "pad-pill-wrap" }, el("span", { class: "pad-pill" }), el("small", {}, "SELECT")),
        el("div", { class: "pad-pill-wrap" }, el("span", { class: "pad-pill" }), el("small", {}, "START"))),
      el("div", { class: "pad-ab" },
        el("div", { class: "pad-btn-wrap" }, el("span", { class: "pad-btn" }), el("small", {}, "B")),
        el("div", { class: "pad-btn-wrap" }, el("span", { class: "pad-btn" }), el("small", {}, "A")))),
    genesis: () => el("div", { class: "pad-face pad-genesis" },
      el("div", { class: "pad-dpad round" }, el("i"), el("i")),
      el("div", { class: "pad-mid" }, el("div", { class: "pad-pill-wrap" }, el("span", { class: "pad-pill" }), el("small", {}, "START"))),
      el("div", { class: "pad-abc" }, ["A", "B", "C"].map((b) =>
        el("div", { class: "pad-btn-wrap" }, el("span", { class: "pad-btn" }, b))))),
    tg16: () => el("div", { class: "pad-face pad-tg16" },
      el("div", { class: "pad-dpad" }, el("i"), el("i")),
      el("div", { class: "pad-mid" },
        el("div", { class: "pad-pill-wrap" }, el("span", { class: "pad-pill" }), el("small", {}, "SELECT")),
        el("div", { class: "pad-pill-wrap" }, el("span", { class: "pad-pill" }), el("small", {}, "RUN"))),
      el("div", { class: "pad-ab" },
        el("div", { class: "pad-btn-wrap" }, el("span", { class: "pad-btn" }), el("small", {}, "II")),
        el("div", { class: "pad-btn-wrap" }, el("span", { class: "pad-btn" }), el("small", {}, "I")))),
    atari: () => el("div", { class: "pad-face pad-atari" },
      el("div", { class: "stick" }, el("span", { class: "stick-fire" }), el("span", { class: "stick-base" }, el("span", { class: "stick-shaft" }))),
      el("div", { class: "switches" }, ["SELECT", "RESET", "COLOR"].map((t) =>
        el("div", { class: "switch" }, el("span", {}), el("small", {}, t))))),
  };

  function renderRetro(item) {
    const r = RETRO[item.platform];
    const stage = $("#player-stage");
    stage.className = "player-stage game-stage";

    const screen = el("div", { class: "tv-screen" }, embedFrame(item.title, item.id, false));
    const frame = () => screen.querySelector("iframe");
    const fullBtn = el("button", { class: "btn console-btn", type: "button",
      onclick: () => { const f = frame(); if (f) (f.requestFullscreen || f.webkitRequestFullscreen || (() => {})).call(f); } }, "Fullscreen");
    const resetBtn = el("button", { class: "btn console-btn", type: "button",
      onclick: () => { const f = frame(); if (f) f.src = f.src; } }, "Reset");

    const tv = el("div", { class: "tv" },
      el("div", { class: "tv-bezel" }, screen),
      el("div", { class: `deck deck-${item.platform}` },
        el("span", { class: "deck-badge mono" }, r.badge),
        el("span", { class: "deck-slot", "aria-hidden": "true" }),
        el("span", { class: "deck-power", "aria-hidden": "true" }),
        el("div", { class: "deck-btns" }, resetBtn, fullBtn)));

    const keyList = el("dl", { class: "pad-map" }, r.keys.map(([k, what]) => [
      el("dt", {}, k.split(" / ").map((part, i) => [i ? el("span", { class: "or" }, "or") : null, el("kbd", {}, part)])),
      el("dd", {}, what),
    ]));
    const pad = el("div", { class: "pad", role: "img",
      "aria-label": "Controls: " + r.keys.map(([k, what]) => `${what}: ${k}`).join(", ") }, PADS[r.pad](), keyList);

    const side = el("aside", { class: "game-side" },
      el("p", { class: "np-label mono" }, "Cartridge"),
      el("h3", { class: "game-title" }, item.title),
      el("p", { class: "game-by mono" }, [byline(item), item.year].filter(Boolean).join(" · ")),
      item.description ? el("p", { class: "game-desc" }, item.description) : null,
      item.tags.length ? el("div", { class: "card-tags" }, item.tags.map((t) => el("span", { class: "tag" }, t))) : null,
      el("p", { class: "np-label mono keys-head" }, "Controls"),
      pad,
      el("p", { class: "game-hint" }, r.hint + " Gamepads work too. On a Mac, Ctrl plus an arrow key can trigger Mission Control, so a gamepad is the comfiest way to play."));

    stage.replaceChildren(el("div", { class: `game retro retro-${item.platform}` }, tv, side));
  }

  function closePlayer() {
    stopAlbum();
    $("#player-stage").replaceChildren(); // stops playback
    playing = null;
    if (dlg.open) dlg.close();
  }

  // Closing an episode returns to its series page; closing anything else returns home.
  function leavePlayer() {
    const m = location.hash.match(/^#watch=([^&]+)/);
    const item = m && byId.get(decodeURIComponent(m[1]));
    go(item && item.type === "series" ? seriesHash(item.id) : "");
  }
  $("#player-close").addEventListener("click", leavePlayer);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); leavePlayer(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) leavePlayer(); });

  function route() {
    const h = location.hash;
    let m = h.match(/^#series=([^&]+)$/);
    if (m) {
      const item = byId.get(decodeURIComponent(m[1]));
      if (item) { closePlayer(); showSeries(item); return; }
    }
    m = h.match(/^#watch=([^&]+)(?:&ep=(.+))?$/);
    if (m) {
      const item = byId.get(decodeURIComponent(m[1]));
      const ep = m[2] ? decodeURIComponent(m[2]) : null;
      if (item && item.type === "series" && !ep) { // old-style link to a whole series
        history.replaceState(null, "", seriesHash(item.id));
        return route();
      }
      if (item) {
        if (item.type === "series") showSeries(item); else showHome();
        openPlayer(item.id, ep);
        return;
      }
    }
    closePlayer();
    showHome();
  }
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  document.body.dataset.view = "home";

  /* ---------- Controls ---------- */
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    if (document.body.dataset.view === "series") go("");
    state.type = tab.dataset.type;
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-pressed", String(t === tab)));
    renderShelves();
  }));
  let qTimer;
  $("#search").addEventListener("input", (e) => {
    if (document.body.dataset.view === "series") go("");
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value.trim().toLowerCase(); renderShelves(); }, 120);
  });

  /* ---------- Boot ---------- */
  renderHero();
  renderTags();
  renderShelves();
  route();

  // Enrich a few at a time so a large catalog doesn't flood the Archive.
  (async function enrichAll() {
    const queue = items.slice();
    const worker = async () => { while (queue.length) { await enrich(queue.shift()); refreshSublines(); } };
    await Promise.all([worker(), worker(), worker()]);
  })();
})();
