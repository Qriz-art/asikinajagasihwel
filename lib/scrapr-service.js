import crypto from "node:crypto";
import scrapr from "@coflyn/scrapr";
import { withTimeout } from "@/lib/async";
import {
  assertPublicHttpUrl,
  buildFileTitle,
  cleanDisplayTitle,
  extensionFromUrl,
  fetchPublicUrl,
  filenameFromUrl,
  hostMatches,
  isIpAddress,
  isPrivateIpAddress,
  isLikelyAudioUrl,
  parseArtistAndTitle,
  parseHttpUrl,
  probeAudioUrl,
  UnsafeUrlError,
} from "@/lib/media-url";
import { normalizeSearchValue, truncateText } from "@/lib/format";
import { extractYouTubeVideoId } from "@/lib/youtube";

const {
  applemusic,
  bandcamp,
  resolver,
  soundcloud,
  spotify,
  youtube,
} = scrapr;

const SCRAPER_TIMEOUT_MS = Math.max(
  15000,
  Number.parseInt(process.env.SCRAPER_TIMEOUT_MS || "60000", 10),
);
const PROBE_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.AUDIO_PROBE_TIMEOUT_MS || "12000", 10),
);
const MAX_TRACKS_PER_ENTRY = Math.max(
  1,
  Math.min(
    5000,
    Number.parseInt(process.env.MUSIC_MAX_TRACKS_PER_ENTRY || "1000", 10) ||
      1000,
  ),
);

const HOSTS = {
  youtube: [
    "youtube.com",
    ".youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    ".youtube-nocookie.com",
  ],
  soundcloud: ["soundcloud.com", ".soundcloud.com"],
  spotify: ["open.spotify.com", "spotify.com", ".spotify.com", "spotify.link"],
  apple: ["music.apple.com", "itunes.apple.com", "apple.co"],
  bandcamp: ["bandcamp.com", ".bandcamp.com"],
};

const FILE_RESOLVERS = [
  {
    method: "mediafire",
    label: "MediaFire",
    hosts: ["mediafire.com", ".mediafire.com"],
  },
  {
    method: "sfile",
    label: "Sfile",
    hosts: ["sfile.co", "sfile.mobi", ".sfile.co", ".sfile.mobi"],
  },
  {
    method: "pixeldrain",
    label: "Pixeldrain",
    hosts: ["pixeldrain.com", ".pixeldrain.com"],
  },
  {
    method: "catbox",
    label: "Catbox",
    hosts: ["catbox.moe", ".catbox.moe"],
  },
  {
    method: "gdrive",
    label: "Google Drive",
    hosts: ["drive.google.com", "docs.google.com"],
  },
  {
    method: "krakenfiles",
    label: "Krakenfiles",
    hosts: ["krakenfiles.com", ".krakenfiles.com"],
  },
  {
    method: "safelinku",
    label: "Safelinku",
    hosts: ["safelinku.com", ".safelinku.com", "sfl.gl"],
  },
  {
    method: "sub2unlock",
    label: "Sub2Unlock",
    hosts: ["sub2unlock.io", ".sub2unlock.io", "sub2unlock.com", ".sub2unlock.com"],
  },
  {
    method: "rekonise",
    label: "Rekonise",
    hosts: ["rekonise.com", ".rekonise.com"],
  },
];

const SHORTLINK_HOSTS = [
  "bit.ly",
  "bit.do",
  "tinyurl.com",
  "t.co",
  "cutt.ly",
  "shorturl.at",
  "rebrand.ly",
  "s.id",
  "on.soundcloud.com",
  "soundcloud.app.goo.gl",
];

const PLATFORM_LABELS = {
  youtube: "YouTube",
  "youtube-playlist": "Playlist YouTube",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  apple: "Apple Music",
  bandcamp: "Bandcamp",
  filehost: "File audio",
  shortlink: "Tautan pendek",
  direct: "Audio langsung",
  unsupported: "Belum didukung",
};

export class ExtractionError extends Error {
  constructor(message, code = "EXTRACTION_FAILED") {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
  }
}

function providerLog(label, error) {
  const message =
    error instanceof Error ? error.message : String(error || "Tanpa pesan");
  console.warn(`[Musik-In] ${label}: ${truncateText(message, 180)}`);
}

function entryIdForUrl(link) {
  const parsed = parseHttpUrl(link);
  const normalized = parsed ? parsed.href : String(link);
  return `e_${crypto
    .createHash("sha1")
    .update(normalized)
    .digest("hex")
    .slice(0, 16)}`;
}

function trackIdFor(entryId, index, identity) {
  const hash = crypto
    .createHash("sha1")
    .update(`${index}|${identity || ""}`)
    .digest("hex")
    .slice(0, 10);
  return `${entryId}.${hash}`;
}

