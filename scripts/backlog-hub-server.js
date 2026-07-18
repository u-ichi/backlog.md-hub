#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { ListenerManager, parseBooleanFlag } = require("./listener-manager");

const PORT = numberFromEnv("BACKLOG_HUB_PORT", 6419);
const HOST = process.env.BACKLOG_HUB_HOST || "127.0.0.1";
const TAILSCALE_LISTEN_RAW = process.env.BACKLOG_HUB_TAILSCALE_LISTEN;
const TAILSCALE_LISTEN = parseBooleanFlag(TAILSCALE_LISTEN_RAW, false);
const HUB_CONFIG = process.env.BACKLOG_HUB_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "backlog-md-hub", "config.json");
const META_TTL_MS = 60_000;
const TASK_TTL_MS = 3_000;
const CONFIG_CANDIDATES = ["backlog/config.yml", "backlog.config.yml", ".backlog/config.yml"];
const TASK_KEYS = new Set(["id", "title", "status", "assignee", "labels", "priority", "ordinal", "created_date", "updated_date", "milestone"]);
const MILESTONE_TTL_MS = 60_000;
const STATUSES = ["To Do", "In Progress", "Done"];

let repoCache = { expiresAt: 0, repos: [] };
// repo_root -> { mtimeMs, port } 。各 repo `backlog/config.yml` の default_port を mtime cache 付きで保持
const portCache = new Map();
const taskCache = new Map();
const milestoneCache = new Map();

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (level === "INFO") {
    console.log(line);
  } else {
    console.error(line);
  }
}

if (TAILSCALE_LISTEN_RAW !== undefined && TAILSCALE_LISTEN_RAW !== "true" && TAILSCALE_LISTEN_RAW !== "false") {
  log("WARN", `invalid BACKLOG_HUB_TAILSCALE_LISTEN=${TAILSCALE_LISTEN_RAW}; Tailscale listener disabled`);
}

function realpathIfExists(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (_error) {
    return null;
  }
}

function statIfExists(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_error) {
    return null;
  }
}

function expandHomePath(rawPath) {
  if (typeof rawPath !== "string") return "";
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

function hasBacklogConfig(repoRoot) {
  return CONFIG_CANDIDATES.some((candidate) => fs.existsSync(path.join(repoRoot, candidate)));
}

function repoName(repoRoot) {
  return path.basename(repoRoot) || repoRoot;
}

function loadHubSources(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (_error) {
    log("WARN", `hub config is not readable; no backlog repos discovered: ${configPath}`);
    return [];
  }
  if (!raw.trim()) {
    log("WARN", `hub config is empty; no backlog repos discovered: ${configPath}`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log("WARN", `failed to parse hub config; no backlog repos discovered: ${configPath}: ${error.message}`);
    return [];
  }

  return parsed && Array.isArray(parsed.sources) ? parsed.sources : [];
}

function discoverRepos() {
  const now = Date.now();
  const configPath = expandHomePath(HUB_CONFIG);
  const configStat = statIfExists(configPath);
  const configMtimeMs = configStat ? configStat.mtimeMs : -1;
  if (now < repoCache.expiresAt && repoCache.configPath === configPath && repoCache.configMtimeMs === configMtimeMs) {
    return repoCache.repos;
  }

  const roots = [];
  const seen = new Set();
  const addRepo = (candidate) => {
    const root = realpathIfExists(candidate);
    if (!root || seen.has(root) || !hasBacklogConfig(root)) return;
    seen.add(root);
    roots.push(root);
  };

  for (const source of loadHubSources(configPath)) {
    const sourceType = source && typeof source === "object" ? source.type : "";
    const rawPath = source && typeof source === "object" ? source.path : "";
    if (typeof rawPath !== "string" || !rawPath) {
      log("WARN", `hub config source path is empty; skip type=${sourceType || "empty"}`);
      continue;
    }

    const expandedPath = expandHomePath(rawPath);
    const sourcePath = realpathIfExists(expandedPath);
    if (!sourcePath) {
      log("WARN", `hub config source path is not readable; skip type=${sourceType || "empty"} path=${rawPath}`);
      continue;
    }

    if (sourceType === "repo") {
      addRepo(sourcePath);
      continue;
    }

    if (sourceType === "base_dir") {
      let entries = [];
      try {
        entries = fs.readdirSync(sourcePath, { withFileTypes: true });
      } catch (error) {
        log("WARN", `failed to read hub config base_dir; skip path=${rawPath}: ${error.message}`);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          addRepo(path.join(sourcePath, entry.name));
        }
      }
      continue;
    }

    log("WARN", `unknown hub config source type; skip type=${sourceType || "empty"} path=${rawPath}`);
  }

  roots.sort((a, b) => repoName(a).localeCompare(repoName(b)));
  repoCache = { expiresAt: now + META_TTL_MS, configPath, configMtimeMs, repos: roots };
  return roots;
}

function findRepoConfigPath(repoRoot) {
  for (const candidate of CONFIG_CANDIDATES) {
    const p = path.join(repoRoot, candidate);
    if (statIfExists(p)) return p;
  }
  return null;
}

// 各 repo `backlog/config.yml` の `default_port` を返す (未設定なら null)。mtime cache 付き。
// yaml は builtin parser が無いため flat な top-level key を regex で拾う (config.yml は flat schema)。
function getPortForRepo(repoRoot) {
  const configPath = findRepoConfigPath(repoRoot);
  if (!configPath) {
    portCache.delete(repoRoot);
    return null;
  }
  const stat = statIfExists(configPath);
  if (!stat) {
    portCache.delete(repoRoot);
    return null;
  }
  const cached = portCache.get(repoRoot);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.port;
  }
  let port = null;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const match = /^default_port:\s*(\d+)\s*$/m.exec(text);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed > 0) port = parsed;
    }
  } catch (error) {
    log("WARN", `failed to read config.yml for ${repoRoot}: ${error.message}`);
  }
  portCache.set(repoRoot, { mtimeMs: stat.mtimeMs, port });
  return port;
}

// ---------------- child-manager -----------------
// hub が各 repo の `backlog browser` を child として spawn / 監視 / 再起動する
const BROWSER_CLI = process.env.BACKLOG_HUB_CLI_PATH || process.env.BACKLOG_CLI_PATH || "backlog";
const BROWSER_LOG_RELPATH = path.join("backlog", "logs", "browser.log");
const CHILD_KILL_GRACE_MS = 5_000;
const CHILD_BACKOFF_INITIAL_MS = 1_000;
const CHILD_BACKOFF_MAX_MS = 60_000;
const CHILD_QUARANTINE_STREAK = 5;
const CHILD_QUARANTINE_WINDOW_MS = 10_000;
const CHILD_QUARANTINE_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 500;

