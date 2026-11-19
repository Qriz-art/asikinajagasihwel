#!/usr/bin/env node
// Bot Telegram Musik-In: menerima link Spotify, mengunduh audio tiap lagu,
// lalu mengirimnya ke channel Telegram.
//
// Cara kerja:
// 1. Long-polling getUpdates (offset disimpan di data/telegram-bot-state.json).
// 2. Pesan teks yang mengandung link Spotify diproses.
// 3. extractCatalogEntry() membaca daftar lagu dari link.
// 4. resolveTrackAudio() mencari URL audio tiap lagu.
// 5. Audio diunduh lalu dikirim ke channel via sendAudio.
//
// Jalankan: node --import ./scripts/register-alias.mjs scripts/telegram-bot.mjs
//
// Catatan: Telegram hanya mengizinkan SATU konsumen getUpdates per token.
// Hentikan proses bot lain yang memakai token yang sama agar tidak terjadi
// konflik 409.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callTelegramApi,
  normalizeMessage,
  readBotToken,
  readChannelId,
  sendAudio,
  sendChatAction,
  sendMessage,
  TelegramRequestError,
} from "@/lib/telegram";
import {
  extractCatalogEntry,
  resolveTrackAudio,
} from "@/lib/scrapr-service";
import { fetchPublicUrl } from "@/lib/media-url";
import { sleep } from "@/lib/async";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "telegram-bot-state.json");
const SENT_PATH = path.join(DATA_DIR, "telegram-bot-sent.json");
const LOG_PATH = path.join(DATA_DIR, "telegram-bot-log.json");

const POLL_TIMEOUT = 30;
const MAX_TRACKS_PER_LINK = Math.max(
  1,
  Math.min(200, Number.parseInt(process.env.TELEGRAM_BOT_MAX_TRACKS || "50", 10)),
);
const MAX_FILE_BYTES =
  Math.max(
    1,
    Math.min(50, Number.parseInt(process.env.TELEGRAM_BOT_MAX_FILE_MB || "45", 10)),
  ) *
  1024 *
  1024;
const DOWNLOAD_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.TELEGRAM_BOT_DOWNLOAD_TIMEOUT_MS || "180000", 10),
);
const EXIT_WHEN_IDLE_SECONDS = readDurationFlag("--exit-when-idle", 0);
const MAX_RUNTIME_SECONDS = readDurationFlag("--max-runtime", 0);