export function detectSource(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    return { platform: "unsupported", url: null, reason: "URL tidak valid." };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const path = parsed.pathname.toLowerCase();

  if (hostMatches(host, HOSTS.youtube)) {
    const isPlaylist =
      (parsed.searchParams.has("list") && !parsed.searchParams.has("v")) ||
      path === "/playlist";
    return {
      platform: isPlaylist ? "youtube-playlist" : "youtube",
      url: parsed,
      label: isPlaylist ? PLATFORM_LABELS["youtube-playlist"] : PLATFORM_LABELS.youtube,
    };
  }

  if (hostMatches(host, HOSTS.soundcloud)) {
    if (path.includes("/sets/")) {
      return {
        platform: "soundcloud",
        url: parsed,
        label: PLATFORM_LABELS.soundcloud,
        unsupported: "Playlist SoundCloud belum didukung. Gunakan tautan satu lagu.",
      };
    }

    return {
      platform: "soundcloud",
      url: parsed,
      label: PLATFORM_LABELS.soundcloud,
    };
  }

  if (hostMatches(host, HOSTS.spotify)) {
    return {
      platform: "spotify",
      url: parsed,
      label: PLATFORM_LABELS.spotify,
    };
  }

  if (hostMatches(host, HOSTS.apple)) {
    const isAlbum = path.includes("/album/") && !parsed.searchParams.get("i");
    const unsupported = isAlbum
      ? "Untuk album Apple Music, gunakan tautan lagu dengan parameter ?i=."
      : null;
    return {
      platform: "apple",
      url: parsed,
      label: PLATFORM_LABELS.apple,
      unsupported,
    };
  }

  if (hostMatches(host, HOSTS.bandcamp)) {
    return {
      platform: "bandcamp",
      url: parsed,
      label: PLATFORM_LABELS.bandcamp,
    };
  }

  const fileResolver = FILE_RESOLVERS.find((item) =>
    hostMatches(host, item.hosts),
  );
  if (fileResolver) {
    return {
      platform: "filehost",
      url: parsed,
      label: fileResolver.label,
      resolverMethod: fileResolver.method,
    };
  }

  if (hostMatches(host, SHORTLINK_HOSTS)) {
    return {
      platform: "shortlink",
      url: parsed,
      label: PLATFORM_LABELS.shortlink,
    };
  }

  return {
    platform: "direct",
    url: parsed,
    label: PLATFORM_LABELS.direct,
  };
}

async function validateSource(link, source) {
  if (source.platform === "direct") {
    return assertPublicHttpUrl(link);
  }

  const allowed =
    source.platform === "filehost"
      ? FILE_RESOLVERS.find((item) => item.method === source.resolverMethod)?.hosts
      : source.platform === "shortlink"
        ? SHORTLINK_HOSTS
        : HOSTS[
            source.platform === "youtube-playlist" ? "youtube" : source.platform
          ];

  if (!allowed) {
    throw new ExtractionError("Sumber tautan tidak dikenali.", "UNSUPPORTED_SOURCE");
  }

  return assertPublicHttpUrl(link, {
    allowedHosts: allowed,
    skipDns: true,
  });
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  let candidate = value.trim();
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  }

  const parsed = parseHttpUrl(candidate);
  return parsed ? parsed.href : null;
}

function normalizeImageUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      (isIpAddress(host) && isPrivateIpAddress(host))
    ) {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

function collectAudioCandidates(result, track, options = {}) {
  const { allowGeneric = false, includeResultDownloads = true } = options;
  const trackDownloads = Array.isArray(track?.downloads)
    ? track.downloads
    : [];
  const resultDownloads = Array.isArray(result?.downloads)
    ? result.downloads
    : [];
  const rawDownloads =
    trackDownloads.length > 0
      ? trackDownloads
      : includeResultDownloads
        ? resultDownloads
        : [];
  const candidates = [];
  const seen = new Set();

  for (const download of rawDownloads) {
    const rawUrl =
      typeof download === "string"
        ? download
        : download?.url || download?.downloadUrl || download?.link;
    const url = normalizeHttpUrl(rawUrl);
    if (!url || seen.has(url)) {
      continue;
    }

    const type = String(
      typeof download === "object" ? download?.type || download?.quality || "" : "",
    ).toLowerCase();
    const extension = extensionFromUrl(url);

    if (
      type.includes("cover") ||
      type.includes("photo") ||
      type.includes("image") ||
      type.includes("thumbnail") ||
      type.includes("video") ||
      ["jpg", "jpeg", "png", "webp", "gif", "mp4", "webm"].includes(extension)
    ) {
      continue;
    }

    const looksAudio =
      isLikelyAudioUrl(url) ||
      type.includes("audio") ||
      type.includes("mp3") ||
      type.includes("m4a") ||
      type.includes("music") ||
      (allowGeneric && type.includes("download"));

    if (!looksAudio) {
      continue;
    }

    seen.add(url);
    candidates.push({
      url,
      type: type || "audio",
      quality:
        typeof download === "object" && download?.quality
          ? String(download.quality)
          : null,
    });
  }

  return candidates;
}

function buildTrack({
  entryId,
  index,
  title,
  artist,
  album,
  duration,
  cover,
  sourceUrl,
  platform,
  videoId,
  audioCandidates = [],
  identity,
  needsResolve,
}) {
  const fallbackTitle = cleanDisplayTitle(title, "Tanpa judul");
  const parsed = artist
    ? { artist: String(artist).trim(), title: fallbackTitle }
    : parseArtistAndTitle(fallbackTitle);
  const cleanArtist = parsed.artist || String(artist || "").trim();
  const finalTitle = parsed.title || fallbackTitle;
  const candidates = [...new Set(audioCandidates.filter(Boolean))].slice(0, 8);

  return {
    id: trackIdFor(entryId, index, identity || `${finalTitle}|${cleanArtist}`),
    entryId,
    title: finalTitle,
    artist: cleanArtist,
    album: String(album || "").trim(),
    duration:
      Number.isFinite(Number(duration)) && Number(duration) > 0
        ? Math.round(Number(duration))
        : 0,
    cover: normalizeImageUrl(cover),
    platform,
    videoId:
      String(videoId || "").trim() ||
      (platform === "youtube" || platform === "youtube-playlist"
        ? extractYouTubeVideoId(sourceUrl)
        : null),
    sourceUrl: normalizeHttpUrl(sourceUrl),
    audioUrl: candidates[0] || null,
    audioCandidates: candidates,
    needsResolve: needsResolve ?? candidates.length === 0,
    sourceIndex: index,
  };
}

function buildEntry({
  platform,
  kind,
  title,
  subtitle,
  artist,
  album,
  cover,
  tracks,
  warnings = [],
  reportedTrackCount = null,
}) {
  const limitedTracks = tracks
    .filter(Boolean)
    .slice(0, MAX_TRACKS_PER_ENTRY);
  const nextWarnings = [...warnings];

  if (tracks.length > MAX_TRACKS_PER_ENTRY) {
    nextWarnings.push(
      `Hanya ${MAX_TRACKS_PER_ENTRY} lagu pertama dari sumber ini yang dimuat.`,
    );
  }

  if (limitedTracks.length === 0) {
    throw new ExtractionError(
      "Tidak ada lagu yang dapat dibaca dari tautan ini.",
      "NO_TRACKS",
    );
  }

  return {
    platform,
    kind,
    title:
      cleanDisplayTitle(title, PLATFORM_LABELS[platform] || "Katalog Ongaku"),
    subtitle: String(subtitle || "").trim(),
    artist: String(artist || "").trim(),
    album: String(album || "").trim(),
    cover: normalizeImageUrl(cover),
    tracks: limitedTracks,
    warnings: nextWarnings,
    reportedTrackCount:
      Number.isFinite(Number(reportedTrackCount)) &&
      Number(reportedTrackCount) > 0
        ? Number(reportedTrackCount)
        : limitedTracks.length,
  };
}

async function callProvider(label, callback) {
  try {
    const response = await withTimeout(
      Promise.resolve().then(callback),
      SCRAPER_TIMEOUT_MS,
      `Waktu ${label} habis.`,
    );

    if (!response?.status || !response?.result) {
      const message =
        response?.message || `${label} tidak mengembalikan hasil.`;
      providerLog(label, new Error(message));
      return { ok: false, message };
    }

    return { ok: true, result: response.result };
  } catch (error) {
    providerLog(label, error);
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${label} gagal.`,
    };
  }
}

async function extractYoutube(link, entryId) {
  const providers = [
    ["YouTube ytmp3", () => youtube.ytmp3(link, "mp3")],
    ["YouTube ytmp3.gg", () => youtube.ytmp3gg(link, { format: "mp3" })],
  ];

  for (const [label, callback] of providers) {
    const response = await callProvider(label, callback);
    if (!response.ok) {
      continue;
    }

    const result = response.result;
    const candidates = collectAudioCandidates(result, null);
    if (candidates.length === 0) {
      providerLog(label, new Error("Tautan audio tidak ditemukan."));
      continue;
    }

    const parsed = parseArtistAndTitle(result.title, "");
    const providerName = label.toLowerCase().includes("ytmp3.gg")
      ? "ytmp3gg"
      : "ytmp3";

    return buildEntry({
      platform: "youtube",
      kind: "track",
      title: parsed.title || result.title,
      subtitle: "YouTube",
      artist: parsed.artist,
      cover: result.thumbnail,
      reportedTrackCount: 1,
      tracks: [
        buildTrack({
          entryId,
          index: 0,
          title: result.title,
          artist: "",
          sourceUrl: link,
          platform: "youtube",
          videoId: extractYouTubeVideoId(link),
          audioCandidates: candidates.map((item) => item.url),
          identity: link,
          needsResolve: true,
        }),
      ],
      warnings: [
        `Audio diekstrak melalui ${providerName}. URL dapat kedaluwarsa dan akan diperbarui saat diputar.`,
      ],
    });
  }

  throw new ExtractionError(
    "Audio YouTube tidak dapat disiapkan saat ini. Coba lagi beberapa saat.",
    "PROVIDER_FAILED",
  );
}

async function extractYoutubePlaylist(link, entryId) {
  const response = await callProvider("Playlist YouTube", () =>
    youtube.playlist(link),
  );

  if (!response.ok || !Array.isArray(response.result.items)) {
    throw new ExtractionError(
      "Playlist YouTube tidak dapat dibaca. Pastikan playlist bersifat publik.",
      "PROVIDER_FAILED",
    );
  }

  const result = response.result;
  const items = response.result.items;
  const tracks = items.map((item, index) => {
    const parsed = parseArtistAndTitle(item.title, item.author || "");
    return buildTrack({
      entryId,
      index,
      title: item.title,
      artist: parsed.artist,
      cover: item.thumbnail,
      sourceUrl: item.url || `https://www.youtube.com/watch?v=${item.id}`,
      platform: "youtube",
      videoId: item.id || extractYouTubeVideoId(item.url),
      identity: item.id || item.url || String(index),
      needsResolve: true,
    });
  });

  return buildEntry({
    platform: "youtube-playlist",
    kind: "playlist",
    title: result.title,
    subtitle: result.author?.name
      ? `Playlist oleh ${result.author.name}`
      : "Playlist YouTube",
    cover: result.thumbnail,
    tracks,
    reportedTrackCount: result.itemCount,
    warnings: [
      "Audio setiap lagu dicari saat pertama kali diputar. Durasi mengikuti metadata file.",
    ],
  });
}