// repoRoot -> { child, port, backoffMs, restartTimer, failStreak, streakStartTs, killing }
const children = new Map();
let shuttingDown = false;
let reconcileTimer = null;

function ensureBrowserLogStream(repoRoot) {
  const logPath = path.join(repoRoot, BROWSER_LOG_RELPATH);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch (error) {
    log("WARN", `browser log dir mkdir failed for ${repoRoot}: ${error.message}`);
    return null;
  }
  try {
    return fs.openSync(logPath, "a");
  } catch (error) {
    log("WARN", `browser log open failed for ${repoRoot}: ${error.message}`);
    return null;
  }
}

function spawnBrowserFor(repoRoot, port) {
  if (shuttingDown) return;
  const logFd = ensureBrowserLogStream(repoRoot);
  // `backlog browser` は stdin が閉じると exit する。Node の pipe で stdin を開き続け、
  // hub が死んだ時は自然に EOF が伝播する。detached=true で process group leader 化し、
  // kill 時に process group ごと殺すことで backlog CLI の内部 spawn した grand-child も止める。
  const stdio = ["pipe", logFd || "ignore", logFd || "ignore"];
  let child;
  try {
    child = spawn(BROWSER_CLI, ["browser", "--port", String(port), "--no-open"], {
      cwd: repoRoot,
      stdio,
      env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      detached: true,
    });
  } catch (error) {
    log("ERROR", `browser spawn failed for ${repoRoot} port=${port}: ${error.message}`);
    if (logFd !== null) fs.closeSync(logFd);
    scheduleChildRestart(repoRoot, port);
    return;
  }
  if (logFd !== null) fs.closeSync(logFd);

  const entry = children.get(repoRoot) || {};
  entry.child = child;
  entry.port = port;
  entry.killing = false;
  if (entry.backoffMs == null) entry.backoffMs = CHILD_BACKOFF_INITIAL_MS;
  if (entry.failStreak == null) entry.failStreak = 0;
  if (entry.streakStartTs == null) entry.streakStartTs = 0;
  children.set(repoRoot, entry);

  log("INFO", `browser spawned repo=${repoRoot} port=${port} pid=${child.pid}`);

  child.on("exit", (code, signal) => {
    handleChildExit(repoRoot, port, code, signal);
  });
  child.on("error", (error) => {
    log("ERROR", `browser child error repo=${repoRoot}: ${error.message}`);
    handleChildExit(repoRoot, port, null, null);
  });
}

function handleChildExit(repoRoot, port, code, signal) {
  const entry = children.get(repoRoot);
  if (!entry || !entry.child) return;
  const deadChild = entry.child;
  entry.child = null;
  const wasKilling = entry.killing;
  entry.killing = false;

  // 直接 pid が死んだ後、同じ process group に残る grand-child (backlog CLI が内部 spawn
  // した darwin-arm64 binary) を確実に始末する。port を掴んだまま生き残ると次の spawn が
  // EADDRINUSE で失敗し無限再起動になる。
  if (deadChild && deadChild.pid) {
    try {
      process.kill(-deadChild.pid, "SIGKILL");
    } catch (_error) { /* ESRCH は正常 */ }
  }

  log("INFO", `browser exited repo=${repoRoot} port=${port} code=${code} signal=${signal || "-"}${wasKilling ? " (kill)" : ""}`);

  if (wasKilling || shuttingDown) {
    return;
  }

  const now = Date.now();
  if (entry.streakStartTs === 0 || now - entry.streakStartTs > CHILD_QUARANTINE_WINDOW_MS) {
    entry.streakStartTs = now;
    entry.failStreak = 1;
  } else {
    entry.failStreak += 1;
  }

  let delay = entry.backoffMs || CHILD_BACKOFF_INITIAL_MS;
  if (entry.failStreak >= CHILD_QUARANTINE_STREAK) {
    log("WARN", `browser quarantine repo=${repoRoot} streak=${entry.failStreak} delay=${CHILD_QUARANTINE_MS}ms`);
    delay = CHILD_QUARANTINE_MS;
    entry.streakStartTs = 0;
    entry.failStreak = 0;
  }
  entry.backoffMs = Math.min((entry.backoffMs || CHILD_BACKOFF_INITIAL_MS) * 2, CHILD_BACKOFF_MAX_MS);

  scheduleChildRestart(repoRoot, port, delay);
}

function scheduleChildRestart(repoRoot, port, delay) {
  const entry = children.get(repoRoot) || {};
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  const ms = delay != null ? delay : entry.backoffMs || CHILD_BACKOFF_INITIAL_MS;
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = null;
    if (shuttingDown) return;
    const desiredPort = getPortForRepo(repoRoot);
    if (!desiredPort) {
      log("WARN", `browser restart skipped repo=${repoRoot}: no default_port in config.yml`);
      return;
    }
    spawnBrowserFor(repoRoot, desiredPort);
  }, ms);
  children.set(repoRoot, entry);
  log("INFO", `browser restart scheduled repo=${repoRoot} port=${port} delay=${ms}ms`);
}

function killBrowserFor(repoRoot) {
  const entry = children.get(repoRoot);
  if (!entry) return;
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  const child = entry.child;
  if (!child) {
    children.delete(repoRoot);
    return;
  }
  entry.killing = true;
  // detached=true で spawn しているため process group leader。負の pid で signal 送ると
  // process group 全体 (backlog CLI + それが内部 spawn した darwin-arm64 binary) に伝わる。
  const pgid = child.pid;
  const signalGroup = (sig) => {
    try {
      process.kill(-pgid, sig);
    } catch (_error) {
      // group が既に消えている場合 (ESRCH) は許容
    }
  };
  signalGroup("SIGTERM");
  const timeout = setTimeout(() => {
    if (entry.child && !entry.child.killed) {
      signalGroup("SIGKILL");
      log("WARN", `SIGKILL sent to repo=${repoRoot}`);
    }
  }, CHILD_KILL_GRACE_MS);
  child.once("exit", () => {
    clearTimeout(timeout);
    children.delete(repoRoot);
  });
}

