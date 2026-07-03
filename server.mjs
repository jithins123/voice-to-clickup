import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const oneDayMs = 24 * 60 * 60 * 1000;
const accessCookieName = "vtc_access";
const refreshCookieName = "vtc_refresh";

loadEnv();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function app(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return getConfig(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      return getSession(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      return signUp(res, await readJson(req));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      return login(res, await readJson(req));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      return logout(res);
    }

    if (req.method === "GET" && url.pathname === "/api/user/credentials") {
      return getUserCredentialStatus(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/user/credentials") {
      return saveUserCredentials(req, res, await readJson(req));
    }

    if (req.method === "GET" && url.pathname === "/api/realtime/token") {
      return createRealtimeToken(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/tasks/extract") {
      return extractTasks(req, res, await readJson(req));
    }

    if (req.method === "POST" && url.pathname === "/api/clickup/tasks") {
      return createClickUpTask(req, res, await readJson(req));
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      return handleMcp(res, await readJson(req));
    }

    if (req.method === "GET") {
      return serveStatic(res, url.pathname);
    }

    return sendJson(res, { error: "Method not allowed" }, 405);
  } catch (error) {
    return sendJson(res, { error: errorMessage(error) }, statusCode(error));
  }
}

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  createServer(app).listen(port, () => {
    console.log(`Voice to ClickUp running at http://localhost:${port}`);
  });
}

export default app;

function loadEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function getConfig(req, res) {
  const user = await optionalUser(req, res);
  const status = user ? await credentialStatus(user.id) : fallbackCredentialStatus();
  return sendJson(res, {
    authEnabled: authEnabled(),
    authenticated: Boolean(user),
    email: user?.email || null,
    hasOpenAI: status.hasOpenAI,
    hasClickUp: status.hasClickUp,
    credentialsSaved: status.credentialsSaved,
    defaultLanguage: envValue("OPENAI_TRANSCRIPTION_LANGUAGE") || "en"
  });
}

async function getSession(req, res) {
  const user = await optionalUser(req, res);
  const status = user ? await credentialStatus(user.id) : fallbackCredentialStatus();
  return sendJson(res, {
    authEnabled: authEnabled(),
    authenticated: Boolean(user),
    user: user ? { id: user.id, email: user.email } : null,
    credentials: status
  });
}

async function signUp(res, body) {
  ensureAuthConfigured();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) throw httpError(400, "Email and password are required.");
  if (password.length < 8) throw httpError(400, "Password must be at least 8 characters.");

  const data = await supabaseAuthRequest("/signup", {
    method: "POST",
    body: { email, password }
  });

  if (data.access_token && data.refresh_token) {
    setSessionCookies(res, data);
    return sendJson(res, { ok: true, user: authUserFromTokenResponse(data) });
  }

  return sendJson(res, {
    ok: true,
    needsConfirmation: true,
    message: "Check your email to confirm this account, then sign in."
  });
}

async function login(res, body) {
  ensureAuthConfigured();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) throw httpError(400, "Email and password are required.");

  const data = await supabaseAuthRequest("/token?grant_type=password", {
    method: "POST",
    body: { email, password }
  });

  setSessionCookies(res, data);
  return sendJson(res, { ok: true, user: authUserFromTokenResponse(data) });
}

function logout(res) {
  clearSessionCookies(res);
  return sendJson(res, { ok: true });
}

async function getUserCredentialStatus(req, res) {
  const user = await requireUser(req, res);
  return sendJson(res, await credentialStatus(user.id));
}

async function saveUserCredentials(req, res, body) {
  const user = await requireUser(req, res);
  const current = await credentialRow(user.id).catch(() => null);
  const next = {
    user_id: user.id,
    openai_api_key_enc: keepOrEncrypt(body.openai_api_key, current?.openai_api_key_enc),
    clickup_api_token_enc: keepOrEncrypt(body.clickup_api_token, current?.clickup_api_token_enc),
    clickup_list_id_enc: keepOrEncrypt(body.clickup_list_id, current?.clickup_list_id_enc),
    updated_at: new Date().toISOString()
  };

  await supabaseDbRequest("/rest/v1/user_credentials", {
    method: "POST",
    query: "?on_conflict=user_id",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: next
  });

  return sendJson(res, { ok: true, credentials: await credentialStatus(user.id) });
}

