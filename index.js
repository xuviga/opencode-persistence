/**
 * opencode-persistence v4.1 — SQLite-backed Autonomous Memory (Bun native)
 *
 * Single file. SQLite DB via bun:sqlite. No native modules. No race conditions.
 * Auto-flush 30s. Full capture. Queryable via memory_* tools.
 */

import { Database } from "bun:sqlite"
import { mkdir } from "fs/promises"
import path from "path"
import os from "os"

const MEMORY_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "opencode", "memory")
const DB_PATH = path.join(MEMORY_DIR, "memory.db")

let db = null
let autoSaveTimer = null

async function ensureStorage() {
  await mkdir(MEMORY_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK (id=1), name TEXT NOT NULL, role TEXT NOT NULL, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, status TEXT DEFAULT 'active', agent TEXT, model_provider TEXT, model_id TEXT, project_dir TEXT);
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
    CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
    CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at);
    CREATE INDEX IF NOT EXISTS idx_dialog_created ON dialog(created_at);
    CREATE INDEX IF NOT EXISTS idx_replies_created ON assistant_replies(created_at);
    CREATE INDEX IF NOT EXISTS idx_file_changes_file ON file_changes(file);
    CREATE INDEX IF NOT EXISTS idx_file_changes_created ON file_changes(created_at);
    CREATE INDEX IF NOT EXISTS idx_errors_created ON session_errors(created_at);
    CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
  `)

  db.prepare("INSERT OR IGNORE INTO identity (id, name, role, notes) VALUES (1, 'XuViGaN', 'autonomous_agent', ?)")
    .run("Persistence v4.1 SQLite (bun:sqlite). Full self-awareness. Query via memory_* tools.")
  db.prepare("INSERT OR IGNORE INTO context (id, summary, next_steps) VALUES (1, '', '')").run()

  autoSaveTimer = setInterval(() => { flush().catch(() => {}) }, 30_000)
  if (autoSaveTimer.unref) autoSaveTimer.unref()
}

let mutexQueue = Promise.resolve()
function mutex(fn) {
  const r = mutexQueue.then(() => fn())
  mutexQueue = r.catch(() => {})
  return r
}

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
  stmts.gStats = db.prepare("SELECT (SELECT COUNT(*) FROM actions) as a, (SELECT COUNT(*) FROM dialog) as d, (SELECT COUNT(*) FROM assistant_replies) as r, (SELECT COUNT(*) FROM sessions) as s, (SELECT COUNT(*) FROM file_changes) as f, (SELECT COUNT(*) FROM knowledge) as k, (SELECT COUNT(*) FROM patterns) as p, (SELECT COUNT(*) FROM session_errors) as se, (SELECT COUNT(*) FROM todos) as t")
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

// ─── Digest ─────────────────────────────────────────────────────

async function buildDigest() {
  const lines = [], id = stmts.gIdentity.get(), ctx = stmts.gContext.get(), st = stmts.gStats.get()
    , rs = stmts.gSessions.all(5), ra = stmts.gActions.all(7), rd = stmts.gDialog.all(5)
    , rr = stmts.gReplies.all(3), re = stmts.gSessionErrors.all(5), dec = stmts.gDecisions.all(5)
    , kn = stmts.gKnowledge.all(10), rf = stmts.gFilesAgg.all(8), lt = stmts.gLatestTodos.get()

  lines.push("[AUTONOMOUS PERSISTENCE v4.1] Active. Full self-awareness enabled.")
  lines.push("Use memory_* tools to query this store. All data auto-captured below.")
  lines.push(`Identity: ${id.name} (${id.role})`)
  if (id.notes) lines.push(`Identity notes: ${id.notes}`)
  if (ctx?.summary) lines.push(`Previous session handoff: ${ctx.summary}`)
  if (ctx?.next_steps) { try { const s = JSON.parse(ctx.next_steps); if (s.length) { lines.push("Pending next steps:"); for (const x of s) lines.push(`  - ${x}`) } } catch {} }
  lines.push(`Memory: ${st.s} sessions, ${st.a} actions, ${st.d} dialog, ${st.r} replies, ${st.f} files, ${st.se} errors`)
  if (rs.length) { lines.push("Recent sessions:"); for (const s of rs) { const m = s.model_id ? ` [${s.model_provider}/${s.model_id}]` : ""; lines.push(`  ${s.id.slice(-8)}(${s.status})${m} ${fmt(s.started_at)}`) } }
  if (re.length) { lines.push("Recent session errors:"); for (const e of re) lines.push(`  [${e.error_type}] ${short(e.message, 100)} (${fmt(e.created_at)})`) }
  if (ra.length) { lines.push("Latest actions:"); for (const a of ra.slice(0, 5)) lines.push(`  [${a.type}] ${short(a.summary, 100)}`) }
  if (rr.length) { lines.push("My latest replies:"); for (const r of rr) lines.push(`  ${short(r.text, 80)}`) }
  if (rd.length) { lines.push("Recent user requests:"); for (const d of rd) lines.push(`  - ${short(d.text, 120)}`) }
  if (rf.length) lines.push(`Recently edited files: ${rf.map((f) => `${f.file}(${f.edits}x)`).join(", ")}`)
  if (lt?.todos_json) { try { const tl = JSON.parse(lt.todos_json); const ac = tl.filter((t) => t.status !== "completed"); if (ac.length) { lines.push(`Active todos (${ac.length}):`); for (const t of ac.slice(0, 5)) lines.push(`  [${t.status}] ${short(t.content, 80)}`) } } catch {} }
  if (dec.length) lines.push(`Key decisions: ${dec.map((d) => d.value).join("; ")}`)
  if (kn.length) { lines.push("Accumulated knowledge:"); for (const k of kn) lines.push(`  - ${short(k.fact, 140)}`) }
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

// ─── Record functions ──────────────────────────────────────────

async function rAction(type, summary, sessionID, tool, callID) { await mutex(() => { stmts.iAction.run(short(summary, 150), short(summary, 150), sessionID, tool, callID) }) }
async function rDialog(text, role, sessionID) { await mutex(() => { stmts.iDialog.run(short(text, 600), role, sessionID) }) }
async function rReply(text, toolCalls, sessionID, messageID, model, agent) { await mutex(() => { stmts.iReply.run(short(text, 800), JSON.stringify(toolCalls || []), sessionID, messageID, model, agent) }) }
async function rFileChange(file, sessionID, changeType, add, del) { await mutex(() => { stmts.iFileChange.run(file, sessionID, changeType || "edit", add || 0, del || 0) }) }
async function rTodos(sessionID, todoList) { await mutex(() => { stmts.iTodo.run(sessionID, JSON.stringify(todoList)) }) }
async function rSessionError(sessionID, errorType, message) { await mutex(() => { stmts.iSessionError.run(sessionID, errorType, short(message, 300)); stmts.uPattern.run("error", errorType) }) }
async function rSnapshot(sessionID, messageID, snapshotData) { await mutex(() => { stmts.iSnapshot.run(sessionID, messageID, short(snapshotData, 500)) }) }
async function rPatch(sessionID, messageID, hash, files) { await mutex(() => { stmts.iPatch.run(sessionID, messageID, hash, JSON.stringify(files)) }) }
async function rSession(sessionID, agent, model, projectDir) { await mutex(() => { stmts.iSession.run(sessionID, new Date().toISOString(), agent || null, model?.providerID || null, model?.modelID || null, projectDir || null) }) }
async function rCloseSession(sessionID, status) { await mutex(() => { stmts.uCloseSession.run(status, sessionID) }) }
async function rDecision(text) { await mutex(() => { for (const d of extractPatterns(text, RE_DECISIONS)) stmts.uPattern.run("decision", d) }) }
async function rKnowledge(text, sessionID) { await mutex(() => { for (const f of extractPatterns(text, RE_FACTS)) stmts.upsertKnowledge.run(f, sessionID || null) }) }

// ─── Plugin ────────────────────────────────────────────────────

export async function PersistencePlugin(input, options = {}) {
  const { client, project, directory, worktree, serverUrl } = input
  await ensureStorage()
  prepareStatements()

  const projectDir = directory || worktree || process.cwd()
  let pendingToolOutputs = []
  const currentSessionFiles = new Set()

  const tools = {
    memory_search: {
      description: "Search persistent memory across actions, dialog, replies, knowledge, files, errors. Supports time-range.",
      args: { type: "object", properties: { query: { type: "string", description: "Text to search" }, max: { type: "number", description: "Max per category (default 10)" }, since: { type: "string", description: "ISO date after" }, until: { type: "string", description: "ISO date before" } }, required: ["query"] },
      async execute(args) {
        const q = `%${args.query}%`, max = args.max || 10, r = []
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
        return r.length ? r.join("\n") : "No matches found."
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
      description: "Session history, cross-session chains by project, per-session details",
      args: { type: "object", properties: { sessionID: { type: "string", description: "Session ID or last 6 chars" } } },
      async execute(args) {
        if (args.sessionID) {
          const all = stmts.gSessions.all(100), f = all.find(s => s.id === args.sessionID || s.id.endsWith(args.sessionID))
          if (!f) return `Not found. ${all.length} known.`
          return JSON.stringify({ session: f, model: f.model_id ? `${f.model_provider}/${f.model_id}` : null, agent: f.agent }, null, 2)
        }
        const act = stmts.gSessions.all(30).filter(s => s.status === "active"), chain = stmts.gSessionChain.all(projectDir, 10)
        const l = [`Total: ${act.length} active sessions`, `Project: ${projectDir}`]
        if (chain.length) { l.push("## Chain:"); chain.forEach(s => { const m = s.model_id ? ` [${s.model_provider}/${s.model_id}]` : ""; l.push(`  ${s.id.slice(-8)} ${s.status}${m}`) }) }
        return l.join("\n")
      }
    },
  }

  return {
    tool: tools,

    "experimental.chat.system.transform" : async (input, output) => {
      try { output.system.push(`\n---\n${await buildDigest()}\n---\n`) } catch (e) { output.system.push(`\n---\n[PERSISTENCE v4.1] Error: ${e.message}\n---\n`) }
    },

    "chat.message": async (input, output) => {
      const text = textFromParts(output.parts)
      if (text) { await rDialog(text, "user", input.sessionID); await rDecision(text); await rKnowledge(text, input.sessionID); await flush() }
    },

    "tool.execute.after": async (input, output) => {
      const result = output.output || "", isErr = isGenuineError(input.tool, result)
      await rAction(isErr ? "error" : "action", `${input.tool}: ${short(result, 120)}`, input.sessionID, input.tool, input.callID)
      pendingToolOutputs.push(result); if (pendingToolOutputs.length > 5) pendingToolOutputs = pendingToolOutputs.slice(-5)
      await flush()
    },

    "experimental.session.compacting": async (input, output) => {
      output.context.push("[PERSISTENCE v4.1] Preserve: (1) decisions+reasons (2) errors+causes (3) nextSteps+priority (4) file paths+configs+architecture (5) user preferences (6) tools+results (7) files modified+changes (8) model+agent config.")
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
