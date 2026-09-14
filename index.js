/**
 * opencode-persistence v2.0 — Autonomous Memory System
 *
 * Self-reinforcing persistent memory for opencode agent.
 * Every session starts with full context of what was done, decided,
 * broken, and planned. Zero interaction required.
 *
 * Architecture:
 *   - JSON-file store in %APPDATA%/opencode/memory
 *   - 7 memory files: identity, sessions, actions, dialog, context, patterns, knowledge
 *   - Smart extraction: decisions, errors, next-steps, file-touch tracking
 *   - Atomic writes with corruption recovery
 *   - UTF-8 safe, encoding-aware
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
  context: path.join(MEMORY_DIR, "current_context.json"),
  patterns: path.join(MEMORY_DIR, "patterns.json"),
  knowledge: path.join(MEMORY_DIR, "knowledge.json"),
}

// ─── Limits & config ────────────────────────────────────────────
const LIMITS = {
  actions: 150,
  sessions: 30,
  dialog: 50,
  errors: 15,
  recurring: 10,
  decisions: 15,
  knowledge: 100,
  recentActionsDigest: 7,
  recentDialogDigest: 5,
  recentSessionsDigest: 5,
}

// ─── I/O helpers ────────────────────────────────────────────────

async function ensureStorage() {
  await mkdir(MEMORY_DIR, { recursive: true })
  const defaults = {
    [FILES.identity]: {
      name: "XuViGaN",
      role: "autonomous_agent",
      notes: "Autonomous persistence v2.0. Full memory loop: capture → distill → inject → learn.",
    },
    [FILES.sessions]: { history: [] },
    [FILES.actions]: { items: [] },
    [FILES.dialog]: { entries: [] },
    [FILES.context]: { summary: "", nextSteps: [], updatedAt: null },
    [FILES.patterns]: { recurring: [], errors: [], decisions: [] },
    [FILES.knowledge]: { facts: [] },
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
 * Deep sanitize: remove control chars, collapse whitespace, strip outer quotes.
 * Preserves UTF-8 (Cyrillic, CJK, emoji safe).
 */
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

const RE_FILE_PATH = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[\w\-\\/\.]+\.\w{1,10}/g
const RE_ERROR_INDICATORS = /\b(error|failed|failure|exception|crash|panic|fatal|errno|exit\s*code\s*[1-9]|traceback|stack\s*trace|cannot|unable to|denied|timeout|timed?\s*out|broken|corrupt|refused|not found|404|500|502|503)\b/i

/**
 * Check if a tool result actually represents an error.
 * Looks at the output content, not just keyword presence.
 * Avoids false positives from content that mentions errors in data.
 */
function isGenuineError(toolName, output) {
  if (!output) return false
  const s = String(output)
  // Structural indicators: exit codes, stack traces, explicit failures
  if (/exit code [1-9]|Traceback \(most recent|SyntaxError|TypeError|ReferenceError|ENOENT|EACCES|EPERM/.test(s)) return true
  // PowerShell/Node error objects
  if (/^\s*(Error|Exception|Failed|FAIL)\s*[:!]/m.test(s)) return true
  // Tool-specific: bash output starting with error indicator
  if (toolName === "bash" && /^\s*(error|fatal|failed|command not found|is not recognized)/mi.test(s)) return true
  // Generic fallback — but require the output to be SHORT (real errors are usually concise)
  if (RE_ERROR_INDICATORS.test(s) && s.length < 500) return true
  return false
}

function extractPatterns(text, patterns) {
  const results = []
  for (const re of patterns) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const extracted = short(m[1], 140)
      if (extracted && !results.includes(extracted)) results.push(extracted)
    }
  }
  return results.slice(0, 5)
}

function extractFilePaths(text) {
  const matches = String(text).match(RE_FILE_PATH)
  if (!matches) return []
  return [...new Set(matches)].slice(0, 10)
}

// ─── Memory digest builder ──────────────────────────────────────

