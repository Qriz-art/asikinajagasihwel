import dns from "node:dns/promises";
import net from "node:net";

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "m4b",
  "aac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "flac",
  "mp2",
  "weba",
]);

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

const blockedAddresses = new net.BlockList();
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.0.0.0", 24, "ipv4");
blockedAddresses.addSubnet("192.0.2.0", 24, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedAddresses.addSubnet("198.18.0.0", 15, "ipv4");
blockedAddresses.addSubnet("198.51.100.0", 24, "ipv4");
blockedAddresses.addSubnet("203.0.113.0", 24, "ipv4");
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedAddresses.addSubnet("240.0.0.0", 4, "ipv4");
blockedAddresses.addAddress("255.255.255.255", "ipv4");
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("ff00::", 8, "ipv6");
blockedAddresses.addSubnet("2001:db8::", 32, "ipv6");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export class UnsafeUrlError extends Error {
  constructor(message = "Alamat tautan tidak aman.") {
    super(message);
    this.name = "UnsafeUrlError";
    this.code = "UNSAFE_URL";
  }
}

export function parseHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    if (parsed.username || parsed.password) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function hostMatches(hostname, patterns = []) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) => {
    const normalized = String(pattern).toLowerCase();
    if (normalized.startsWith(".")) {
      return host.endsWith(normalized) || host === normalized.slice(1);
    }
    return host === normalized;
  });
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host)) {
    return true;
  }

  return (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  );
}

export function isIpAddress(value) {
  return net.isIP(String(value || "").replace(/^\[|\]$/g, "")) !== 0;
}

export function isPrivateIpAddress(address) {
  const normalizedAddress = String(address || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(normalizedAddress);
  if (family === 4) {
    return blockedAddresses.check(normalizedAddress, "ipv4");
  }

  if (family === 6) {
    const normalized = normalizedAddress.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice(7);
      if (net.isIP(mapped) === 4) {
        return blockedAddresses.check(mapped, "ipv4");
      }
    }

    return blockedAddresses.check(normalized, "ipv6");
  }

  return true;
}

export async function assertPublicHttpUrl(rawUrl, options = {}) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    throw new UnsafeUrlError("Gunakan tautan HTTP atau HTTPS yang valid.");
  }

  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new UnsafeUrlError("Port tautan tidak diizinkan.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || isBlockedHostname(hostname)) {
    throw new UnsafeUrlError("Host tautan tidak diizinkan.");
  }

  if (options.allowedHosts?.length && !hostMatches(hostname, options.allowedHosts)) {
    throw new UnsafeUrlError("Sumber tautan tidak termasuk platform yang didukung.");
  }

  if (isIpAddress(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new UnsafeUrlError("Alamat jaringan privat tidak diizinkan.");
    }
    return parsed;
  }

  if (options.skipDns === true) {
    return parsed;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("Host tautan tidak dapat diverifikasi.");
  }

  if (!addresses.length) {
    throw new UnsafeUrlError("Host tautan tidak dapat diverifikasi.");
  }

  for (const entry of addresses) {
    if (isPrivateIpAddress(entry.address)) {
      throw new UnsafeUrlError("Alamat jaringan privat tidak diizinkan.");
    }
  }

  return parsed;
}

export async function fetchPublicUrl(rawUrl, options = {}) {
  const {
    method = "GET",
    headers = {},
    timeout = 10000,
    maxRedirects = 3,
    signal,
    allowedHosts,
    body,
  } = options;

  let current = await assertPublicHttpUrl(rawUrl, { allowedHosts });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const abortHandler = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  try {
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const response = await fetch(current.href, {
        method,
        headers: {
          "User-Agent": USER_AGENT,
          ...headers,
        },
        body,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === maxRedirects) {
          throw new UnsafeUrlError("Terlalu banyak pengalihan tautan.");
        }

        const nextUrl = new URL(location, current).href;
        current = await assertPublicHttpUrl(nextUrl);
        continue;
      }

      return { response, finalUrl: current };
    }

    throw new UnsafeUrlError("Terlalu banyak pengalihan tautan.");
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

export function extensionFromUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

export function filenameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts.at(-1) || "") || parsed.hostname;
  } catch {
    return "audio";
  }
}