async function fetchSoundCloudMetadata(link) {
  try {
    const endpoint = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(link)}`;
    const { response } = await fetchPublicUrl(endpoint, {
      allowedHosts: HOSTS.soundcloud,
      timeout: 8000,
      maxRedirects: 2,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }

    const data = await withTimeout(
      response.json(),
      6000,
      "Metadata SoundCloud terlalu lama dibaca.",
    );
    return {
      title: typeof data?.title === "string" ? data.title : "",
      author: typeof data?.author_name === "string" ? data.author_name : "",
      cover: normalizeImageUrl(data?.thumbnail_url),
    };
  } catch {
    return null;
  }
}

async function extractSoundCloud(link, entryId) {
  const [response, oembed] = await Promise.all([
    callProvider("SoundCloud", () => soundcloud.klickaud(link)),
    fetchSoundCloudMetadata(link),
  ]);

  if (!response.ok) {
    throw new ExtractionError(
      "Lagu SoundCloud tidak dapat diproses saat ini. Coba lagi beberapa saat.",
      "PROVIDER_FAILED",
    );
  }

  const result = response.result;
  const candidates = collectAudioCandidates(result, null);
  if (candidates.length === 0) {
    throw new ExtractionError(
      "Tautan audio SoundCloud tidak ditemukan.",
      "NO_AUDIO",
    );
  }

  const parsed = parseArtistAndTitle(
    oembed?.title || result.title,
    oembed?.author || "",
  );

  return buildEntry({
    platform: "soundcloud",
    kind: "track",
    title: parsed.title || oembed?.title || result.title,
    subtitle: oembed?.author || parsed.artist || "SoundCloud",
    artist: parsed.artist || oembed?.author || "",
    cover: oembed?.cover,
    reportedTrackCount: 1,
    tracks: [
      buildTrack({
        entryId,
        index: 0,
        title: parsed.title || result.title,
        artist: parsed.artist || oembed?.author || "",
        cover: oembed?.cover,
        sourceUrl: link,
        platform: "soundcloud",
        audioCandidates: candidates.map((item) => item.url),
        identity: link,
        needsResolve: true,
      }),
    ],
    warnings: [
      "URL audio SoundCloud dapat kedaluwarsa dan akan diperbarui saat diputar.",
    ],
  });
}

async function extractBandcamp(link, entryId) {
  const response = await callProvider("Bandcamp", () =>
    bandcamp.direct(link),
  );

  if (!response.ok) {
    throw new ExtractionError(
      "Halaman Bandcamp tidak dapat dibaca. Pastikan tautan publik dan bukan halaman akun.",
      "PROVIDER_FAILED",
    );
  }

  const result = response.result;
  const sourceTracks =
    Array.isArray(result.tracks) && result.tracks.length > 0
      ? result.tracks
      : [
          {
            title: result.title,
            artist: result.artist,
            album: result.album,
            cover: result.cover,
            downloads: result.downloads,
          },
        ];

  const tracks = sourceTracks.map((track, index) => {
    const candidates = collectAudioCandidates(result, track, {
      includeResultDownloads: false,
    });
    return buildTrack({
      entryId,
      index,
      title: track.title || result.title,
      artist: track.artist || result.artist || "",
      album: track.album || result.album || "",
      cover: track.cover || result.cover,
      sourceUrl: link,
      platform: "bandcamp",
      audioCandidates: candidates.map((item) => item.url),
      identity: `${track.track_num || index}|${track.title || ""}`,
      needsResolve: candidates.length === 0,
    });
  });

  const isAlbum = result.type === "album" || tracks.length > 1;

  return buildEntry({
    platform: "bandcamp",
    kind: isAlbum ? "album" : "track",
    title: result.title,
    subtitle: result.artist ? `Bandcamp · ${result.artist}` : "Bandcamp",
    artist: result.artist || "",
    album: isAlbum ? result.title : result.album || "",
    cover: result.cover,
    tracks,
    reportedTrackCount: result.trackCount,
    warnings:
      tracks.some((track) => !track.audioUrl)
        ? ["Sebagian trek memerlukan pencarian audio saat diputar."]
        : [],
  });
}

function spotifySourceUrl(type, id) {
  if (!id) {
    return null;
  }

  return `https://open.spotify.com/${type || "track"}/${id}`;
}