function buildDigest(data) {
  const { identity, sessions, actions, dialog, context, patterns, knowledge } = data
  const lines = []

  lines.push("[AUTONOMOUS PERSISTENCE v2] Active. All context below is auto-generated.")

  // Identity
  lines.push(`Identity: ${identity.name} (${identity.role})`)
  if (identity.notes) lines.push(`Identity notes: ${identity.notes}`)

  // Handoff from previous session
  if (context.summary) {
    lines.push(`Previous session handoff: ${context.summary}`)
  }
  if (context.nextSteps?.length) {
    lines.push("Pending next steps:")
    for (const s of context.nextSteps) lines.push(`  - ${s}`)
  }

  // Active sessions overview
  if (sessions.history?.length) {
    const recent = sessions.history.slice(-LIMITS.recentSessionsDigest)
    lines.push(`Recent sessions: ${recent.map((s) => `${s.id.slice(-8)}(${s.status})`).join(", ")}`)
  }

  // What was actually done
  if (actions.items?.length) {
    const recent = actions.items.slice(-LIMITS.recentActionsDigest)
    lines.push("Latest actions:")
    for (const a of recent) {
      lines.push(`  - [${a.type}] ${short(a.summary, 100)}`)
    }
  }

  // What user actually said
  if (dialog.entries?.length) {
    const recent = dialog.entries.slice(-LIMITS.recentDialogDigest)
    lines.push("Recent user requests:")
    for (const d of recent) {
      lines.push(`  - ${short(d.text, 120)}`)
    }
  }

  // Learned patterns
  if (patterns.recurring?.length) {
    lines.push(`Recurring issues: ${patterns.recurring.slice(-3).join("; ")}`)
  }
  if (patterns.decisions?.length) {
    lines.push(`Key decisions: ${patterns.decisions.slice(-5).join("; ")}`)
  }

  // Knowledge base
  if (knowledge.facts?.length) {
    lines.push("Accumulated knowledge:")
    for (const f of knowledge.facts.slice(-10)) {
      lines.push(`  - ${short(f.text, 140)}`)
    }
  }

  return lines.join("\n")
}

// ─── Auto-summarizer ────────────────────────────────────────────

function autoSummarize(actions, dialog, patterns) {
  const lastActions = actions.slice(-7)
  const lastDialog = dialog.slice(-5)

  // Build summary parts
  const parts = []
  if (lastDialog.length) {
    const asked = lastDialog.map((d) => short(d.text, 80)).join(" | ")
    parts.push(`Last asked: ${asked}`)
  }
  if (lastActions.length) {
    const done = lastActions.map((a) => short(a.summary, 80)).join(" | ")
    parts.push(`Last done: ${done}`)
  }
  const summary = parts.join("; ") || "No significant activity."

  // Derive next steps
  const nextSteps = []

  // 1. Real errors from latest actions
  const lastErrors = lastActions.filter((a) => a.type === "error")
  for (const err of lastErrors.slice(-2)) {
    const step = `Fix error: ${short(err.summary, 100)}`
    if (!nextSteps.includes(step)) nextSteps.push(step)
  }

  // 2. Explicit next steps from user messages
  for (const d of lastDialog) {
    const steps = extractPatterns(d.text, RE_NEXT_STEPS)
    for (const s of steps) {
      if (!nextSteps.includes(s)) nextSteps.push(s)
    }
  }

  // 3. Recurring errors that demand attention
  if (patterns.recurring?.length) {
    for (const r of patterns.recurring.slice(-2)) {
      const step = `Recurring issue needs attention: ${short(r, 80)}`
      if (!nextSteps.includes(step)) nextSteps.push(step)
    }
  }

  return { summary, nextSteps: nextSteps.slice(0, 7) }
}

/**
 * Extract knowledge-worthy facts from user text and tool outputs.
 */
