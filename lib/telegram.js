const API_BASE = "https://api.telegram.org";

const runtime = globalThis.__ongakuTelegramRuntime || {
  botInfo: null,
  botInfoAt: 0,
};
globalThis.__ongakuTelegramRuntime = runtime;

export class TelegramConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelegramConfigurationError";
    this.code = "TELEGRAM_CONFIG";
  }
}

export class TelegramRequestError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "TelegramRequestError";
    this.code = "TELEGRAM_REQUEST";
    this.status = status;
  }
}

export function readBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  if (!token) {
    throw new TelegramConfigurationError(
      "TELEGRAM_BOT_TOKEN belum diisi di environment.",
    );
  }

  return token;
}

export function readChannelId() {
  const channelId = process.env.TELEGRAM_CHANNEL_ID?.trim() || "";
  if (!channelId) {
    throw new TelegramConfigurationError(
      "TELEGRAM_CHANNEL_ID belum diisi di environment.",
    );
  }

  return channelId;
}

export function isTelegramConfigured() {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN?.trim() &&
      process.env.TELEGRAM_CHANNEL_ID?.trim(),
  );
}

export function normalizeChannelId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (/^@[a-zA-Z0-9_]{4,32}$/.test(raw)) {
    return raw;
  }

  if (/^-?\d{5,}$/.test(raw)) {
    return raw;
  }

  return raw;
}

export function normalizeFileId(value) {
  return String(value || "").trim();
}

export function normalizeMessageId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeDuration(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

export function normalizeDate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 0;
}

export function normalizeCaption(value) {
  return String(value || "").trim();
}

export function normalizeMimeType(value) {
  return String(value || "").trim();
}

export function normalizeFileSize(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeFileName(value) {
  return String(value || "").trim();
}

export function normalizeThumb(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    fileSize: normalizeFileSize(value.file_size),
  };
}

export function normalizeAudio(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    duration: normalizeDuration(value.duration),
    performer: normalizeCaption(value.performer),
    title: normalizeCaption(value.title),
    fileName: normalizeFileName(value.file_name),
    mimeType: normalizeMimeType(value.mime_type),
    fileSize: normalizeFileSize(value.file_size),
    thumb: normalizeThumb(value.thumb),
  };
}

export function normalizeDocument(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    fileName: normalizeFileName(value.file_name),
    mimeType: normalizeMimeType(value.mime_type),
    fileSize: normalizeFileSize(value.file_size),
    thumb: normalizeThumb(value.thumb),
  };
}

export function normalizeVideo(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    duration: normalizeDuration(value.duration),
    fileName: normalizeFileName(value.file_name),
    mimeType: normalizeMimeType(value.mime_type),
    fileSize: normalizeFileSize(value.file_size),
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    thumb: normalizeThumb(value.thumb),
  };
}

export function normalizeVoice(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    duration: normalizeDuration(value.duration),
    mimeType: normalizeMimeType(value.mime_type),
    fileSize: normalizeFileSize(value.file_size),
  };
}

export function normalizeVideoNote(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    duration: normalizeDuration(value.duration),
    fileSize: normalizeFileSize(value.file_size),
    length: Number(value.length) || 0,
    thumb: normalizeThumb(value.thumb),
  };
}

export function normalizePhoto(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    fileSize: normalizeFileSize(value.file_size),
  };
}

export function normalizeMessage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const messageId = normalizeMessageId(value.message_id);
  if (!messageId) {
    return null;
  }

  const date = normalizeDate(value.date);
  if (!date) {
    return null;
  }

  const audio = normalizeAudio(value.audio);
  const document = normalizeDocument(value.document);
  const video = normalizeVideo(value.video);
  const voice = normalizeVoice(value.voice);
  const videoNote = normalizeVideoNote(value.video_note);
  const photo = Array.isArray(value.photo)
    ? value.photo.map(normalizePhoto).filter(Boolean)
    : [];

  const media =
    audio ||
    document ||
    video ||
    voice ||
    videoNote ||
    (photo.length > 0 ? { photo } : null);

  if (!media) {
    return null;
  }

  return {
    messageId,
    date,
    chatId: String(value.chat?.id ?? ""),
    chatUsername: String(value.chat?.username ?? ""),
    caption: normalizeCaption(value.caption),
    media,
  };
}

export function normalizeUpdate(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const updateId = Number.parseInt(value.update_id, 10);
  if (!Number.isFinite(updateId)) {
    return null;
  }

  const message = normalizeMessage(value.message);
  const editedMessage = normalizeMessage(value.edited_message);
  const channelPost = normalizeMessage(value.channel_post);
  const editedChannelPost = normalizeMessage(value.edited_channel_post);

  return {
    updateId,
    message,
    editedMessage,
    channelPost,
    editedChannelPost,
  };
}

export function normalizeUpdateList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeUpdate).filter(Boolean);
}

