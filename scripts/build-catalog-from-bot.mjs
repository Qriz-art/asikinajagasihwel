#!/usr/bin/env node
// Membangun data/catalog.json dari lagu yang sudah dikirim bot ke channel
// Telegram (data/telegram-bot-sent.json + data/telegram-bot-log.json).
//
// Alur:
// 1. Baca daftar lagu terkirim (sent + log).
// 2. Untuk lagu yang belum punya fileId (dikirim sebelum fitur log),
//    kirim ulang audio ke channel agar fileId tercatat (opsional, --resend).
// 3. Tulis data/catalog.json (entries + tracks), sehingga website bisa
//    memutar lagu via /api/resolve.
//
// Penggunaan:
//   node --import ./scripts/register-alias.mjs scripts/build-catalog-from-bot.mjs
//   node --import ./scripts/register-alias.mjs scripts/build-catalog-from-bot.mjs --resend
//   node --import ./scripts/register-alias.mjs scripts/build-catalog-from-bot.mjs --dry-run
//   node --import ./scripts/register-alias.mjs scripts/build-catalog-from-bot.mjs --covers "https://open.spotify.com/playlist/..."

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBotToken,
  readChannelId,
  sendAudio,
  sendChatAction,
  TelegramRequestError,
} from "@/lib/telegram";
import { fetchPublicUrl } from "@/lib/media-url";
import { sleep } from "@/lib/async";
import { extractCatalogEntry } from "@/lib/scrapr-service";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CATALOG_PATH = path.join(DATA_DIR, "catalog.json");
const SENT_PATH = path.join(DATA_DIR, "telegram-bot-sent.json");
const LOG_PATH = path.join(DATA_DIR, "telegram-bot-log.json");

const configuredMaxFileMb = Number.parseInt(
  process.env.TELEGRAM_BOT_MAX_FILE_MB || "45",
  10,
);
const MAX_FILE_MB = Number.isFinite(configuredMaxFileMb)
  ? Math.max(1, Math.min(50, configuredMaxFileMb))
  : 45;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180000;

function log(message) {
  console.log(`[build-catalog] ${new Date().toISOString()} ${message}`);
}

function warn(message) {
  console.warn(`[build-catalog] ${new Date().toISOString()} ${message}`);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function catalogSignature(catalog) {
  if (!catalog) {
    return "";
  }
  const { generatedAt, ...rest } = catalog;
  return stableStringify(rest);
}

function sanitizeFilename(value) {
  return String(value || "audio")
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function buildCaption(track) {
  const lines = [`🎵 ${track.title}`];
  if (track.artist) {
    lines.push(`👤 ${track.artist}`);
  }
  if (track.album) {
    lines.push(`💿 ${track.album}`);
  }
  return lines.join("\n");
}

async function downloadAudio(url) {
  const { response } = await fetchPublicUrl(url, {
    method: "GET",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 5,
  });

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_FILE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Ukuran file melebihi batas ${MAX_FILE_MB} MB.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("File audio kosong.");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`Ukuran file melebihi batas ${MAX_FILE_MB} MB.`);
  }

  return buffer;
}

// --- Kumpulkan lagu dari sent + log ---------------------------------------

function collectTracks(sent, log) {
  const byKey = new Map();

  for (const [sourceUrl, value] of Object.entries(sent || {})) {
    byKey.set(sourceUrl, {
      sourceUrl,
      title: value?.title || "",
      artist: value?.artist || "",
      album: "",
      cover: "",
      duration: 0,
      sentAt: value?.sentAt || "",
      messageId: 0,
      fileId: "",
      fileName: "",
      fileSize: 0,
      mimeType: "audio/mpeg",
    });
  }

  for (const entry of Array.isArray(log) ? log : []) {
    const key = String(entry?.sourceUrl || "").trim();
    if (!key) {
      continue;
    }
    byKey.set(key, {
      sourceUrl: key,
      title: entry?.title || "",
      artist: entry?.artist || "",
      album: entry?.album || "",
      cover: String(entry?.cover || "").trim(),
      duration: Number(entry?.duration) || 0,
      sentAt: entry?.sentAt || "",
      messageId: Number(entry?.messageId) || 0,
      fileId: String(entry?.fileId || "").trim(),
      fileName: String(entry?.fileName || "").trim(),
      fileSize: Number(entry?.fileSize) || 0,
      mimeType: String(entry?.mimeType || "audio/mpeg").trim(),
    });
  }

  return [...byKey.values()];
}