async function createRealtimeToken(req, res) {
  const credentials = await credentialsForRequest(req, res, { needsOpenAI: true });
  const apiKey = credentials.openaiApiKey;

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "voice-to-clickup-user"
    },
    body: JSON.stringify({
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper",
              language: envValue("OPENAI_TRANSCRIPTION_LANGUAGE") || "en",
              delay: "low"
            }
          }
        }
      }
    })
  });

  const data = await readResponseBody(response);
  if (!response.ok) {
    return sendJson(res, { error: data.message || "Could not create realtime token" }, response.status);
  }

  return sendJson(res, data.json || {});
}

async function extractTasks(req, res, body) {
  const credentials = await credentialsForRequest(req, res, { needsOpenAI: true });
  const apiKey = credentials.openaiApiKey;
  const nowIso = new Date().toISOString();
  const defaultStartIso = new Date(Date.now() + oneDayMs).toISOString();

  const transcript = String(body.transcript || "").trim();
  if (!transcript) return sendJson(res, { tasks: [] });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: envValue("OPENAI_TASK_MODEL") || "gpt-5.5",
      input: [
        {
          role: "system",
          content: [
            "Extract ClickUp-ready tasks from a spoken transcript.",
            "Return only JSON shaped as {\"tasks\": [...]} with no markdown.",
            "Each task must include name, description, priority, start_date, due_date, assignee_hint, tags, and confidence.",
            `Current server time is ${nowIso}. Resolve relative dates into ISO 8601 strings when possible.`,
            `If no start date is implied, set start_date to null; the app will default it to ${defaultStartIso} when sending to ClickUp.`,
            "Use null when unknown. Keep task names short and action-oriented."
          ].join(" ")
        },
        {
          role: "user",
          content: transcript
        }
      ]
    })
  });

  const data = await readResponseBody(response);
  if (!response.ok) {
    return sendJson(res, { error: data.message || "Could not extract tasks" }, response.status);
  }

  const text = responseText(data.json || {});
  const parsed = parseJsonObject(text);
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask) : [];
  return sendJson(res, { tasks });
}

async function createClickUpTask(req, res, body) {
  try {
    const credentials = await credentialsForRequest(req, res, { needsClickUp: true });
    const result = await sendTaskToClickUp(normalizeTask(body), credentials);
    return sendJson(res, result);
  } catch (error) {
    return sendJson(res, { error: errorMessage(error) }, statusCode(error));
  }
}

async function credentialsForRequest(req, res, requirements = {}) {
  if (!authEnabled()) {
    return envCredentials(requirements);
  }

  const user = await requireUser(req, res);
  const row = await credentialRow(user.id).catch(() => null);
  const credentials = row ? decryptCredentialRow(row) : {};

  if (requirements.needsOpenAI && !credentials.openaiApiKey) {
    throw httpError(403, "Add your OpenAI API key in Settings before using transcription or extraction.");
  }

  if (requirements.needsClickUp && (!credentials.clickUpToken || !credentials.clickUpListId)) {
    throw httpError(403, "Add your ClickUp API token and list ID in Settings before creating ClickUp tasks.");
  }

  return credentials;
}

function envCredentials(requirements = {}) {
  const credentials = {
    openaiApiKey: envValue("OPENAI_API_KEY"),
    clickUpToken: envValue("CLICKUP_API_TOKEN"),
    clickUpListId: envValue("CLICKUP_LIST_ID")
  };

  if (requirements.needsOpenAI && !credentials.openaiApiKey) {
    throw httpError(500, "OPENAI_API_KEY is missing. Add it to your Vercel environment variables.");
  }

  if (requirements.needsClickUp && (!credentials.clickUpToken || !credentials.clickUpListId)) {
    throw httpError(500, "CLICKUP_API_TOKEN or CLICKUP_LIST_ID is missing. Add them to your Vercel environment variables.");
  }

  return credentials;
}

