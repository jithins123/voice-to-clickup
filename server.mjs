import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

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
      return sendJson(res, {
        hasOpenAI: Boolean(envValue("OPENAI_API_KEY")),
        hasClickUp: Boolean(envValue("CLICKUP_API_TOKEN") && envValue("CLICKUP_LIST_ID")),
        defaultLanguage: envValue("OPENAI_TRANSCRIPTION_LANGUAGE") || "en"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/realtime/token") {
      return createRealtimeToken(res);
    }

    if (req.method === "POST" && url.pathname === "/api/tasks/extract") {
      return extractTasks(res, await readJson(req));
    }

    if (req.method === "POST" && url.pathname === "/api/clickup/tasks") {
      return createClickUpTask(res, await readJson(req));
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      return handleMcp(res, await readJson(req));
    }

    if (req.method === "GET") {
      return serveStatic(res, url.pathname);
    }

    sendJson(res, { error: "Method not allowed" }, 405);
  } catch (error) {
    sendJson(res, { error: error.message || "Unexpected error" }, error.status || 500);
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

async function createRealtimeToken(res) {
  const apiKey = assertEnv("OPENAI_API_KEY");

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

  sendJson(res, data.json || {});
}

async function extractTasks(res, body) {
  const apiKey = assertEnv("OPENAI_API_KEY");

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
            "Each task must include name, description, priority, due_date, assignee_hint, tags, and confidence.",
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
  sendJson(res, { tasks });
}

async function createClickUpTask(res, body) {
  const created = await sendTaskToClickUp(normalizeTask(body));
  sendJson(res, created);
}

async function sendTaskToClickUp(task) {
  const token = assertEnv("CLICKUP_API_TOKEN");
  const listId = assertEnv("CLICKUP_LIST_ID");

  if (!task.name) throw new Error("Task name is required");

  const descriptionParts = [];
  if (task.description) descriptionParts.push(task.description);
  if (task.assignee_hint) descriptionParts.push(`Assignee hint: ${task.assignee_hint}`);
  if (task.tags.length) descriptionParts.push(`Tags: ${task.tags.map((tag) => `#${tag}`).join(" ")}`);

  const payload = {
    name: task.name,
    description: descriptionParts.join("\n\n"),
    notify_all: false
  };

  const priority = priorityValue(task.priority);
  if (priority) payload.priority = priority;

  const dueDate = dateToClickUpTimestamp(task.due_date);
  if (dueDate) payload.due_date = dueDate;

  const defaultAssignee = Number(envValue("CLICKUP_DEFAULT_ASSIGNEE_ID"));
  if (Number.isFinite(defaultAssignee) && defaultAssignee > 0) {
    payload.assignees = [defaultAssignee];
  }

  const response = await fetch(`https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await readResponseBody(response);
  if (!response.ok) {
    const error = new Error(clickUpErrorMessage(response.status, data));
    error.status = response.status;
    throw error;
  }

  return { ok: true, task: data.json || {} };
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

  const message = json?.error?.message || json?.err || json?.error || json?.message || json?.ECODE || text || response.statusText;
  return { json, text, message };
}

function clickUpErrorMessage(status, data) {
  const hint = status === 401 || status === 403
    ? " Check CLICKUP_API_TOKEN permissions in Vercel."
    : status === 404
      ? " Check that CLICKUP_LIST_ID is the numeric list ID for the target ClickUp list."
      : "";
  return `ClickUp ${status}: ${data.message || "Task creation failed"}.${hint}`;
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

  sendJson(res, {
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
    sendJson(res, { error: "Not found" }, 404);
  }
}

function normalizeTask(task) {
  return {
    name: String(task.name || task.title || "").trim(),
    description: String(task.description || "").trim(),
    priority: task.priority || null,
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
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
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
    throw new Error(`${name} is missing. Add it to your environment variables.`);
  }
  return value;
}

async function readJson(req) {
  const text = await readText(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function readText(req) {
  return new Promise((resolveRead, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
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