function trackIdForSourceUrl(sourceUrl) {
  const match = String(sourceUrl || "").match(/\/track\/([a-zA-Z0-9]+)/);
  return match ? `spotify-${match[1]}` : `src-${sourceUrl}`;
}

// Lengkapi fileId dari katalog lama. Log bot versi awal tidak mencatat fileId,
// padahal katalog lama bisa saja sudah punya fileId dari build sebelumnya.
// Tanpa langkah ini, lagu lama akan kehilangan fileId saat katalog dibangun ulang.
function mergeExistingCatalogData(tracks, existingCatalog) {
  const existingTracks = Array.isArray(existingCatalog?.tracks)
    ? existingCatalog.tracks
    : [];
  const byId = new Map();

  for (const entry of existingTracks) {
    const id = String(entry?.id || "").trim();
    if (id) {
      byId.set(id, entry);
    }
  }

  for (const track of tracks) {
    const existing = byId.get(trackIdForSourceUrl(track.sourceUrl));
    if (!existing) {
      continue;
    }

    if (!track.cover && existing.cover) {
      track.cover = String(existing.cover).trim();
    }

    if (track.fileId || !existing.fileId) {
      continue;
    }

    track.fileId = String(existing.fileId).trim();
    track.messageId = Number(existing.messageId) || track.messageId;
    track.fileName = String(existing.fileName || "").trim() || track.fileName;
    track.fileSize = Number(existing.fileSize) || track.fileSize;
    track.mimeType = String(existing.mimeType || "").trim() || track.mimeType;
    track.duration = Number(existing.duration) || track.duration;
  }

  return tracks;
}

function buildCatalog(tracks, generatedAt) {
  const entries = tracks.map((track, index) => ({
    id: trackIdForSourceUrl(track.sourceUrl),
    messageId: track.messageId || 0,
    title: track.title,
    artist: track.artist,
    album: track.album,
    kind: "audio",
    duration: track.duration,
    cover: track.cover || null,
    fileId: track.fileId,
    mimeType: track.mimeType,
    fileSize: track.fileSize,
    fileName: track.fileName,
    caption: `${track.artist ? `${track.artist} - ` : ""}${track.title}`,
    postedAt: track.sentAt ? new Date(track.sentAt).getTime() : 0,
    active: true,
  }));

  const tracksOut = entries.map((entry) => ({
    id: entry.id,
    entryId: entry.id,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    duration: entry.duration,
    cover: entry.cover,
    platform: "telegram",
    needsResolve: true,
    fileId: entry.fileId,
    mimeType: entry.mimeType,
    fileSize: entry.fileSize,
    fileName: entry.fileName,
    caption: entry.caption,
    messageId: entry.messageId,
    postedAt: entry.postedAt,
  }));

  return {
    version: 1,
    source: "telegram",
    generatedAt,
    stats: {
      totalEntries: entries.length,
      totalTracks: tracksOut.length,
      audioEntries: entries.length,
      fileEntries: 0,
      photoEntries: 0,
      videoEntries: 0,
      voiceEntries: 0,
      videoNoteEntries: 0,
    },
    entries,
    tracks: tracksOut,
  };
}

// --- Kirim ulang lagu yang belum punya fileId ------------------------------

