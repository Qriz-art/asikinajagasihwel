# Musik-In Source

Repo sumber untuk Musik-In: bot Telegram, katalog lagu, dan API audio bertanda tangan. Repo ini tidak memiliki UI pemutar; UI berada di repo `musik-in`.

## Arsitektur

- GitHub Actions menjalankan bot 4x sehari, membangun `data/catalog.json`, lalu commit perubahan `data/`.
- Vercel `musik-source` hanya menjalankan API. API tidak membaca katalog, jadi perubahan data tidak memicu redeploy API.
- Viewer mengambil katalog dari `https://raw.githubusercontent.com/Qriz-art/musik-in-v1/main/data/catalog.json`.
- Saat lagu diputar, viewer meminta signed URL ke API ini. Token Telegram tetap berada di server source.

## API

- `POST /api/source/resolve`
  - Header: `Authorization: Bearer <MUSIC_SOURCE_SECRET>`
  - Body: `{ "fileId": "...", "mimeType": "audio/mpeg" }`
  - Respons: `{ fileId, audioUrl, expiresAt, mimeType, fileSize }`
- `GET` / `HEAD /api/source/stream?p=...&m=...&exp=...&sig=...`
  - Meneruskan `Range` dan `HEAD` ke Telegram.
  - Signature HMAC-SHA256, berlaku 30 menit secara default.
- `GET /api/health`
  - Status konfigurasi tanpa membocorkan secret.

## Environment

Isi `.env.local` untuk lokal dan Environment Variables Vercel untuk source API.

- `TELEGRAM_BOT_TOKEN`: token bot dari BotFather.
- `TELEGRAM_CHANNEL_ID`: channel tujuan upload.
- `TELEGRAM_BOT_CHANNEL_ID`: opsional, channel yang dipantau bot.
- `TELEGRAM_BOT_ALLOWED_CHATS`: opsional, daftar chat ID dipisahkan koma.
- `TELEGRAM_BOT_MAX_TRACKS`: default 50.
- `TELEGRAM_BOT_MAX_FILE_MB`: default 45.
- `TELEGRAM_BOT_DOWNLOAD_TIMEOUT_MS`: default 180000.
- `MUSIC_SOURCE_SECRET`: minimal 16 karakter; gunakan `openssl rand -hex 32`.
- `MUSIC_SOURCE_PUBLIC_URL`: URL publik Vercel source.
- `MUSIC_SOURCE_STREAM_URL_TTL_SECONDS`: default 1800.

Nilai `MUSIC_SOURCE_SECRET` harus sama dengan yang dipakai viewer.

## Lokal

```powershell
npm install
Copy-Item .env.example .env.local
npm run bot
npm run catalog
npm run dev
```

Bot bisa dibatasi agar cocok untuk GitHub Actions:

```powershell
npm run bot:once
```

Itu sama dengan menjalankan `telegram-bot.mjs --exit-when-idle=300 --max-runtime=4800`.

Builder katalog:

```powershell
npm run catalog
npm run catalog:resend
```

`--resend` hanya diperlukan untuk lagu lama yang belum punya `fileId`.

## GitHub Actions

Workflow `.github/workflows/telegram-bot.yml` berjalan pada:

```text
17 1,5,9,13 * * *
```

Itu berarti 08:17, 12:17, 16:17, dan 20:17 WIB. Workflow juga bisa dijalankan manual.

Secrets yang dibutuhkan:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- `TELEGRAM_BOT_CHANNEL_ID` (opsional)
- `TELEGRAM_BOT_ALLOWED_CHATS` (opsional)

Workflow memakai `concurrency: telegram-bot` agar bot tidak berjalan bersamaan. Jangan jalankan bot lokal dengan token yang sama saat workflow aktif.

## Vercel

Project Vercel source disarankan API-only dan memakai Node.js runtime. Atur Ignored Build Step:

```text
bash scripts/vercel-ignore-source.sh
```

Script melewati build bila commit hanya mengubah `data/`, workflow, atau dokumentasi. Perubahan kode tetap memicu build.

Vercel Hobby membatasi durasi function maksimal 300 detik. Lagu yang lebih panjang dari batas tersebut berisiko terputus; fallback ke Cloudflare Worker bisa ditambahkan nanti.

## Menambah Lagu

1. Kirim link Spotify ke bot.
2. Bot mengunggah audio ke Telegram dan mencatat `data/telegram-bot-log.json`, `data/telegram-bot-sent.json`, dan state offset.
3. Workflow menjalankan builder untuk memperbarui `data/catalog.json`.
4. Perubahan `data/` di-commit ke repo ini.
5. Viewer mengambil katalog terbaru dari raw GitHub. Tidak perlu deploy ulang viewer atau source API.

## Catatan

- Repo source sebaiknya publik agar raw catalog dan GitHub Actions gratis. Workflow terjadwal di repo publik bisa dinonaktifkan GitHub setelah 60 hari tanpa aktivitas.
- Jangan pernah menaruh token Telegram di viewer atau variabel `NEXT_PUBLIC_*`.
- Signed URL hanya untuk stream; jangan menganggapnya sebagai pengganti autentikasi viewer.