function reconcileChildren() {
  if (shuttingDown) return;
  const desired = new Set(discoverRepos());
  for (const [repoRoot, entry] of children) {
    if (!desired.has(repoRoot)) {
      log("INFO", `browser reconcile drop repo=${repoRoot}`);
      killBrowserFor(repoRoot);
    }
  }
  for (const repoRoot of desired) {
    const port = getPortForRepo(repoRoot);
    if (!port) {
      const existing = children.get(repoRoot);
      if (existing && existing.child) killBrowserFor(repoRoot);
      continue;
    }
    const existing = children.get(repoRoot);
    if (!existing || !existing.child) {
      spawnBrowserFor(repoRoot, port);
    } else if (existing.port !== port) {
      log("INFO", `browser port changed repo=${repoRoot} from=${existing.port} to=${port}`);
      killBrowserFor(repoRoot);
      // exit handler で restart 復元、ただし port 変更後の port を pickup させたい。
      // killBrowserFor で children から削除されるため、削除後 spawn を予約する。
      setTimeout(() => {
        if (!shuttingDown && !children.get(repoRoot)) spawnBrowserFor(repoRoot, port);
      }, CHILD_KILL_GRACE_MS + 500);
    }
  }
}

function scheduleReconcile(reason) {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    log("INFO", `reconcile trigger=${reason}`);
    reconcileChildren();
  }, RECONCILE_DEBOUNCE_MS);
}

function watchHubConfig() {
  const configPath = HUB_CONFIG;
  const parent = path.dirname(configPath);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (_error) { /* noop */ }
  try {
    fs.watch(configPath, { persistent: false }, () => scheduleReconcile("config-change")).unref();
    log("INFO", `watching hub config: ${configPath}`);
  } catch (error) {
    log("WARN", `fs.watch failed for ${configPath}: ${error.message}`);
  }
}

function killAllChildrenSync(deadline) {
  for (const repoRoot of Array.from(children.keys())) {
    killBrowserFor(repoRoot);
  }
  // 実際の exit 待ちは caller の setTimeout で担保 (Node は sync に待てない)
}

function taskDirs(repoRoot) {
  return [
    { dir: path.join(repoRoot, "backlog", "tasks"), completed: false },
    { dir: path.join(repoRoot, "backlog", "completed"), completed: true },
  ];
}

function listTaskFiles(repoRoot) {
  const files = [];
  for (const { dir, completed } of taskDirs(repoRoot)) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({ file: path.join(dir, entry.name), completed });
      }
    }
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return files;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "[]" || value === "") return value === "[]" ? [] : "";
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineList(value.slice(1, -1)).map(parseScalar).filter((item) => item !== "");
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function splitInlineList(value) {
  const items = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = "";
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function stripBlockIndent(lines) {
  const indents = lines.filter((line) => line.trim()).map(countIndent);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(minIndent, line.length)));
}

function parseBlockScalar(lines, startIndex, keyIndent, mode) {
  const block = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() && countIndent(line) <= keyIndent && /^[^\s][^:]*:/.test(line)) {
      break;
    }
    block.push(line);
    index += 1;
  }
  const stripped = stripBlockIndent(block);
  const text = mode.startsWith("|")
    ? stripped.join("\n").trimEnd()
    : stripped.map((line) => line.trim()).filter(Boolean).join(" ");
  return { value: text, nextIndex: index };
}

function parseBlockList(lines, startIndex, keyIndent) {
  const items = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (countIndent(line) <= keyIndent && /^[^\s][^:]*:/.test(line)) {
      break;
    }
    const match = line.match(/^\s*-\s+(.*)$/);
    if (match) items.push(parseScalar(match[1]));
    index += 1;
  }
  return { value: items, nextIndex: index };
}

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return null;

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) return null;

  const meta = {};
  const fm = lines.slice(1, end);
  let index = 0;
  while (index < fm.length) {
    const line = fm[index];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) {
      index += 1;
      continue;
    }

    const key = match[2];
    const rawValue = match[3] || "";
    const keyIndent = match[1].length;
    if (!TASK_KEYS.has(key)) {
      index += 1;
      continue;
    }
    if (/^[>|]/.test(rawValue.trim())) {
      const parsed = parseBlockScalar(fm, index + 1, keyIndent, rawValue.trim());
      meta[key] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (rawValue.trim() === "") {
      const parsed = parseBlockList(fm, index + 1, keyIndent);
      meta[key] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    meta[key] = parseScalar(rawValue);
    index += 1;
  }
  return meta;
}

function normalizeLabels(labels) {
  if (Array.isArray(labels)) {
    return labels.map((label) => String(label).trim()).filter(Boolean);
  }
  if (typeof labels === "string" && labels.trim()) {
    return [labels.trim()];
  }
  return [];
}

function parseTaskFile(file, completed) {
  const meta = parseFrontmatter(fs.readFileSync(file, "utf8"));
  if (!meta || !meta.id) return null;
  return {
    id: String(meta.id),
    title: String(meta.title || meta.id),
    status: String(meta.status || (completed ? "Done" : "To Do")),
    assignee: Array.isArray(meta.assignee) ? meta.assignee : meta.assignee || [],
    labels: normalizeLabels(meta.labels),
    priority: meta.priority ? String(meta.priority) : "",
    ordinal: Number.isFinite(meta.ordinal) ? meta.ordinal : Number(meta.ordinal || 0),
    created_date: meta.created_date ? String(meta.created_date) : "",
    updated_date: meta.updated_date ? String(meta.updated_date) : "",
    milestone: meta.milestone ? String(meta.milestone).trim() : "",
    completed,
    path: file,
  };
}

function loadMilestones(repoRoot) {
  const now = Date.now();
  const cache = milestoneCache.get(repoRoot);
  if (cache && now < cache.expiresAt) return cache.milestones;
  const dir = path.join(repoRoot, "backlog", "milestones");
  const milestones = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    milestoneCache.set(repoRoot, { expiresAt: now + MILESTONE_TTL_MS, milestones });
    return milestones;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (_err) {
      continue;
    }
    const meta = parseFrontmatter(content) || {};
    const idMatch = entry.match(/^(m-\d+)\b/);
    const id = meta.id ? String(meta.id) : idMatch ? idMatch[1] : entry.replace(/\.md$/, "");
    let title = meta.title ? String(meta.title) : "";
    if (!title) {
      const stem = entry.replace(/\.md$/, "").replace(/^m-\d+\s-\s/, "");
      title = stem.replace(/-/g, " ");
    }
    milestones.push({ id, title });
  }
  milestones.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  milestoneCache.set(repoRoot, { expiresAt: now + MILESTONE_TTL_MS, milestones });
  return milestones;
}