async function resendMissing(tracks, token, channelId) {
  const missing = tracks.filter((track) => !track.fileId);
  if (missing.length === 0) {
    log("Semua lagu sudah punya fileId. Tidak ada yang perlu dikirim ulang.");
    return tracks;
  }

  log(`Mengirim ulang ${missing.length} lagu yang belum punya fileId…`);

  for (let index = 0; index < missing.length; index += 1) {
    const track = missing[index];
    const label = `${track.artist ? `${track.artist} – ` : ""}${track.title}`;

    try {
      await sendChatAction(token, channelId, "upload_audio");

      // Coba resolve dari sourceUrl Spotify (provider scrapr).
      const { resolveTrackAudio } = await import("@/lib/scrapr-service");
      const resolved = await resolveTrackAudio(
        { id: track.sourceUrl, sourceUrl: track.sourceUrl, platform: "spotify" },
        track.sourceUrl,
      );
      const buffer = await downloadAudio(resolved.audioUrl);

      const filename = sanitizeFilename(
        `${track.artist ? `${track.artist} - ` : ""}${track.title}.mp3`,
      );
      const blob = new Blob([buffer], {
        type: resolved.contentType || "audio/mpeg",
      });

      const sentMessage = await sendAudio(token, channelId, blob, {
        filename,
        title: track.title,
        performer: track.artist || "",
        caption: buildCaption(track),
        duration: track.duration || undefined,
        timeoutMs: 300000,
      });

      const fileId = sentMessage?.audio?.file_id || "";
      const messageId = Number(sentMessage?.message_id) || 0;
      const fileSize = Number(sentMessage?.audio?.file_size) || buffer.length;

      track.fileId = fileId;
      track.messageId = messageId;
      track.fileSize = fileSize;
      track.fileName = filename;
      track.mimeType = resolved.contentType || "audio/mpeg";

      log(`OK (${index + 1}/${missing.length}) ${label} → fileId ${fileId}`);
    } catch (error) {
      warn(
        `GAGAL (${index + 1}/${missing.length}) ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await sleep(1500);
  }

  return tracks;
}

async function attachCovers(tracks, link) {
  log(`Mengambil cover dari ${link}…`);
  const entry = await extractCatalogEntry(link);
  const covers = new Map();

  for (const track of entry.tracks) {
    const id = trackIdForSourceUrl(track.sourceUrl);
    const cover = String(track.cover || "").trim();
    if (id && cover) {
      covers.set(id, cover);
    }
  }

  let updated = 0;
  let missing = 0;

  for (const track of tracks) {
    const cover = covers.get(trackIdForSourceUrl(track.sourceUrl));
    if (!cover) {
      missing += 1;
      continue;
    }

    if (track.cover !== cover) {
      track.cover = cover;
      updated += 1;
    }
  }

  log(
    `Cover ditemukan: ${covers.size}, diperbarui: ${updated}, tanpa cover: ${missing}.`,
  );
  return tracks;
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const resend = args.includes("--resend");
  const coverIndex = args.indexOf("--covers");
  const coverSource =
    coverIndex >= 0 ? String(args[coverIndex + 1] || "").trim() : "";

  if (coverIndex >= 0 && !coverSource) {
    throw new Error("Opsi --covers membutuhkan URL playlist/album Spotify.");
  }

  const token = resend ? readBotToken() : "";
  const channelId = resend ? readChannelId() : "";

  const sent = await readJson(SENT_PATH, {});
  const sentLog = await readJson(LOG_PATH, []);
  const existingCatalog = await readJson(CATALOG_PATH, null);
  let tracks = mergeExistingCatalogData(
    collectTracks(sent, sentLog),
    existingCatalog,
  );

  log(`Ditemukan ${tracks.length} lagu dari data bot.`);

  if (coverSource) {
    tracks = await attachCovers(tracks, coverSource);
  }

  if (dryRun) {
    log("Mode dry-run: tidak ada perubahan yang ditulis.");
    for (const track of tracks) {
      console.log(
        `  - ${track.artist ? `${track.artist} – ` : ""}${track.title}` +
          (track.fileId ? " [fileId OK]" : " [belum ada fileId]"),
      );
    }
    return;
  }

  if (resend) {
    tracks = await resendMissing(tracks, token, channelId);
  }

  const missing = tracks.filter((track) => !track.fileId).length;
  if (missing > 0) {
    warn(
      `${missing} lagu belum punya fileId dan tidak bisa diputar. ` +
        "Jalankan dengan --resend untuk mengirim ulang otomatis.",
    );
  }

  const catalog = buildCatalog(tracks, new Date().toISOString());

  if (
    existingCatalog &&
    catalogSignature(existingCatalog) === catalogSignature(catalog)
  ) {
    log("Katalog tidak berubah. Tidak ada file yang ditulis.");
    return;
  }

  await writeJson(CATALOG_PATH, catalog);

  log(
    `Katalog ditulis: ${catalog.stats.totalTracks} lagu → ${CATALOG_PATH}` +
      (missing > 0 ? ` (${missing} tanpa fileId)` : ""),
  );
}

main().catch((error) => {
  warn(`Gagal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});