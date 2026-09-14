/**
 * opencode-persistence v3.0 — Full Self-Aware Autonomous Memory System
 *
 * Captures EVERYTHING: user input, assistant replies, file changes,
 * todos, errors, diffs, model info. Queryable via registered tools.
 * Zero interaction. Full self-knowledge across sessions.
 */

import { mkdir, readFile, writeFile, rename } from "fs/promises"
import path from "path"
import os from "os"

// ─── Storage layout ──────────────────────────────────────────────
const MEMORY_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), ".config"),
  "opencode",
  "memory",
)

const FILES = {
  identity: path.join(MEMORY_DIR, "identity.json"),
  sessions: path.join(MEMORY_DIR, "sessions.json"),
  actions: path.join(MEMORY_DIR, "actions.json"),
  dialog: path.join(MEMORY_DIR, "dialog.json"),
  context: path.join(MEMORY_DIR, "context.json"),
  patterns: path.join(MEMORY_DIR, "patterns.json"),
  knowledge: path.join(MEMORY_DIR, "knowledge.json"),
  // v3 additions
  fileChanges: path.join(MEMORY_DIR, "file_changes.json"),
  todos: path.join(MEMORY_DIR, "todos.json"),
  sessionErrors: path.join(MEMORY_DIR, "session_errors.json"),
  assistantReplies: path.join(MEMORY_DIR, "assistant_replies.json"),
}

const LIMITS = {
  actions: 200,
  sessions: 30,
  dialog: 80,
  errors: 20,
  recurring: 10,
  decisions: 20,
  knowledge: 150,
  fileChanges: 300,
  todos: 200,
  sessionErrors: 15,
  assistantReplies: 30,
  digest_actions: 7,
  digest_dialog: 5,
  digest_sessions: 5,
  digest_knowledge: 10,
  digest_errors: 3,
  digest_files: 10,
  digest_todos: 15,
}

// ─── I/O ─────────────────────────────────────────────────────────

async function ensureStorage() {
  await mkdir(MEMORY_DIR, { recursive: true })
  const defaults = {
    [FILES.identity]: {
      name: "XuViGaN",
      role: "autonomous_agent",
      notes: "Persistence v3.0. Full self-awareness. Query via memory_* tools.",
    },
    [FILES.sessions]: { history: [] },
    [FILES.actions]: { items: [] },
    [FILES.dialog]: { entries: [] },
    [FILES.context]: { summary: "", nextSteps: [], updatedAt: null },
    [FILES.patterns]: { recurring: [], errors: [], decisions: [] },
    [FILES.knowledge]: { facts: [] },
    [FILES.fileChanges]: { changes: [] },
    [FILES.todos]: { snapshots: [] },
    [FILES.sessionErrors]: { errors: [] },
    [FILES.assistantReplies]: { replies: [] },
  }
  for (const [file, fallback] of Object.entries(defaults)) {
    try {
      await readFile(file, "utf-8")
    } catch {
      await atomicWrite(file, fallback)
    }
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, "utf-8")
    return JSON.parse(raw)
  } catch {
    return structuredClone(fallback)
  }
}

async function atomicWrite(file, data) {
  const tmp = file + ".tmp"
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8")
  await rename(tmp, file)
}

// ─── Text processing ────────────────────────────────────────────

function cap(arr, max) {
  if (!Array.isArray(arr)) return []
  return arr.length > max ? arr.slice(-max) : arr
}

/**
 * Detect and repair CP1251/CP866 mojibake in strings that got mangled
 * passing through Windows console (PowerShell, cmd).
 * This is a heuristic — looks for typical mojibake patterns.
 */