async function sendTaskToClickUp(task, credentials = envCredentials({ needsClickUp: true })) {
  const token = credentials.clickUpToken;
  const rawListId = credentials.clickUpListId;
  const listId = normalizeClickUpListId(rawListId);

  if (!task.name) {
    throw httpError(400, "Task name is required before sending to ClickUp.");
  }

  const descriptionParts = [];
  if (task.description) descriptionParts.push(task.description);
  if (task.assignee_hint) descriptionParts.push(`Assignee hint: ${task.assignee_hint}`);
  if (task.tags.length) descriptionParts.push(`Tags: ${task.tags.map((tag) => "#" + tag).join(" ")}`);

  const payload = {
    name: task.name,
    description: descriptionParts.join("\n\n"),
    notify_all: false
  };

  const priority = priorityValue(task.priority);
  if (priority) payload.priority = priority;

  const startDate = dateToClickUpTimestamp(task.start_date) || defaultStartDateTimestamp();
  payload.start_date = startDate;

  const dueDate = dateToClickUpTimestamp(task.due_date);
  if (dueDate) payload.due_date = dueDate;

  const defaultAssignee = Number(envValue("CLICKUP_DEFAULT_ASSIGNEE_ID"));
  if (Number.isFinite(defaultAssignee) && defaultAssignee > 0) {
    payload.assignees = [defaultAssignee];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let response;
  try {
    response = await fetch(`https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "ClickUp request timed out. Check the list ID and try again."
      : `Could not reach ClickUp: ${errorMessage(error)}`;
    throw httpError(502, message);
  } finally {
    clearTimeout(timeout);
  }

  const data = await readResponseBody(response);
  if (!response.ok) {
    throw httpError(response.status, clickUpErrorMessage(response.status, data, rawListId, listId));
  }

  return { ok: true, task: data.json || {} };
}

async function optionalUser(req, res) {
  if (!authEnabled()) return null;
  const accessToken = readCookie(req, accessCookieName);
  if (!accessToken) return null;

  const direct = await userFromAccessToken(accessToken).catch(() => null);
  if (direct) return direct;

  const refreshToken = readCookie(req, refreshCookieName);
  if (!refreshToken) return null;

  const refreshed = await refreshSession(refreshToken).catch(() => null);
  if (!refreshed?.access_token) return null;
  setSessionCookies(res, refreshed);
  return userFromAccessToken(refreshed.access_token).catch(() => null);
}

async function requireUser(req, res) {
  const user = await optionalUser(req, res);
  if (!user) throw httpError(401, "Please sign in first.");
  return user;
}

async function userFromAccessToken(accessToken) {
  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`
    }
  });
  const data = await readResponseBody(response);
  if (!response.ok) throw httpError(response.status, data.message || "Invalid session.");
  return normalizeSupabaseUser(data.json || {});
}

async function refreshSession(refreshToken) {
  return supabaseAuthRequest("/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: refreshToken }
  });
}

function normalizeSupabaseUser(user) {
  return {
    id: user.id,
    email: user.email || user.user_metadata?.email || ""
  };
}

function authUserFromTokenResponse(data) {
  return normalizeSupabaseUser(data.user || {});
}

async function credentialStatus(userId) {
  const row = await credentialRow(userId).catch(() => null);
  return {
    credentialsSaved: Boolean(row),
    hasOpenAI: Boolean(row?.openai_api_key_enc),
    hasClickUp: Boolean(row?.clickup_api_token_enc && row?.clickup_list_id_enc)
  };
}