function loadTasks(repoRoot) {
  const now = Date.now();
  const cache = taskCache.get(repoRoot) || { expiresAt: 0, files: new Map(), tasks: [] };
  if (now < cache.expiresAt) return cache.tasks;

  const nextFiles = new Map();
  const tasks = [];
  for (const { file, completed } of listTaskFiles(repoRoot)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_error) {
      continue;
    }
    const previous = cache.files.get(file);
    const signature = `${stat.mtimeMs}:${stat.size}:${completed ? 1 : 0}`;
    let task = previous && previous.signature === signature ? previous.task : null;
    if (!task) {
      task = parseTaskFile(file, completed);
    }
    if (task) {
      nextFiles.set(file, { signature, task });
      tasks.push(task);
    }
  }

  tasks.sort((a, b) => {
    const dateCompare = String(b.updated_date).localeCompare(String(a.updated_date));
    if (dateCompare) return dateCompare;
    return String(a.id).localeCompare(String(b.id));
  });
  const nextCache = { expiresAt: now + TASK_TTL_MS, files: nextFiles, tasks };
  taskCache.set(repoRoot, nextCache);
  return tasks;
}

function hostFromRequest(req) {
  const rawHost = req.headers.host || "";
  let host = rawHost.startsWith("[") ? rawHost.slice(1, rawHost.indexOf("]")) : rawHost.split(":")[0];
  if (!host || !/^[A-Za-z0-9_.:-]+$/.test(host)) {
    log("WARN", `invalid Host header; fallback to 127.0.0.1: ${rawHost}`);
    host = "127.0.0.1";
  }
  return host;
}

function browserUrlFor(host, port) {
  return `http://${host}:${port}/`;
}

function taskUrlFor(repoUrl, taskId) {
  return `${repoUrl}tasks/${encodeURIComponent(taskId)}`;
}