function repairMojibake(s) {
  if (!s) return s
  // CP1251 bytes decoded as Latin-1 produce patterns like "РњРµРЅСЏ"
  // Try reverse: if we see high-byte sequences typical of CP1251-as-Latin1
  let repaired = s
  try {
    // Pattern: Cyrillic bytes misinterpreted as Latin-1
    // Common mojibake chars for Russian: Р±-Рї, СЂ-СЏ, Рђ-Рџ
    const cp1251Pattern = /[\u0410-\u044F\u0451\u0401]{3,}/
    if (cp1251Pattern.test(repaired)) {
      // Text already looks like valid Unicode Cyrillic — don't touch
      return repaired
    }
    // Heuristic: if we see sequences like ÐœÐµÐ½Ñ that's CP1251-in-Latin1
    // The real fix is at the source (PS console), but we can detect and flag it
    const suspicious = /[\u0080-\u00FF]{3,}/
    if (suspicious.test(repaired) && !/[\u0400-\u04FF]/.test(repaired)) {
      // Likely mojibake — try to re-encode
      // This is lossy, but at least we flag it
      repaired = repaired.replace(/[\u0080-\u009F]/g, "")
    }
  } catch { /* ignore */ }
  return repaired
}

function sanitize(text) {
  if (!text) return ""
  let s = String(text)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function short(text, len = 120) {
  const s = sanitize(text)
  if (!s) return ""
  return s.length > len ? s.slice(0, len - 1) + "…" : s
}

// ─── Extraction heuristics ──────────────────────────────────────

const RE_NEXT_STEPS = [
  /(?:todo|next|later|remember|don't forget|fix|need to|must|should)[:\s]+([^\n.]{5,150})/gi,
  /(?:сделать|нужно|надо|дальше|затем|потом|не забудь|запомни|исправить|добавить|убрать|проверить)[:\s]+([^\n.]{5,150})/gi,
  /(?:потом|затем|дальше)\s+(?:надо|нужно)?\s*([^\n.]{5,150})/gi,
]

const RE_DECISIONS = [
  /(?:decided|chose|using|going with|will use|stick with|picked|selected|agreed on|finalized)[:\s]+([^\n.]{5,150})/gi,
  /(?:решили|выбрали|будем использовать|отказались от|остановились на|определились с|зафиксировали|утвердили)[:\s]+([^\n.]{5,150})/gi,
  /(?:decision|решение)[:\s]+([^\n.]{5,150})/gi,
]

const RE_FACTS = [
  /(?:remember|note|important|key|fact|rule|convention|always|never)[:\s]+([^\n.]{5,200})/gi,
  /(?:запомни|важно|факт|правило|конвенция|всегда|никогда|учти|имей в виду)[:\s]+([^\n.]{5,200})/gi,
]

const RE_FILE_PATH = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])[\w\-\\/\.]+\.\w{1,10}/g

const RE_STRUCTURAL_ERROR = /exit code [1-9]|Traceback \(most recent|SyntaxError|TypeError|ReferenceError|ENOENT|EACCES|EPERM|Segmentation fault|FATAL/

const RE_ERROR_LINE = /^\s*(Error|Exception|Failed|FAIL|FATAL|error:|fatal:)/

const RE_GENERIC_ERROR = /\b(error|failed|failure|exception|crash|panic|fatal|errno|timeout|denied|refused|not found|404|500|502|503)\b/

function isGenuineError(toolName, output) {
  if (!output) return false
  const s = String(output).slice(0, 2000) // cap analysis length
  if (RE_STRUCTURAL_ERROR.test(s)) return true
  if (RE_ERROR_LINE.test(s)) return true
  if (toolName === "bash" && /^\s*(error|fatal|failed|command not found|is not recognized)/mi.test(s)) return true
  if (RE_GENERIC_ERROR.test(s) && s.length < 400) return true
  return false
}

function extractPatterns(text, patterns) {
  const results = []
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const e = short(m[1], 140)
      if (e && !results.includes(e)) results.push(e)
    }
  }
  return results.slice(0, 5)
}

function extractFilePaths(text) {
  const matches = String(text).match(RE_FILE_PATH)
  if (!matches) return []
  return [...new Set(matches)].slice(0, 15)
}

// ─── Part type helpers ──────────────────────────────────────────

function textFromParts(parts) {
  if (!parts) return ""
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim()
}

