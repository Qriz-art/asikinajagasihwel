#!/usr/bin/env node
// Menampilkan daftar lagu yang berhasil dikirim ke channel Telegram
// dari data/telegram-bot-log.json.
//
// Penggunaan:
//   node scripts/telegram-bot-log.mjs            # semua entri
//   node scripts/telegram-bot-log.mjs --limit 10 # 10 entri terbaru
//   node scripts/telegram-bot-log.mjs --json     # output JSON mentah
//   node scripts/telegram-bot-log.mjs --search "tulus" # cari judul/artis

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, "..", "data", "telegram-bot-log.json");

function parseArgs(argv) {
  const args = { limit: Infinity, json: false, search: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--limit") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(value) && value > 0) {
        args.limit = value;
        i += 1;
      }
    } else if (arg === "--search") {
      args.search = String(argv[i + 1] || "").toLowerCase();
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) {
    return "-";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readLog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`File log tidak ditemukan: ${LOG_PATH}`);
      console.error("Jalankan bot dulu (npm run bot) agar log terisi.");
    } else {
      console.error(`Gagal membaca log: ${error.message}`);
    }
    process.exit(1);
  }
}

function printTable(entries) {
  if (entries.length === 0) {
    console.log("Belum ada lagu yang tercatat di log.");
    return;
  }

  const rows = entries.map((entry, index) => {
    const no = String(index + 1);
    const title = entry.title || "-";
    const artist = entry.artist || "-";
    const sentAt = formatDate(entry.sentAt);
    const messageId = entry.messageId ? String(entry.messageId) : "-";
    const fileSize = formatBytes(entry.fileSize);
    return { no, title, artist, sentAt, messageId, fileSize };
  });

  const widths = {
    no: Math.max(2, ...rows.map((r) => r.no.length)),
    title: Math.max(5, ...rows.map((r) => r.title.length)),
    artist: Math.max(6, ...rows.map((r) => r.artist.length)),
    sentAt: Math.max(7, ...rows.map((r) => r.sentAt.length)),
    messageId: Math.max(10, ...rows.map((r) => r.messageId.length)),
    fileSize: Math.max(9, ...rows.map((r) => r.fileSize.length)),
  };

  const pad = (value, width) => String(value).padEnd(width);
  const line = (row) =>
    ` ${pad(row.no, widths.no)} │ ${pad(row.title, widths.title)} │ ` +
    `${pad(row.artist, widths.artist)} │ ${pad(row.sentAt, widths.sentAt)} │ ` +
    `${pad(row.messageId, widths.messageId)} │ ${pad(row.fileSize, widths.fileSize)} `;

  const header = line({
    no: "No",
    title: "Judul",
    artist: "Artis",
    sentAt: "Waktu",
    messageId: "Message ID",
    fileSize: "Ukuran",
  });
  const separator = ` ${"-".repeat(widths.no)}─┼─${"-".repeat(widths.title)}─┼─` +
    `${"-".repeat(widths.artist)}─┼─${"-".repeat(widths.sentAt)}─┼─` +
    `${"-".repeat(widths.messageId)}─┼─${"-".repeat(widths.fileSize)} `;

  console.log(header);
  console.log(separator);
  for (const row of rows) {
    console.log(line(row));
  }
  console.log(`\nTotal: ${entries.length} lagu`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Penggunaan: node scripts/telegram-bot-log.mjs [opsi]
  --limit <n>     Tampilkan n entri terbaru
  --search <teks> Cari berdasarkan judul/artis (tidak peka huruf besar)
  --json          Tampilkan JSON mentah
  --help          Bantuan ini`);
    return;
  }

  let entries = readLog();

  if (args.search) {
    entries = entries.filter(
      (entry) =>
        String(entry.title || "").toLowerCase().includes(args.search) ||
        String(entry.artist || "").toLowerCase().includes(args.search),
    );
  }

  if (Number.isFinite(args.limit) && args.limit < entries.length) {
    entries = entries.slice(entries.length - args.limit);
  }

  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  printTable(entries);
}

main();