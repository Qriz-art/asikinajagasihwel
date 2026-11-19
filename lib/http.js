import { NextResponse } from "next/server";

export function jsonNoStore(data, options = {}) {
  const { status = 200, headers = {} } = options;
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      ...headers,
    },
  });
}

export function errorResponse(
  message,
  code = "INTERNAL_ERROR",
  status = 500,
  options = {},
) {
  return jsonNoStore(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: options.headers,
    },
  );
}

export function rateLimitResponse(result) {
  return errorResponse(
    "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.",
    "RATE_LIMITED",
    429,
    {
      headers: {
        "Retry-After": String(result.retryAfter),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}