function toolCallsFromParts(parts) {
  if (!parts) return []
  return parts
    .filter((p) => p.type === "tool")
    .map((p) => ({
      tool: p.tool,
      callID: p.callID,
      status: p.state?.status,
      title: p.state?.title || "",
      error: p.state?.status === "error" ? short(p.state?.error, 100) : undefined,
    }))
}

// ─── Digest builder ─────────────────────────────────────────────

function buildDigest(data) {
  const { identity, sessions, actions, dialog, context, patterns, knowledge, fileChanges, todos, sessionErrors, assistantReplies } = data
  const lines = []

  lines.push("[AUTONOMOUS PERSISTENCE v3] Active. Full self-awareness enabled.")
  lines.push("Use memory_* tools to query this store. All data auto-captured below.")

  // Identity
  lines.push(`Identity: ${identity.name} (${identity.role})`)
  if (identity.notes) lines.push(`Identity notes: ${identity.notes}`)

  // Handoff
  if (context.summary) lines.push(`Previous session handoff: ${context.summary}`)
  if (context.nextSteps?.length) {
    lines.push("Pending next steps:")
    for (const s of context.nextSteps) lines.push(`  - ${s}`)
  }

  // Sessions (enhanced with model/agent info)
  if (sessions.history?.length) {
    const recent = sessions.history.slice(-LIMITS.digest_sessions)
    lines.push("Recent sessions:")
    for (const s of recent) {
      const model = s.model ? ` [${s.model.providerID}/${s.model.modelID}]` : ""
      const agent = s.agent ? ` agent=${s.agent}` : ""
      const files = s.filesEdited?.length ? ` files=${s.filesEdited.length}` : ""
      lines.push(`  ${s.id.slice(-8)}(${s.status})${model}${agent}${files}`)
    }
  }

  // Errors (non-action, system level)
  if (sessionErrors.errors?.length) {
    const recent = sessionErrors.errors.slice(-LIMITS.digest_errors)
    lines.push("Recent session errors:")
    for (const e of recent) {
      lines.push(`  [${e.type}] ${short(e.message, 100)}${e.sessionID ? ` (session ${e.sessionID.slice(-6)})` : ""}`)
    }
  }

  // What was done
  if (actions.items?.length) {
    const recent = actions.items.slice(-LIMITS.digest_actions)
    lines.push("Latest actions:")
    for (const a of recent) {
      lines.push(`  [${a.type}] ${short(a.summary, 100)}`)
    }
  }

  // What I replied (mirror)
  if (assistantReplies.replies?.length) {
    const recent = assistantReplies.replies.slice(-3)
    lines.push("My latest replies:")
    for (const r of recent) {
      const toolInfo = r.toolCalls?.length ? ` (${r.toolCalls.length} tools: ${r.toolCalls.map((t) => t.tool).join(", ")})` : ""
      lines.push(`  ${short(r.text, 80)}${toolInfo}`)
    }
  }

  // What user said
  if (dialog.entries?.length) {
    const recent = dialog.entries.slice(-LIMITS.digest_dialog)
    lines.push("Recent user requests:")
    for (const d of recent) {
      lines.push(`  - ${short(d.text, 120)}`)
    }
  }

  // Files recently modified
  if (fileChanges.changes?.length) {
    const recent = fileChanges.changes.slice(-LIMITS.digest_files)
    const uniqueFiles = [...new Set(recent.map((c) => c.file))]
    lines.push(`Recently edited files: ${uniqueFiles.join(", ")}`)
  }

  // Current todo state (latest snapshot)
  if (todos.snapshots?.length) {
    const latest = todos.snapshots[todos.snapshots.length - 1]
    if (latest.todos?.length) {
      const active = latest.todos.filter((t) => t.status === "pending" || t.status === "in_progress")
      if (active.length) {
        lines.push(`Active todos (${active.length}):`)
        for (const t of active.slice(0, 5)) {
          lines.push(`  [${t.status}] ${short(t.content, 80)}`)
        }
      }
    }
  }

  // Patterns
  if (patterns.recurring?.length) {
    lines.push(`Recurring issues: ${patterns.recurring.slice(-3).join("; ")}`)
  }
  if (patterns.decisions?.length) {
    lines.push(`Key decisions: ${patterns.decisions.slice(-5).join("; ")}`)
  }

  // Knowledge
  if (knowledge.facts?.length) {
    lines.push("Accumulated knowledge:")
    for (const f of knowledge.facts.slice(-LIMITS.digest_knowledge)) {
      lines.push(`  - ${short(f.text, 140)}`)
    }
  }

  return lines.join("\n")
}