function extractSpotifyType(link) {
  try {
    const path = new URL(link).pathname;
    const match = path.match(
      /\/(track|album|playlist|artist|show|episode)\/([a-zA-Z0-9]+)/,
    );
    return {
      type: match?.[1] || "track",
      id: match?.[2] || "",
    };
  } catch {
    return { type: "track", id: "" };
  }
}

async function extractSpotify(link, entryId) {
  const spotifyInfo = extractSpotifyType(link);
  const isSingleTrack = spotifyInfo.type === "track";
  const providers = isSingleTrack
    ? [
        ["Spotify Spotisaver", () => spotify.spotisaver(link)],
        ["Spotify SpotiDown", () => spotify.spotidown(link)],
        ["Spotify Spotmate", () => spotify.spotmate(link)],
      ]
    : [
        ["Spotify SpotiDown", () => spotify.spotidown(link)],
        ["Spotify Spotmate", () => spotify.spotmate(link)],
      ];

  let result = null;

  for (const [label, callback] of providers) {
    const response = await callProvider(label, callback);
    if (!response.ok) {
      continue;
    }

    if (!isSingleTrack) {
      const trackCount = Array.isArray(response.result?.tracks)
        ? response.result.tracks.length
        : 0;
      const reportedCount = Number(response.result?.trackCount);
      if (Number.isFinite(reportedCount) && reportedCount > trackCount) {
        providerLog(
          label,
          new Error(
            `Hanya ${trackCount} dari ${reportedCount} lagu yang terbaca.`,
          ),
        );
        continue;
      }
    }

    result = response.result;
    break;
  }

  if (!result) {
    throw new ExtractionError(
      isSingleTrack
        ? "Metadata Spotify tidak dapat dibaca. Coba lagi beberapa saat."
        : "Daftar lagu Spotify tidak dapat dibaca lengkap. Coba lagi beberapa saat.",
      "PROVIDER_FAILED",
    );
  }

  const isMulti =
    Array.isArray(result.tracks) &&
    result.tracks.length > 0 &&
    (result.tracks.length > 1 || spotifyInfo.type !== "track");
  const rawTracks =
    Array.isArray(result.tracks) && result.tracks.length > 0
      ? result.tracks
      : [
          {
            id: spotifyInfo.id,
            title: result.title,
            artist: result.artist,
            album: result.album,
            thumbnail: result.thumbnail,
          },
        ];
  const entryCandidates = collectAudioCandidates(result, null, {
    allowGeneric: true,
  });

  const tracks = rawTracks.map((track, index) => {
    const trackCandidates =
      index === 0
        ? entryCandidates.map((candidate) => candidate.url)
        : collectAudioCandidates(result, track, {
            allowGeneric: true,
            includeResultDownloads: false,
          }).map((candidate) => candidate.url);
    const sourceUrl =
      track.track_url ||
      spotifySourceUrl("track", track.id) ||
      (spotifyInfo.type === "track" ? link : null);
    const parsedTrack = parseArtistAndTitle(
      track.title || result.title,
      track.artist || result.artist || "",
    );

    return buildTrack({
      entryId,
      index,
      title: parsedTrack.title,
      artist: parsedTrack.artist,
      album: track.album || result.album || "",
      duration: track.duration,
      cover: track.thumbnail || result.thumbnail,
      sourceUrl,
      platform: "spotify",
      audioCandidates: trackCandidates,
      identity: track.id || track.track_url || `${index}|${track.title || ""}`,
      needsResolve: true,
    });
  });

  return buildEntry({
    platform: "spotify",
    kind: isMulti
      ? spotifyInfo.type === "album"
        ? "album"
        : "playlist"
      : "track",
    title: result.title,
    subtitle: result.artist
      ? `Spotify · ${result.artist}`
      : "Spotify",
    artist: result.artist || "",
    album: result.album || "",
    cover: result.thumbnail,
    tracks,
    warnings: [
      "Spotify tidak menyediakan stream resmi ke aplikasi pihak ketiga. Audio dicari saat lagu diputar dan dapat gagal.",
    ],
  });
}