function buildData(req) {
  const host = hostFromRequest(req);
  const repos = discoverRepos().map((root) => {
    const port = getPortForRepo(root);
    const browserUrl = port ? browserUrlFor(host, port) : "";
    const tasks = loadTasks(root).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignee: task.assignee,
      labels: task.labels,
      priority: task.priority,
      ordinal: task.ordinal,
      created_date: task.created_date,
      updated_date: task.updated_date,
      milestone: task.milestone || "",
      completed: task.completed,
      browser_url: browserUrl ? taskUrlFor(browserUrl, task.id) : "",
    }));
    return {
      name: repoName(root),
      root,
      port,
      browser_url: browserUrl,
      milestones: loadMilestones(root),
      tasks,
    };
  });
  return { generated_at: new Date().toISOString(), repos };
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function handleRequest(req, res) {
  try {
    if (req.method !== "GET") {
      send(res, 405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }

    const requestUrl = new URL(req.url, "http://127.0.0.1");
    if (requestUrl.pathname === "/healthz") {
      send(res, 200, "text/plain; charset=utf-8", "ok");
      return;
    }
    if (requestUrl.pathname === "/api/tasks") {
      sendJson(res, 200, buildData(req));
      return;
    }
    if (requestUrl.pathname === "/") {
      send(res, 200, "text/html; charset=utf-8", renderHtml());
      return;
    }
    send(res, 404, "text/plain; charset=utf-8", "not found");
  } catch (error) {
    log("ERROR", error && error.stack ? error.stack : String(error));
    sendJson(res, 500, { error: "internal error" });
  }
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backlog.md Hub</title>
<style>
/* ============================================================
   Backlog.md Hub v2 — full stylesheet
   light = :root defaults / dark = prefers-color-scheme OR [data-theme="dark"]
   ============================================================ */
:root {
  color-scheme: light dark;
  /* light theme */
  --bg: #f4f4f6;
  --panel: #ffffff;        /* repo section / sidebar */
  --well: #eef0f2;         /* kanban column background */
  --card: #ffffff;
  --line: #e2e4e9;
  --line-strong: #cdd1d8;
  --text: #191b1e;
  --muted: #676d76;
  --faint: #989ea7;
  --accent: #3465cf;
  --accent-soft: rgba(52, 101, 207, .09);
  --todo: #7b828c;
  --inprog: #b07f1a;
  --done: #2e8757;
  --high: #c06a14;
  --high-bg: rgba(192, 106, 20, .07);
  --critical: #cc3d3d;
  --critical-bg: rgba(204, 61, 61, .06);
  --label-bg: rgba(46, 135, 87, .10);
  --label-fg: #2e6e4c;
  --shadow: 0 1px 2px rgba(20, 24, 30, .06);
}
[data-theme="dark"] {
  --bg: #0c0d0f;
  --panel: #121417;
  --well: #0e1013;
  --card: #17191e;
  --line: rgba(255, 255, 255, .075);
  --line-strong: rgba(255, 255, 255, .14);
  --text: #e8eaed;
  --muted: #979da7;
  --faint: #676d76;
  --accent: #6f9bf5;
  --accent-soft: rgba(111, 155, 245, .13);
  --todo: #9aa1ab;
  --inprog: #e0b04b;
  --done: #56b280;
  --high: #e8964e;
  --high-bg: rgba(232, 150, 78, .07);
  --critical: #e46262;
  --critical-bg: rgba(228, 98, 98, .08);
  --label-bg: rgba(86, 178, 128, .13);
  --label-fg: #7cc39c;
  --shadow: none;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0c0d0f;
    --panel: #121417;
    --well: #0e1013;
    --card: #17191e;
    --line: rgba(255, 255, 255, .075);
    --line-strong: rgba(255, 255, 255, .14);
    --text: #e8eaed;
    --muted: #979da7;
    --faint: #676d76;
    --accent: #6f9bf5;
    --accent-soft: rgba(111, 155, 245, .13);
    --todo: #9aa1ab;
    --inprog: #e0b04b;
    --done: #56b280;
    --high: #e8964e;
    --high-bg: rgba(232, 150, 78, .07);
    --critical: #e46262;
    --critical-bg: rgba(228, 98, 98, .08);
    --label-bg: rgba(86, 178, 128, .13);
    --label-fg: #7cc39c;
    --shadow: none;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.35;
  font-size: 13px;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ---------- layout ---------- */
.layout {
  display: grid;
  grid-template-columns: 236px 1fr;
  min-height: 100vh;
}
main { padding: 12px 14px 24px; min-width: 0; }

/* ---------- topbar (mobile only) ---------- */
.topbar {
  display: none;
  position: sticky; top: 0; z-index: 30;
  align-items: center; gap: 10px;
  height: 48px; padding: 0 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
.topbar h1 { font-size: 15px; margin: 0; flex: 1; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 36px; min-height: 36px; padding: 4px 8px;
  border: 1px solid var(--line); border-radius: 6px;
  background: transparent; color: var(--muted);
  font: inherit; font-size: 15px; cursor: pointer;
}
.icon-btn:hover { color: var(--text); border-color: var(--line-strong); }
.backdrop {
  display: none;
  position: fixed; inset: 0; z-index: 40;
  background: rgba(0, 0, 0, .45);
}
body.drawer-open .backdrop { display: block; }

/* ---------- sidebar ---------- */
.sidebar {
  border-right: 1px solid var(--line);
  background: var(--panel);
  padding: 16px 14px 20px;
  overflow-y: auto;
  position: sticky; top: 0; max-height: 100vh;
  display: flex; flex-direction: column; gap: 18px;
}
.sidebar-brand {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px;
}
.sidebar-brand h1 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: -.01em; flex: 1; }
.sidebar-brand .icon-btn { min-width: 28px; min-height: 28px; padding: 2px; font-size: 13px; border-color: transparent; }
.sidebar-brand .icon-btn:hover { border-color: transparent; background: var(--accent-soft); }
.sidebar-brand .meta { flex-basis: 100%; }
.meta { color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.sidebar-block { display: flex; flex-direction: column; gap: 8px; }
.sidebar-block h2 {
  margin: 0 0 2px; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .07em; color: var(--faint);
}
input[type="search"] {
  min-height: 30px;
  border: 0;
  background: var(--well);
  color: var(--text);
  border-radius: 7px;
  padding: 4px 10px;
  font: inherit; font-size: 12.5px;
  width: 100%;
}
input::placeholder { color: var(--faint); }
.fgroup { display: flex; flex-direction: column; gap: 4px; }
.fgroup > span { color: var(--muted); font-size: 12px; }
.fgroup-picker { position: relative; }
.frow { display: flex; align-items: center; gap: 8px; min-height: 26px; }
.frow > span { color: var(--muted); font-size: 12px; flex: none; }
.fpicker {
  flex: 1; min-width: 0; min-height: 26px; border: 0;
  background: transparent; color: var(--text); font: inherit; font-size: 12px;
  text-align: right; padding: 0; cursor: pointer;
}
.fpicker:hover { color: var(--accent); }
.fpop {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20;
  max-height: 40vh; overflow-y: auto; padding: 8px;
  border: 1px solid var(--line); border-radius: 7px;
  background: var(--panel); box-shadow: var(--shadow);
}
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips button {
  border: 0; border-radius: 999px; padding: 2px 8px;
  background: var(--well); color: var(--muted);
  font: inherit; font-size: 12px; cursor: pointer;
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: left;
  white-space: normal;
}
.chips button:hover { color: var(--accent); }
.chips button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
#labelFilter { max-height: 30vh; overflow-y: auto; }
/* view tabs: plain text + accent underline */
.tabs { display: flex; gap: 16px; }
.tabs button {
  border: 0; background: transparent; padding: 0 0 4px; min-height: 0;
  font: inherit; font-size: 12.5px; font-weight: 500; color: var(--faint);
  border-bottom: 2px solid transparent; border-radius: 0; cursor: pointer;
}
.tabs button:hover { color: var(--text); }
.tabs button[aria-pressed="true"] { color: var(--text); font-weight: 650; border-bottom-color: var(--accent); }
.summary {
  color: var(--faint); font-size: 11px;
  margin-top: auto; padding-top: 12px;
}
#repoNav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; max-height: 44vh; overflow-y: auto; }
#repoNav button {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 4px 2px; border: 0; border-radius: 5px; min-height: 26px;
  background: transparent; color: var(--muted);
  font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  transition: color .15s;
}
#repoNav .sidebar-repo { overflow-wrap: anywhere; flex: 1; color: var(--text); }
#repoNav .sidebar-count { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
#repoNav button:hover .sidebar-repo { color: var(--accent); }
#repoNav button[aria-pressed="true"] .sidebar-repo { color: var(--accent); font-weight: 650; }
#repoNav button[aria-pressed="true"] .sidebar-count { color: var(--accent); }
#repoNav button.is-empty .sidebar-repo, #repoNav button.is-empty .sidebar-count { color: var(--faint); opacity: .55; }

/* ---------- progress bar ---------- */
.progress {
  display: inline-block; vertical-align: middle;
  width: 56px; height: 3px; border-radius: 2px;
  background: var(--line-strong);
  overflow: hidden;
}
.progress-fill { display: block; height: 100%; background: var(--done); border-radius: 2px; }

/* ---------- repo section ---------- */
.repo-groups { display: flex; flex-direction: column; gap: 12px; }
.repo-section {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.repo-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 5;
}
.repo-header h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
.repo-title-link { color: var(--text); text-decoration: none; }
.repo-title-link:hover { color: var(--accent); }
.repo-title-link .ext { color: var(--faint); font-size: 12px; margin-left: 5px; font-weight: 400; }
.repo-title-link:hover .ext { color: var(--accent); }
.repo-progress {
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ---------- milestone group ---------- */
.milestone-group { border-top: 1px solid var(--line); }
.milestone-group:first-child { border-top: 0; }
.milestone-header {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 5px 12px;
  background: var(--well);
}
.milestone-header h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--muted); }
.milestone-header h3 .ms-id { color: var(--faint); font-variant-numeric: tabular-nums; margin-right: 6px; }
.milestone-progress {
  display: inline-flex; align-items: center; gap: 7px;
  color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ---------- kanban board ---------- */
.board {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px; align-items: start;
  padding: 8px;
}
.column {
  min-width: 0;
  background: var(--well);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px;
}
.column h3 {
  display: flex; align-items: center; gap: 6px;
  margin: 1px 2px 7px;
  font-size: 10.5px; font-weight: 650;
  text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted);
}
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--todo); flex: none; }
.st-inprog .status-dot { background: var(--inprog); }
.st-done .status-dot { background: var(--done); }
.column h3 .count { margin-left: auto; color: var(--faint); font-weight: 500; font-variant-numeric: tabular-nums; }
.column-empty { padding: 4px; text-align: center; color: var(--faint); font-size: 12px; }

/* Done column: visually subdued */
.st-done .task-card { opacity: .62; }
.st-done .task-card:hover, .st-done .task-card:focus { opacity: 1; }