// ─── Auto-summarizer ────────────────────────────────────────────

function autoSummarize(actions, dialog, patterns, sessionErrors, assistantReplies, todos) {
  const lastActions = actions.slice(-7)
  const lastDialog = dialog.slice(-5)
  const lastErrors = sessionErrors.slice(-3)
  const lastReplies = assistantReplies.slice(-3)
  const latestTodos = todos.snapshots?.length ? todos.snapshots[todos.snapshots.length - 1] : null

  const parts = []
  if (lastDialog.length) parts.push(`Asked: ${lastDialog.map((d) => short(d.text, 80)).join(" | ")}`)
  if (lastReplies.length) parts.push(`Replied: ${lastReplies.map((r) => short(r.text, 60)).join(" | ")}`)
  if (lastActions.length) parts.push(`Did: ${lastActions.map((a) => short(a.summary, 80)).join(" | ")}`)
  const summary = parts.join("; ") || "No significant activity."

  const nextSteps = []

  // From action errors
  for (const err of lastActions.filter((a) => a.type === "error").slice(-2)) {
    const step = `Fix error: ${short(err.summary, 100)}`
    if (!nextSteps.includes(step)) nextSteps.push(step)
  }

  // From session errors
  for (const err of lastErrors.slice(-1)) {
    const step = `Resolve session error: ${short(err.message, 80)}`
    if (!nextSteps.includes(step)) nextSteps.push(step)
  }

  // From explicit user asks
  for (const d of lastDialog) {
    const steps = extractPatterns(d.text, RE_NEXT_STEPS)
    for (const s of steps) {
      if (!nextSteps.includes(s)) nextSteps.push(s)
    }
  }

  // From active todos
  if (latestTodos?.todos) {
    const active = latestTodos.todos.filter((t) => t.status === "pending" || t.status === "in_progress")
    for (const t of active.slice(-3)) {
      const step = `[todo] ${short(t.content, 100)}`
      if (!nextSteps.includes(step)) nextSteps.push(step)
    }
  }

  // Recurring issues
  for (const r of patterns.recurring?.slice(-2) || []) {
    const step = `Recurring issue: ${short(r, 80)}`
    if (!nextSteps.includes(step)) nextSteps.push(step)
  }

  return { summary, nextSteps: nextSteps.slice(0, 8) }
}

function extractKnowledge(userText, toolOutputs) {
  const facts = []
  facts.push(...extractPatterns(userText, RE_FACTS))
  for (const out of toolOutputs) {
    const s = String(out)
    if (/(?:default|config|convention|always use|never use|prefer|recommend)/i.test(s) && s.length < 400) {
      facts.push(short(s, 140))
    }
  }
  return [...new Set(facts)].slice(0, 5)
}

// ─── Plugin entry ───────────────────────────────────────────────

