import crypto from "node:crypto";

const DEFAULT_STREAM_TTL_SECONDS = 1800;
const MIN_STREAM_TTL_SECONDS = 60;
const MAX_STREAM_TTL_SECONDS = 24 * 60 * 60;
const MIN_SECRET_LENGTH = 16;

export class SourceAuthError extends Error {
  constructor(message, status = 401, code = "UNAUTHORIZED") {
    super(message);
    this.name = "SourceAuthError";
    this.status = status;
    this.code = code;
  }
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  if (first.length !== second.length) {
    return false;
  }

  return crypto.timingSafeEqual(first, second);
}

export function getSourceSecret() {
  const secret = process.env.MUSIC_SOURCE_SECRET?.trim() || "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new SourceAuthError(
      "MUSIC_SOURCE_SECRET belum diisi atau terlalu pendek.",
      500,
      "SOURCE_CONFIG",
    );
  }

  return secret;
}

export function readStreamTtlSeconds() {
  const parsed = Number.parseInt(
    process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS || "",
    10,
  );
  if (!Number.isFinite(parsed)) {
    return DEFAULT_STREAM_TTL_SECONDS;
  }

  return Math.min(
    MAX_STREAM_TTL_SECONDS,
    Math.max(MIN_STREAM_TTL_SECONDS, parsed),
  );
}

export function getSourceOrigin(request) {
  const configured = process.env.MUSIC_SOURCE_PUBLIC_URL?.trim() || "";
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return new URL(request.url).origin;
}

export function normalizeStreamMimeType(value) {
  const mimeType = String(value || "").trim().toLowerCase();
  return mimeType.startsWith("audio/") ? mimeType : "audio/mpeg";
}

function signaturePayload({ filePath, mimeType, expiresAt }) {
  return `${filePath}\n${mimeType}\n${expiresAt}`;
}

export function signStream({ filePath, mimeType, expiresAt, secret }) {
  return crypto
    .createHmac("sha256", secret)
    .update(signaturePayload({ filePath, mimeType, expiresAt }))
    .digest("hex");
}

export function createSignedStreamUrl({
  origin,
  filePath,
  mimeType,
  ttlSeconds,
  secret,
}) {
  const normalizedMimeType = normalizeStreamMimeType(mimeType);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.round(ttlSeconds)
    : DEFAULT_STREAM_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = signStream({
    filePath,
    mimeType: normalizedMimeType,
    expiresAt,
    secret,
  });
  const url = new URL("/api/source/stream", origin);
  url.searchParams.set("p", filePath);
  url.searchParams.set("m", normalizedMimeType);
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signature);

  return {
    url: url.toString(),
    expiresAt,
    mimeType: normalizedMimeType,
  };
}

export function verifyStreamSignature(searchParams, secret) {
  const filePath = String(searchParams.get("p") || "").trim();
  const mimeType = normalizeStreamMimeType(searchParams.get("m"));
  const expiresAt = Number.parseInt(searchParams.get("exp") || "", 10);
  const signature = String(searchParams.get("sig") || "").trim();

  if (
    !filePath ||
    filePath.length > 600 ||
    !Number.isFinite(expiresAt) ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    throw new SourceAuthError(
      "Signed URL tidak valid.",
      401,
      "INVALID_SIGNATURE",
    );
  }

  if (expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new SourceAuthError(
      "Signed URL sudah kedaluwarsa.",
      401,
      "EXPIRED_SIGNATURE",
    );
  }

  const expected = signStream({
    filePath,
    mimeType,
    expiresAt,
    secret,
  });

  if (!safeEqual(signature, expected)) {
    throw new SourceAuthError(
      "Tanda tangan stream tidak valid.",
      401,
      "INVALID_SIGNATURE",
    );
  }

  return { filePath, mimeType, expiresAt };
}

export function assertSourceAuthorized(request) {
  const secret = getSourceSecret();
  const header = String(request?.headers?.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match || !safeEqual(match[1].trim(), secret)) {
    throw new SourceAuthError(
      "Akses source API tidak diizinkan.",
      401,
      "UNAUTHORIZED",
    );
  }

  return secret;
}
