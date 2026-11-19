import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  cn,
  formatDateTime,
  formatDuration,
  formatNumber,
  normalizeSearchValue,
  truncateText,
} from "../lib/format.js";

test("cn menggabungkan nilai yang truthy", () => {
  assert.equal(cn("a", "", null, false, "b"), "a b");
  assert.equal(cn(0, "a"), "a");
});

test("clamp membatasi nilai pada rentang", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test("formatDuration menangani menit, jam, dan nilai tidak valid", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(61), "1:01");
  assert.equal(formatDuration(3599), "59:59");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(Number.NaN), "--:--");
  assert.equal(formatDuration(-5), "--:--");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "--:--");
});

test("formatNumber memakai locale Indonesia", () => {
  assert.equal(formatNumber(1234), new Intl.NumberFormat("id-ID").format(1234));
  assert.equal(formatNumber(Number.NaN), "0");
});

test("formatDateTime mengembalikan null untuk nilai tidak valid", () => {
  assert.equal(formatDateTime(null), null);
  assert.equal(formatDateTime(""), null);
  assert.equal(formatDateTime("bukan tanggal"), null);
  assert.equal(typeof formatDateTime("2026-01-02T03:04:00Z"), "string");
});

test("normalizeSearchValue menghapus diakritik dan merapikan spasi", () => {
  assert.equal(normalizeSearchValue("  Café\tDéjà   VU "), "cafe deja vu");
  assert.equal(normalizeSearchValue(null), "");
});

test("truncateText memotong tanpa melewati batas", () => {
  assert.equal(truncateText("abcdefghij", 5), "abcd…");
  assert.equal(truncateText("short", 10), "short");
  assert.equal(truncateText("  spaced  ", 20), "spaced");
  assert.equal(truncateText("abcdef", 1), "…");
});
