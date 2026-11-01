// Anime Master Calendar (AniList + AV1 + Nyaa) — v3.0.|

const ANILIST_URL = "https://graphql.anilist.co";
const BASE_AV1 = "https://animeav1.com";
const NYAA_URL = "https://nyaa.si";
const UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// =========================================================================================
// 1. GESTIÓN INTERNA (PROGRESO Y LISTA)
// =========================================================================================
async function getProgress(id) {
  try {
    const data = await kino.storage.get(`prog_${id}`);
    return data ? parseInt(data, 10) : 0;
  } catch (_) { return 0; }
}
async function saveProgress(id, epNum) {
  await kino.storage.set(`prog_${id}`, String(epNum));
}
async function getInternalList() {
  try {
    const data = await kino.storage.get("follows");
    return data ? JSON.parse(data) : [];
  } catch (_) { return []; }
}
async function toggleInternal(id) {
  let list = await getInternalList();
  if (list.includes(id)) list = list.filter(x => x !== id);
  else list.push(id);
  await kino.storage.set("follows", JSON.stringify(list));
}

// =========================================================================================
// 2. ANILIST (CALENDARIO Y METADATOS)
// =========================================================================================
async function anilistQuery(query, variables) {
  const r = await kino.fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error("AniList HTTP " + r.status);
  return (await r.json()).data;
}

const MEDIA_FRAGMENT = `
  id title { romaji english native } description
  coverImage { extraLarge } bannerImage episodes
  nextAiringEpisode { episode, airingAt } seasonYear format
`;

async function toKinoItem(media) {
  let title = media.title.romaji || media.title.english || media.title.native;
  let nextEpStr = "";
  const currentProgress = await getProgress(media.id);

  if (media.nextAiringEpisode) {
    const latestEp = media.nextAiringEpisode.episode - 1; 
    const date = new Date(media.nextAiringEpisode.airingAt * 1000);
    const days = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    title = `[${days[date.getDay()]}] ${title}`;
    const nextToWatch = currentProgress + 1;
    
    if (nextToWatch <= latestEp) nextEpStr = `Sig: Ep ${nextToWatch}`;
    else nextEpStr = `Al día (Ep ${currentProgress})`;
  } else {
    nextEpStr = `Visto: Ep ${currentProgress}`;
  }

  return {
    id: String(media.id), ref: String(media.id), title: title,
    poster: media.coverImage?.extraLarge, backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: media.description ? media.description.replace(/<[^>]*>?/gm, '').slice(0, 200) + "..." : "",
    year: media.seasonYear ? String(media.seasonYear) : undefined,
    kind: "series", badges: [nextEpStr]
  };
}

// =========================================================================================
// 3. ANIMEAV1 (REPRODUCTOR DIRECTO)
// =========================================================================================
function unflatten(flat) {
  const cache = new Map();
  function get(i) {
    if (typeof i !== "number" || i < 0) return undefined;
    if (cache.has(i)) return cache.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") { cache.set(i, v[1]); return v[1]; }
      const out = []; cache.set(i, out); for (const x of v) out.push(get(x)); return out;
    }
    if (v && typeof v === "object") {
      const out = {}; cache.set(i, out); for (const k of Object.keys(v)) out[k] = get(v[k]); return out;
    }
    cache.set(i, v); return v;
  }
  return get(0);
}

