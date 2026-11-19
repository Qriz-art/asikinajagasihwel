const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export const YOUTUBE_PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
};

function hostIsYoutube(host) {
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

export function extractYouTubeVideoId(value) {
  const input = String(value || "").trim();
  if (!input) {
    return null;
  }

  if (VIDEO_ID_PATTERN.test(input)) {
    return input;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    return VIDEO_ID_PATTERN.test(id || "") ? id : null;
  }

  if (!hostIsYoutube(host)) {
    return null;
  }

  const queryId = parsed.searchParams.get("v");
  if (VIDEO_ID_PATTERN.test(queryId || "")) {
    return queryId;
  }

  const pathMatch = parsed.pathname.match(
    /\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})(?:[/?]|$)/,
  );
  return pathMatch ? pathMatch[1] : null;
}

let youtubeApiPromise = null;

function waitForYouTubeApi(timeoutMs = 15000) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube hanya tersedia di browser."));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (window.YT?.Player) {
        clearInterval(timer);
        resolve(window.YT);
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("YouTube API terlalu lama dimuat."));
      }
    }, 100);
  });
}

export function loadYouTubeIframeApi() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube hanya tersedia di browser."));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(
      'script[data-ongaku-youtube-api="true"]',
    );
    const previousReady = window.onYouTubeIframeAPIReady;
    const timeoutId = setTimeout(() => {
      reject(new Error("YouTube API gagal dimuat."));
    }, 15000);

    window.onYouTubeIframeAPIReady = () => {
      try {
        if (typeof previousReady === "function") {
          previousReady();
        }
      } catch {
        // Ignore errors from other listeners.
      }

      if (window.YT?.Player) {
        clearTimeout(timeoutId);
        resolve(window.YT);
      }
    };

    if (existing) {
      waitForYouTubeApi()
        .then((api) => {
          clearTimeout(timeoutId);
          resolve(api);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.dataset.ongakuYoutubeApi = "true";
    script.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error("YouTube API gagal dimuat."));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    youtubeApiPromise = null;
    throw error;
  });

  return youtubeApiPromise;
}