async function fetchAppleMusic(link) {
  const response = await callProvider("Apple Music", () =>
    applemusic.aplmate(link),
  );

  if (!response.ok) {
    throw new ExtractionError(
      "Lagu Apple Music tidak dapat diproses saat ini.",
      "PROVIDER_FAILED",
    );
  }

  return response.result;
}

async function extractApple(link, entryId) {
  const result = await fetchAppleMusic(link);
  const candidates = collectAudioCandidates(result, null, {
    allowGeneric: true,
  });
  const parsed = parseArtistAndTitle(result.title);

  return buildEntry({
    platform: "apple",
    kind: "track",
    title: parsed.title || result.title,
    subtitle: parsed.artist
      ? `Apple Music · ${parsed.artist}`
      : "Apple Music",
    artist: parsed.artist,
    cover: result.thumbnail,
    reportedTrackCount: 1,
    tracks: [
      buildTrack({
        entryId,
        index: 0,
        title: parsed.title || result.title,
        artist: parsed.artist,
        sourceUrl: link,
        platform: "apple",
        audioCandidates: candidates.map((candidate) => candidate.url),
        identity: link,
        needsResolve: true,
      }),
    ],
    warnings: [
      "Ketersediaan audio Apple Music bergantung pada penyedia ekstraksi dan dapat berubah.",
    ],
  });
}

async function extractFileHost(link, entryId, method) {
  const resolveCall = resolver[method];
  if (typeof resolveCall !== "function") {
    throw new ExtractionError(
      "Resolver untuk layanan file ini tidak tersedia.",
      "UNSUPPORTED_SOURCE",
    );
  }

  const response = await callProvider(`Resolver ${method}`, () =>
    resolveCall(link),
  );

  if (!response.ok) {
    throw new ExtractionError(
      "File audio tidak dapat diambil dari layanan penyimpanan ini.",
      "PROVIDER_FAILED",
    );
  }

  const result = response.result;
  if (result.destinationUrl && result.destinationUrl !== link) {
    const nested = detectSource(result.destinationUrl);
    if (
      nested.platform !== "filehost" &&
      nested.platform !== "shortlink" &&
      nested.platform !== "direct"
    ) {
      return extractDetectedSource(
        result.destinationUrl,
        nested,
        entryId,
        1,
      );
    }
  }

  const candidates = collectAudioCandidates(result, null, {
    allowGeneric: true,
  });
  if (result.url) {
    const normalized = normalizeHttpUrl(result.url);
    if (normalized && !candidates.some((item) => item.url === normalized)) {
      candidates.unshift({ url: normalized, type: "file", quality: null });
    }
  }

  const filename = result.filename || filenameFromUrl(candidates[0]?.url || link);
  const parsed = buildFileTitle(candidates[0]?.url || link, filename);

  if (candidates.length === 0) {
    throw new ExtractionError(
      "Tautan penyimpanan tidak mengarah ke file audio.",
      "NO_AUDIO",
    );
  }

  return buildEntry({
    platform: "filehost",
    kind: "track",
    title: parsed.title,
    subtitle: method,
    artist: parsed.artist,
    reportedTrackCount: 1,
    tracks: [
      buildTrack({
        entryId,
        index: 0,
        title: parsed.title,
        artist: parsed.artist,
        sourceUrl: link,
        platform: "filehost",
        audioCandidates: candidates.map((candidate) => candidate.url),
        identity: link,
        needsResolve: true,
      }),
    ],
    warnings: [
      "Tautan unduhan dapat berubah atau memerlukan verifikasi dari penyedia file.",
    ],
  });
}