async function av1FindSlug(title) {
  const r = await kino.fetch(`${BASE_AV1}/catalogo/__data.json?search=${encodeURIComponent(title)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  const body = await r.json();
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  const data = unflatten(nodes[nodes.length - 1].data);
  const results = data.results || [];
  if (results.length === 0) return null;
  const cleanTitle = title.toLowerCase();
  const best = results.find(m => m.title.toLowerCase().includes(cleanTitle) || cleanTitle.includes(m.title.toLowerCase()));
  return best ? best.slug : results[0].slug;
}

function voeDecode(packed) {
  let s = packed.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
  for (const junk of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(junk).join("");
  s = atob(s);
  let shifted = "";
  for (let i = 0; i < s.length; i++) shifted += String.fromCharCode(s.charCodeAt(i) - 3);
  return JSON.parse(atob(shifted.split("").reverse().join("")));
}

async function resolveVoe(url) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const r = await kino.fetch(current, { headers: { "User-Agent": UA } });
    const html = await r.text();
    const packed = html.match(/<script type="application\/json">\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/);
    if (packed) {
      try {
        const data = voeDecode(packed[1]);
        if (data && data.source) return { url: data.source, mime: "application/vnd.apple.mpegurl", headers: { "User-Agent": UA } };
      } catch (_) {}
    }
    const next = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!next) break;
    current = next[1];
  }
  throw new Error("Voe fallo");
}

async function resolveMp4Upload(url) {
  const r = await kino.fetch(url, { headers: { "User-Agent": UA } });
  const html = await r.text();
  const m = html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
  if (!m) throw new Error("MP4 fallo");
  return { url: m[1], mime: "video/mp4", headers: { Referer: "https://www.mp4upload.com/", "User-Agent": UA } };
}

async function av1GetStream(slug, episodeNum) {
  const epData = await kino.fetch(`${BASE_AV1}/media/${slug}/${episodeNum}/__data.json`, { headers: { Accept: "application/json" } }).then(r => r.json());
  const nodes = (epData.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  const data = unflatten(nodes[nodes.length - 1].data);
  
  const lang = kino.config.get("idioma") === "dub" ? "DUB" : "SUB";
  const embeds = data.embeds || {};
  const list = embeds[lang] || embeds["SUB"] || [];
  
  for (const embed of list) {
    try {
      if (embed.server === "voe" || embed.url.includes("voe.sx")) return await resolveVoe(embed.url);
      if (embed.server === "mp4upload" || embed.url.includes("mp4upload")) return await resolveMp4Upload(embed.url);
    } catch (e) { continue; }
  }
  throw new Error("No servidores AV1");
}

// =========================================================================================
// 4. NYAA (BUSCADOR TORRENT)
// =========================================================================================
async function fetchNyaa(queryStr) {
  const url = `${NYAA_URL}/?page=rss&q=${encodeURIComponent(queryStr)}&c=1_2&f=0`;
  const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  if (!r.ok) return [];
  const xml = await r.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const infoHash = (block.match(/<nyaa:infoHash>([^<]+)<\/nyaa:infoHash>/i) || [])[1] || "";
    const seeders = Number((block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i) || [])[1] || 0);
    if (infoHash) items.push({ id: infoHash, seeders });
  }
  return items;
}

function buildMagnet(infoHash) {
  const trackers = ["udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce"];
  const params = [`xt=urn:btih:${infoHash}`];
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join("&")}`;
}

// =========================================================================================
// 5. INTERFAZ PRINCIPAL (CALENDARIO Y CUADRÍCULA)
// =========================================================================================
const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const TABS = [
  { id: "hoy", label: "🔥 HOY" },
  { id: "lunes", label: "Lunes" },
  { id: "martes", label: "Martes" },
  { id: "miercoles", label: "Miércoles" },
  { id: "jueves", label: "Jueves" },
  { id: "viernes", label: "Viernes" },
  { id: "sabado", label: "Sábado" },
  { id: "domingo", label: "Domingo" },
  { id: "mi_lista", label: "Mi Lista" }
];

export async function section(arg) {
  const tab = arg && arg.tab ? String(arg.tab) : "hoy";
  const rows = [];
  
  let query = `query { Page(page: 1, perPage: 50) { media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) { ${MEDIA_FRAGMENT} } } }`;
  let mediaList = [];
  
  if (tab === "mi_lista") {
    const ids = await getInternalList();
    if (ids.length > 0) {
      query = `query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FRAGMENT} } } }`;
      const data = await anilistQuery(query, { ids });
      mediaList = data.Page?.media || [];
    } else {
      rows.push({ id: "empty", title: "Ve a las pestañas de días, entra a una serie y añádela.", items: [] });
    }
  } else {
    const data = await anilistQuery(query, {});
    const allMedia = data.Page?.media || [];
    const todayIdx = new Date().getDay();
    
    mediaList = allMedia.filter(m => {
      if (!m.nextAiringEpisode) return false;
      const airDate = new Date(m.nextAiringEpisode.airingAt * 1000);
      const airDayIdx = airDate.getDay();
      if (tab === "hoy") return airDayIdx === todayIdx;
      return DAYS[airDayIdx].toLowerCase() === tab;
    });
  }

  const items = await Promise.all(mediaList.map(m => toKinoItem(m)));

  // --- MAGIA DE CUADRÍCULA (Filas de 3) ---
  const CHUNK_SIZE = 3; 
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    rows.push({
      id: `${tab}_row_${i}`,
      title: i === 0 ? `Estrenos del ${tab.toUpperCase()}` : "", // Título solo en la primera fila
      items: chunk,
      ref: i === 0 ? `browse_${tab}` : undefined // Habilita el botón "Ver todo" para el scroll infinito
    });
  }
  
  return { tabs: TABS, tab, rows: rows.filter(r => r.items.length > 0 || r.id === "empty") };
}

// --- SCROLL INFINITO (Se activa al pulsar "Ver todo" en una fila) ---
export async function browse(ref, cursor) {
  const page = parseInt(cursor || "1", 10);
  const tab = ref.replace("browse_", ""); 
  
  const query = `query { Page(page: ${page}, perPage: 30) { media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) { ${MEDIA_FRAGMENT} } } }`;
  const data = await anilistQuery(query, {});
  const allMedia = data.Page?.media || [];
  
  let mediaList = allMedia;
  if (tab !== "mi_lista") {
    const todayIdx = new Date().getDay();
    mediaList = allMedia.filter(m => {
      if (!m.nextAiringEpisode) return false;
      const airDate = new Date(m.nextAiringEpisode.airingAt * 1000);
      const airDayIdx = airDate.getDay();
      if (tab === "hoy") return airDayIdx === todayIdx;
      return DAYS[airDayIdx].toLowerCase() === tab;
    });
  }

  const items = await Promise.all(mediaList.map(m => toKinoItem(m)));

  return {
    items: items,
    next: items.length > 0 ? String(page + 1) : undefined 
  };
}

