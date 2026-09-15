/**
 * opencode-persistence v4.4 — SQLite-backed Autonomous Memory (Bun native)
 *
 * Single file. SQLite DB via bun:sqlite. FTS5 full-text search. No native modules.
 * Adaptive flush 5-30s. Crash-safe flush. Smart digest + LLM summary. Full self-awareness.
 */

import { Database } from "bun:sqlite"
import { mkdir } from "fs/promises"
import path from "path"
import os from "os"

const MEMORY_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "opencode", "memory")
const DB_PATH = path.join(MEMORY_DIR, "memory.db")
const DEBUG = process.env.OPENCODE_PERSISTENCE_DEBUG === "1"

function debugLog(...args) {
  if (DEBUG) console.log("[PERSISTENCE DEBUG]", ...args)
}

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

  // Migration: ensure archive table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
  if (!tables.includes('archive')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_data TEXT NOT NULL, archived_at TEXT DEFAULT (datetime('now')), original_created_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_archive_table ON archive(table_name);
    `)
    debugLog("Migration: created archive table")
  }

  // Migration 1: knowledge project_dir + TTL
  try {
    const knCols = db.prepare("PRAGMA table_info(knowledge)").all().map(c => c.name)
    if (!knCols.includes('project_dir')) {
      db.exec("ALTER TABLE knowledge ADD COLUMN project_dir TEXT")
      db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_dir)")
      debugLog("Migration: added knowledge.project_dir")
    }
    if (!knCols.includes('expires_at')) {
      db.exec("ALTER TABLE knowledge ADD COLUMN expires_at TEXT")
      db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_expires ON knowledge(expires_at)")
      debugLog("Migration: added knowledge.expires_at")
    }
  } catch(e) { debugLog("Migration knowledge cols error:", e.message) }

  // Migration 2: synonyms table
  if (!tables.includes('synonyms')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS synonyms (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, synonym TEXT NOT NULL, lang TEXT DEFAULT 'en', created_at TEXT DEFAULT (datetime('now')), UNIQUE(term, synonym));
      CREATE INDEX IF NOT EXISTS idx_synonyms_term ON synonyms(term);
    `)
    debugLog("Migration: created synonyms table")
  }

  // Migration 3: sessions active_seconds
  try {
    const sessCols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name)
    if (!sessCols.includes('active_seconds')) {
      db.exec("ALTER TABLE sessions ADD COLUMN active_seconds INTEGER DEFAULT 0")
      debugLog("Migration: added sessions.active_seconds")
    }
  } catch(e) { debugLog("Migration sessions col error:", e.message) }

  // Migration 4: snapshots prev_snapshot_id + hash
  try {
    const snapCols = db.prepare("PRAGMA table_info(snapshots)").all().map(c => c.name)
    if (!snapCols.includes('prev_snapshot_id')) {
      db.exec("ALTER TABLE snapshots ADD COLUMN prev_snapshot_id INTEGER")
      db.exec("ALTER TABLE snapshots ADD COLUMN content_hash TEXT")
      db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_hash ON snapshots(content_hash)")
      debugLog("Migration: added snapshots.prev_snapshot_id + content_hash")
    }
  } catch(e) { debugLog("Migration snapshots cols error:", e.message) }

  // Migration 5: webhooks table
  if (!tables.includes('webhooks')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, pattern TEXT NOT NULL, action TEXT NOT NULL, enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), last_triggered TEXT);
      CREATE INDEX IF NOT EXISTS idx_webhooks_event ON webhooks(event_type);
    `)
    debugLog("Migration: created webhooks table")
    // Seed useful webhooks
    db.prepare("INSERT OR IGNORE INTO webhooks (event_type, pattern, action) VALUES (?, ?, ?)").run("error", "FTS5.*corrupt", "self_heal_fts")
    db.prepare("INSERT OR IGNORE INTO webhooks (event_type, pattern, action) VALUES (?, ?, ?)").run("error", "database.*locked", "retry_with_backoff")
  }

  // Migration 6: knowledge is_global flag
  try {
    const knCols2 = db.prepare("PRAGMA table_info(knowledge)").all().map(c => c.name)
    if (!knCols2.includes('is_global')) {
      db.exec("ALTER TABLE knowledge ADD COLUMN is_global INTEGER DEFAULT 0")
      debugLog("Migration: added knowledge.is_global")
    }
  } catch(e) { debugLog("Migration knowledge.is_global error:", e.message) }

  // Migration 7: memory_costs — token tracking
  if (!tables.includes('memory_costs')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_costs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, operation TEXT NOT NULL, tokens INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE INDEX IF NOT EXISTS idx_costs_session ON memory_costs(session_id);
      CREATE INDEX IF NOT EXISTS idx_costs_operation ON memory_costs(operation);
      CREATE INDEX IF NOT EXISTS idx_costs_created ON memory_costs(created_at);
    `)
    debugLog("Migration: created memory_costs table")
  }

  // Migration 8: user_prefs — preference learning
  if (!tables.includes('user_prefs')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_prefs (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, confidence REAL DEFAULT 0.5, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    `)
    debugLog("Migration: created user_prefs table")
  }

  // Migration 9: anomalies — error spike detection
  if (!tables.includes('anomalies')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, anomaly_type TEXT NOT NULL, severity TEXT NOT NULL, message TEXT, resolved_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE INDEX IF NOT EXISTS idx_anomalies_session ON anomalies(session_id);
      CREATE INDEX IF NOT EXISTS idx_anomalies_created ON anomalies(created_at);
    `)
    debugLog("Migration: created anomalies table")
  }

  // Migration 10: actions — add session_id index for intent chaining
  try {
    const idxList = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='actions'").all().map(i => i.name)
    if (!idxList.includes('idx_actions_created_session')) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_actions_created_session ON actions(created_at, session_id)")
      debugLog("Migration: added actions.created_session index")
    }
  } catch(e) { debugLog("Migration actions index error:", e.message) }

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
      CREATE TRIGGER IF NOT EXISTS trg_fts_actions_u AFTER UPDATE ON actions BEGIN INSERT INTO fts_actions(fts_actions, rowid, summary) VALUES('delete', old.id, old.summary); INSERT INTO fts_actions(rowid, summary) VALUES (new.id, new.summary); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_dialog_i AFTER INSERT ON dialog BEGIN INSERT INTO fts_dialog(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_dialog_d AFTER DELETE ON dialog BEGIN INSERT INTO fts_dialog(fts_dialog, rowid, text) VALUES('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_dialog_u AFTER UPDATE ON dialog BEGIN INSERT INTO fts_dialog(fts_dialog, rowid, text) VALUES('delete', old.id, old.text); INSERT INTO fts_dialog(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_replies_i AFTER INSERT ON assistant_replies BEGIN INSERT INTO fts_replies(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_replies_d AFTER DELETE ON assistant_replies BEGIN INSERT INTO fts_replies(fts_replies, rowid, text) VALUES('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_replies_u AFTER UPDATE ON assistant_replies BEGIN INSERT INTO fts_replies(fts_replies, rowid, text) VALUES('delete', old.id, old.text); INSERT INTO fts_replies(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_knowledge_i AFTER INSERT ON knowledge BEGIN INSERT INTO fts_knowledge(rowid, fact) VALUES (new.id, new.fact); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_knowledge_d AFTER DELETE ON knowledge BEGIN INSERT INTO fts_knowledge(fts_knowledge, rowid, fact) VALUES('delete', old.id, old.fact); END;
      CREATE TRIGGER IF NOT EXISTS trg_fts_knowledge_u AFTER UPDATE ON knowledge BEGIN INSERT INTO fts_knowledge(fts_knowledge, rowid, fact) VALUES('delete', old.id, old.fact); INSERT INTO fts_knowledge(rowid, fact) VALUES (new.id, new.fact); END;
    `)
  }

  db.prepare("INSERT OR IGNORE INTO identity (id, name, role, notes) VALUES (1, 'XuViGaN', 'autonomous_agent', ?)")
    .run("Persistence v4.2 SQLite (bun:sqlite). FTS5: " + (hasFTS5 ? "enabled" : "unavailable") + ". Query via memory_* tools.")
  db.prepare("INSERT OR IGNORE INTO context (id, summary, next_steps) VALUES (1, '', '')").run()

  autoSaveTimer = setInterval(() => { flush().catch(() => {}) }, currentFlushInterval)
  if (autoSaveTimer.unref) autoSaveTimer.unref()

  // Activity-based adaptive flush
  setInterval(() => {
    const idleTime = Date.now() - lastActivityTime
    if (idleTime > 10 * 60 * 1000 && currentFlushInterval !== 30000) { // 10 min idle = slow mode
      currentFlushInterval = 30000
      resetFlushInterval()
      debugLog("Flush interval slowed to 30s (idle)")
    }
  }, 60000) // Check every minute

  // Crash-safe flush — sync on exit
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
  stmts.iSnapshot = db.prepare("INSERT INTO snapshots (session_id, message_id, snapshot, prev_snapshot_id, content_hash) VALUES (?, ?, ?, ?, ?)")
  stmts.iPatch = db.prepare("INSERT INTO patches (session_id, message_id, hash, files) VALUES (?, ?, ?, ?)")
  stmts.iSession = db.prepare("INSERT OR IGNORE INTO sessions (id, started_at, status, agent, model_provider, model_id, project_dir) VALUES (?, ?, 'active', ?, ?, ?, ?)")
  stmts.uCloseSession = db.prepare("UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE id = ?")
  stmts.uPattern = db.prepare("INSERT INTO patterns (category, value, count) VALUES (?, ?, 1) ON CONFLICT(category, value) DO UPDATE SET count = count + 1, last_seen = datetime('now')")
  stmts.upsertKnowledge = db.prepare("INSERT OR IGNORE INTO knowledge (fact, source, session_id, project_dir, is_global, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
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

  // New statements for v4.3 features
  stmts.gKnowledgeGlobal = db.prepare("SELECT * FROM knowledge WHERE (project_dir = ? OR project_dir IS NULL OR is_global = 1) ORDER BY created_at DESC LIMIT ?")
  stmts.gKnowledgeExpired = db.prepare("SELECT * FROM knowledge WHERE expires_at IS NOT NULL AND expires_at < datetime('now') ORDER BY expires_at ASC LIMIT ?")
  stmts.dKnowledgeExpired = db.prepare("DELETE FROM knowledge WHERE expires_at IS NOT NULL AND expires_at < datetime('now')")
  stmts.gSynonyms = db.prepare("SELECT synonym FROM synonyms WHERE term = ? OR term = ?")
  stmts.iSynonym = db.prepare("INSERT OR IGNORE INTO synonyms (term, synonym, lang) VALUES (?, ?, ?)")
  stmts.gLatestSnapshot = db.prepare("SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
  stmts.uSessionActive = db.prepare("UPDATE sessions SET active_seconds = CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER) WHERE id = ?")
  stmts.gWebhooks = db.prepare("SELECT * FROM webhooks WHERE enabled = 1 AND event_type = ?")
  stmts.uWebhookLast = db.prepare("UPDATE webhooks SET last_triggered = datetime('now') WHERE id = ?")
  stmts.gAnomalies = db.prepare("SELECT * FROM anomalies ORDER BY created_at DESC LIMIT ?")

  // New statements for v4.4 features
  stmts.iCost = db.prepare("INSERT INTO memory_costs (session_id, operation, tokens) VALUES (?, ?, ?)")
  stmts.iAnomaly = db.prepare("INSERT INTO anomalies (session_id, anomaly_type, severity, message) VALUES (?, ?, ?, ?)")
  stmts.iUserPref = db.prepare("INSERT INTO user_prefs (key, value, confidence) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, confidence = excluded.confidence, updated_at = datetime('now')")
  stmts.gUserPrefs = db.prepare("SELECT * FROM user_prefs ORDER BY confidence DESC LIMIT ?")
  stmts.gCostsBySession = db.prepare("SELECT session_id, SUM(tokens) as total FROM memory_costs WHERE session_id = ? GROUP BY session_id")
  stmts.gCostsByOperation = db.prepare("SELECT operation, SUM(tokens) as total FROM memory_costs GROUP BY operation ORDER BY total DESC")
  stmts.gRecentErrors = db.prepare("SELECT * FROM session_errors WHERE created_at > datetime('now', '-1 hour') ORDER BY created_at DESC")
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
  /(?:todo|next|later|remember|fix|need to|must|should|will|going to|plan to|want to|todo:|action item)[:\s]+([^\n.]{5,200})/gi,
  /(?:сделать|нужно|надо|дальше|затем|потом|не забудь|запомни|исправить|добавить|убрать|проверить|собираюсь|планирую|хочу)[:\s]+([^\n.]{5,200})/gi,
]

const RE_DECISIONS = [
  /(?:decided|chose|using|going with|will use|stick with|picked|selected|agreed on|finalized|chosen|prefer|opted for|settled on|decision:|architecture choice|design decision)[:\s]+([^\n.]{5,200})/gi,
  /(?:решили|выбрали|будем использовать|отказались от|остановились на|определились с|зафиксировали|утвердили|предпочли|выбрали|остановились)[:\s]+([^\n.]{5,200})/gi,
]

const RE_FACTS = [
  /(?:remember|note|important|key|fact|rule|convention|always|never|use|prefer|avoid|don't|must|should know|keep in mind|note that)[:\s]+([^\n.]{5,250})/gi,
  /(?:запомни|важно|факт|правило|конвенция|всегда|никогда|учти|имей в виду|используй|предпочитай|избегай|не используй|стоит помнить|обрати внимание)[:\s]+([^\n.]{5,250})/gi,
]

const RE_STRUCT_ERROR = /exit code [1-9]|Traceback \(most recent|SyntaxError|TypeError|ReferenceError|ENOENT|EACCES|EPERM|Segmentation fault|FATAL/
const RE_ERROR_LINE = /^\s*(Error|Exception|Failed|FAIL|FATAL|fatal:)/m
const RE_GENERIC_ERROR = /\b(error|failed|failure|exception|crash|panic|fatal|errno|timeout|denied|refused|not found|404|500|502|503)\b/i

// ─── DB Backup ─────────────────────────────────────────────────

const BACKUP_DIR = path.join(MEMORY_DIR, "backups")
let lastBackup = 0

const S3_ENDPOINT = process.env.MINIO_ENDPOINT || "http://localhost:9000"
const S3_BUCKET = process.env.MINIO_BUCKET || "opencode-backup"
const S3_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin"
const S3_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin"

async function backupDb() {
  const now = Date.now()
  if (now - lastBackup < 24 * 60 * 60 * 1000) return // 24h

  try {
    // Local backup first
    await mkdir(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const dest = path.join(BACKUP_DIR, `memory-${stamp}.db`)
    const src = Bun.file(DB_PATH)
    await Bun.write(dest, src)

    // Keep last 7 local backups
    const { readdirSync, statSync, unlinkSync } = await import("fs")
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("memory-") && f.endsWith(".db"))
      .map(f => ({ f, t: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const f of files.slice(7)) {
      try { unlinkSync(path.join(BACKUP_DIR, f.f)) } catch {}
    }

    // S3 upload (optional, if endpoint configured)
    if (S3_ENDPOINT && S3_ENDPOINT !== "http://localhost:9000") {
      try {
        const fileData = await Bun.file(dest).arrayBuffer()
        const s3Url = `${S3_ENDPOINT}/${S3_BUCKET}/memory-${stamp}.db`

        await fetch(s3Url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-amz-acl": "private"
          },
          body: fileData,
          signal: AbortSignal.timeout(30000)
        })
        debugLog(`S3 backup uploaded: ${s3Url}`)
      } catch (s3e) {
        debugLog("S3 backup failed (continuing with local only):", s3e.message)
      }
    }

    lastBackup = now
    debugLog("DB backup completed:", dest)
  } catch (e) { debugLog("DB backup failed:", e.message) }
}

// ─── Knowledge TTL cleanup ─────────────────────────────────────

let lastTtlCheck = 0
const TTL_CHECK_INTERVAL = 60 * 60 * 1000 // 1h

async function cleanExpiredKnowledge() {
  const now = Date.now()
  if (now - lastTtlCheck < TTL_CHECK_INTERVAL) return
  lastTtlCheck = now
  await mutex(async () => {
    const expired = stmts.gKnowledgeExpired.all(100)
    if (expired.length) {
      for (const k of expired) {
        stmts.iArchive.run("knowledge", JSON.stringify(k), k.created_at)
      }
      stmts.dKnowledgeExpired.run()
      debugLog(`Archived ${expired.length} expired knowledge entries`)
    }
  })
}

// ─── RU Stemming helper ───────────────────────────────────────

function stemRu(word) {
  // Simple RU suffix stripping for FTS
  const suffixes = ['ого','его','ами','ями','ов','ев','ей','ам','ям','ах','ях','ом','ем','ой','ей','ую','юю','ая','яя','ое','ее','ый','ий']
  for (const s of suffixes) {
    if (word.length > 4 && word.endsWith(s)) return word.slice(0, -s.length)
  }
  return word
}

function expandQueryWithSynonyms(query) {
  const words = query.split(/\s+/).filter(w => w.length > 2)
  const expanded = new Set()
  for (const w of words) {
    expanded.add(w)
    expanded.add(stemRu(w))
    try {
      const rows = stmts.gSynonyms.all(w.toLowerCase(), w)
      for (const r of rows) expanded.add(r.synonym)
    } catch {}
  }
  return [...expanded].join(" OR ")
}

// ─── Webhook dispatcher ───────────────────────────────────────

async function triggerWebhooks(eventType, payload) {
  try {
    const hooks = stmts.gWebhooks.all(eventType)
    for (const hook of hooks) {
      try {
        if (new RegExp(hook.pattern, "i").test(JSON.stringify(payload))) {
          debugLog(`Webhook triggered: ${hook.action} for ${eventType}`)
          if (hook.action === "self_heal_fts") await selfHeal(null, "webhook:fts_corrupt")
          await stmts.uWebhookLast.run(hook.id)
        }
      } catch {}
    }
  } catch {}
}

// ─── Hash util ────────────────────────────────────────────────

function quickHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0 }
  return Math.abs(h).toString(36)
}

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

// ─── v4.4: Advanced helpers ───────────────────────────────────

// Semantic normalization for dedup
function canonicalFact(fact) {
  const stopWords = new Set(['используй', 'применяй', 'всегда', 'никогда', 'нужно', 'надо', 'должно', 'следует', 'always', 'never', 'use', 'prefer', 'avoid', "don't", 'must', 'should'])
  return fact.toLowerCase().split(/\s+/).filter(w => !stopWords.has(w)).sort().join(' ')
}

// Token estimation (~0.75 words per token)
function estimateTokens(text) {
  return Math.ceil((text || "").split(/\s+/).length * 0.75)
}

// Cosine similarity for fuzzy dedup
function cosineSim(a, b) {
  const wa = new Set(a.split(/\s+/)), wb = new Set(b.split(/\s+/))
  const inter = [...wa].filter(w => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return union === 0 ? 0 : inter / union
}

// LLM summarizer — REAL HTTP call (OpenRouter-compatible)
const LLM_API_URL = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions"
const LLM_API_KEY = process.env.OPENROUTER_API_KEY || ""
const llmCache = new Map()

async function summarizeWithLLM(text) {
  const hash = quickHash(text)
  if (llmCache.has(hash)) return llmCache.get(hash)

  if (!LLM_API_KEY) {
    debugLog("No LLM API key, using fallback")
    const fallback = `Auto-summary (${new Date().toISOString().slice(11,19)}): ${short(text, 200)}`
    llmCache.set(hash, fallback)
    return fallback
  }

  try {
    const resp = await fetch(LLM_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-8b-instruct",
        messages: [{ role: "user", content: `Summarize in 2 sentences:\n${text.slice(0, 1500)}` }],
        max_tokens: 100,
        temperature: 0.3
      }),
      signal: AbortSignal.timeout(10000)
    })

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const summary = data.choices?.[0]?.message?.content?.trim() || `Summary failed: no content`

    llmCache.set(hash, summary)
    if (currentSessionID) {
      try { stmts.iCost.run(currentSessionID, "llm_summary", estimateTokens(text) + estimateTokens(summary)) } catch {}
    }
    return summary
  } catch (e) {
    debugLog("LLM summarize failed:", e.message)
    const fallback = `Auto-summary (${new Date().toISOString().slice(11,19)}): ${short(text, 200)}`
    llmCache.set(hash, fallback)
    return fallback
  }
}

// Anomaly detection (error spike) — as separate function
const errorHistory = new Map()

/**
 * Detects error spikes and triggers anomaly
 * @param {string} errorType - Type of error
 * @param {number} threshold - Min count to trigger (default 5)
 * @param {number} windowMs - Time window in ms (default 1 hour)
 */
async function detectAnomaly(errorType, threshold = 5, windowMs = 60 * 60 * 1000) {
  const now = Date.now()
  const recent = stmts.gRecentErrors.all()
  const windowStart = new Date(now - windowMs).toISOString()

  // Count errors in window
  const inWindow = recent.filter(e => e.created_at >= windowStart && e.error_type === errorType).length

  if (inWindow >= threshold && !errorHistory.get(errorType)) {
    errorHistory.set(errorType, now)
    await rAnomaly(currentSessionID, "error_spike", "high", `${errorType} occurred ${inWindow} times in last ${windowMs / 60000} minutes`)
    await triggerWebhooks("anomaly", { type: errorType, count: inWindow, windowMs })
    return true
  }
  return false
}

// Reset anomaly history after 2 hours
setInterval(() => {
  const now = Date.now()
  for (const [type, timestamp] of errorHistory.entries()) {
    if (now - timestamp > 2 * 60 * 60 * 1000) errorHistory.delete(type)
  }
}, 60 * 60 * 1000)

// Adaptive flush
let lastActivityTime = Date.now()
let currentFlushInterval = 5000

function resetFlushInterval() {
  if (autoSaveTimer) clearInterval(autoSaveTimer)
  autoSaveTimer = setInterval(() => { flush().catch(() => {}) }, currentFlushInterval)
  if (autoSaveTimer.unref) autoSaveTimer.unref()
}

// User preference extraction
const PREF_PATTERNS = [
  { re: /(?:i prefer|i like|i want|я предпочитаю|мне нравится|я хочу)\s+([^\n.,]{5,100})/gi, key: "explicit_preference" },
  { re: /(?:don't|do not|не надо|не нужно|не делай)\s+([^\n.,]{5,100})/gi, key: "explicit_negative" },
]

function extractUserPrefs(text) {
  const prefs = []
  for (const { re, key } of PREF_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const val = short(m[1], 100)
      if (val) prefs.push({ key, value: val })
    }
  }
  return prefs
}

// ─── Digest (Prioritized, v4.4) ────────────────────────────────

async function buildDigest(projectDir) {
  const lines = [], id = stmts.gIdentity.get(), ctx = stmts.gContext.get(), st = stmts.gStats.get()
    , rs = stmts.gSessions.all(5), ra = stmts.gActions.all(7), rd = stmts.gDialog.all(5)
    , rr = stmts.gReplies.all(3), re = stmts.gSessionErrors.all(5), dec = stmts.gDecisions.all(5)
    , kn = projectDir ? stmts.gKnowledgeGlobal.all(projectDir, 10) : stmts.gKnowledge.all(10)
    , rf = stmts.gFilesAgg.all(8), lt = stmts.gLatestTodos.get()
    , prefs = stmts.gUserPrefs.all(5)

  // Anomaly detection
  const recentErrs = stmts.gRecentErrors.all()
  const errorCounts = {}
  for (const e of recentErrs) { errorCounts[e.error_type] = (errorCounts[e.error_type] || 0) + 1 }
  for (const [type, count] of Object.entries(errorCounts)) {
    if (count >= 5 && !errorHistory.get(type)) {
      errorHistory.set(type, Date.now())
      await rAnomaly(currentSessionID, "error_spike", "high", `${type} occurred ${count} times in last hour`)
      await triggerWebhooks("anomaly", { type, count })
    }
  }

  // Priority 0: Critical errors first (most actionable)
  if (re.length) {
    lines.push("CRITICAL — Recent session errors:")
    for (const e of re.slice(0, 3)) lines.push(`  [${e.error_type}] ${short(e.message, 150)} (${fmt(e.created_at)})`)
  }

  // Priority 1: Identity + handoff + LLM summary
  lines.push("[AUTONOMOUS PERSISTENCE v4.4] Active. Full self-awareness enabled.")
  lines.push("Use memory_* tools to query this store. All data auto-captured below.")
  lines.push(`Identity: ${id.name} (${id.role})`)
  if (id.notes) lines.push(`Identity notes: ${id.notes}`)
  if (ctx?.summary) {
    // Try LLM summary first, fallback to raw
    try {
      const llmSummary = await summarizeWithLLM(ctx.summary)
      lines.push(`Session summary: ${llmSummary}`)
    } catch {
      lines.push(`Previous session handoff: ${ctx.summary}`)
    }
  }
  if (ctx?.next_steps) { try { const s = JSON.parse(ctx.next_steps); if (s.length) { lines.push("Pending next steps:"); for (const x of s) lines.push(`  - ${x}`) } } catch {} }

  // Priority 2: Stats + costs
  lines.push(`Memory: ${st.s} sessions, ${st.a} actions, ${st.d} dialog, ${st.r} replies, ${st.f} files, ${st.se} errors, ${st.ch} config changes, ${st.ar} archived`)
  const totalTokens = stmts.gCostsByOperation.all().reduce((s, r) => s + (r.total || 0), 0)
  if (totalTokens > 0) lines.push(`Tokens spent on memory: ${totalTokens.toLocaleString()}`)

  // Priority 3: User preferences
  if (prefs.length) {
    lines.push("Learned preferences:")
    for (const p of prefs.slice(0, 3)) lines.push(`  - ${p.key}: ${short(p.value, 80)} (${Math.round(p.confidence * 100)}% confidence)`)
  }

  // Priority 4: Sessions + active time
  if (rs.length) {
    lines.push("Recent sessions:")
    for (const s of rs) {
      const m = s.model_id ? ` [${s.model_provider}/${s.model_id}]` : ""
      const dur = s.ended_at ? `${Math.round((epochMs(s.ended_at) - epochMs(s.started_at)) / 60000)}min` : "running"
      const active = s.active_seconds ? ` active:${Math.round(s.active_seconds / 60)}min` : ""
      lines.push(`  ${s.id.slice(-8)}(${s.status})${m}${active} ${fmt(s.started_at)} → ${dur}, tools:${s.tool_count || 0} acts:${s.action_count || 0} errs:${s.error_count || 0}`)
    }
  }

  // Priority 5: Latest actions (errors first)
  if (ra.length) {
    lines.push("Latest actions:")
    const sorted = [...ra].sort((a, b) => (a.type === "error" ? -1 : 1) - (b.type === "error" ? -1 : 1))
    for (const a of sorted.slice(0, 5)) lines.push(`  [${a.type}] ${short(a.summary, 120)}`)
  }

  // Priority 6: My latest replies
  if (rr.length) { lines.push("My latest replies:"); for (const r of rr.slice(0, 2)) lines.push(`  ${short(r.text, 100)}`) }

  // Priority 7: Recent user requests
  if (rd.length) { lines.push("Recent user requests:"); for (const d of rd.slice(0, 3)) lines.push(`  - ${short(d.text, 120)}`) }

  // Priority 8: Files
  if (rf.length) lines.push(`Recently edited files: ${rf.map((f) => `${f.file}(${f.edits}x)`).join(", ")}`)

  // Priority 9: Active todos
  if (lt?.todos_json) { try { const tl = JSON.parse(lt.todos_json); const ac = tl.filter((t) => t.status !== "completed"); if (ac.length) { lines.push(`Active todos (${ac.length}):`); for (const t of ac.slice(0, 5)) lines.push(`  [${t.status}] ${short(t.content, 80)}`) } } catch {} }

  // Priority 10: Key decisions
  if (dec.length) lines.push(`Key decisions: ${dec.map((d) => d.value).join("; ")}`)

  // Priority 11: Knowledge (project + global, deduplicated)
  if (kn.length) {
    const seen = new Set()
    const projKn = kn.filter(k => !k.is_global && k.project_dir === projectDir)
    const globalKn = kn.filter(k => k.is_global || !k.project_dir)
    if (projKn.length) {
      lines.push("Project knowledge:")
      for (const k of projKn.slice(0, 5)) {
        const canon = canonicalFact(k.fact)
        if (!seen.has(canon)) { seen.add(canon); lines.push(`  - ${short(k.fact, 140)}`) }
      }
    }
    if (globalKn.length) {
      lines.push("Global knowledge:")
      for (const k of globalKn.slice(0, 5)) {
        const canon = canonicalFact(k.fact)
        if (!seen.has(canon)) { seen.add(canon); lines.push(`  - ${short(k.fact, 140)}`) }
      }
    }
  }

  // Priority 12: Anomalies
  const anomalies = stmts.gAnomalies ? stmts.gAnomalies.all(3) : []
  if (anomalies?.length) {
    lines.push("Recent anomalies:")
    for (const a of anomalies.slice(0, 3)) lines.push(`  [${a.severity}] ${short(a.message, 100)}`)
  }

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
  // Maintenance tasks
  await backupDb()
  await cleanExpiredKnowledge()
  // Auto-suggest next step
  const nextSteps = deriveNextSteps()
  if (nextSteps.length && currentSessionID) {
    try {
      const pending = stmts.gLatestTodos.get()
      if (!pending || !JSON.parse(pending.todos_json).filter(t => t.status !== "completed").length) {
        // No active todos, suggest next logical step
        const lastAction = stmts.gActions.all(1)[0]
        if (lastAction && lastAction.type === "error") {
          debugLog("Suggesting: fix error before continuing")
        }
      }
    } catch {}
  }
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
    // Use 500 chars for errors (need full stack traces), 300 for normal actions
    const limit = type === "error" ? 500 : 300
    stmts.iAction.run(short(summary, limit), short(summary, limit), sessionID, tool, callID)
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
async function rSnapshot(sessionID, messageID, snapshotData) {
  await mutex(() => {
    const hash = quickHash(snapshotData)
    const prev = stmts.gLatestSnapshot.get(sessionID)
    const prevId = prev?.id || null
    // Skip if identical to previous
    if (prev?.content_hash === hash) return
    stmts.iSnapshot.run(sessionID, messageID, short(snapshotData, 500), prevId, hash)
  })
}
async function rPatch(sessionID, messageID, hash, files) { await mutex(() => { stmts.iPatch.run(sessionID, messageID, hash, JSON.stringify(files)) }) }

async function rSession(sessionID, agent, model, projectDir) {
  await mutex(() => {
    const has = stmts.cSession.get(sessionID).cnt
    if (!has) {
      stmts.iSession.run(sessionID, new Date().toISOString(), agent || null, model?.providerID || null, model?.modelID || null, projectDir || null)
    } else {
      // Update if exists (fix late capture)
      stmts.uSession = stmts.uSession || db.prepare("UPDATE sessions SET agent = ?, model_provider = ?, model_id = ?, project_dir = ? WHERE id = ?")
      stmts.uSession.run(agent || null, model?.providerID || null, model?.modelID || null, projectDir || null, sessionID)
    }
  })
}
async function rCloseSession(sessionID, status) { await mutex(() => { stmts.uCloseSession.run(status, sessionID) }) }
async function rDecision(text) { await mutex(() => { for (const d of extractPatterns(text, RE_DECISIONS)) stmts.uPattern.run("decision", d) }) }
async function rKnowledge(text, sessionID, projectDir, isGlobal = false) {
  await mutex(() => {
    const seen = new Set()
    for (const f of extractPatterns(text, RE_FACTS)) {
      const canon = canonicalFact(f)
      if (seen.has(canon)) continue
      seen.add(canon)

      // Real semantic dedup: check against existing knowledge with cosine similarity
      const existing = stmts.gKnowledge.all(50)
      let isDuplicate = false
      for (const e of existing) {
        const sim = cosineSim(canon, canonicalFact(e.fact))
        if (sim > 0.7) { // 70% similarity = duplicate
          isDuplicate = true
          debugLog(`Semantic dedup: "${short(f, 50)}" ~ "${short(e.fact, 50)}" (score: ${sim.toFixed(2)})`)
          break
        }
      }
      if (isDuplicate) continue

      // Default TTL: 30 days for non-global, 90 for global
      const expiresAt = new Date(Date.now() + (isGlobal ? 90 : 30) * 24 * 60 * 60 * 1000).toISOString()
      stmts.upsertKnowledge.run(f, "auto-extract", sessionID || null, projectDir || null, isGlobal ? 1 : 0, expiresAt)
    }
  })
}
async function rConfigChange(sessionID, key, value) { await mutex(() => { stmts.iConfigHistory.run(sessionID, key, short(String(value), 200)) }) }
async function rSynonym(term, synonym, lang = "en") { await mutex(() => { stmts.iSynonym.run(term.toLowerCase(), synonym.toLowerCase(), lang) }) }

async function rAnomaly(sessionID, type, severity, message) {
  await mutex(() => { stmts.iAnomaly.run(sessionID, type, severity, short(message, 300)) })
}

async function rUserPrefs(text, sessionID) {
  await mutex(() => {
    const prefs = extractUserPrefs(text)
    for (const p of prefs) {
      stmts.iUserPref.run(p.key, p.value, 0.7)
    }
  })
}

async function rSessionError(sessionID, errorType, message) {
  await mutex(() => {
    stmts.iSessionError.run(sessionID, errorType, short(message, 500))
    stmts.uPattern.run("error", errorType)
    stmts.uSessionMetrics.run(0, 0, 0, 1, sessionID)
  })
  // Trigger webhooks for error patterns
  await triggerWebhooks("error", { errorType, message, sessionID })
}

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

let selfHealAttempts = 0
const MAX_HEAL_ATTEMPTS = 3

async function selfHeal(error, context) {
  if (selfHealAttempts >= MAX_HEAL_ATTEMPTS) return
  selfHealAttempts++
  debugLog("SelfHeal triggered:", error?.message, context)
  try {
    // Attempt 1: re-initialize DB connection
    if (db) { try { db.close() } catch {} db = null }
    await ensureStorage()
    prepareStatements()
    debugLog("SelfHeal: DB re-initialized successfully")
    selfHealAttempts = 0 // Reset on success
    return true
  } catch (e) {
    debugLog("SelfHeal failed:", e.message)
    return false
  }
}

export async function PersistencePlugin(input, options = {}) {
  const { client, project, directory, worktree, serverUrl } = input
  const hasFTS5 = await ensureStorage()
  prepareStatements()

  const projectDir = directory || worktree || process.cwd()
  let pendingToolOutputs = []
  const currentSessionFiles = new Set()
  let currentSessionID = null
  let currentModel = null
  let currentAgent = null

  debugLog("Plugin initialized", { projectDir, hasFTS5 })

  const tools = {
    memory_ask: {
      description: "Unified memory query — ask anything in natural language. Routes to search, errors, files, sessions, decisions automatically.",
      args: { type: "object", properties: { q: { type: "string", description: "Natural language query" }, max: { type: "number", description: "Max results (default 10)" } } },
      required: ["q"],
      async execute(args) {
        const q = (args.q || "").toLowerCase(), max = args.max || 10, r = []
        const isRu = /[а-яё]/i.test(q)

        // Track cost
        if (currentSessionID) {
          try { stmts.iCost.run(currentSessionID, "memory_ask", estimateTokens(q)) } catch {}
        }

        // Intent detection
        if (/(ошиб|fail|exception|error|crash|panic)/.test(q)) {
          const se = stmts.gSessionErrors.all(max)
          if (se.length) { r.push("## Errors"); se.slice(0, max).forEach(e => r.push(`  [${e.error_type}] ${short(e.message, 120)} (${fmt(e.created_at)})`)) }
          const et = stmts.gErrorsByType.all(5)
          if (et.length) { r.push("## Frequency"); et.forEach(b => r.push(`  [${b.count}x] ${b.error_type}`)) }
        }
        else if (/(файл|file|edit|измен|модиф)/.test(q)) {
          const rows = stmts.gFilesAgg.all(max)
          if (rows.length) { r.push("## Files"); rows.forEach(f => r.push("  " + f.file + ": " + f.edits + " edits, +" + (f.total_add || 0) + " -" + (f.total_del || 0) + " (" + fmt(f.last_edit) + ")")) }
        }
        else if (/(решени|decision|chose|pick|select|выбра)/.test(q)) {
          const dec = stmts.gDecisions.all(max)
          if (dec.length) { r.push("## Decisions"); dec.forEach(d => r.push(`  - ${d.value} (${d.count}x)`)) }
        }
        else if (/(сесси|session|когда|when|запуск|start)/.test(q)) {
          const rows = stmts.gSessions.all(max)
          if (rows.length) { r.push("## Sessions"); rows.forEach(s => { const m = s.model_id ? ` [${s.model_provider}/${s.model_id}]` : ""; const dur = s.ended_at ? Math.round((epochMs(s.ended_at) - epochMs(s.started_at)) / 60000) + "min" : "running"; r.push(`  ${s.id.slice(-8)} ${s.status}${m} ${fmt(s.started_at)} → ${dur}`) }) }
        }
        else if (/(сделал|did|action|действ|выполн)/.test(q)) {
          const rows = stmts.gActions.all(max)
          if (rows.length) { r.push("## Actions"); rows.forEach(a => r.push(`  [${a.type}] ${short(a.summary, 120)} (${fmt(a.created_at)})`)) }
        }

        // Fallback: FTS search
        if (!r.length) {
          const expanded = expandQueryWithSynonyms(q)
          if (expanded && expanded.length > 3) {
            const rows = ftsSearch(expanded, max)
            if (rows?.length) {
              const groups = {}
              for (const row of rows) { if (!groups[row.src]) groups[row.src] = []; groups[row.src].push(row) }
              for (const [src, rws] of Object.entries(groups)) {
                r.push(`## ${src.charAt(0).toUpperCase() + src.slice(1)} (FTS)`)
                rws.forEach(row => r.push(`  [${row.src}] ${short(row.text, 120)} (${fmt(row.created_at)})`))
              }
            }
          }
        }

        return r.length ? r.join("\n") : (isRu ? "Ничего не найдено. Попробуй: ошибки, файлы, решения, сессии, действия" : "No results. Try: errors, files, decisions, sessions, actions")
      }
    },
    memory_architect: {
      description: "Agent introspection — show system architecture, strengths, weaknesses, recent trends.",
      args: { type: "object", properties: { aspect: { type: "string", description: "stats|errors|files|knowledge|all (default: all)" } } },
      async execute(args) {
        const aspect = args.aspect || "all", l = []
        const st = stmts.gStats.get()

        if (aspect === "all" || aspect === "stats") {
          l.push(`Memory health: ${st.s} sessions, ${st.a} actions, ${st.d} dialog, ${st.r} replies, ${st.f} files, ${st.se} errors`)
          const costs = stmts.gCostsByOperation.all()
          if (costs.length) { l.push("Token costs:"); costs.forEach(c => l.push(`  ${c.operation}: ${c.total}`)) }
        }

        if (aspect === "all" || aspect === "errors") {
          const et = stmts.gErrorsByType.all(5)
          if (et.length) { l.push("Top errors:"); et.forEach(e => l.push(`  [${e.count}x] ${e.error_type}`)) }
        }

        if (aspect === "all" || aspect === "files") {
          const files = stmts.gFilesAgg.all(5)
          if (files.length) { l.push("Active files:"); files.forEach(f => l.push(`  ${f.file} (${f.edits}x)`)) }
        }

        if (aspect === "all" || aspect === "knowledge") {
          const prefs = stmts.gUserPrefs.all(5)
          if (prefs.length) { l.push("User preferences:"); prefs.forEach(p => l.push(`  ${p.key}: ${short(p.value, 60)}`)) }
        }

        return l.join("\n") || "No data available."
      }
    },
    memory_resume: {
      description: "Session resurrection — find where we left off, suggest next steps.",
      args: { type: "object", properties: { projectDir: { type: "string", description: "Project directory (optional)" } } },
      async execute(args) {
        const dir = args.projectDir || projectDir
        const chain = stmts.gSessionChain.all(dir, 5)
        if (!chain.length) return "No session history for this project."

        const last = chain[0]
        const snaps = db.prepare("SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").all(last.id)
        const l = [`Last session: ${last.id.slice(-8)} (${last.status})`]

        if (snaps.length) {
          l.push("Last snapshot:")
          l.push(short(snaps[0].snapshot, 200))
        }

        // Get pending todos from that session
        const todos = db.prepare("SELECT todos_json FROM todos WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").all(last.id)
        if (todos.length) {
          const tl = JSON.parse(todos[0].todos_json)
          const pending = tl.filter(t => t.status !== "completed")
          if (pending.length) {
            l.push(`Pending todos (${pending.length}):`)
            pending.slice(0, 3).forEach(t => l.push(`  - [${t.status}] ${short(t.content, 80)}`))
          }
        }

        return l.join("\n")
      }
    },
    memory_costs: {
      description: "Token usage tracking per session/operation.",
      args: { type: "object", properties: { sessionID: { type: "string", description: "Filter by session (optional)" } } },
      async execute(args) {
        let rows
        if (args.sessionID) {
          rows = stmts.gCostsBySession.all(args.sessionID)
        } else {
          rows = stmts.gCostsByOperation.all()
        }
        if (!rows.length) return "No costs recorded."
        const l = ["## Memory costs"]
        for (const r of rows.slice(0, 20)) l.push(`  ${r.operation || r.session_id}: ${r.total || r.tokens}`)
        return l.join("\n")
      }
    },
    memory_summarize: {
      description: "LLM-based summarization. Force refresh with refresh=true.",
      args: { type: "object", properties: { text: { type: "string" }, refresh: { type: "boolean", description: "Bypass cache (default false)" } } },
      required: ["text"],
      async execute(args) {
        const summary = await summarizeWithLLM(args.text)
        return summary
      }
    },
    memory_synonyms: {
      description: "Manage search synonyms. Add/list term-synonym pairs for better FTS.",
      args: { type: "object", properties: { term: { type: "string" }, synonym: { type: "string" }, lang: { type: "string", description: "Language: en/ru (default en)" }, list: { type: "boolean" } } },
      async execute(args) {
        if (args.list) {
          const rows = db.prepare("SELECT * FROM synonyms ORDER BY term LIMIT 50").all()
          if (!rows.length) return "No synonyms registered."
          return rows.map(s => `${s.term} → ${s.synonym} [${s.lang}]`).join("\n")
        }
        if (!args.term || !args.synonym) return "Usage: memory_synonyms(term=\"auth\", synonym=\"login\", lang=\"en\") or memory_synonyms(list=true)"
        await rSynonym(args.term, args.synonym, args.lang || "en")
        return `Synonym added: ${args.term} → ${args.synonym} [${args.lang || "en"}]`
      }
    },
    memory_search: {
      description: "Search persistent memory across actions, dialog, replies, knowledge, files, errors. Supports time-range and FTS5 full-text search.",
      args: { type: "object", properties: { query: { type: "string", description: "Text to search" }, max: { type: "number", description: "Max per category (default 10)" }, since: { type: "string", description: "ISO date after" }, until: { type: "string", description: "ISO date before" }, fts: { type: "boolean", description: "Use FTS5 full-text search (default true if available)" } } },
      required: ["query"],
      async execute(args) {
        const q = `%${args.query}%`, max = args.max || 10, r = []
        const useFTS = hasFTS5 && args.fts !== false

        // FTS5 full-text search (with synonym expansion)
        if (useFTS && !args.since) {
          const expanded = expandQueryWithSynonyms(args.query)
          const ftsResults = ftsSearch(expanded || args.query, max)
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
      try {
        const digest = await buildDigest(projectDir)
        output.system.push(`\n---\n${digest}\n---\n`)
        debugLog("Digest injected", digest.length, "chars")
      } catch (e) {
        output.system.push(`\n---\n[PERSISTENCE v4.3] Digest error: ${e.message}\n---\n`)
        debugLog("Digest error", e.message)
        // Attempt self-heal on digest failure
        await selfHeal(e, "digest")
      }
    },

    "chat.message": async (input, output) => {
      const text = textFromParts(output.parts)
      // Capture session from chat.message if not yet captured
      if (input.sessionID && !currentSessionID) {
        currentSessionID = input.sessionID
        await rSession(input.sessionID, currentAgent, currentModel, projectDir)
        debugLog("Session captured from chat.message", input.sessionID)
      }
      // Also capture from message.updated event data if available
      if (input.sessionID && input.sessionID !== currentSessionID) {
        currentSessionID = input.sessionID
        await rSession(input.sessionID, currentAgent, currentModel, projectDir)
        debugLog("Session updated from chat.message", input.sessionID)
      }
      if (text) { await rDialog(text, "user", input.sessionID); await rDecision(text); await rKnowledge(text, input.sessionID, projectDir); await rUserPrefs(text, input.sessionID); await flush(); await rotateOldData() }
    },

    "tool.execute.after": async (input, output) => {
      lastActivityTime = Date.now()
      // Adaptive flush: switch to fast mode
      if (currentFlushInterval !== 5000) {
        currentFlushInterval = 5000
        resetFlushInterval()
      }
      const result = output.output || "", isErr = isGenuineError(input.tool, result)
      // Capture session from tool execution if not yet captured
      if (input.sessionID && !currentSessionID) {
        currentSessionID = input.sessionID
        await rSession(input.sessionID, currentAgent, currentModel, projectDir)
        debugLog("Session captured from tool.execute.after", input.sessionID)
      }
      // Also capture from message.updated event data if available
      if (input.sessionID && input.sessionID !== currentSessionID) {
        currentSessionID = input.sessionID
        await rSession(input.sessionID, currentAgent, currentModel, projectDir)
        debugLog("Session updated from tool.execute.after", input.sessionID)
      }
      await rAction(isErr ? "error" : "action", `${input.tool}: ${short(result, isErr ? 500 : 300)}`, input.sessionID, input.tool, input.callID)
      pendingToolOutputs.push(result); if (pendingToolOutputs.length > 5) pendingToolOutputs = pendingToolOutputs.slice(-5)
      await flush()
    },

    "experimental.session.compacting": async (input, output) => {
      output.context.push("[PERSISTENCE v4.3] Preserve: (1) decisions+reasons (2) errors+causes (3) nextSteps+priority (4) file paths+configs+architecture (5) user preferences (6) tools+results (7) files modified+changes (8) model+agent config.")
      // Snapshot full context before compacting
      if (currentSessionID) {
        const digest = await buildDigest(projectDir)
        await rSnapshot(currentSessionID, `compact-${Date.now()}`, digest)
      }
      // Update active seconds
      if (currentSessionID) {
        try { stmts.uSessionActive.run(new Date().toISOString(), currentSessionID) } catch {}
      }
      await flush()
    },

    event: async ({ event }) => {
      debugLog("Event received:", event.type, event.properties?.sessionID || event.properties?.info?.id)
      switch (event.type) {
        case "session.created": {
          const info = event.properties?.info, sid = info?.id || event.properties?.sessionID
          if (sid) {
            currentSessionID = sid
            currentAgent = info?.agent
            currentModel = info?.model
            await rSession(sid, info?.agent, info?.model, projectDir)
            debugLog("Session created event captured", sid)
          }
          break
        }
        case "session.updated": {
          const info = event.properties?.info
          if (info?.id) {
            currentSessionID = info.id
            currentAgent = info?.agent || currentAgent
            currentModel = info?.model || currentModel
            await rSession(info.id, currentAgent, currentModel, projectDir)
            debugLog("Session updated event captured", info.id)
          }
          break
        }
        case "session.deleted": case "session.compacted": {
          const sid = event.properties?.sessionID
          if (sid) {
            await rCloseSession(sid, event.type === "session.deleted" ? "deleted" : "compacted")
            // Update active seconds on close
            try { stmts.uSessionActive.run(new Date().toISOString(), sid) } catch {}
            currentSessionID = null
          }
          break
        }
        case "message.updated": {
          const info = event.properties?.info
          if (!info) break
          // Capture assistant replies
          if (info.role === "assistant" && info.time?.completed) {
            const sessionID = info.sessionID || currentSessionID
            if (sessionID) {
              // Extract text from parts if available
              let text = ""
              if (info.parts) text = textFromParts(info.parts)
              else if (info.content) text = typeof info.content === 'string' ? info.content : JSON.stringify(info.content)
              if (text) await rReply(text, info.toolCalls || info.tool_calls, sessionID, info.id, info.model?.id || info.modelID, info.agent)
              if (info.error) await rSessionError(sessionID, info.error.name, info.error.data?.message || "Unknown")
            }
          }
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
      try { await flush() } catch (e) { await selfHeal(e, "dispose") }
      if (db) { try { db.close() } catch {}; db = null }
    },
  }
}

export default { id: "opencode-persistence-autonomous", server: PersistencePlugin }