async function extractShortlink(link, entryId) {
  let response;
  try {
    const fetched = await fetchPublicUrl(link, {
      method: "GET",
      timeout: 12000,
      maxRedirects: 4,
      allowedHosts: SHORTLINK_HOSTS,
    });
    response = fetched.response;
    await response.body?.cancel().catch(() => {});

    const destination = fetched.finalUrl.href;
    if (normalizeSearchValue(destination) === normalizeSearchValue(link)) {
      throw new ExtractionError(
        "Tautan pendek tidak mengarah ke sumber yang didukung.",
        "UNSUPPORTED_SOURCE",
      );
    }

    const nested = detectSource(destination);
    return await extractDetectedSource(destination, nested, entryId, 1);
  } catch (error) {
    if (error instanceof ExtractionError || error instanceof UnsafeUrlError) {
      throw error;
    }

    throw new ExtractionError(
      "Tautan pendek tidak dapat dibuka atau mengarah ke alamat yang tidak aman.",
      "PROVIDER_FAILED",
    );
  }
}

async function extractDirect(link, entryId) {
  const probe = await probeAudioUrl(link, {
    allowOpaque: false,
    timeout: PROBE_TIMEOUT_MS,
  });

  if (!probe.ok) {
    throw new ExtractionError(
      "Tautan tidak mengembalikan media audio yang dapat diputar.",
      "NOT_AUDIO",
    );
  }

  const parsed = buildFileTitle(link, probe.filename);

  return buildEntry({
    platform: "direct",
    kind: "track",
    title: parsed.title,
    subtitle: "Audio langsung",
    artist: parsed.artist,
    reportedTrackCount: 1,
    tracks: [
      buildTrack({
        entryId,
        index: 0,
        title: parsed.title,
        artist: parsed.artist,
        sourceUrl: link,
        platform: "direct",
        audioCandidates: [probe.url || link],
        identity: link,
        needsResolve: false,
      }),
    ],
    warnings: [],
  });
}

async function extractDetectedSource(link, source, entryId, depth = 0) {
  if (depth > 1) {
    throw new ExtractionError(
      "Terlalu banyak pengalihan tautan.",
      "UNSUPPORTED_SOURCE",
    );
  }

  if (source.unsupported) {
    throw new ExtractionError(source.unsupported, "UNSUPPORTED_SOURCE");
  }

  if (source.platform === "shortlink") {
    return extractShortlink(link, entryId);
  }

  await validateSource(link, source);

  switch (source.platform) {
    case "youtube":
      return extractYoutube(link, entryId);
    case "youtube-playlist":
      return extractYoutubePlaylist(link, entryId);
    case "soundcloud":
      return extractSoundCloud(link, entryId);
    case "spotify":
      return extractSpotify(link, entryId);
    case "apple":
      return extractApple(link, entryId);
    case "bandcamp":
      return extractBandcamp(link, entryId);
    case "filehost":
      return extractFileHost(link, entryId, source.resolverMethod);
    case "direct":
      return extractDirect(link, entryId);
    default:
      throw new ExtractionError(
        "Platform tautan ini belum didukung untuk pemutaran audio.",
        "UNSUPPORTED_SOURCE",
      );
  }
}

export async function extractCatalogEntry(link) {
  const parsed = parseHttpUrl(link);
  if (!parsed) {
    throw new ExtractionError("Tautan tidak valid.", "INVALID_URL");
  }

  parsed.hash = "";
  const normalizedLink = parsed.href;
  const source = detectSource(normalizedLink);
  const entryId = entryIdForUrl(normalizedLink);

  return extractDetectedSource(normalizedLink, source, entryId);
}

function allowOpaqueForPlatform(platform) {
  return platform === "youtube" || platform === "spotify";
}

async function probeCandidates(candidates, platform) {
  const seen = new Set();
  let lastReason = "";

  for (const rawUrl of candidates) {
    const url = normalizeHttpUrl(rawUrl);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);

    const probe = await probeAudioUrl(url, {
      allowOpaque: allowOpaqueForPlatform(platform),
      timeout: PROBE_TIMEOUT_MS,
    });

    if (probe.ok) {
      return {
        ok: true,
        audioUrl: probe.url || url,
        contentType: probe.contentType,
        filename: probe.filename,
      };
    }

    lastReason = probe.reason;
  }

  return { ok: false, reason: lastReason };
}

