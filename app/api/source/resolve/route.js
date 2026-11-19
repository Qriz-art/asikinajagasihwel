import {
  getFile,
  readBotToken,
  TelegramConfigurationError,
  TelegramRequestError,
} from "@/lib/telegram";
import {
  assertSourceAuthorized,
  createSignedStreamUrl,
  getSourceOrigin,
  normalizeStreamMimeType,
  readStreamTtlSeconds,
  SourceAuthError,
} from "@/lib/source-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { errorResponse, jsonNoStore, rateLimitResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request) {
  const limit = checkRateLimit(request, "source-resolve", 60, 60 * 1000);
  if (limit.limited) {
    return rateLimitResponse(limit);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 4096) {
    return errorResponse(
      "Permintaan terlalu besar.",
      "PAYLOAD_TOO_LARGE",
      413,
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(
      "Body permintaan harus berupa JSON.",
      "INVALID_JSON",
      400,
    );
  }

  const fileId =
    typeof payload?.fileId === "string" ? payload.fileId.trim() : "";
  if (!fileId || fileId.length > 500) {
    return errorResponse("ID file tidak valid.", "INVALID_FILE_ID", 400);
  }

  try {
    const secret = assertSourceAuthorized(request);
    const mimeType = normalizeStreamMimeType(payload?.mimeType);
    const file = await getFile(readBotToken(), fileId);

    if (!file?.filePath) {
      return errorResponse(
        "File audio tidak tersedia di Telegram.",
        "AUDIO_NOT_FOUND",
        404,
      );
    }

    const signed = createSignedStreamUrl({
      origin: getSourceOrigin(request),
      filePath: file.filePath,
      mimeType,
      ttlSeconds: readStreamTtlSeconds(),
      secret,
    });

    return jsonNoStore(
      {
        fileId: file.fileId,
        audioUrl: signed.url,
        expiresAt: signed.expiresAt,
        mimeType: signed.mimeType,
        fileSize: file.fileSize || 0,
      },
      {
        headers: { "X-RateLimit-Remaining": String(limit.remaining) },
      },
    );
  } catch (error) {
    if (error instanceof SourceAuthError) {
      return errorResponse(error.message, error.code, error.status);
    }

    if (error instanceof TelegramConfigurationError) {
      return errorResponse(error.message, error.code, 500);
    }

    if (error instanceof TelegramRequestError) {
      return errorResponse(error.message, error.code, error.status || 502);
    }

    console.error(
      "[Musik-Source] Resolve error:",
      error instanceof Error ? error.message : String(error),
    );
    return errorResponse(
      "Audio lagu tidak dapat disiapkan saat ini.",
      "AUDIO_UNAVAILABLE",
      503,
    );
  }
}
