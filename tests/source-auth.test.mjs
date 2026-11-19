import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSourceAuthorized,
  createSignedStreamUrl,
  getSourceSecret,
  normalizeStreamMimeType,
  readStreamTtlSeconds,
  signStream,
  SourceAuthError,
  verifyStreamSignature,
} from "../lib/source-auth.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const FILE_PATH = "music/file_123.mp3";
const MIME_TYPE = "audio/mpeg";

function signedParams(overrides = {}) {
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const filePath = overrides.filePath || FILE_PATH;
  const mimeType = overrides.mimeType || MIME_TYPE;
  const secret = overrides.secret || SECRET;
  const signature =
    overrides.signature ||
    signStream({ filePath, mimeType, expiresAt, secret });

  return new URLSearchParams({
    p: filePath,
    m: mimeType,
    exp: String(overrides.expiresAt || expiresAt),
    sig: signature,
  });
}

test("signature stream yang valid diterima", () => {
  const params = signedParams();
  const result = verifyStreamSignature(params, SECRET);

  assert.equal(result.filePath, FILE_PATH);
  assert.equal(result.mimeType, MIME_TYPE);
  assert.equal(result.expiresAt, Number(params.get("exp")));
});

test("signature dengan secret atau isi berbeda ditolak", () => {
  assert.throws(
    () => verifyStreamSignature(signedParams(), `${SECRET}-lain`),
    (error) =>
      error instanceof SourceAuthError && error.code === "INVALID_SIGNATURE",
  );

  const tampered = signedParams();
  tampered.set("p", "music/file_lain.mp3");

  assert.throws(
    () => verifyStreamSignature(tampered, SECRET),
    (error) =>
      error instanceof SourceAuthError && error.code === "INVALID_SIGNATURE",
  );
});

test("signature kedaluwarsa ditolak", () => {
  const expiresAt = Math.floor(Date.now() / 1000) - 10;
  const signature = signStream({
    filePath: FILE_PATH,
    mimeType: MIME_TYPE,
    expiresAt,
    secret: SECRET,
  });
  const params = new URLSearchParams({
    p: FILE_PATH,
    m: MIME_TYPE,
    exp: String(expiresAt),
    sig: signature,
  });

  assert.throws(
    () => verifyStreamSignature(params, SECRET),
    (error) =>
      error instanceof SourceAuthError && error.code === "EXPIRED_SIGNATURE",
  );
});

test("parameter signature yang tidak lengkap ditolak", () => {
  assert.throws(
    () => verifyStreamSignature(new URLSearchParams(), SECRET),
    (error) =>
      error instanceof SourceAuthError && error.code === "INVALID_SIGNATURE",
  );
});

test("createSignedStreamUrl menghasilkan URL yang bisa diverifikasi", () => {
  const signed = createSignedStreamUrl({
    origin: "https://musik-source.test",
    filePath: FILE_PATH,
    mimeType: "application/octet-stream",
    ttlSeconds: 60,
    secret: SECRET,
  });
  const url = new URL(signed.url);

  assert.equal(url.origin, "https://musik-source.test");
  assert.equal(url.pathname, "/api/source/stream");
  assert.equal(url.searchParams.get("p"), FILE_PATH);
  assert.equal(url.searchParams.get("m"), MIME_TYPE);

  const result = verifyStreamSignature(url.searchParams, SECRET);
  assert.equal(result.filePath, FILE_PATH);
  assert.equal(result.expiresAt, signed.expiresAt);
});

test("mime type selain audio memakai audio/mpeg", () => {
  assert.equal(normalizeStreamMimeType("application/octet-stream"), "audio/mpeg");
  assert.equal(normalizeStreamMimeType("AUDIO/MP4"), "audio/mp4");
  assert.equal(normalizeStreamMimeType(""), "audio/mpeg");
});

test("assertSourceAuthorized menerima Bearer yang benar", () => {
  const previous = process.env.MUSIC_SOURCE_SECRET;
  process.env.MUSIC_SOURCE_SECRET = SECRET;

  try {
    const request = new Request("https://musik-source.test/api/source/resolve", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(assertSourceAuthorized(request), SECRET);

    const wrong = new Request("https://musik-source.test/api/source/resolve", {
      headers: { Authorization: "Bearer salah" },
    });
    assert.throws(
      () => assertSourceAuthorized(wrong),
      (error) =>
        error instanceof SourceAuthError && error.code === "UNAUTHORIZED",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MUSIC_SOURCE_SECRET;
    } else {
      process.env.MUSIC_SOURCE_SECRET = previous;
    }
  }
});

test("secret yang terlalu pendek ditolak", () => {
  const previous = process.env.MUSIC_SOURCE_SECRET;
  process.env.MUSIC_SOURCE_SECRET = "pendek";

  try {
    assert.throws(
      () => getSourceSecret(),
      (error) =>
        error instanceof SourceAuthError && error.code === "SOURCE_CONFIG",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MUSIC_SOURCE_SECRET;
    } else {
      process.env.MUSIC_SOURCE_SECRET = previous;
    }
  }
});

test("TTL stream dibatasi pada rentang yang aman", () => {
  const previous = process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS;
  process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS = "5";
  assert.equal(readStreamTtlSeconds(), 60);

  process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS = "999999";
  assert.equal(readStreamTtlSeconds(), 86400);

  try {
    delete process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS;
    assert.equal(readStreamTtlSeconds(), 1800);
  } finally {
    if (previous === undefined) {
      delete process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS;
    } else {
      process.env.MUSIC_SOURCE_STREAM_URL_TTL_SECONDS = previous;
    }
  }
});