export function isAudioFilename(filename) {
  const match = String(filename || "").match(/\.([a-zA-Z0-9]{2,5})(?:\?.*)?$/);
  return Boolean(match && AUDIO_EXTENSIONS.has(match[1].toLowerCase()));
}

export function isLikelyAudioUrl(rawUrl) {
  return AUDIO_EXTENSIONS.has(extensionFromUrl(rawUrl));
}

export function parseContentDispositionFilename(value) {
  if (!value) {
    return "";
  }

  const encodedMatch = value.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encodedMatch) {
    try {
      return decodeURIComponent(encodedMatch[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      return encodedMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch ? plainMatch[1].trim() : "";
}

function contentTypeIsAudio(contentType, { allowOpaque, filename, finalUrl }) {
  const type = String(contentType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  if (!type) {
    return allowOpaque || isAudioFilename(filename) || isLikelyAudioUrl(finalUrl);
  }

  if (type.startsWith("audio/")) {
    return true;
  }

  if (
    type === "application/ogg" ||
    type === "application/x-ogg" ||
    type === "application/mp3" ||
    type === "application/mpeg"
  ) {
    return true;
  }

  if (type === "application/octet-stream" || type === "binary/octet-stream") {
    return Boolean(
      allowOpaque || isAudioFilename(filename) || isLikelyAudioUrl(finalUrl),
    );
  }

  return false;
}

function evaluateAudioResponse(response, finalUrl, allowOpaque) {
  const contentType = response.headers.get("content-type") || "";
  const dispositionFilename = parseContentDispositionFilename(
    response.headers.get("content-disposition"),
  );
  const urlFilename = filenameFromUrl(finalUrl);
  const filename = dispositionFilename || urlFilename;

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      contentType,
      filename,
      reason: `HTTP ${response.status}`,
    };
  }

  if (!contentTypeIsAudio(contentType, { allowOpaque, filename, finalUrl })) {
    return {
      ok: false,
      contentType,
      filename,
      reason: "Server tidak mengembalikan media audio.",
    };
  }

  return {
    ok: true,
    contentType,
    filename,
    url: finalUrl,
  };
}

export async function probeAudioUrl(rawUrl, options = {}) {
  const { allowOpaque = false, timeout = 9000 } = options;
  let lastResult = null;

  try {
    const head = await fetchPublicUrl(rawUrl, {
      method: "HEAD",
      timeout,
      maxRedirects: 3,
    });
    lastResult = evaluateAudioResponse(
      head.response,
      head.finalUrl.href,
      allowOpaque,
    );
    if (lastResult.ok) {
      return lastResult;
    }
  } catch {
    lastResult = null;
  }

  try {
    const ranged = await fetchPublicUrl(rawUrl, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      timeout,
      maxRedirects: 3,
    });
    const result = evaluateAudioResponse(
      ranged.response,
      ranged.finalUrl.href,
      allowOpaque,
    );

    try {
      await ranged.response.body?.cancel();
    } catch {
      return result;
    }

    return result;
  } catch {
    return {
      ok: false,
      contentType: "",
      filename: filenameFromUrl(rawUrl),
      reason: lastResult?.reason || "Audio tidak dapat dijangkau.",
    };
  }
}

export function cleanDisplayTitle(value, fallback = "Tanpa judul") {
  let title = String(value || "")
    .replace(/_KLICKAUD\.mp3$/i, "")
    .replace(/_forhub_soundcloud_to_mp3\.mp3$/i, "")
    .replace(/\.[a-zA-Z0-9]{2,5}$/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  title = title.replace(/^\d{1,3}[\s._-]+(?=\D)/, "").trim();

  return title || fallback;
}

export function parseArtistAndTitle(value, fallbackArtist = "") {
  const cleaned = cleanDisplayTitle(value);
  const separatorMatch = cleaned.match(/\s+[-–—]\s+/);

  if (separatorMatch) {
    const index = separatorMatch.index;
    const left = cleaned.slice(0, index).trim();
    const right = cleaned.slice(index + separatorMatch[0].length).trim();
    if (left && right) {
      return { artist: left, title: right };
    }
  }

  return {
    artist: String(fallbackArtist || "").trim(),
    title: cleaned,
  };
}

export function buildFileTitle(url, filename = "") {
  const rawName = filename || filenameFromUrl(url);
  return parseArtistAndTitle(decodeSafe(rawName));
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
