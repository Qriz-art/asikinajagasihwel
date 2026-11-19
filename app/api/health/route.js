import { jsonNoStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return jsonNoStore({
    ok: true,
    service: "musik-source",
    time: new Date().toISOString(),
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    authConfigured: Boolean(process.env.MUSIC_SOURCE_SECRET?.trim()),
  });
}
