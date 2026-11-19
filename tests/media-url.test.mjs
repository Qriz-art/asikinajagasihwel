import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFileTitle,
  cleanDisplayTitle,
  extensionFromUrl,
  filenameFromUrl,
  hostMatches,
  isAudioFilename,
  isIpAddress,
  isLikelyAudioUrl,
  isPrivateIpAddress,
  parseArtistAndTitle,
  parseContentDispositionFilename,
  parseHttpUrl,
} from "../lib/media-url.js";

test("parseHttpUrl hanya menerima HTTP/HTTPS tanpa kredensial", () => {
  assert.equal(parseHttpUrl(" https://example.com/a ").hostname, "example.com");
  assert.equal(parseHttpUrl("http://example.com")?.protocol, "http:");
  assert.equal(parseHttpUrl("ftp://example.com"), null);
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("https://user:pass@example.com"), null);
  assert.equal(parseHttpUrl("//example.com"), null);
  assert.equal(parseHttpUrl(""), null);
  assert.equal(parseHttpUrl(null), null);
});

test("hostMatches mendukung host persis dan suffix", () => {
  assert.equal(hostMatches("Example.com.", ["example.com"]), true);
  assert.equal(hostMatches("r1.googlevideo.com", [".googlevideo.com"]), true);
  assert.equal(hostMatches("googlevideo.com", [".googlevideo.com"]), true);
  assert.equal(hostMatches("fakegooglevideo.com", [".googlevideo.com"]), false);
  assert.equal(hostMatches("example.com", []), false);
});

test("deteksi IP privat mencakup IPv4, IPv6, dan IPv4-mapped", () => {
  assert.equal(isIpAddress("8.8.8.8"), true);
  assert.equal(isIpAddress("[2606:4700:4700::1111]"), true);
  assert.equal(isIpAddress("example.com"), false);

  for (const address of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "192.0.2.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:192.168.1.1",
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }

  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
  ]) {
    assert.equal(isPrivateIpAddress(address), false, address);
  }

  assert.equal(isPrivateIpAddress("bukan-ip"), true);
});

test("util nama file menangani query, encoding, dan ekstensi audio", () => {
  assert.equal(extensionFromUrl("https://x.test/My%20Song.MP3?token=1"), "mp3");
  assert.equal(extensionFromUrl("https://x.test/stream"), "");
  assert.equal(extensionFromUrl("bukan-url"), "");

  assert.equal(filenameFromUrl("https://x.test/My%20Song.mp3?token=1"), "My Song.mp3");
  assert.equal(filenameFromUrl("bukan-url"), "audio");

  assert.equal(isAudioFilename("track.m4a"), true);
  assert.equal(isAudioFilename("cover.jpg"), false);
  assert.equal(isLikelyAudioUrl("https://x.test/a.flac?x=1"), true);
  assert.equal(isLikelyAudioUrl("https://x.test/a.txt"), false);
});

test("parseContentDispositionFilename mendukung format encoded dan quoted", () => {
  assert.equal(
    parseContentDispositionFilename("inline; filename*=UTF-8''Song%20Name.mp3"),
    "Song Name.mp3",
  );
  assert.equal(
    parseContentDispositionFilename('attachment; filename="Song Name.mp3"'),
    "Song Name.mp3",
  );
  assert.equal(
    parseContentDispositionFilename("attachment; filename=Song.mp3"),
    "Song.mp3",
  );
  assert.equal(parseContentDispositionFilename(""), "");
  assert.equal(parseContentDispositionFilename(null), "");
});

test("cleanDisplayTitle membersihkan suffix dan prefix umum", () => {
  assert.equal(cleanDisplayTitle("01 - Artis - Lagu.mp3"), "Artis - Lagu");
  assert.equal(cleanDisplayTitle("Artis_-_Lagu_KLICKAUD.mp3"), "Artis - Lagu");
  assert.equal(
    cleanDisplayTitle("Artis - Lagu_forhub_soundcloud_to_mp3.mp3"),
    "Artis - Lagu",
  );
  assert.equal(cleanDisplayTitle("", "Cadangan"), "Cadangan");
});

test("parseArtistAndTitle memisahkan artis dan judul", () => {
  assert.deepEqual(parseArtistAndTitle("Artis - Lagu"), {
    artist: "Artis",
    title: "Lagu",
  });
  assert.deepEqual(parseArtistAndTitle("Artis \u2013 Lagu"), {
    artist: "Artis",
    title: "Lagu",
  });
  assert.deepEqual(parseArtistAndTitle("Artis \u2014 Lagu"), {
    artist: "Artis",
    title: "Lagu",
  });
  assert.deepEqual(parseArtistAndTitle("A - B - C"), {
    artist: "A",
    title: "B - C",
  });
  assert.deepEqual(parseArtistAndTitle("Lagu", "Artis Cadangan"), {
    artist: "Artis Cadangan",
    title: "Lagu",
  });
});

test("buildFileTitle menggabungkan nama file dan URL", () => {
  assert.deepEqual(
    buildFileTitle("https://x.test/ignore.mp3", "Artis - Lagu.mp3"),
    { artist: "Artis", title: "Lagu" },
  );
  assert.deepEqual(buildFileTitle("https://x.test/Artis%20-%20Lagu.mp3"), {
    artist: "Artis",
    title: "Lagu",
  });
});