function fallbackCredentialStatus() {
  return {
    credentialsSaved: false,
    hasOpenAI: Boolean(envValue("OPENAI_API_KEY")),
    hasClickUp: Boolean(envValue("CLICKUP_API_TOKEN") && envValue("CLICKUP_LIST_ID"))
  };
}

async function credentialRow(userId) {
  const rows = await supabaseDbRequest("/rest/v1/user_credentials", {
    method: "GET",
    query: `?user_id=eq.${encodeURIComponent(userId)}&select=*`
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

function decryptCredentialRow(row) {
  return {
    openaiApiKey: decryptSecret(row.openai_api_key_enc),
    clickUpToken: decryptSecret(row.clickup_api_token_enc),
    clickUpListId: decryptSecret(row.clickup_list_id_enc)
  };
}

function keepOrEncrypt(value, existing) {
  const text = String(value || "").trim();
  if (!text) return existing || null;
  return encryptSecret(text);
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptSecret(value) {
  if (!value) return "";
  const [version, ivText, tagText, encryptedText] = String(value).split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) return "";
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

function encryptionKey() {
  const raw = assertEnv("APP_ENCRYPTION_KEY");
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(raw).digest();
}

async function supabaseAuthRequest(path, options) {
  const response = await fetch(`${supabaseUrl()}/auth/v1${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: supabaseAnonKey(),
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await readResponseBody(response);
  if (!response.ok) throw httpError(response.status, data.message || "Supabase auth request failed.");
  return data.json || {};
}

async function supabaseDbRequest(path, options) {
  const response = await fetch(`${supabaseUrl()}${path}${options.query || ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: supabaseServiceRoleKey(),
      Authorization: `Bearer ${supabaseServiceRoleKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await readResponseBody(response);
  if (!response.ok) throw httpError(response.status, data.message || "Supabase database request failed.");
  return data.json;
}

function setSessionCookies(res, data) {
  const accessMaxAge = Number(data.expires_in || 3600);
  const refreshMaxAge = 60 * 60 * 24 * 30;
  addCookie(res, accessCookieName, data.access_token, accessMaxAge);
  addCookie(res, refreshCookieName, data.refresh_token, refreshMaxAge);
}

function clearSessionCookies(res) {
  addCookie(res, accessCookieName, "", 0);
  addCookie(res, refreshCookieName, "", 0);
}

function addCookie(res, name, value, maxAge) {
  const encoded = encodeURIComponent(value || "");
  const secure = process.env.VERCEL ? "; Secure" : "";
  const cookie = `${name}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const existing = res.getHeader?.("Set-Cookie");
  const next = existing ? (Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]) : [cookie];
  res.setHeader("Set-Cookie", next);
}

function readCookie(req, name) {
  const cookie = String(req.headers.cookie || "");
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return "";
}

function authEnabled() {
  return Boolean(envValue("SUPABASE_URL") && envValue("SUPABASE_ANON_KEY") && envValue("SUPABASE_SERVICE_ROLE_KEY") && envValue("APP_ENCRYPTION_KEY"));
}

function ensureAuthConfigured() {
  if (!authEnabled()) {
    throw httpError(500, "Supabase auth is not configured. Add SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, and APP_ENCRYPTION_KEY.");
  }
}

function supabaseUrl() {
  return assertEnv("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseAnonKey() {
  return assertEnv("SUPABASE_ANON_KEY");
}

function supabaseServiceRoleKey() {
  return assertEnv("SUPABASE_SERVICE_ROLE_KEY");
}

async function readResponseBody(response) {
  const text = await response.text().catch(() => "");
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  const message = json?.error_description || json?.error?.message || json?.err || json?.error || json?.message || json?.ECODE || text || response.statusText;
  return { json, text, message };
}

function clickUpErrorMessage(status, data, rawListId, normalizedListId) {
  const base = `ClickUp ${status}: ${data.message || "Task creation failed"}.`;
  if (status === 400 && String(data.message || "").toLowerCase().includes("list id")) {
    return `${base} ClickUp list ID is currently being sent as ${normalizedListId}. For URLs like /v/l/8c9z29a-302, use 8c9z29a-302.`;
  }
  if (status === 401 || status === 403) {
    return `${base} Check your ClickUp API token permissions in Settings.`;
  }
  if (status === 404) {
    return `${base} Check that your ClickUp list ID matches the target ClickUp list, such as 8c9z29a-302 from /v/l/8c9z29a-302.`;
  }
  return base;
}

function normalizeClickUpListId(value) {
  const trimmed = String(value || "").trim();
  const decoded = decodeURIComponent(trimmed);
  const listSlug = "([A-Za-z0-9_-]+)";
  const patterns = [
    new RegExp(`(?:^|[/?#&])l/${listSlug}(?:[/?#&]|$)`, "i"),
    new RegExp(`(?:^|[/?#&])li/${listSlug}(?:[/?#&]|$)`, "i"),
    new RegExp(`(?:^|[/?#&])list/${listSlug}(?:[/?#&]|$)`, "i"),
    /(?:^|[/?#&])list_id=([A-Za-z0-9_-]+)/i,
    /(?:^|[/?#&])li=([A-Za-z0-9_-]+)/i,
    /(?:^|[/?#&])list=([A-Za-z0-9_-]+)/i,
    /^([A-Za-z0-9_-]+)$/
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) return match[1];
  }

  return decoded;
}

async function handleMcp(res, message) {
  if (message.method === "tools/list") {
    return sendJson(res, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "create_clickup_task",
            description: "Create a ClickUp task from a structured task draft.",
            inputSchema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                priority: { type: "string" },
                start_date: { type: "string" },
                due_date: { type: "string" },
                tags: { type: "array", items: { type: "string" } }
              }
            }
          }
        ]
      }
    });
  }

  if (message.method === "tools/call" && message.params?.name === "create_clickup_task") {
    const result = await sendTaskToClickUp(normalizeTask(message.params.arguments || {}));
    return sendJson(res, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result.task, null, 2) }]
      }
    });
  }

  return sendJson(res, {
    jsonrpc: "2.0",
    id: message.id || null,
    error: { code: -32601, message: "Method not found" }
  });
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(publicDir, `.${decodeURIComponent(cleanPath)}`);
  if (!filePath.startsWith(resolve(publicDir))) {
    return sendJson(res, { error: "Not found" }, 404);
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch {
    return sendJson(res, { error: "Not found" }, 404);
  }
}

function normalizeTask(task) {
  return {
    name: String(task.name || task.title || "").trim(),
    description: String(task.description || "").trim(),
    priority: task.priority || null,
    start_date: task.start_date || null,
    due_date: task.due_date || null,
    assignee_hint: task.assignee_hint || null,
    tags: Array.isArray(task.tags) ? task.tags.filter(Boolean).map(String) : [],
    confidence: Number(task.confidence || 0)
  };
}

function priorityValue(priority) {
  const normalized = String(priority).toLowerCase();
  if (normalized.includes("urgent")) return 1;
  if (normalized.includes("high")) return 2;
  if (normalized.includes("normal") || normalized.includes("medium")) return 3;
  if (normalized.includes("low")) return 4;
  return null;
}

function dateToClickUpTimestamp(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function defaultStartDateTimestamp() {
  return Date.now() + oneDayMs;
}

function responseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { tasks: [] };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { tasks: [] };
    }
  }
}

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function assertEnv(name) {
  const value = envValue(name);
  if (!value) {
    throw httpError(500, `${name} is missing. Add it to your Vercel environment variables.`);
  }
  return value;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function statusCode(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function errorMessage(error) {
  return String(error?.message || error || "Unexpected server error").slice(0, 800);
}

async function readJson(req) {
  const text = await readText(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Request body was not valid JSON.");
  }
}

function readText(req) {
  return new Promise((resolveRead, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(httpError(413, "Request body too large."));
      }
    });
    req.on("end", () => resolveRead(data));
    req.on("error", reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
