import {
  buildFileUrl,
  readBotToken,
  TelegramConfigurationError,
  TelegramRequestError,
} from "@/lib/telegram";
import {
  getSourceSecret,
  SourceAuthError,
  verifyStreamSignature,
} from "@/lib/source-auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Type",
};

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

async function handleStream(request) {
  const isHead = request.method === "HEAD";

  try {
    const secret = getSourceSecret();
    const signed = verifyStreamSignature(
      new URL(request.url).searchParams,
      secret,
    );
    const upstreamUrl = buildFileUrl(readBotToken(), signed.filePath);
    const range = request.headers.get("range");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 295000);
    timeout.unref?.();

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "GET",
        headers: range ? { Range: range } : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

    if (upstream.status === 404 || upstream.status === 410) {
      await upstream.body?.cancel().catch(() => {});
      return errorResponse(
        "Audio tidak ditemukan di Telegram.",
        "AUDIO_NOT_FOUND",
        404,
        { headers: CORS_HEADERS },
      );
    }

    if (upstream.status !== 200 && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => {});
      return errorResponse(
        "Sumber audio sedang tidak tersedia.",
        "AUDIO_UNAVAILABLE",
        502,
        { headers: CORS_HEADERS },
      );
    }

    const headers = new Headers(CORS_HEADERS);
    const upstreamType = upstream.headers.get("content-type") || "";
    headers.set(
      "Content-Type",
      upstreamType.startsWith("audio/") ||
        upstreamType.startsWith("multipart/byteranges")
        ? upstreamType
        : signed.mimeType,
    );
    headers.set("Cache-Control", "private, no-store");
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
    headers.set("Content-Disposition", "inline");
    headers.set("X-Content-Type-Options", "nosniff");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) {
      headers.set("Content-Range", contentRange);
    }

    if (isHead) {
      clearTimeout(timeout);
      await upstream.body?.cancel().catch(() => {});
      return new Response(null, {
        status: upstream.status,
        headers,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    if (error instanceof SourceAuthError) {
      return errorResponse(error.message, error.code, error.status, {
        headers: CORS_HEADERS,
      });
    }

    if (error instanceof TelegramConfigurationError) {
      return errorResponse(error.message, error.code, 500, {
        headers: CORS_HEADERS,
      });
    }

    if (error instanceof TelegramRequestError) {
      return errorResponse(error.message, error.code, error.status || 502, {
        headers: CORS_HEADERS,
      });
    }

    if (error?.name === "AbortError") {
      return errorResponse(
        "Stream audio melebihi batas waktu.",
        "STREAM_TIMEOUT",
        504,
        { headers: CORS_HEADERS },
      );
    }

    console.error(
      "[Musik-Source] Stream error:",
      error instanceof Error ? error.message : String(error),
    );
    return errorResponse(
      "Stream audio tidak dapat dimuat saat ini.",
      "STREAM_UNAVAILABLE",
      502,
      { headers: CORS_HEADERS },
    );
  }
}

export function GET(request) {
  return handleStream(request);
}

export function HEAD(request) {
  return handleStream(request);
}