export function normalizeFileResult(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileId = normalizeFileId(value.file_id);
  if (!fileId) {
    return null;
  }

  return {
    fileId,
    fileSize: normalizeFileSize(value.file_size),
    filePath: String(value.file_path || "").trim(),
  };
}

export function normalizeChat(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    id: String(value.id ?? ""),
    type: String(value.type || ""),
    title: String(value.title || ""),
    username: String(value.username || ""),
  };
}

export function normalizeBotInfo(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    id: Number(value.id) || 0,
    username: String(value.username || ""),
    firstName: String(value.first_name || ""),
  };
}

export function buildApiUrl(method, token) {
  return `${API_BASE}/bot${token}/${method}`;
}

export function buildFileUrl(token, filePath) {
  return `${API_BASE}/file/bot${token}/${filePath}`;
}

export async function callTelegramApi(method, token, options = {}) {
  const url = buildApiUrl(method, token);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 30000,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body || {}),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok !== true) {
      const description = payload.description || `HTTP ${response.status}`;
      throw new TelegramRequestError(
        `Telegram ${method} gagal: ${description}`,
        response.status === 401 ? 502 : response.status || 502,
      );
    }

    return payload.result;
  } catch (error) {
    if (error instanceof TelegramRequestError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new TelegramRequestError(
        `Telegram ${method} melebihi batas waktu.`,
        504,
      );
    }

    throw new TelegramRequestError(
      `Telegram ${method} tidak dapat dihubungi.`,
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function callTelegramUpload(method, token, form, options = {}) {
  const url = buildApiUrl(method, token);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 120000,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok !== true) {
      const description = payload.description || `HTTP ${response.status}`;
      throw new TelegramRequestError(
        `Telegram ${method} gagal: ${description}`,
        response.status === 401 ? 502 : response.status || 502,
      );
    }

    return payload.result;
  } catch (error) {
    if (error instanceof TelegramRequestError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new TelegramRequestError(
        `Telegram ${method} melebihi batas waktu.`,
        504,
      );
    }

    throw new TelegramRequestError(
      `Telegram ${method} tidak dapat dihubungi.`,
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendMessage(token, chatId, text, options = {}) {
  return callTelegramApi("sendMessage", token, {
    body: {
      chat_id: String(chatId),
      text: String(text),
      parse_mode: options.parseMode || "HTML",
      disable_web_page_preview: options.disableWebPagePreview !== false,
      ...(options.replyToMessageId
        ? { reply_to_message_id: options.replyToMessageId }
        : {}),
    },
    timeoutMs: options.timeoutMs || 30000,
  });
}

export async function sendChatAction(token, chatId, action = "upload_audio") {
  return callTelegramApi("sendChatAction", token, {
    body: { chat_id: String(chatId), action },
    timeoutMs: 30000,
  });
}

export async function sendAudio(token, chatId, audio, options = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("audio", audio, options.filename || "audio.mp3");

  if (options.caption) {
    form.append("caption", String(options.caption));
  }
  if (options.title) {
    form.append("title", String(options.title));
  }
  if (options.performer) {
    form.append("performer", String(options.performer));
  }
  if (options.duration) {
    form.append("duration", String(Math.round(Number(options.duration))));
  }
  if (options.thumb) {
    form.append("thumb", options.thumb);
  }
  if (options.disableNotification) {
    form.append("disable_notification", "true");
  }

  return callTelegramUpload("sendAudio", token, form, options);
}

export async function getMe(token) {
  return normalizeBotInfo(await callTelegramApi("getMe", token));
}

export async function getChat(token, chatId) {
  return normalizeChat(
    await callTelegramApi("getChat", token, { body: { chat_id: chatId } }),
  );
}

export async function getFile(token, fileId) {
  return normalizeFileResult(
    await callTelegramApi("getFile", token, { body: { file_id: fileId } }),
  );
}

export async function getUpdates(token, options = {}) {
  const body = {
    timeout: Math.max(0, Math.min(50, Number(options.timeout) || 0)),
    allowed_updates: ["channel_post", "edited_channel_post", "message", "edited_message"],
  };

  if (options.offset) {
    body.offset = options.offset;
  }

  if (options.limit) {
    body.limit = Math.max(1, Math.min(100, Number(options.limit) || 100));
  }

  return normalizeUpdateList(
    await callTelegramApi("getUpdates", token, { body }),
  );
}

export async function getFileStreamUrl(token, fileId) {
  const file = await getFile(token, fileId);
  if (!file?.filePath) {
    throw new TelegramRequestError(
      "File audio tidak tersedia di Telegram.",
      404,
    );
  }

  return {
    fileId: file.fileId,
    filePath: file.filePath,
    fileSize: file.fileSize,
    url: buildFileUrl(token, file.filePath),
  };
}

export async function getBotInfo(token) {
  if (runtime.botInfo && Date.now() - runtime.botInfoAt < 10 * 60 * 1000) {
    return runtime.botInfo;
  }

  const info = await getMe(token);
  runtime.botInfo = info;
  runtime.botInfoAt = Date.now();
  return info;
}