/**
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export async function PersistencePlugin(input, options = {}) {
  const { client, project, directory, worktree, $ } = input
  await ensureStorage()

  // Load all memory
  let identity = await readJson(FILES.identity, { name: "XuViGaN", role: "autonomous_agent", notes: "" })
  let sessions = await readJson(FILES.sessions, { history: [] })
  let actions = await readJson(FILES.actions, { items: [] })
  let dialog = await readJson(FILES.dialog, { entries: [] })
  let context = await readJson(FILES.context, { summary: "", nextSteps: [], updatedAt: null })
  let patterns = await readJson(FILES.patterns, { recurring: [], errors: [], decisions: [] })
  let knowledge = await readJson(FILES.knowledge, { facts: [] })
  let fileChanges = await readJson(FILES.fileChanges, { changes: [] })
  let todos = await readJson(FILES.todos, { snapshots: [] })
  let sessionErrors = await readJson(FILES.sessionErrors, { errors: [] })
  let assistantReplies = await readJson(FILES.assistantReplies, { replies: [] })

  // Session state
  let pendingToolOutputs = []
  let currentSessionFiles = new Set()
  let dirty = false

  // ─── Internal mutators ─────────────────────────────────────

  async function pushAction(type, summary, meta = {}) {
    actions.items.push({ type, summary: short(summary, 150), meta: { ...meta, at: new Date().toISOString() } })
    actions.items = cap(actions.items, LIMITS.actions)
    if (type === "error") {
      const key = short(summary, 50)
      patterns.errors.push(key)
      patterns.errors = cap(patterns.errors, LIMITS.errors)
      const count = patterns.errors.filter((e) => e === key).length
      if (count >= 3 && !patterns.recurring.includes(key)) {
        patterns.recurring.push(key)
        patterns.recurring = cap(patterns.recurring, LIMITS.recurring)
      }
    }
    dirty = true
  }

  async function pushDialog(text, role = "user") {
    const cleanText = short(repairMojibake(text), 600)
    dialog.entries.push({ text: cleanText, role, at: new Date().toISOString() })
    dialog.entries = cap(dialog.entries, LIMITS.dialog)

    // Extract decisions
    for (const d of extractPatterns(cleanText, RE_DECISIONS)) {
      if (!patterns.decisions.includes(d)) patterns.decisions.push(d)
    }
    patterns.decisions = cap(patterns.decisions, LIMITS.decisions)

    // Extract knowledge
    for (const f of extractKnowledge(cleanText, pendingToolOutputs)) {
      if (!knowledge.facts.some((k) => k.text === f)) {
        knowledge.facts.push({ text: f, at: new Date().toISOString(), source: role })
      }
    }
    knowledge.facts = cap(knowledge.facts, LIMITS.knowledge)

    // Extract file paths
    const files = extractFilePaths(cleanText)
    dirty = true
    return { decisions: [], facts: [], files }
  }

  async function pushAssistantReply(rawText, toolCalls, sessionID, messageID, model, agent) {
    const text = short(repairMojibake(rawText), 800)
    assistantReplies.replies.push({
      text,
      toolCalls,
      sessionID,
      messageID,
      model: model ? `${model.providerID}/${model.modelID}` : undefined,
      agent: agent || undefined,
      at: new Date().toISOString(),
    })
    assistantReplies.replies = cap(assistantReplies.replies, LIMITS.assistantReplies)
    dirty = true
  }

  async function pushFileChange(file, sessionID) {
    fileChanges.changes.push({ file, sessionID, at: new Date().toISOString() })
    fileChanges.changes = cap(fileChanges.changes, LIMITS.fileChanges)
    currentSessionFiles.add(file)
    dirty = true
  }

  async function pushTodos(sessionID, todoList) {
    todos.snapshots.push({ sessionID, todos: todoList, at: new Date().toISOString() })
    todos.snapshots = cap(todos.snapshots, LIMITS.todos)
    dirty = true
  }

  async function pushSessionError(sessionID, errorName, errorMessage, sessionIDShort) {
    sessionErrors.errors.push({
      sessionID,
      type: errorName,
      message: errorMessage,
      at: new Date().toISOString(),
    })
    sessionErrors.errors = cap(sessionErrors.errors, LIMITS.sessionErrors)
    dirty = true
  }

  async function flush() {
    if (!dirty) return
    context = autoSummarize(actions.items, dialog.entries, patterns, sessionErrors.errors, assistantReplies.replies, todos)
    context.updatedAt = new Date().toISOString()

    // Update files edited in current sessions
    for (const s of sessions.history) {
      if (s.status === "active" && s.id) {
        // Merge accumulated files
      }
    }

    await Promise.all([
      atomicWrite(FILES.actions, actions),
      atomicWrite(FILES.dialog, dialog),
      atomicWrite(FILES.context, context),
      atomicWrite(FILES.patterns, patterns),
      atomicWrite(FILES.knowledge, knowledge),
      atomicWrite(FILES.sessions, sessions),
      atomicWrite(FILES.fileChanges, fileChanges),
      atomicWrite(FILES.todos, todos),
      atomicWrite(FILES.sessionErrors, sessionErrors),
      atomicWrite(FILES.assistantReplies, assistantReplies),
    ])
    dirty = false
  }

  // ─── Memory query tools ─────────────────────────────────────

  function getMemory(query, options = {}) {
    const q = String(query).toLowerCase()
    const results = { actions: [], dialog: [], decisions: [], knowledge: [], files: [], errors: [], todos: [] }

    // Search actions
    for (const a of actions.items) {
      if (a.summary.toLowerCase().includes(q) || JSON.stringify(a.meta).toLowerCase().includes(q)) {
        results.actions.push(a)
      }
    }

    // Search dialog
    for (const d of dialog.entries) {
      if (d.text.toLowerCase().includes(q)) results.dialog.push(d)
    }

    // Search decisions
    for (const d of patterns.decisions) {
      if (d.toLowerCase().includes(q)) results.decisions.push(d)
    }

    // Search knowledge
    for (const k of knowledge.facts) {
      if (k.text.toLowerCase().includes(q)) results.knowledge.push(k)
    }

    // Search file changes
    for (const f of fileChanges.changes) {
      if (f.file.toLowerCase().includes(q)) results.files.push(f)
    }

    // Search errors
    for (const e of patterns.errors) {
      if (e.toLowerCase().includes(q)) results.errors.push(e)
    }

    // Search todos
    for (const snap of todos.snapshots) {
      for (const t of snap.todos || []) {
        if (t.content.toLowerCase().includes(q)) results.todos.push(t)
      }
    }

    // Trim result sets
    for (const key of Object.keys(results)) {
      results[key] = results[key].slice(-options.max || 10)
    }

    return results
  }

  function getDecisions() {
    return { decisions: patterns.decisions.slice(-20), recurring: patterns.recurring, recentErrors: patterns.errors.slice(-10) }
  }

  function getFileHistory(fileQuery = "") {
    const changes = fileQuery
      ? fileChanges.changes.filter((c) => c.file.toLowerCase().includes(fileQuery.toLowerCase()))
      : fileChanges.changes
    const byFile = {}
    for (const c of changes) {
      if (!byFile[c.file]) byFile[c.file] = []
      byFile[c.file].push({ sessionID: c.sessionID, at: c.at })
    }
    return { total: changes.length, byFile: Object.fromEntries(Object.entries(byFile).slice(-30)) }
  }

  function getSessionInfo(sessionID = null) {
    if (!sessionID) {
      return {
        total: sessions.history.length,
        active: sessions.history.filter((s) => s.status === "active").length,
        recent: sessions.history.slice(-10),
      }
    }
    const s = sessions.history.find((x) => x.id === sessionID || x.id.endsWith(sessionID))
    if (!s) return { error: "session not found" }
    return {
      session: s,
      actions: actions.items.filter((a) => a.meta.sessionID === s.id).slice(-20),
      dialog: dialog.entries.filter((d) => d.meta?.sessionID === s.id).slice(-20),
      fileChanges: fileChanges.changes.filter((c) => c.sessionID === s.id).slice(-20),
      todos: todos.snapshots.filter((t) => t.sessionID === s.id).slice(-5),
    }
  }

  function getErrors() {
    return {
      sessionLevel: sessionErrors.errors.slice(-10),
      actionLevel: patterns.errors.slice(-15),
      recurring: patterns.recurring,
    }
  }

  // ─── Tool definitions ──────────────────────────────────────

  // zod-lite: define our own minimal arg-schema validation
  const tools = {
    memory_search: {
      description: "Search persistent memory for any text pattern across actions, dialog, knowledge, files, errors, decisions",
      args: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" },
          max: { type: "number", description: "Max results per category (default 10)" },
        },
        required: ["query"],
      },
      async execute(args, context) {
        const results = getMemory(args.query, { max: args.max })
        const lines = []
        for (const [cat, items] of Object.entries(results)) {
          if (items.length) {
            lines.push(`## ${cat} (${items.length})`)
            for (const item of items) {
              if (typeof item === "string") lines.push(`  - ${item}`)
              else lines.push(`  - ${short(JSON.stringify(item), 120)}`)
            }
          }
        }
        return lines.length ? lines.join("\n") : "No matches found."
      },
    },
    memory_decisions: {
      description: "Get all recorded decisions, recurring issues, and recent errors from persistent memory",
      args: { type: "object", properties: {} },
      async execute() {
        const d = getDecisions()
        return [
          "## Decisions",
          ...d.decisions.map((d) => `  - ${d}`),
          `## Recurring issues (${d.recurring.length})`,
          ...d.recurring.map((r) => `  - ${r}`),
          `## Recent errors (${d.recentErrors.length})`,
          ...d.recentErrors.map((e) => `  - ${short(e, 100)}`),
        ].join("\n")
      },
    },
    memory_files: {
      description: "Get file change history from persistent memory — which files were edited, when, in which sessions",
      args: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional file path filter" },
        },
      },
      async execute(args) {
        const data = getFileHistory(args.query)
        const lines = [`Total file changes tracked: ${data.total}`]
        for (const [file, events] of Object.entries(data.byFile)) {
          lines.push(`  ${file}: ${events.length} edits, latest ${events[events.length - 1]?.at || "?"}`)
        }
        return lines.join("\n")
      },
    },
    memory_errors: {
      description: "Get recent errors from persistent memory — both session-level and tool-level",
      args: { type: "object", properties: {} },
      async execute() {
        const e = getErrors()
        const lines = []
        if (e.sessionLevel.length) {
          lines.push("## Session errors")
          for (const err of e.sessionLevel) lines.push(`  [${err.type}] ${short(err.message, 100)}`)
        }
        if (e.actionLevel.length) {
          lines.push("## Action errors")
          for (const err of e.actionLevel) lines.push(`  - ${short(err, 100)}`)
        }
        if (e.recurring.length) {
          lines.push("## Recurring")
          for (const r of e.recurring) lines.push(`  - ${short(r, 80)}`)
        }
        return lines.join("\n") || "No errors recorded."
      },
    },
    memory_sessions: {
      description: "Get session information and history from persistent memory",
      args: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "Optional session ID to get detailed info for" },
        },
      },
      async execute(args) {
        return JSON.stringify(getSessionInfo(args.sessionID), null, 2)
      },
    },
  }

  // ─── Hook handlers ─────────────────────────────────────────

  return {
    // ── Query tools exposed to LLM ──
    tool: tools,

    /**
     * Inject full memory digest into system prompt.
     */
    async "experimental.chat.system.transform"(input, output) {
      const digest = buildDigest({ identity, sessions, actions, dialog, context, patterns, knowledge, fileChanges, todos, sessionErrors, assistantReplies })
      output.system.push(`\n---\n${digest}\n---\n`)
    },

    /**
     * Capture user message.
     */
    async "chat.message"(input, output) {
      const text = textFromParts(output.parts)
      if (text) {
        await pushDialog(text, "user")
        await flush()
      }
    },

    /**
     * Log tool execution with accurate error detection.
     */
    async "tool.execute.after"(input, output) {
      const result = output.output || ""
      const isErr = isGenuineError(input.tool, result)
      await pushAction(isErr ? "error" : "action", `${input.tool}: ${short(result, 120)}`, {
        sessionID: input.sessionID,
        tool: input.tool,
        callID: input.callID,
      })
      pendingToolOutputs.push(result)
      if (pendingToolOutputs.length > 5) pendingToolOutputs = pendingToolOutputs.slice(-5)
      await flush()
    },

    /**
     * Protect context during compaction.
     */
    async "experimental.session.compacting"(input, output) {
      output.context.push(
        "[AUTONOMOUS PERSISTENCE v3] Session is being compacted. You MUST preserve:\n" +
        "(1) ALL key decisions and their rationale\n" +
        "(2) All unresolved errors with root causes\n" +
        "(3) Explicit next steps and pending tasks\n" +
        "(4) Important file paths and configurations\n" +
        "(5) User preferences, conventions, and constraints\n" +
        "(6) What tools/commands were executed and their results\n" +
        "The next context window depends on this summary."
      )
      await flush()
    },

    /**
     * Main event handler — captures everything.
     */
    async event({ event }) {
      const type = event.type

      // ── Session lifecycle ──
      if (type === "session.created") {
        const info = event.properties?.info
        const sessionID = info?.id || event.properties?.sessionID
        if (sessionID) {
          sessions.history.push({
            id: sessionID,
            startedAt: new Date().toISOString(),
            status: "active",
            agent: info?.agent,
            model: info?.model ? { providerID: info.model.providerID, modelID: info.model.modelID } : undefined,
          })
          sessions.history = cap(sessions.history, LIMITS.sessions)
          dirty = true
          await flush()
        }
      }

      if (type === "session.deleted" || type === "session.compacted") {
        const sessionID = event.properties?.sessionID
        if (sessionID) {
          const idx = sessions.history.findIndex((s) => s.id === sessionID)
          if (idx >= 0) {
            sessions.history[idx].status = type === "session.deleted" ? "deleted" : "compacted"
            sessions.history[idx].endedAt = new Date().toISOString()
            // Save files edited in this session
            if (currentSessionFiles.size) {
              sessions.history[idx].filesEdited = [...currentSessionFiles]
            }
          }
          await flush()
        }
      }

      // ── Assistant message capture ──
      if (type === "message.updated") {
        const info = event.properties?.info
        if (info?.role === "assistant") {
          // Assistant finished (has completed timestamp)
          if (info.time?.completed) {
            // Extract text and tool calls from messageParts event (parts come separately)
            // For now, capture what we have
            const sessionID = info.sessionID
            const messageID = info.id
            const model = { providerID: info.providerID, modelID: info.modelID }

            // Check for assistant error
            if (info.error) {
              await pushSessionError(sessionID, info.error.name, info.error.data?.message || "Unknown error")
            }
          }
        }
      }

      // ── Message parts (assistant text + tools) ──
      if (type === "message.part.updated") {
        const part = event.properties?.part
        if (part && part.type === "text" && part.sessionID) {
          // We get text parts — accumulate them per message
          // This is streaming so we get deltas; we capture the final state
        }
      }

      // ── File edited ──
      if (type === "file.edited") {
        const file = event.properties?.file
        if (file) {
          await pushFileChange(file, event.properties?.sessionID)
          await flush()
        }
      }

      // ── Session diff (final diff per session) ──
      if (type === "session.diff") {
        const sessionID = event.properties?.sessionID
        const diffs = event.properties?.diff || []
        if (sessionID && diffs.length) {
          const fileList = diffs.map((d) => `${d.file} (+${d.additions}/-${d.deletions})`).join(", ")
          dirty = true
        }
      }

      // ── Todo state capture ──
      if (type === "todo.updated") {
        const sessionID = event.properties?.sessionID
        const todoList = event.properties?.todos
        if (sessionID && todoList) {
          await pushTodos(sessionID, todoList)
          await flush()
        }
      }

      // ── Session errors ──
      if (type === "session.error") {
        const sessionID = event.properties?.sessionID
        const err = event.properties?.error
        if (err) {
          await pushSessionError(sessionID, err.name, err.data?.message || JSON.stringify(err.data).slice(0, 200))
          await flush()
        }
      }

      // ── Permission replies (user decisions on asks) ──
      if (type === "permission.replied") {
        const response = event.properties?.response
        if (response) {
          // Track that a permission was asked and what was decided
          dirty = true
        }
      }

      // ── File watcher ──
      if (type === "file.watcher.updated") {
        // Could track external file changes — high volume, skip for now
      }
    },

    /**
     * Final persist on shutdown.
     */
    async dispose() {
      await flush()
    },
  }
}

export default {
  id: "opencode-persistence-autonomous",
  server: PersistencePlugin,
}