async function providerCandidatesForTrack(track, entryLink) {
  const platform = track.platform;
  const sourceUrl = track.sourceUrl || entryLink;

  if (platform === "youtube") {
    const providers = [
      () => youtube.ytmp3(sourceUrl, "mp3"),
      () => youtube.ytmp3gg(sourceUrl, { format: "mp3" }),
    ];

    for (const callback of providers) {
      const response = await callProvider("YouTube", callback);
      if (response.ok) {
        const candidates = collectAudioCandidates(response.result, null);
        if (candidates.length > 0) {
          return candidates.map((candidate) => candidate.url);
        }
      }
    }
  }

  if (platform === "spotify" && track.sourceUrl) {
    const spotifyUrl = track.sourceUrl;
    const providers = [
      () => spotify.spotidown(spotifyUrl),
      () => spotify.spotmate(spotifyUrl),
      () => spotify.spotisaver(spotifyUrl),
    ];

    for (const callback of providers) {
      const response = await callProvider("Spotify", callback);
      if (response.ok) {
        const candidates = collectAudioCandidates(response.result, null, {
          allowGeneric: true,
        });
        if (candidates.length > 0) {
          return candidates.map((candidate) => candidate.url);
        }
      }
    }
  }

  if (platform === "soundcloud") {
    const response = await callProvider("SoundCloud", () =>
      soundcloud.klickaud(sourceUrl),
    );
    if (response.ok) {
      return collectAudioCandidates(response.result, null).map(
        (candidate) => candidate.url,
      );
    }
  }

  if (platform === "bandcamp") {
    const response = await callProvider("Bandcamp", () =>
      bandcamp.direct(sourceUrl),
    );
    if (response.ok) {
      const result = response.result;
      const sourceTrack =
        result.tracks?.find(
          (item, index) =>
            normalizeSearchValue(item.title) ===
              normalizeSearchValue(track.title) &&
            (index === track.sourceIndex ||
              normalizeSearchValue(item.artist || result.artist) ===
                normalizeSearchValue(track.artist)),
        ) ||
        result.tracks?.[track.sourceIndex] ||
        (result.tracks?.length === 1 ? result.tracks[0] : null);

      if (sourceTrack) {
        return collectAudioCandidates(result, sourceTrack, {
          includeResultDownloads: false,
        }).map((candidate) => candidate.url);
      }
    }
  }

  if (platform === "apple") {
    const result = await fetchAppleMusic(track.sourceUrl || entryLink);
    return collectAudioCandidates(result, null, { allowGeneric: true }).map(
      (candidate) => candidate.url,
    );
  }

  if (platform === "filehost") {
    const source = detectSource(entryLink);
    if (source.platform === "filehost") {
      const resolveCall = resolver[source.resolverMethod];
      if (typeof resolveCall === "function") {
        const response = await callProvider("File host", () =>
          resolveCall(entryLink),
        );
        if (response.ok) {
          const candidates = collectAudioCandidates(
            response.result,
            null,
            { allowGeneric: true },
          );
          const direct = normalizeHttpUrl(response.result.url);
          if (direct) {
            candidates.unshift({ url: direct });
          }
          return candidates.map((candidate) => candidate.url);
        }
      }
    }
  }

  return [];
}

export async function resolveTrackAudio(track, entryLink) {
  if (!track?.id) {
    throw new ExtractionError("Lagu tidak ditemukan.", "NOT_FOUND");
  }

  if (!entryLink) {
    throw new ExtractionError(
      "Sumber lagu tidak tersedia.",
      "SOURCE_NOT_FOUND",
    );
  }

  const existingCandidates = Array.isArray(track.audioCandidates)
    ? track.audioCandidates
    : track.audioUrl
      ? [track.audioUrl]
      : [];
  const existing = await probeCandidates(existingCandidates, track.platform);
  if (existing.ok) {
    return existing;
  }

  const freshCandidates = await withTimeout(
    providerCandidatesForTrack(track, entryLink),
    Math.max(SCRAPER_TIMEOUT_MS, 45000),
    "Pencarian audio terlalu lama.",
  );
  const resolved = await probeCandidates(freshCandidates, track.platform);

  if (!resolved.ok) {
    providerLog(
      `Resolve ${track.platform} (${freshCandidates.length} kandidat)`,
      new Error(
        freshCandidates.length === 0
          ? "Provider tidak mengembalikan URL audio."
          : "Semua URL audio gagal diprobe.",
      ),
    );
    throw new ExtractionError(
      "Audio lagu ini tidak tersedia saat ini. Coba lagu lain atau coba lagi nanti.",
      "AUDIO_UNAVAILABLE",
    );
  }

  return resolved;
}

export function toPublicTrack(track) {
  return {
    id: track.id,
    entryId: track.entryId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    cover: track.cover,
    platform: track.platform,
    videoId:
      track.videoId ||
      (track.platform === "youtube" || track.platform === "youtube-playlist"
        ? extractYouTubeVideoId(track.sourceUrl)
        : null),
    needsResolve: Boolean(track.needsResolve),
  };
}

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || "Sumber audio";
}

export function getEntryId(link) {
  return entryIdForUrl(link);
}