function readDurationFlag(name, fallback = 0) {
  const inline = process.argv.find((argument) =>
    argument.startsWith(`${name}=`),
  );
  const index = process.argv.indexOf(name);
  const raw = inline
    ? inline.slice(name.length + 1)
    : index >= 0
      ? process.argv[index + 1]
      : "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SPOTIFY_URL_PATTERN =
  /https?:\/\/(?:open\.|www\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist)\/[a-zA-Z0-9]+/i;

function log(message) {
  console.log(`[telegram-bot] ${new Date().toISOString()} ${message}`);
}

function warn(message) {
  console.warn(`[telegram-bot] ${new Date().toISOString()} ${message}`);
}

function readAllowedChats() {
  const raw = process.env.TELEGRAM_BOT_ALLOWED_CHATS?.trim();
  if (!raw) {
    return null;
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function readTargetChannelId() {
  return (
    process.env.TELEGRAM_BOT_CHANNEL_ID?.trim() || readChannelId()
  );
}

function extractSpotifyLink(text) {
  const match = String(text || "").match(SPOTIFY_URL_PATTERN);
  return match ? match[0] : null;
}

function sanitizeFilename(value) {
  return String(value || "audio")
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      offset: Number.isFinite(Number(parsed.offset)) ? Number(parsed.offset) : 0,
    };
  } catch {
    return { offset: 0 };
  }
}

async function writeState(offset) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

// --- Catatan lagu yang sudah terkirim ke channel ---------------------------
// Kunci: sourceUrl track Spotify (unik per lagu). Nilai: { title, artist,
// sentAt }. Dipakai untuk melewati lagu yang sudah ada saat link yang sama
// dikirim lagi, sehingga tidak ada duplikat di channel.

async function readSentTracks() {
  try {
    const raw = await fs.readFile(SENT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSentTracks(sent) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    SENT_PATH,
    JSON.stringify(sent, null, 2),
    "utf8",
  );
}

// --- Log lagu yang berhasil dikirim ke channel -----------------------------
// Daftar kronologis (array) setiap audio yang berhasil dikirim, dengan detail
// seperti judul, artis, album, durasi, message_id, file_id, dan ukuran file.
// File ini terpisah dari telegram-bot-sent.json (map dedupe) agar mudah
// dibaca/diproses sebagai daftar.

async function readSentLog() {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendSentLog(entry) {
  const log = await readSentLog();
  log.push(entry);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(log, null, 2), "utf8");
}

function trackKey(track) {
  return String(track?.sourceUrl || track?.id || "").trim();
}

async function fetchUpdates(token, offset) {
  const body = {
    timeout: POLL_TIMEOUT,
    offset: offset || undefined,
    allowed_updates: ["message", "channel_post"],
  };

  return callTelegramApi("getUpdates", token, {
    body,
    timeoutMs: (POLL_TIMEOUT + 10) * 1000,
  });
}

function pickMessage(update) {
  return update?.message || update?.channel_post || null;
}

function messageText(message) {
  return String(message?.text || message?.caption || "").trim();
}

function messageChatId(message) {
  return String(message?.chat?.id ?? "");
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
    throw new Error(
      `Ukuran file melebihi batas ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("File audio kosong.");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `Ukuran file melebihi batas ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }

  return buffer;
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

async function processLink(link, chatId, token, channelId, runtimeExceeded) {
  const entry = await extractCatalogEntry(link);
  const sent = await readSentTracks();

  const pending = entry.tracks.filter((track) => {
    const key = trackKey(track);
    return key && !sent[key];
  });

  const tracks = pending.slice(0, MAX_TRACKS_PER_LINK);
  const skippedCount = entry.tracks.length - pending.length;
  const remainingAfterBatch = pending.length - tracks.length;

  if (tracks.length === 0) {
    await sendMessage(
      token,
      chatId,
      `✅ Semua lagu dari <b>${escapeHtml(entry.title)}</b> sudah pernah dikirim ke channel. Tidak ada yang baru.`,
    );
    return;
  }

  await sendMessage(
    token,
    chatId,
    `📥 <b>${escapeHtml(entry.title)}</b>\n` +
      `${pending.length} lagu belum terkirim, memproses ${tracks.length} sekarang` +
      (skippedCount > 0 ? ` (${skippedCount} sudah pernah dikirim, dilewati)` : "") +
      "." +
      (remainingAfterBatch > 0
        ? `\nSisa ${remainingAfterBatch} lagu setelah batch ini — kirim link ini lagi untuk melanjutkan.`
        : "") +
      "\nMulai mengunduh…",
  );

  let okCount = 0;
  let failCount = 0;
  let stopped = false;

  for (let index = 0; index < tracks.length; index += 1) {
    if (runtimeExceeded()) {
      stopped = true;
      warn("Batas runtime tercapai saat memproses link.");
      break;
    }

    const track = tracks[index];
    const label = `${track.artist ? `${track.artist} – ` : ""}${track.title}`;

    try {
      await sendChatAction(token, channelId, "upload_audio");

      const resolved = await resolveTrackAudio(track, link);
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

      const key = trackKey(track);
      if (key) {
        sent[key] = {
          title: track.title,
          artist: track.artist || "",
          sentAt: new Date().toISOString(),
        };
        await writeSentTracks(sent);
      }

            const normalized = normalizeMessage(sentMessage);
                  await appendSentLog({
                    sourceUrl: key,
                    title: track.title,
                    artist: track.artist || "",
                    album: track.album || "",
                    cover: track.cover || "",
                    duration: track.duration || 0,
                    sentAt: new Date().toISOString(),
                    messageId: normalized?.messageId || 0,
                    fileId: normalized?.media?.fileId || "",
                    fileName: normalized?.media?.fileName || filename,
                    fileSize: normalized?.media?.fileSize || buffer.length,
                    mimeType: normalized?.media?.mimeType || resolved.contentType || "audio/mpeg",
                  });

      okCount += 1;
      log(`OK (${index + 1}/${tracks.length}) ${label}`);
    } catch (error) {
      failCount += 1;
      warn(`GAGAL (${index + 1}/${tracks.length}) ${label}: ${errorMessage(error)}`);
    }

    await sleep(1500);
  }

  const remaining = pending.length - okCount;
  const summary =
    `✅ Selesai: ${okCount} lagu terkirim` +
    (failCount > 0 ? `, ${failCount} gagal` : "") +
    "." +
    (stopped
      ? " Bot berhenti karena batas waktu; kirim link ini lagi untuk melanjutkan."
      : "") +
    (remaining > 0
      ? ` Sisa ${remaining} lagu — kirim link ini lagi untuk melanjutkan.`
      : " Semua lagu sudah terkirim.");

  await sendMessage(token, chatId, summary);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function handleUpdate(
  update,
  token,
  channelId,
  allowedChats,
  runtimeExceeded,
) {
  const message = pickMessage(update);
  if (!message) {
    return;
  }

  const chatId = messageChatId(message);
  if (!chatId) {
    return;
  }

  if (allowedChats && !allowedChats.has(chatId)) {
    return;
  }

  const link = extractSpotifyLink(messageText(message));
  if (!link) {
    return;
  }

  log(`Link diterima dari ${chatId}: ${link}`);

  try {
    await sendMessage(
      token,
      chatId,
      `🔍 Memproses link Spotify…`,
    );
    await processLink(link, chatId, token, channelId, runtimeExceeded);
  } catch (error) {
    warn(`Gagal memproses ${link}: ${errorMessage(error)}`);
    await sendMessage(
      token,
      chatId,
      `❌ Gagal memproses link:\n<code>${escapeHtml(errorMessage(error))}</code>`,
    ).catch(() => {});
  }
}

async function main() {
  const token = readBotToken();
  const channelId = readTargetChannelId();
  const allowedChats = readAllowedChats();
  const startedAt = Date.now();
  let lastActivityAt = Date.now();

  const runtimeExceeded = () =>
    MAX_RUNTIME_SECONDS > 0 &&
    Date.now() - startedAt >= MAX_RUNTIME_SECONDS * 1000;
  const idleExceeded = () =>
    EXIT_WHEN_IDLE_SECONDS > 0 &&
    Date.now() - lastActivityAt >= EXIT_WHEN_IDLE_SECONDS * 1000;

  log(
    `Bot aktif. Channel tujuan: ${channelId}` +
      (allowedChats ? ` (hanya chat: ${[...allowedChats].join(", ")})` : "") +
      ` | idle-exit=${EXIT_WHEN_IDLE_SECONDS || "off"}s` +
      ` | max-runtime=${MAX_RUNTIME_SECONDS || "off"}s`,
  );

  let state = await readState();

  while (true) {
    if (runtimeExceeded()) {
      log("Batas runtime tercapai. Bot berhenti.");
      break;
    }

    try {
      const updates = await fetchUpdates(token, state.offset);

      if (updates.length > 0) {
        lastActivityAt = Date.now();
      } else if (idleExceeded()) {
        log("Tidak ada update. Bot berhenti karena idle.");
        break;
      }

      for (const update of updates) {
        const updateId = Number(update?.update_id);
        if (!Number.isFinite(updateId)) {
          continue;
        }

        state.offset = updateId + 1;

        try {
          await handleUpdate(
            update,
            token,
            channelId,
            allowedChats,
            runtimeExceeded,
          );
        } catch (error) {
          warn(`Kesalahan update ${updateId}: ${errorMessage(error)}`);
        }

        await writeState(state.offset);
      }
    } catch (error) {
      if (error instanceof TelegramRequestError && error.status === 409) {
        warn(
          "Konflik getUpdates (409): proses lain memakai token yang sama. " +
            "Hentikan proses bot lain yang memakai token ini.",
        );
        await sleep(30000);
      } else {
        warn(`getUpdates gagal: ${errorMessage(error)}`);
        await sleep(5000);
      }
    }
  }
}

main().catch((error) => {
  console.error(`[telegram-bot] Fatal: ${errorMessage(error)}`);
  process.exit(1);
});