/* ---------- task card ---------- */
.task-card {
  display: block;
  color: inherit; text-decoration: none;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid transparent;
  border-radius: 6px;
  padding: 6px 8px 7px;
  margin-bottom: 6px;
  box-shadow: var(--shadow);
  transition: background .15s, border-color .15s;
}
.task-card:last-child { margin-bottom: 0; }
.task-card:hover, .task-card:focus { border-color: var(--accent); outline: none; }
.task-card.prio-high { border-left-color: var(--high); background: var(--high-bg); }
.task-card.prio-critical { border-left-color: var(--critical); background: var(--critical-bg); }
.card-top { display: flex; align-items: baseline; gap: 8px; }
.task-id { color: var(--faint); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.prio { margin-left: auto; font-size: 10.5px; color: var(--faint); }
.prio.high { color: var(--high); font-weight: 650; }
.prio.critical { color: var(--critical); font-weight: 650; text-transform: uppercase; letter-spacing: .03em; }
.task-title {
  font-weight: 500; font-size: 12.5px; line-height: 1.4;
  overflow-wrap: anywhere;
  margin: 2px 0 0;
}
.card-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 5px; }
.label {
  max-width: 100%;
  background: var(--label-bg); color: var(--label-fg);
  border-radius: 4px; padding: 1px 5px;
  font-size: 10.5px; line-height: 1.5;
  overflow-wrap: anywhere;
}
.date { margin-left: auto; color: var(--faint); font-size: 10.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* ---------- list view ---------- */
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
table { width: 100%; border-collapse: collapse; min-width: 860px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; font-size: 12.5px; }
th { background: var(--well); color: var(--muted); font-weight: 650; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
td a { color: var(--accent); text-decoration: none; font-weight: 600; }
.empty, .error { padding: 20px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; color: var(--muted); }
.error { color: var(--critical); }

/* ---------- responsive ---------- */
@media (max-width: 920px) {
  .layout { grid-template-columns: 1fr; }
  .topbar { display: flex; }
  main { padding: 10px 10px 20px; }
  .repo-header { top: 48px; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 50;
    width: min(300px, 85vw); max-height: none;
    border-right: 1px solid var(--line);
    transform: translateX(-102%);
    transition: transform .2s ease;
  }
  body.drawer-open .sidebar { transform: translateX(0); }
  body.drawer-open { overflow: hidden; }
}
@media (max-width: 810px) {
  .board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .column.st-done { grid-column: 1 / -1; }
}
@media (max-width: 480px) {
  .board { grid-template-columns: 1fr; gap: 6px; padding: 6px; }
  .column.st-done { grid-column: auto; }
  .repo-header h2 { font-size: 14px; }
}
</style>
</head>
<body>
<header class="topbar">
  <button id="drawerBtn" class="icon-btn" aria-label="Open filters" aria-expanded="false">&#9776;</button>
  <h1>Backlog.md Hub</h1>
  <button class="icon-btn theme-toggle" aria-label="Toggle theme">&#9681;</button>
</header>
<div class="backdrop" id="backdrop"></div>
<div class="layout">
  <aside class="sidebar" aria-label="Sidebar">
    <div class="sidebar-brand">
      <h1>Backlog.md Hub</h1>
      <button class="icon-btn theme-toggle" aria-label="Toggle theme">&#9681;</button>
      <div class="meta" id="meta">Loading</div>
    </div>
    <input id="textFilter" type="search" autocomplete="off" placeholder="Filter tasks&hellip;" aria-label="Search">
    <div class="tabs" role="group" aria-label="View">
      <button id="boardTab" type="button" aria-pressed="true">Board</button>
      <button id="listTab" type="button" aria-pressed="false">List</button>
    </div>
    <section class="sidebar-block" aria-label="Repositories">
      <h2>Repos</h2>
      <ul id="repoNav"></ul>
    </section>
    <section class="sidebar-block" aria-label="Filters">
      <h2>Filter</h2>
      <div class="fgroup"><span>Status</span><div class="chips" id="statusFilter" role="group" aria-label="Status"></div></div>
      <div class="fgroup"><span>Priority</span><div class="chips" id="priorityFilter" role="group" aria-label="Priority"></div></div>
      <div class="fgroup fgroup-picker">
        <div class="frow">
          <span>Label</span>
          <button type="button" id="labelPickerBtn" class="fpicker" aria-haspopup="listbox" aria-expanded="false" aria-controls="labelPickerPop">All ▾</button>
        </div>
        <div id="labelPickerPop" class="fpop" hidden>
          <div class="chips" id="labelFilter" role="listbox" aria-multiselectable="true" aria-label="Label"></div>
        </div>
      </div>
    </section>
    <div class="summary" id="summary"></div>
  </aside>
  <main>
    <section id="content" aria-live="polite"><div class="empty">Loading tasks</div></section>
  </main>
</div>
<script>
const state = { data: null, view: "board", error: "", repoSel: new Set(), statusSel: new Set(), labelSel: new Set(), prioritySel: new Set(), labelPickerOpen: false };
const statusColumns = ${JSON.stringify(STATUSES)};
const STATUS_KEYS = { "To Do": "todo", "In Progress": "inprog", "Done": "done" };
const els = {
  meta: document.getElementById("meta"),
  summary: document.getElementById("summary"),
  content: document.getElementById("content"),
  text: document.getElementById("textFilter"),
  status: document.getElementById("statusFilter"),
  label: document.getElementById("labelFilter"),
  priority: document.getElementById("priorityFilter"),
  labelPickerBtn: document.getElementById("labelPickerBtn"),
  labelPickerPop: document.getElementById("labelPickerPop"),
  boardTab: document.getElementById("boardTab"),
  listTab: document.getElementById("listTab"),
  nav: document.getElementById("repoNav")
};
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function shortDate(value) {
  const str = String(value || "");
  const year = String(new Date().getFullYear());
  return str.startsWith(year + "-") ? str.slice(5) : str;
}
// task file の labels フィールドが誤った YAML list 記法で保存された残骸
// (例: '["慶應"', '"データスキーマ"', '"マイルストーン"]') を chip 化して表示すると
// 見た目が破綻するため、hub 側で防御的に正規化する。
function normLabel(value) {
  return String(value == null ? "" : value).replace(/[\[\]"']/g, "").trim();
}
function allTasks() {
  if (!state.data) return [];
  return state.data.repos.flatMap((repo) => repo.tasks.map((task) => ({
    ...task,
    labels: [...new Set((task.labels || []).map(normLabel).filter(Boolean))],
    repo: repo.name,
    repo_url: repo.browser_url,
  })));
}
function normalizeStatus(task) {
  if (task.completed || task.status === "Done") return "Done";
  if (task.status === "In Progress") return "In Progress";
  return "To Do";
}
function filteredTasks(ignoreRepoSel = false) {
  const text = els.text.value.trim().toLowerCase();
  return allTasks().filter((task) => {
    const haystack = [task.id, task.title, task.repo, task.status, task.priority, ...(task.labels || [])].join(" ").toLowerCase();
    if (!ignoreRepoSel && state.repoSel.size && !state.repoSel.has(task.repo)) return false;
    if (state.statusSel.size && !state.statusSel.has(normalizeStatus(task))) return false;
    if (state.labelSel.size && !(task.labels || []).some((label) => state.labelSel.has(label))) return false;
    if (state.prioritySel.size && !state.prioritySel.has(task.priority)) return false;
    if (text && !haystack.includes(text)) return false;
    return true;
  });
}
function renderFilterChips() {
  const tasks = allTasks();
  const chipFilters = [
    [els.status, state.statusSel, statusColumns],
    [els.priority, state.prioritySel, [...new Set(tasks.map((task) => task.priority).filter(Boolean))].sort()]
  ];
  chipFilters.forEach(([container, selected, values]) => {
    selected.forEach((value) => { if (!values.includes(value)) selected.delete(value); });
    container.innerHTML = values.map((value) => '<button type="button" data-value="' + esc(value) + '" aria-pressed="' + selected.has(value) + '">' + esc(value) + '</button>').join("");
  });
  const labels = [...new Set(tasks.flatMap((task) => task.labels || []))].filter(Boolean).sort();
  state.labelSel.forEach((value) => { if (!labels.includes(value)) state.labelSel.delete(value); });
  els.label.innerHTML = labels.map((value) => '<button type="button" data-value="' + esc(value) + '" aria-pressed="' + state.labelSel.has(value) + '">' + esc(value) + '</button>').join("");
  els.labelPickerBtn.textContent = state.labelSel.size === 0 ? "All ▾" : state.labelSel.size === 1 ? [...state.labelSel][0] + " ▾" : state.labelSel.size + " selected ▾";
  els.labelPickerBtn.setAttribute("aria-expanded", String(state.labelPickerOpen));
  els.labelPickerPop.hidden = !state.labelPickerOpen;
}
function render() {
  if (state.error) {
    els.content.innerHTML = '<div class="error">' + esc(state.error) + '</div>';
    return;
  }
  if (!state.data) return;
  renderFilterChips();
  const tasks = filteredTasks();
  els.meta.textContent = "Updated " + new Date(state.data.generated_at).toLocaleString();
  els.summary.textContent = allTasks().length + " tasks · " + tasks.length + " visible";
  els.boardTab.setAttribute("aria-pressed", String(state.view === "board"));
  els.listTab.setAttribute("aria-pressed", String(state.view === "list"));
  if (!tasks.length) {
    els.content.innerHTML = '<div class="empty">No tasks match the filters</div>';
    renderSidebar(filteredTasks(true));
    return;
  }
  if (state.view === "board") {
    els.content.innerHTML = renderBoard(tasks);
  } else {
    els.content.innerHTML = renderList(tasks);
  }
  renderSidebar(filteredTasks(true));
}
function repoAnchor(name) {
  return "repo-" + String(name).replace(/[^a-zA-Z0-9_-]/g, "-");
}
function renderSidebar(tasks) {
  if (!els.nav) return;
  const repoOrder = (state.data?.repos || []).map((repo) => repo.name);
  const counts = new Map();
  tasks.forEach((task) => { counts.set(task.repo, (counts.get(task.repo) || 0) + 1); });
  els.nav.innerHTML = repoOrder.map((name) => {
    const count = counts.get(name) || 0;
    const selected = state.repoSel.has(name);
    const cls = (!count && !selected) ? ' class="is-empty"' : '';
    return '<li><button type="button"' + cls + ' data-repo="' + esc(name) + '" aria-pressed="' + selected + '"><span class="sidebar-repo">' + esc(name) + '</span><span class="sidebar-count">' + count + '</span></button></li>';
  }).join("");
}
function renderBoard(tasks) {
  const repoOrder = (state.data?.repos || []).map((repo) => repo.name);
  const repoMeta = new Map((state.data?.repos || []).map((repo) => [repo.name, repo]));
  const grouped = new Map();
  tasks.forEach((task) => {
    if (!grouped.has(task.repo)) grouped.set(task.repo, []);
    grouped.get(task.repo).push(task);
  });
  const names = repoOrder.filter((name) => grouped.has(name));
  return '<div class="repo-groups">' + names.map((name) => {
    const items = grouped.get(name);
    const done = items.filter((task) => normalizeStatus(task) === "Done").length;
    const total = items.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const meta = repoMeta.get(name);
    const headerTitle = meta && meta.browser_url
      ? '<a class="repo-title-link" href="' + esc(meta.browser_url) + '" target="_blank" rel="noreferrer">' + esc(name) + '<span class="ext">&#8599;</span></a>'
      : '<span class="repo-title-link">' + esc(name) + '</span>';
    return '<section id="' + esc(repoAnchor(name)) + '" class="repo-section">' +
      '<header class="repo-header"><h2>' + headerTitle + '</h2>' +
      '<span class="repo-progress"><span class="progress"><span class="progress-fill" style="width:' + pct + '%"></span></span>' + done + '/' + total + ' done</span></header>' +
      renderMilestoneGroups(items, meta) +
    '</section>';
  }).join("") + '</div>';
}
function renderMilestoneGroups(items, repoMeta) {
  const milestoneList = (repoMeta && repoMeta.milestones) || [];
  const titleById = new Map(milestoneList.map((m) => [m.id, m.title]));
  const buckets = new Map();
  items.forEach((task) => {
    const key = task.milestone || "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(task);
  });
  const declaredIds = milestoneList.map((m) => m.id).filter((id) => buckets.has(id));
  const declaredSet = new Set(declaredIds);
  const extras = [...buckets.keys()].filter((k) => k && !declaredSet.has(k)).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const orderedKeys = [...declaredIds, ...extras];
  if (buckets.has("")) orderedKeys.push("");
  if (orderedKeys.length === 1 && orderedKeys[0] === "") {
    return renderStatusBoard(buckets.get(""));
  }
  return orderedKeys.map((key) => {
    const sub = buckets.get(key);
    const label = key
      ? '<span class="ms-id">' + esc(key) + '</span>' + (titleById.get(key) ? esc(titleById.get(key)) : '')
      : 'No milestone';
    const done = sub.filter((task) => normalizeStatus(task) === "Done").length;
    const pct = sub.length ? Math.round((done / sub.length) * 100) : 0;
    return '<div class="milestone-group">' +
      '<header class="milestone-header"><h3>' + label + '</h3>' +
      '<span class="milestone-progress"><span class="progress"><span class="progress-fill" style="width:' + pct + '%"></span></span>' + done + '/' + sub.length + '</span></header>' +
      renderStatusBoard(sub) +
    '</div>';
  }).join("");
}
function renderStatusBoard(items) {
  const columns = statusColumns.map((status) => {
    const sub = items.filter((task) => normalizeStatus(task) === status);
    const cards = sub.map(renderCard).join("") || '<div class="column-empty">&ndash;</div>';
    return '<section class="column st-' + STATUS_KEYS[status] + '"><h3><span class="status-dot"></span>' + esc(status) + '<span class="count">' + sub.length + '</span></h3>' + cards + '</section>';
  }).join("");
  return '<div class="board">' + columns + '</div>';
}
function renderCard(task) {
  const labels = (task.labels || []).slice(0, 4).map((label) => '<span class="label">' + esc(label) + '</span>').join("");
  const p = String(task.priority || "").toLowerCase();
  const flagged = p === "high" || p === "critical";
  const prio = task.priority ? '<span class="prio' + (flagged ? ' ' + esc(p) : '') + '">' + esc(task.priority) + '</span>' : '';
  return '<a class="task-card' + (flagged ? ' prio-' + esc(p) : '') + '" href="' + esc(task.browser_url || task.repo_url || "#") + '" target="_blank" rel="noreferrer">' +
    '<div class="card-top"><span class="task-id">' + esc(task.id) + '</span>' + prio + '</div>' +
    '<div class="task-title">' + esc(task.title) + '</div>' +
    ((labels || task.updated_date || task.created_date) ? '<div class="card-meta">' + labels + '<span class="date">' + esc(shortDate(task.updated_date || task.created_date || "")) + '</span></div>' : '') +
    '</a>';
}
function renderList(tasks) {
  const sorted = [...tasks].sort((a, b) => String(b.updated_date).localeCompare(String(a.updated_date)));
  return '<div class="table-wrap"><table><thead><tr><th>Task</th><th>Repo</th><th>Status</th><th>Priority</th><th>Labels</th><th>Updated</th></tr></thead><tbody>' +
    sorted.map((task) => '<tr><td><a href="' + esc(task.browser_url || task.repo_url || "#") + '" target="_blank" rel="noreferrer">' + esc(task.id) + '</a> ' + esc(task.title) + '</td><td>' + esc(task.repo) + '</td><td>' + esc(task.status) + '</td><td>' + esc(task.priority) + '</td><td>' + esc((task.labels || []).join(", ")) + '</td><td>' + esc(task.updated_date || task.created_date || "") + '</td></tr>').join("") +
    '</tbody></table></div>';
}
async function load() {
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    state.data = await response.json();
    state.error = "";
    render();
  } catch (error) {
    state.error = "Failed to load tasks: " + error.message;
    render();
  }
}
els.text.addEventListener("input", render);
els.nav.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-repo]");
  if (!btn) return;
  const name = btn.dataset.repo;
  if (state.repoSel.has(name)) state.repoSel.delete(name); else state.repoSel.add(name);
  render();
});
[[els.status, state.statusSel], [els.label, state.labelSel], [els.priority, state.prioritySel]].forEach(([container, selected]) => {
  container.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-value]");
    if (!btn) return;
    const value = btn.dataset.value;
    if (selected.has(value)) selected.delete(value); else selected.add(value);
    render();
  });
});
els.labelPickerBtn.addEventListener("click", () => {
  state.labelPickerOpen = !state.labelPickerOpen;
  render();
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Node) || !event.target.isConnected) return;
  if (state.labelPickerOpen && !event.target.closest("#labelPickerBtn, #labelPickerPop")) {
    state.labelPickerOpen = false;
    render();
  }
});
document.addEventListener("keydown", (event) => {
  if (state.labelPickerOpen && event.key === "Escape") {
    state.labelPickerOpen = false;
    render();
  }
});
els.boardTab.addEventListener("click", () => { state.view = "board"; render(); });
els.listTab.addEventListener("click", () => { state.view = "list"; render(); });
load();
setInterval(load, 30000);