export async function home() {
  const today = new Date().getDay();
  const tabName = DAYS[today].toLowerCase();
  return section({ tab: tabName }).then(res => res.rows);
}

// =========================================================================================
// 6. BÚSQUEDA, EPISODIOS Y RESOLUCIÓN (AV1 Y NYAA)
// =========================================================================================
export async function search(query) {
  const q = query.q || "";
  if (!q) return [];
  const gql = `query ($search: String) { Page(page: 1, perPage: 30) { media(search: $search, type: ANIME) { ${MEDIA_FRAGMENT} } } }`;
  const data = await anilistQuery(gql, { search: q });
  return Promise.all((data.Page?.media || []).map(m => toKinoItem(m)));
}

export async function episodes(ref) {
  const gql = `query ($id: Int) { Media(id: $id) { ${MEDIA_FRAGMENT} } }`;
  const data = await anilistQuery(gql, { id: parseInt(ref, 10) });
  const media = data.Media;
  if (!media) throw kino.error("not_found", "Anime no encontrado");

  const series = {
    title: media.title.romaji || media.title.english,
    poster: media.coverImage?.extraLarge,
    backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: media.description ? media.description.replace(/<[^>]*>?/gm, '') : ""
  };

  const eps = [];
  const isInternal = (await getInternalList()).includes(ref);
  const currentProgress = await getProgress(ref);

  // Botón de seguimiento
  eps.push({ season: 0, number: 0, ref: `${ref}|0|${media.title.romaji}|toggle`, title: isInternal ? "❌ Quitar de mi lista" : "➕ Seguir en mi lista" });

  let totalEps = media.episodes || 12;
  let latestAired = media.nextAiringEpisode ? media.nextAiringEpisode.episode - 1 : totalEps;

  for (let i = 1; i <= totalEps; i++) {
    let badge = "";
    if (i === currentProgress + 1) badge = " (Siguiente)";
    if (i > latestAired) badge = " (No emitido)";
    
    // Opción A: AnimeAV1
    eps.push({ 
      season: 1, number: i, 
      ref: `${ref}|${i}|${media.title.romaji || media.title.english}|av1`, 
      title: `[Directo AV1] Ep ${i}${badge}` 
    });
    
    // Opción B: Torrent Nyaa
    eps.push({ 
      season: 2, number: i, 
      ref: `${ref}|${i}|${media.title.romaji || media.title.english}|nyaa`, 
      title: `[Torrent Nyaa] Ep ${i}${badge}` 
    });
  }
  
  return { 
    series, 
    episodes: eps,
    seasons: [
      { seasonNumber: 0, label: "Acciones", episodes: eps.filter(e => e.season === 0) },
      { seasonNumber: 1, label: "Directo (AnimeAV1)", episodes: eps.filter(e => e.season === 1) },
      { seasonNumber: 2, label: "Torrents (Nyaa)", episodes: eps.filter(e => e.season === 2) }
    ]
  };
}

export async function resolve(ref) {
  const parts = String(ref).split("|");
  const anilistId = parts[0];
  const action = parts[1];
  const title = parts[2] || "";
  const mode = parts[3] || "av1"; 

  if (mode === "toggle") {
    await toggleInternal(anilistId);
    return { message: "Lista actualizada." };
  }

  const episodeNum = parseInt(action, 10);
  const quality = "1080p";
  const epStr = String(episodeNum).padStart(2, '0');

  if (mode === "nyaa") {
    const queries = [`${title} ${epStr} ${quality}`, `${title} ${epStr}`];
    for (const q of queries) {
      const results = await fetchNyaa(q);
      if (results.length > 0) {
        results.sort((a, b) => b.seeders - a.seeders);
        await saveProgress(anilistId, episodeNum);
        const pack = kino.config.get("external_app") || "com.kino.torcino";
        return { external: { protocol: "magnet", ref: buildMagnet(results[0].id), package: pack } };
      }
    }
    throw kino.error("not_found", "No hay torrents en Nyaa.");
  } else {
    try {
      const slug = await av1FindSlug(title);
      if (!slug) throw new Error("No encontrado en AV1");
      const stream = await av1GetStream(slug, episodeNum);
      await saveProgress(anilistId, episodeNum);
      return stream;
    } catch (err) {
      throw kino.error("unavailable", `Fallo en AV1: ${err.message}.`);
    }
  }
}

export async function action(key) {
  if (key === "clear_internal") {
    await kino.storage.set("follows", "[]");
    return { message: "Lista borrada." };
  }
  return { message: "Acción no reconocida." };
}