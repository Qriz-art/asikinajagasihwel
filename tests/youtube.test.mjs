import test from "node:test";
import assert from "node:assert/strict";
import { extractYouTubeVideoId } from "../lib/youtube.js";

test("extractYouTubeVideoId menerima ID video langsung", () => {
  assert.equal(extractYouTubeVideoId(" dQw4w9WgXcQ "), "dQw4w9WgXcQ");
});

test("extractYouTubeVideoId membaca format watch, youtu.be, shorts, dan music", () => {
  const expected = "dQw4w9WgXcQ";
  const urls = [
    `https://www.youtube.com/watch?v=${expected}`,
    `https://youtu.be/${expected}?si=abc`,
    `https://youtube.com/shorts/${expected}`,
    `https://www.youtube.com/embed/${expected}`,
    `https://www.youtube.com/live/${expected}`,
    `https://music.youtube.com/watch?v=${expected}&list=RD123`,
    `https://music.youtube.com/playlist?list=RDCLAK5uy`,
  ];

  for (const url of urls.slice(0, 6)) {
    assert.equal(extractYouTubeVideoId(url), expected, url);
  }

  assert.equal(extractYouTubeVideoId(urls[6]), null);
});

test("extractYouTubeVideoId menolak host dan ID yang tidak valid", () => {
  assert.equal(extractYouTubeVideoId(""), null);
  assert.equal(extractYouTubeVideoId("bukan url"), null);
  assert.equal(
    extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"),
    null,
  );
  assert.equal(
    extractYouTubeVideoId("https://www.youtube.com/watch?v=pendek"),
    null,
  );
});