function extractKnowledge(userText, toolOutputs) {
  const facts = []
  // From user messages
  facts.push(...extractPatterns(userText, RE_FACTS))
  // From tool outputs: only if they look like config/convention statements
  for (const out of toolOutputs) {
    const s = String(out)
    if (/(?:default|config|convention|always use|never use|prefer)/i.test(s) && s.length < 400) {
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
  const { client, project, directory, serverUrl } = input
  await ensureStorage()

  // Load all memory into working state
  let identity = await readJson(FILES.identity, { name: "XuViGaN", role: "autonomous_agent", notes: "" })
  let sessions = await readJson(FILES.sessions, { history: [] })
  let actions = await readJson(FILES.actions, { items: [] })
  let dialog = await readJson(FILES.dialog, { entries: [] })
  let context = await readJson(FILES.context, { summary: "", nextSteps: [], updatedAt: null })
  let patterns = await readJson(FILES.patterns, { recurring: [], errors: [], decisions: [] })
  let knowledge = await readJson(FILES.knowledge, { facts: [] })

  // Session-scoped accumulators (reduce disk I/O)
  let pendingToolOutputs = []
  let dirty = false

  // ─── Internal mutators ─────────────────────────────────────

  async function pushAction(type, summary, meta = {}) {
    const cleanSummary = short(summary, 150)
    actions.items.push({
      type,
      summary: cleanSummary,
      meta: { ...meta, at: new Date().toISOString() },
    })
    actions.items = cap(actions.items, LIMITS.actions)

    // Learn from real errors only
    if (type === "error") {
      const errKey = cleanSummary.slice(0, 50)
      patterns.errors.push(errKey)
      patterns.errors = cap(patterns.errors, LIMITS.errors)
      // Escalate to recurring if seen 3+ times
      const count = patterns.errors.filter((e) => e === errKey).length
      if (count >= 3 && !patterns.recurring.includes(errKey)) {
        patterns.recurring.push(errKey)
        patterns.recurring = cap(patterns.recurring, LIMITS.recurring)
      }
    }
    dirty = true
  }

  async function pushDialog(text, role = "user") {
    const cleanText = short(text, 600)
    dialog.entries.push({ text: cleanText, role, at: new Date().toISOString() })
    dialog.entries = cap(dialog.entries, LIMITS.dialog)

    // Extract decisions
    const decisions = extractPatterns(cleanText, RE_DECISIONS)
    for (const d of decisions) {
      if (!patterns.decisions.includes(d)) {
        patterns.decisions.push(d)
      }
    }
    patterns.decisions = cap(patterns.decisions, LIMITS.decisions)

    // Extract knowledge
    const facts = extractKnowledge(cleanText, pendingToolOutputs)
    for (const f of facts) {
      const entry = { text: f, at: new Date().toISOString(), source: role }
      // Dedup: skip if very similar fact exists
      if (!knowledge.facts.some((k) => k.text === f)) {
        knowledge.facts.push(entry)
      }
    }
    knowledge.facts = cap(knowledge.facts, LIMITS.knowledge)

    // Extract file paths mentioned
    const files = extractFilePaths(cleanText)

    dirty = true
    return { decisions, facts, files }
  }

  async function flush() {
    if (!dirty) return
    context = autoSummarize(actions.items, dialog.entries, patterns)
    context.updatedAt = new Date().toISOString()

    await Promise.all([
      atomicWrite(FILES.actions, actions),
      atomicWrite(FILES.dialog, dialog),
      atomicWrite(FILES.context, context),
      atomicWrite(FILES.patterns, patterns),
      atomicWrite(FILES.knowledge, knowledge),
      atomicWrite(FILES.sessions, sessions),
    ])
    dirty = false
  }

  // ─── Hook handlers ─────────────────────────────────────────

  return {
    /**
     * Inject full memory digest into every system prompt.
     */
    async "experimental.chat.system.transform"(input, output) {
      const digest = buildDigest({ identity, sessions, actions, dialog, context, patterns, knowledge })
      output.system.push(`\n---\n${digest}\n---\n`)
    },

    /**
     * Capture every user message.
     */
    async "chat.message"(input, output) {
      const text = output.parts
        ?.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
      if (text?.trim()) {
        await pushDialog(text.trim(), "user")
        // Flush after user message (highest-value capture point)
        await flush()
      }
    },

    /**
     * Log every tool execution with accurate error classification.
     */
    async "tool.execute.after"(input, output) {
      const tool = input.tool
      const result = output.output || ""
      const isErr = isGenuineError(tool, result)
      const type = isErr ? "error" : "action"
      const summary = `${tool}: ${short(result, 120)}`
      await pushAction(type, summary, {
        sessionID: input.sessionID,
        tool,
        callID: input.callID,
      })
      // Stash output for knowledge extraction on next user message
      pendingToolOutputs.push(result)
      if (pendingToolOutputs.length > 5) pendingToolOutputs = pendingToolOutputs.slice(-5)
      await flush()
    },

    /**
     * Protect context during compaction — inject preservation instructions.
     */
    async "experimental.session.compacting"(input, output) {
      output.context.push(
        "[AUTONOMOUS PERSISTENCE v2] Session is being compacted. " +
        "You MUST preserve in the compaction summary: " +
        "(1) all key decisions and their rationale, " +
        "(2) unresolved errors and their root causes, " +
        "(3) explicit next steps and pending tasks, " +
        "(4) important file paths and configurations discovered, " +
        "(5) user preferences and conventions stated. " +
        "The next context window depends on this summary."
      )
      await flush()
    },

    /**
     * Track session lifecycle.
     */
    async event({ event }) {
      const sessionID = event.properties?.sessionID
      if (!sessionID) return

      if (event.type === "session.created") {
        sessions.history.push({
          id: sessionID,
          startedAt: new Date().toISOString(),
          status: "active",
        })
        sessions.history = cap(sessions.history, LIMITS.sessions)
        dirty = true
        await flush()
      }

      if (event.type === "session.deleted" || event.type === "session.compacted") {
        const idx = sessions.history.findIndex((s) => s.id === sessionID)
        if (idx >= 0) {
          sessions.history[idx].status = event.type === "session.deleted" ? "deleted" : "compacted"
          sessions.history[idx].endedAt = new Date().toISOString()
        }
        await flush()
      }
    },

    /**
     * Final state persist on shutdown.
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