/* ============ theme toggle (system default + manual override) ============ */
(function () {
  const KEY = "backlog-hub-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  function apply(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }
  function effective() {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
    return media.matches ? "dark" : "light";
  }
  apply(localStorage.getItem(KEY));
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = effective() === "dark" ? "light" : "dark";
      localStorage.setItem(KEY, next);
      apply(next);
    });
  });
  media.addEventListener("change", () => { if (!localStorage.getItem(KEY)) apply(null); });
})();

/* ============ mobile filter drawer ============ */
(function () {
  const btn = document.getElementById("drawerBtn");
  const backdrop = document.getElementById("backdrop");
  function setOpen(open) {
    document.body.classList.toggle("drawer-open", open);
    btn.setAttribute("aria-expanded", String(open));
  }
  btn.addEventListener("click", () => setOpen(!document.body.classList.contains("drawer-open")));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setOpen(false); });
})();
</script>
</body>
</html>
`;
}

const listenerManager = new ListenerManager({
  createServer: (handler) => http.createServer(handler),
  requestHandler: handleRequest,
  port: PORT,
  primaryHost: HOST,
  tailscaleListen: TAILSCALE_LISTEN,
  log,
});

listenerManager.start(() => {
  if (process.env.BACKLOG_HUB_MANAGE_BROWSERS === "1") {
    watchHubConfig();
    scheduleReconcile("startup");
  } else {
    log("INFO", "child-manager disabled (set BACKLOG_HUB_MANAGE_BROWSERS=1 to enable)");
  }
});

function shutdown(signal) {
  log("INFO", `${signal} received; closing backlog hub`);
  shuttingDown = true;
  killAllChildrenSync();
  listenerManager.closeAll(() => {
    // 子の grace kill 完了まで待つ (最大 CHILD_KILL_GRACE_MS + 1s)
    setTimeout(() => process.exit(0), CHILD_KILL_GRACE_MS + 1_000).unref();
  });
  setTimeout(() => process.exit(1), CHILD_KILL_GRACE_MS + 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
