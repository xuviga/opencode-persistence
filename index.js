/**
 * opencode-persistence v4.2 — SQLite-backed Autonomous Memory (Bun native)
 *
 * Single file. SQLite DB via bun:sqlite. FTS5 full-text search. No native modules.
 * Auto-flush 30s. Crash-safe flush. Smart digest. Full self-awareness.
 */

import { Database } from "bun:sqlite"
import { mkdir } from "fs/promises"
import path from "path"
import os from "os"

const MEMORY_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "opencode", "memory")
const DB_PATH = path.join(MEMORY_DIR, "memory.db")
const LEGACY_DB = path.join(MEMORY_DIR, "memory.db")

let db = null
let autoSaveTimer = null

// ─── FTS5 helper ────────────────────────────────────────────────

function fts5Available(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_test USING fts5(x)")
    db.exec("DROP TABLE IF EXISTS _fts_test")
    return true
  } catch { return false }
}

// ─── Storage init ───────────────────────────────────────────────

async function ensureStorage() {
  await mkdir(MEMORY_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")

  const hasFTS5 = fts5Available(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK (id=1), name TEXT NOT NULL, role TEXT NOT NULL, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, status TEXT DEFAULT 'active', agent TEXT, model_provider TEXT, model_id TEXT, project_dir TEXT, tool_count INTEGER DEFAULT 0, action_count INTEGER DEFAULT 0, dialog_count INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, summary TEXT NOT NULL, session_id TEXT, tool TEXT, call_id TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS dialog (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, role TEXT DEFAULT 'user', session_id TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS assistant_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tool_calls TEXT, session_id TEXT, message_id TEXT, model TEXT, agent TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS context (id INTEGER PRIMARY KEY CHECK (id=1), summary TEXT, next_steps TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, value TEXT NOT NULL, count INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), UNIQUE(category, value));
    CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL, source TEXT, session_id TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(fact));
    CREATE TABLE IF NOT EXISTS file_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, session_id TEXT, change_type TEXT DEFAULT 'edit', additions INTEGER DEFAULT 0, deletions INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, todos_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS session_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, error_type TEXT NOT NULL, message TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, message_id TEXT, snapshot TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS patches (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, message_id TEXT, hash TEXT NOT NULL, files TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS config_history (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, key TEXT NOT NULL, value TEXT, changed_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS archive (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_data TEXT NOT NULL, archived_at TEXT DEFAULT (datetime('now')), original_created_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
    CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at);
    CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);
    CREATE INDEX IF NOT EXISTS idx_dialog_created ON dialog(created_at);
    CREATE INDEX IF NOT EXISTS idx_dialog_session ON dialog(session_id);
    CREATE INDEX IF NOT EXISTS idx_replies_created ON assistant_replies(created_at);
    CREATE INDEX IF NOT EXISTS idx_replies_session ON assistant_replies(session_id);
    CREATE INDEX IF NOT EXISTS idx_file_changes_file ON file_changes(file);
    CREATE INDEX IF NOT EXISTS idx_file_changes_created ON file_changes(created_at);
    CREATE INDEX IF NOT EXISTS idx_errors_created ON session_errors(created_at);
    CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
    CREATE INDEX IF NOT EXISTS idx_config_session ON config_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_archive_table ON archive(table_name);
  `)

  // FTS5 virtual tables (if available)
  if (hasFTS5) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_actions USING fts5(summary, content='actions', content_rowid='id', tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_dialog USING fts5(text, content='dialog', content_rowid='id', tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_replies USING fts5(text, content='assistant_replies', content_rowid='id', tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_knowledge USING fts5(fact, content='knowledge', content_rowid='id', tokenize='porter unicode61');
    `)
    // Triggers to keep FTS5 in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_fts_actions_i AFTER INSERT ON actions BEGIN INSERT INTO fts_actions(rowid, summary) VALUES (new.id, new.summary); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_actions_d AFTER DELETE ON actions BEGIN INSERT INTO fts_actions(fts_actions, rowid, summary) VALUES('delete', old.id, old.summary); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_dialog_i AFTER INSERT ON dialog BEGIN INSERT INTO fts_dialog(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_dialog_d AFTER DELETE ON dialog BEGIN INSERT INTO fts_dialog(fts_dialog, rowid, text) VALUES('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_replies_i AFTER INSERT ON assistant_replies BEGIN INSERT INTO fts_replies(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_replies_d AFTER DELETE ON assistant_replies BEGIN INSERT INTO fts_replies(fts_replies, rowid, text) VALUES('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_knowledge_i AFTER INSERT ON knowledge BEGIN INSERT INTO fts_knowledge(rowid, fact) VALUES (new.id, new.fact); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_knowledge_d AFTER DELETE ON knowledge BEGIN INSERT INTO fts_knowledge(fts_knowledge, rowid, fact) VALUES('delete', old.id, old.fact); END;
    `)
  }

  db.prepare("INSERT OR IGNORE INTO identity (id, name, role, notes) VALUES (1, 'XuViGaN', 'autonomous_agent', ?)")
    .run("Persistence v4.2 SQLite (bun:sqlite). FTS5: " + (hasFTS5 ? "enabled" : "unavailable") + ". Query via memory_* tools.")
  db.prepare("INSERT OR IGNORE INTO context (id, summary, next_steps) VALUES (1, '', '')").run()

  autoSaveTimer = setInterval(() => { flush().catch(() => {}) }, 30_000)
  if (autoSaveTimer.unref) autoSaveTimer.unref()

  // Crash-safe flush
  const cleanup = async () => {
    if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null }
    try { await flush() } catch {}
    try { db?.close() } catch {}
    process.exit(0)
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("exit", () => { try { db?.close() } catch {} })

  return hasFTS5
}

// ─── Mutex ──────────────────────────────────────────────────────

let mutexQueue = Promise.resolve()
function mutex(fn) {
  const r = mutexQueue.then(() => fn())
  mutexQueue = r.catch(() => {})
  return r
}

// ─── Prepared Statements ───────────────────────────────────────

let stmts = {}
function prepareStatements() {
  stmts.iAction = db.prepare("INSERT INTO actions (type, summary, session_id, tool, call_id) VALUES (?, ?, ?, ?, ?)")
  stmts.iDialog = db.prepare("INSERT INTO dialog (text, role, session_id) VALUES (?, ?, ?)")
  stmts.iReply = db.prepare("INSERT INTO assistant_replies (text, tool_calls, session_id, message_id, model, agent) VALUES (?, ?, ?, ?, ?, ?)")
  stmts.iFileChange = db.prepare("INSERT INTO file_changes (file, session_id, change_type, additions, deletions) VALUES (?, ?, ?, ?, ?)")
  stmts.iTodo = db.prepare("INSERT INTO todos (session_id, todos_json) VALUES (?, ?)")
  stmts.iSessionError = db.prepare("INSERT INTO session_errors (session_id, error_type, message) VALUES (?, ?, ?)")
  stmts.iSnapshot = db.prepare("INSERT INTO snapshots (session_id, message_id, snapshot) VALUES (?, ?, ?)")
  stmts.iPatch = db.prepare("INSERT INTO patches (session_id, message_id, hash, files) VALUES (?, ?, ?, ?)")
  stmts.iSession = db.prepare("INSERT OR IGNORE INTO sessions (id, started_at, status, agent, model_provider, model_id, project_dir) VALUES (?, ?, 'active', ?, ?, ?, ?)")
  stmts.uCloseSession = db.prepare("UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE id = ?")
  stmts.uPattern = db.prepare("INSERT INTO patterns (category, value, count) VALUES (?, ?, 1) ON CONFLICT(category, value) DO UPDATE SET count = count + 1, last_seen = datetime('now')")
  stmts.upsertKnowledge = db.prepare("INSERT OR IGNORE INTO knowledge (fact, source, session_id) VALUES (?, ?, ?)")
  stmts.uContext = db.prepare("UPDATE context SET summary = ?, next_steps = ?, updated_at = datetime('now') WHERE id = 1")
  stmts.uSessionMetrics = db.prepare("UPDATE sessions SET tool_count = tool_count + ?, action_count = action_count + ?, dialog_count = dialog_count + ?, error_count = error_count + ? WHERE id = ?")
  stmts.iConfigHistory = db.prepare("INSERT INTO config_history (session_id, key, value) VALUES (?, ?, ?)")
  stmts.iArchive = db.prepare("INSERT INTO archive (table_name, row_data, original_created_at) VALUES (?, ?, ?)")
  stmts.gContext = db.prepare("SELECT * FROM context WHERE id = 1")
  stmts.gIdentity = db.prepare("SELECT * FROM identity WHERE id = 1")
  stmts.gSessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
  stmts.gActions = db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT ?")
  stmts.gErrorActions = db.prepare("SELECT * FROM actions WHERE type = 'error' ORDER BY created_at DESC LIMIT ?")
  stmts.gDialog = db.prepare("SELECT * FROM dialog ORDER BY created_at DESC LIMIT ?")
  stmts.gReplies = db.prepare("SELECT * FROM assistant_replies ORDER BY created_at DESC LIMIT ?")
  stmts.gSessionErrors = db.prepare("SELECT * FROM session_errors ORDER BY created_at DESC LIMIT ?")
  stmts.gDecisions = db.prepare("SELECT * FROM patterns WHERE category = 'decision' ORDER BY count DESC, last_seen DESC LIMIT ?")
  stmts.gKnowledge = db.prepare("SELECT * FROM knowledge ORDER BY created_at DESC LIMIT ?")
  stmts.gFilesAgg = db.prepare("SELECT file, COUNT(*) as edits, SUM(additions) as total_add, SUM(deletions) as total_del, MAX(created_at) as last_edit FROM file_changes GROUP BY file ORDER BY last_edit DESC LIMIT ?")
  stmts.gLatestTodos = db.prepare("SELECT * FROM todos ORDER BY created_at DESC LIMIT 1")
  stmts.sActions = db.prepare("SELECT * FROM actions WHERE (summary LIKE ? OR tool LIKE ?) ORDER BY created_at DESC LIMIT ?")
  stmts.sDialog = db.prepare("SELECT * FROM dialog WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?")
  stmts.sReplies = db.prepare("SELECT * FROM assistant_replies WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?")
  stmts.sKnowledge = db.prepare("SELECT * FROM knowledge WHERE fact LIKE ? ORDER BY created_at DESC LIMIT ?")
  stmts.sFiles = db.prepare("SELECT * FROM file_changes WHERE file LIKE ? ORDER BY created_at DESC LIMIT ?")
  stmts.sErrors = db.prepare("SELECT * FROM session_errors WHERE message LIKE ? ORDER BY created_at DESC LIMIT ?")
  stmts.gErrorsByType = db.prepare("SELECT error_type, COUNT(*) as count, MAX(created_at) as last_seen FROM session_errors GROUP BY error_type ORDER BY count DESC LIMIT ?")
  stmts.gActionsByType = db.prepare("SELECT type, COUNT(*) as count FROM actions GROUP BY type ORDER BY count DESC LIMIT ?")
  stmts.gSessionById = db.prepare("SELECT * FROM sessions WHERE id = ? OR id LIKE ? LIMIT 1")
  stmts.gSessionChain = db.prepare("SELECT * FROM sessions WHERE project_dir = ? AND status != 'active' ORDER BY started_at DESC LIMIT ?")
  stmts.gActionsRange = db.prepare("SELECT * FROM actions WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?")
  stmts.gErrorsRange = db.prepare("SELECT * FROM session_errors WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?")
  stmts.gFilesRange = db.prepare("SELECT * FROM file_changes WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?")
  stmts.gConfigHistory = db.prepare("SELECT * FROM config_history WHERE session_id = ? ORDER BY changed_at DESC LIMIT ?")
  stmts.gSessionMetrics = db.prepare("SELECT * FROM sessions WHERE id = ? OR id LIKE ? LIMIT 1")
  stmts.gStats = db.prepare("SELECT (SELECT COUNT(*) FROM actions) as a, (SELECT COUNT(*) FROM dialog) as d, (SELECT COUNT(*) FROM assistant_replies) as r, (SELECT COUNT(*) FROM sessions) as s, (SELECT COUNT(*) FROM file_changes) as f, (SELECT COUNT(*) FROM knowledge) as k, (SELECT COUNT(*) FROM patterns) as p, (SELECT COUNT(*) FROM session_errors) as se, (SELECT COUNT(*) FROM todos) as t, (SELECT COUNT(*) FROM config_history) as ch, (SELECT COUNT(*) FROM archive) as ar")
  stmts.gOldActions = db.prepare("SELECT * FROM actions WHERE created_at < ? ORDER BY created_at ASC LIMIT ?")
  stmts.gOldDialog = db.prepare("SELECT * FROM dialog WHERE created_at < ? ORDER BY created_at ASC LIMIT ?")
  stmts.gOldReplies = db.prepare("SELECT * FROM assistant_replies WHERE created_at < ? ORDER BY created_at ASC LIMIT ?")
  stmts.dOldActions = db.prepare("DELETE FROM actions WHERE created_at < ? AND id <= ?")
  stmts.dOldDialog = db.prepare("DELETE FROM dialog WHERE created_at < ? AND id <= ?")
  stmts.dOldReplies = db.prepare("DELETE FROM assistant_replies WHERE created_at < ? AND id <= ?")
  stmts.cSession = db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE id = ?")
}

// ─── Text utils ─────────────────────────────────────────────────

function sanitize(text) {
  if (!text) return ""
  let s = String(text)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "").replace(/\s+/g, " ").trim()
}

function short(text, len = 120) {
  const s = sanitize(text)
  return s.length > len ? s.slice(0, len - 1) + "…" : s
}

const RE_NEXT_STEPS = [
  /(?:todo|next|later|remember|fix|need to|must|should)[:\s]+([^\n.]{5,150})/gi,
  /(?:сделать|нужно|надо|дальше|затем|потом|не забудь|запомни|исправить|добавить|убрать|проверить)[:\s]+([^\n.]{5,150})/gi,
]

const RE_DECISIONS = [
  /(?:decided|chose|using|going with|will use|stick with|picked|selected|agreed on|finalized)[:\s]+([^\n.]{5,150})/gi,
  /(?:решили|выбрали|будем использовать|отказались от|остановились на|определились с|зафиксировали|утвердили)[:\s]+([^\n.]{5,150})/gi,
]

const RE_FACTS = [
  /(?:remember|note|important|key|fact|rule|convention|always|never)[:\s]+([^\n.]{5,200})/gi,
  /(?:запомни|важно|факт|правило|конвенция|всегда|никогда|учти|имей в виду)[:\s]+([^\n.]{5,200})/gi,
]

const RE_STRUCT_ERROR = /exit code [1-9]|Traceback \(most recent|SyntaxError|TypeError|ReferenceError|ENOENT|EACCES|EPERM|Segmentation fault|FATAL/
const RE_ERROR_LINE = /^\s*(Error|Exception|Failed|FAIL|FATAL|fatal:)/m
const RE_GENERIC_ERROR = /\b(error|failed|failure|exception|crash|panic|fatal|errno|timeout|denied|refused|not found|404|500|502|503)\b/i

function isGenuineError(toolName, output) {
  if (!output) return false
  const s = String(output).slice(0, 3000)
  if (RE_STRUCT_ERROR.test(s)) return true
  if (RE_ERROR_LINE.test(s)) return true
  if (toolName === "bash" && /^\s*(error|fatal|failed|command not found|is not recognized)/mi.test(s)) return true
  if (RE_GENERIC_ERROR.test(s) && s.length < 400) return true
  return false
}

function extractPatterns(text, patterns) {
  const results = []
  for (const re of patterns) { re.lastIndex = 0; let m; while ((m = re.exec(text)) !== null) { const e = short(m[1], 140); if (e && !results.includes(e)) results.push(e) } }
  return results.slice(0, 5)
}

function textFromParts(parts) { return parts ? parts.filter((p) => p.type === "text").map((p) => p.text).join(" ").trim() : "" }
function fmt(iso) { return iso ? iso.replace("T", " ").slice(0, 19) : "?" }
function epochMs(iso) { return iso ? new Date(iso).getTime() : 0 }

// ─── Digest ─────────────────────────────────────────────────────

async function buildDigest() {
  const lines = [], id = stmts.gIdentity.get(), ctx = stmts.gContext.get(), st = stmts.gStats.get()
    , rs = stmts.gSessions.all(5), ra = stmts.gActions.all(7), rd = stmts.gDialog.all(5)
    , rr = stmts.gReplies.all(3), re = stmts.gSessionErrors.all(5), dec = stmts.gDecisions.all(5)
    , kn = stmts.gKnowledge.all(10), rf = stmts.gFilesAgg.all(8), lt = stmts.gLatestTodos.get()

  lines.push("[AUTONOMOUS PERSISTENCE v4.2] Active. Full self-awareness enabled.")
  lines.push("Use memory_* tools to query this store. All data auto-captured below.")
  lines.push(`Identity: ${id.name} (${id.role})`)
  if (id.notes) lines.push(`Identity notes: ${id.notes}`)
  if (ctx?.summary) lines.push(`Previous session handoff: ${ctx.summary}`)
  if (ctx?.next_steps) { try { const s = JSON.parse(ctx.next_steps); if (s.length) { lines.push("Pending next steps:"); for (const x of s) lines.push(`  - ${x}`) } } catch {} }
  lines.push(`Memory: ${st.s} sessions, ${st.a} actions, ${st.d} dialog, ${st.r} replies, ${st.f} files, ${st.se} errors, ${st.ch} config changes, ${st.ar} archived`)
  if (rs.length) { lines.push("Recent sessions:"); for (const s of rs) { const m = s.model_id ? ` [${s.model_provider}/${s.model_id}]` : ""; const dur = s.ended_at ? `${Math.round((epochMs(s.ended_at) - epochMs(s.started_at)) / 60000)}min` : "running"; lines.push(`  ${s.id.slice(-8)}(${s.status})${m} ${fmt(s.started_at)} → ${dur}, tools:${s.tool_count || 0} acts:${s.action_count || 0} errs:${s.error_count || 0}`) } }
  if (re.length) { lines.push("Recent session errors:"); for (const e of re.slice(0, 3)) lines.push(`  [${e.error_type}] ${short(e.message, 100)} (${fmt(e.created_at)})`) }
  if (ra.length) { lines.push("Latest actions:"); for (const a of ra.slice(0, 5)) lines.push(`  [${a.type}] ${short(a.summary, 100)}`) }
  if (rr.length) { lines.push("My latest replies:"); for (const r of rr.slice(0, 2)) lines.push(`  ${short(r.text, 80)}`) }
  if (rd.length) { lines.push("Recent user requests:"); for (const d of rd.slice(0, 3)) lines.push(`  - ${short(d.text, 120)}`) }
  if (rf.length) lines.push(`Recently edited files: ${rf.map((f) => `${f.file}(${f.edits}x)`).join(", ")}`)
  if (lt?.todos_json) { try { const tl = JSON.parse(lt.todos_json); const ac = tl.filter((t) => t.status !== "completed"); if (ac.length) { lines.push(`Active todos (${ac.length}):`); for (const t of ac.slice(0, 5)) lines.push(`  [${t.status}] ${short(t.content, 80)}`) } } catch {} }
  if (dec.length) lines.push(`Key decisions: ${dec.map((d) => d.value).join("; ")}`)
  if (kn.length) { lines.push("Accumulated knowledge:"); for (const k of kn.slice(0, 5)) lines.push(`  - ${short(k.fact, 140)}`) }
  return lines.join("\n")
}

function deriveNextSteps() {
  const s = []
  for (const e of stmts.gErrorActions.all(3).slice(0, 2)) s.push(`Fix error: ${short(e.summary, 100)}`)
  for (const e of stmts.gSessionErrors.all(5).slice(0, 2)) s.push(`Resolve: ${short(e.message, 80)}`)
  for (const d of stmts.gDialog.all(5)) { for (const x of extractPatterns(d.text, RE_NEXT_STEPS)) if (!s.includes(x)) s.push(x) }
  const lt = stmts.gLatestTodos.get(); if (lt?.todos_json) { try { const tl = JSON.parse(lt.todos_json); for (const t of tl.filter((t) => t.status !== "completed").slice(0, 3)) { const st = `[todo] ${short(t.content, 100)}`; if (!s.includes(st)) s.push(st) } } catch {} }
  return s.slice(0, 8)
}

async function flush() {
  await mutex(async () => {
    const actions = stmts.gActions.all(5), dialog = stmts.gDialog.all(3)
    const parts = []
    if (dialog.length) parts.push(`Asked: ${dialog.map((d) => short(d.text, 60)).join(" | ")}`)
    if (actions.length) parts.push(`Did: ${actions.map((a) => short(a.summary, 60)).join(" | ")}`)
    stmts.uContext.run(parts.join("; ") || "Active session.", JSON.stringify(deriveNextSteps()))
  })
}

// ─── Smart digest rotation ─────────────────────────────────────

let lastRotation = 0
const ROTATION_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours

async function rotateOldData() {
  const now = Date.now()
  if (now - lastRotation < ROTATION_INTERVAL) return
  lastRotation = now

  await mutex(async () => {
    const cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days ago
    // Archive old actions
    const oldActions = stmts.gOldActions.all(cutoff, 100)
    for (const a of oldActions) {
      stmts.iArchive.run("actions", JSON.stringify(a), a.created_at)
    }
    if (oldActions.length) stmts.dOldActions.run(cutoff, oldActions[oldActions.length - 1].id)
    // Archive old dialog
    const oldDialog = stmts.gOldDialog.all(cutoff, 100)
    for (const d of oldDialog) {
      stmts.iArchive.run("dialog", JSON.stringify(d), d.created_at)
    }
    if (oldDialog.length) stmts.dOldDialog.run(cutoff, oldDialog[oldDialog.length - 1].id)
    // Archive old replies
    const oldReplies = stmts.gOldReplies.all(cutoff, 50)
    for (const r of oldReplies) {
      stmts.iArchive.run("assistant_replies", JSON.stringify(r), r.created_at)
    }
    if (oldReplies.length) stmts.dOldReplies.run(cutoff, oldReplies[oldReplies.length - 1].id)
  })
}

// ─── Record functions ──────────────────────────────────────────

async function rAction(type, summary, sessionID, tool, callID) {
  await mutex(() => {
    stmts.iAction.run(short(summary, 150), short(summary, 150), sessionID, tool, callID)
    stmts.uSessionMetrics.run(tool ? 1 : 0, 1, 0, type === "error" ? 1 : 0, sessionID)
  })
}
async function rDialog(text, role, sessionID) {
  await mutex(() => {
    stmts.iDialog.run(short(text, 600), role, sessionID)
    stmts.uSessionMetrics.run(0, 0, 1, 0, sessionID)
  })
}
async function rReply(text, toolCalls, sessionID, messageID, model, agent) { await mutex(() => { stmts.iReply.run(short(text, 800), JSON.stringify(toolCalls || []), sessionID, messageID, model, agent) }) }
async function rFileChange(file, sessionID, changeType, add, del) { await mutex(() => { stmts.iFileChange.run(file, sessionID, changeType || "edit", add || 0, del || 0) }) }
async function rTodos(sessionID, todoList) { await mutex(() => { stmts.iTodo.run(sessionID, JSON.stringify(todoList)) }) }
async function rSessionError(sessionID, errorType, message) {
  await mutex(() => {
    stmts.iSessionError.run(sessionID, errorType, short(message, 300))
    stmts.uPattern.run("error", errorType)
    stmts.uSessionMetrics.run(0, 0, 0, 1, sessionID)
  })
}
async function rSnapshot(sessionID, messageID, snapshotData) { await mutex(() => { stmts.iSnapshot.run(sessionID, messageID, short(snapshotData, 500)) }) }
async function rPatch(sessionID, messageID, hash, files) { await mutex(() => { stmts.iPatch.run(sessionID, messageID, hash, JSON.stringify(files)) }) }

async function rSession(sessionID, agent, model, projectDir) {
  await mutex(() => {
    if (!stmts.cSession.get(sessionID).cnt) {
      stmts.iSession.run(sessionID, new Date().toISOString(), agent || null, model?.providerID || null, model?.modelID || null, projectDir || null)
    }
  })
}
async function rCloseSession(sessionID, status) { await mutex(() => { stmts.uCloseSession.run(status, sessionID) }) }
async function rDecision(text) { await mutex(() => { for (const d of extractPatterns(text, RE_DECISIONS)) stmts.uPattern.run("decision", d) }) }
async function rKnowledge(text, sessionID) { await mutex(() => { for (const f of extractPatterns(text, RE_FACTS)) stmts.upsertKnowledge.run(f, sessionID || null) }) }
async function rConfigChange(sessionID, key, value) { await mutex(() => { stmts.iConfigHistory.run(sessionID, key, short(String(value), 200)) }) }

// ─── FTS5 search ───────────────────────────────────────────────

function ftsSearch(query, max) {
  try {
    const ftsQuery = query.replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 2).join(" OR ")
    if (!ftsQuery) return null
    const rows = db.prepare(`
      SELECT 'action' as src, a.id, a.summary as text, a.created_at FROM fts_actions fa JOIN actions a ON a.id = fa.rowid WHERE fts_actions MATCH ? LIMIT ?
      UNION ALL
      SELECT 'dialog' as src, d.id, d.text, d.created_at FROM fts_dialog fd JOIN dialog d ON d.id = fd.rowid WHERE fts_dialog MATCH ? LIMIT ?
      UNION ALL
      SELECT 'reply' as src, r.id, r.text, r.created_at FROM fts_replies fr JOIN assistant_replies r ON r.id = fr.rowid WHERE fts_replies MATCH ? LIMIT ?
      UNION ALL
      SELECT 'knowledge' as src, k.id, k.fact as text, k.created_at FROM fts_knowledge fk JOIN knowledge k ON k.id = fk.rowid WHERE fts_knowledge MATCH ? LIMIT ?
    `).all(ftsQuery, max, ftsQuery, max, ftsQuery, max, ftsQuery, max)
    return rows
  } catch { return null }
}

// ─── Plugin ────────────────────────────────────────────────────

export async function PersistencePlugin(input, options = {}) {
  const { client, project, directory, worktree, serverUrl } = input
  const hasFTS5 = await ensureStorage()
  prepareStatements()

  const projectDir = directory || worktree || process.cwd()
  let pendingToolOutputs = []
  const currentSessionFiles = new Set()

  const tools = {
    memory_search: {
      description: "Search persistent memory across actions, dialog, replies, knowledge, files, errors. Supports time-range and FTS5 full-text search.",
      args: { type: "object", properties: { query: { type: "string", description: "Text to search" }, max: { type: "number", description: "Max per category (default 10)" }, since: { type: "string", description: "ISO date after" }, until: { type: "string", description: "ISO date before" }, fts: { type: "boolean", description: "Use FTS5 full-text search (default true if available)" } } },
      required: ["query"]
    },
      async execute(args) {
        const q = `%${args.query}%`, max = args.max || 10, r = []
        const useFTS = hasFTS5 && args.fts !== false

        // FTS5 full-text search
        if (useFTS && !args.since) {
          const ftsResults = ftsSearch(args.query, max)
          if (ftsResults?.length) {
            const groups = {}
            for (const row of ftsResults) {
              if (!groups[row.src]) groups[row.src] = []
              groups[row.src].push(row)
            }
            for (const [src, rows] of Object.entries(groups)) {
              r.push(`## ${src.charAt(0).toUpperCase() + src.slice(1)} (FTS)`)
              rows.forEach(row => r.push(`  [${row.src}] ${short(row.text, 120)} (${fmt(row.created_at)})`))
            }
            return r.join("\n")
          }
        }

        // Fallback: LIKE search
        let acts = []
        if (args.since) acts = stmts.gActionsRange.all(args.since, args.until || new Date().toISOString(), max)
        else acts = stmts.sActions.all(q, q, max)
        if (acts.length) { r.push("## Actions"); acts.forEach(a => r.push(`  [${a.type}] ${short(a.summary, 120)} (${fmt(a.created_at)})`)) }
        const dlg = stmts.sDialog.all(q, max); if (dlg.length) { r.push("## Dialog"); dlg.forEach(d => r.push(`  - ${short(d.text, 120)} (${fmt(d.created_at)})`)) }
        const rep = stmts.sReplies.all(q, max); if (rep.length) { r.push("## Replies"); rep.forEach(r2 => r.push(`  - ${short(r2.text, 100)} (${fmt(r2.created_at)})`)) }
        const kn = stmts.sKnowledge.all(q, max); if (kn.length) { r.push("## Knowledge"); kn.forEach(k => r.push(`  - ${short(k.fact, 140)}`)) }
        let fil = []
        if (args.since) fil = stmts.gFilesRange.all(args.since, args.until || new Date().toISOString(), max)
        else fil = stmts.sFiles.all(q, max)
        if (fil.length) { r.push("## Files"); fil.forEach(f => r.push(`  ${f.file} [${f.change_type}]${f.additions > 0 ? ` +${f.additions}` : ""} (${fmt(f.created_at)})`)) }
        let errs = []
        if (args.since) errs = stmts.gErrorsRange.all(args.since, args.until || new Date().toISOString(), max)
        else errs = stmts.sErrors.all(q, max)
        if (errs.length) { r.push("## Errors"); errs.forEach(e => r.push(`  [${e.error_type}] ${short(e.message, 100)} (${fmt(e.created_at)})`)) }
        return r.length ? r.join("\n") : (useFTS ? "No FTS5 matches and no LIKE matches found." : "No matches found.")
      }
    },
    memory_decisions: {
      description: "All recorded decisions, recurring issues, error stats",
      args: { type: "object", properties: {} },
      async execute() {
        const dec = stmts.gDecisions.all(20), et = stmts.gErrorsByType.all(10), as = stmts.gActionsByType.all(5), l = []
        if (dec.length) { l.push("## Decisions"); dec.forEach(d => l.push(`  - ${d.value} (${d.count}x)`)) }
        if (et.length) { l.push("## Error frequency"); et.forEach(e => l.push(`  [${e.count}x] ${e.error_type} (last: ${fmt(e.last_seen)})`)) }
        l.push("## Action stats"); as.forEach(a => l.push(`  ${a.type}: ${a.count}`))
        return l.join("\n")
      }
    },
    memory_files: {
      description: "File change history with optional filter. aggregate=true for grouped stats.",
      args: { type: "object", properties: { query: { type: "string", description: "File path filter" }, aggregate: { type: "boolean", description: "Group by file" } } },
      async execute(args) {
        if (args.aggregate) return stmts.gFilesAgg.all(30).map(f => `${f.file}: ${f.edits} edits, +${f.total_add || 0} -${f.total_del || 0} (${fmt(f.last_edit)})`).join("\n")
        const q = args.query ? `%${args.query}%` : "%"
        return stmts.sFiles.all(q, 30).map(f => `${f.file} [${f.change_type}] +${f.additions} -${f.deletions} (${fmt(f.created_at)})`).join("\n")
      }
    },
    memory_errors: {
      description: "Recent errors — session-level, tool-level, grouped by type. Supports time-range.",
      args: { type: "object", properties: { since: { type: "string", description: "ISO date after" } } },
      async execute(args) {
        const se = args.since ? stmts.gErrorsRange.all(args.since, new Date().toISOString(), 20) : stmts.gSessionErrors.all(20)
        const et = stmts.gErrorsByType.all(10), ea = stmts.gErrorActions.all(10), l = []
        if (se.length) { l.push("## Session errors"); se.slice(0, 10).forEach(e => l.push(`  [${e.error_type}] ${short(e.message, 100)} (${fmt(e.created_at)})`)) }
        if (ea.length) { l.push("## Tool errors"); ea.slice(0, 5).forEach(e => l.push(`  - ${short(e.summary, 100)}`)) }
        if (et.length) { l.push("## Frequency"); et.forEach(b => l.push(`  [${b.count}x] ${b.error_type}`)) }
        return l.join("\n") || "No errors recorded."
      }
    },
    memory_sessions: {
      description: "Session history, cross-session chains by project, per-session details with metrics",
      args: { type: "object", properties: { sessionID: { type: "string", description: "Session ID or last 6 chars" } } },
      async execute(args) {
        if (args.sessionID) {
          const all = stmts.gSessions.all(100), f = all.find(s => s.id === args.sessionID || s.id.endsWith(args.sessionID))
          if (!f) return `Not found. ${all.length} known.`
          const cfg = stmts.gConfigHistory.all(f.id, 10)
          const dur = f.ended_at ? Math.round((epochMs(f.ended_at) - epochMs(f.started_at)) / 60000) + " min" : "running"
          return JSON.stringify({
            session: f,
            duration: dur,
            metrics: { tools: f.tool_count, actions: f.action_count, dialog: f.dialog_count, errors: f.error_count },
            model: f.model_id ? `${f.model_provider}/${f.model_id}` : null,
            agent: f.agent,
            config_changes: cfg
          }, null, 2)
        }
        const act = stmts.gSessions.all(30).filter(s => s.status === "active"), chain = stmts.gSessionChain.all(projectDir, 10)
        const l = [`Total: ${act.length} active sessions`, `Project: ${projectDir}`]
        if (chain.length) { l.push("## Chain:"); chain.forEach(s => { const m = s.model_id ? ` [${s.model_provider}/${s.model_id}]` : ""; const d = s.ended_at ? Math.round((epochMs(s.ended_at) - epochMs(s.started_at)) / 60000) + "min" : "running"; l.push(`  ${s.id.slice(-8)} ${s.status}${m} ${fmt(s.started_at)} ${d} tools:${s.tool_count || 0} errs:${s.error_count || 0}`) }) }
        return l.join("\n")
      }
    },
    memory_config: {
      description: "Config change history per session. Track model/agent/options changes over time.",
      args: { type: "object", properties: { sessionID: { type: "string", description: "Session ID or last 6 chars (optional, default: all recent)" } } },
      async execute(args) {
        let rows
        if (args.sessionID) {
          rows = stmts.gConfigHistory.all(args.sessionID, 50)
        } else {
          rows = db.prepare("SELECT * FROM config_history ORDER BY changed_at DESC LIMIT 50").all()
        }
        if (!rows.length) return "No config changes recorded."
        const l = ["## Config changes"]
        rows.forEach(r => l.push(`  ${r.session_id?.slice(-8) || "?"} | ${r.key} = ${short(r.value, 80)} (${fmt(r.changed_at)})`))
        return l.join("\n")
      }
    },
    memory_archive: {
      description: "Browse archived data (pre-rotation). Query by table name or date range.",
      args: { type: "object", properties: { table: { type: "string", description: "Table name filter (actions, dialog, assistant_replies)" }, since: { type: "string", description: "ISO date after" }, limit: { type: "number", description: "Max results (default 20)" } } },
      async execute(args) {
        const limit = args.limit || 20
        let rows
        if (args.table && args.since) {
          rows = db.prepare("SELECT * FROM archive WHERE table_name = ? AND original_created_at > ? ORDER BY original_created_at DESC LIMIT ?").all(args.table, args.since, limit)
        } else if (args.table) {
          rows = db.prepare("SELECT * FROM archive WHERE table_name = ? ORDER BY original_created_at DESC LIMIT ?").all(args.table, limit)
        } else if (args.since) {
          rows = db.prepare("SELECT * FROM archive WHERE original_created_at > ? ORDER BY original_created_at DESC LIMIT ?").all(args.since, limit)
        } else {
          rows = db.prepare("SELECT * FROM archive ORDER BY original_created_at DESC LIMIT ?").all(limit)
        }
        if (!rows.length) return `No archived data. Rotation runs every 24h and archives data older than 7 days. Total archived: ${stmts.gStats.get().ar}.`
        const l = [`## Archive (${rows.length} entries)`]
        rows.forEach(r => {
          try { const d = JSON.parse(r.row_data); l.push(`  [${r.table_name}] ${short(d.summary || d.text || d.fact || JSON.stringify(d).slice(0, 100), 100)} (archived: ${fmt(r.archived_at)})`) } catch { l.push(`  [${r.table_name}] ${short(r.row_data, 100)}`) }
        })
        return l.join("\n")
      }
    },
  }

  return {
    tool: tools,

    "experimental.chat.system.transform" : async (input, output) => {
      try { output.system.push(`\n---\n${await buildDigest()}\n---\n`) } catch (e) { output.system.push(`\n---\n[PERSISTENCE v4.2] Error: ${e.message}\n---\n`) }
    },

    "chat.message": async (input, output) => {
      const text = textFromParts(output.parts)
      if (text) { await rDialog(text, "user", input.sessionID); await rDecision(text); await rKnowledge(text, input.sessionID); await flush(); await rotateOldData() }
    },

    "tool.execute.after": async (input, output) => {
      const result = output.output || "", isErr = isGenuineError(input.tool, result)
      await rAction(isErr ? "error" : "action", `${input.tool}: ${short(result, 120)}`, input.sessionID, input.tool, input.callID)
      pendingToolOutputs.push(result); if (pendingToolOutputs.length > 5) pendingToolOutputs = pendingToolOutputs.slice(-5)
      await flush()
    },

    "experimental.session.compacting": async (input, output) => {
      output.context.push("[PERSISTENCE v4.2] Preserve: (1) decisions+reasons (2) errors+causes (3) nextSteps+priority (4) file paths+configs+architecture (5) user preferences (6) tools+results (7) files modified+changes (8) model+agent config.")
      await flush()
    },

    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const info = event.properties?.info, sid = info?.id || event.properties?.sessionID
          if (sid) await rSession(sid, info?.agent, info?.model, projectDir)
          break
        }
        case "session.deleted": case "session.compacted": {
          const sid = event.properties?.sessionID
          if (sid) await rCloseSession(sid, event.type === "session.deleted" ? "deleted" : "compacted")
          break
        }
        case "message.updated": {
          const info = event.properties?.info
          if (info?.role === "assistant" && info.time?.completed && info.error)
            await rSessionError(info.sessionID, info.error.name, info.error.data?.message || "Unknown")
          break
        }
        case "message.part.updated": {
          const part = event.properties?.part
          if (!part) break
          if (part.type === "snapshot" && part.snapshot) await rSnapshot(part.sessionID, part.messageID, part.snapshot)
          if (part.type === "patch" && part.hash) await rPatch(part.sessionID, part.messageID, part.hash, part.files || [])
          break
        }
        case "file.edited": {
          const file = event.properties?.file
          if (file) { currentSessionFiles.add(file); await rFileChange(file, event.properties?.sessionID, "edit", 0, 0); await flush() }
          break
        }
        case "session.diff": {
          const diffs = event.properties?.diff || [], sid = event.properties?.sessionID
          if (sid && diffs.length) { for (const d of diffs) await rFileChange(d.file, sid, "diff", d.additions || 0, d.deletions || 0); await flush() }
          break
        }
        case "todo.updated": {
          const sid = event.properties?.sessionID, tl = event.properties?.todos
          if (sid && tl) { await rTodos(sid, tl); await flush() }
          break
        }
        case "session.error": {
          const err = event.properties?.error, sid = event.properties?.sessionID
          if (err) { await rSessionError(sid, err.name, err.data?.message || JSON.stringify(err.data).slice(0, 300)); await flush() }
          break
        }
      }
    },

    async dispose() {
      if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null }
      await flush()
      if (db) { db.close(); db = null }
    },
  }
}

export default { id: "opencode-persistence-autonomous", server: PersistencePlugin }
