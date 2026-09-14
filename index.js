/**
 * opencode-persistence (Autonomous Mode)
 * Fully autonomous persistent memory & handoff plugin for opencode.
 *
 * No user interaction required. Automatically logs actions, extracts context,
 * and injects memory into every new session.
 */

import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import os from "os"

// Memory directory: %APPDATA%/opencode/memory (Windows) or ~/.config/opencode/memory
const MEMORY_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), ".config"),
  "opencode",
  "memory",
)

const FILE_IDENTITY = path.join(MEMORY_DIR, "identity.json")
const FILE_SESSIONS = path.join(MEMORY_DIR, "sessions.json")
const FILE_ACTIONS = path.join(MEMORY_DIR, "actions.json")
const FILE_DIALOG = path.join(MEMORY_DIR, "dialog.json")
const FILE_CURRENT = path.join(MEMORY_DIR, "current_context.json")
const FILE_PATTERNS = path.join(MEMORY_DIR, "patterns.json")

// Limits to prevent unbounded growth
const MAX_ACTIONS = 100
const MAX_SESSIONS = 20
const MAX_DIALOG_ENTRIES = 30

async function ensureStorage() {
  await mkdir(MEMORY_DIR, { recursive: true })
  const defaults = {
    [FILE_IDENTITY]: {
      name: "XuViGaN",
      role: "autonomous_agent",
      notes: "Fully autonomous persistence mode enabled. No manual memory tools exposed.",
    },
    [FILE_SESSIONS]: { history: [] },
    [FILE_ACTIONS]: { items: [] },
    [FILE_DIALOG]: { entries: [] },
    [FILE_CURRENT]: { summary: "", nextSteps: [] },
    [FILE_PATTERNS]: { recurring: [], errors: [], decisions: [] },
  }
  for (const file of Object.keys(defaults)) {
    try {
      await readFile(file, "utf-8")
    } catch {
      await writeFile(file, JSON.stringify(defaults[file], null, 2), "utf-8")
    }
  }
}

async function readJson(file, fallback) {
  try {
    const text = await readFile(file, "utf-8")
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

async function writeJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2), "utf-8")
}

/**
 * Truncate array to max length, keeping the most recent items.
 */
function cap(arr, max) {
  if (!Array.isArray(arr)) return []
  return arr.length > max ? arr.slice(-max) : arr
}

/**
 * Sanitize text: strip control chars, normalize whitespace, keep UTF-8 safe.
 */
function sanitize(text) {
  if (!text) return ""
  let s = String(text)
  // Strip surrounding quotes if present (artifacts of JSON stringify)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Extract a short summary from text (first 120 chars).
 */
function short(text, len = 120) {
  if (!text) return ""
  const s = sanitize(text)
  return s.length > len ? s.slice(0, len) + "…" : s
}

/**
 * Extract next steps from user text using Russian/English heuristics.
 */
function extractNextSteps(text) {
  const steps = []
  const patterns = [
    /(?:todo|next|later|remember|don't forget|сделать|нужно|надо|дальше|затем|потом|не забудь|запомни)[:\s]+([^\n\.]{3,120})/gi,
    /(?:потом|затем|дальше)\s+([^\n\.]{3,120})/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) {
      const step = short(m[1], 100)
      if (step && !steps.includes(step)) steps.push(step)
    }
  }
  return steps.slice(0, 3)
}

/**
 * Extract decisions from user text.
 */
function extractDecisions(text) {
  const decisions = []
  const patterns = [
    /(?:решили|выбрали|будем использовать|отказались|остановились на|decided|chose|using|going with|will use|stick with|определились с)[:\s]+([^\n\.]{3,120})/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) {
      const d = short(m[1], 100)
      if (d && !decisions.includes(d)) decisions.push(d)
    }
  }
  return decisions.slice(0, 3)
}

/**
 * Build memory digest for system prompt injection.
 */
function buildMemoryDigest(data) {
  const lines = []
  lines.push(`[AUTONOMOUS PERSISTENCE] Active. All context below is auto-generated.`)

  const { identity, sessions, actions, dialog, current, patterns } = data

  // Identity
  lines.push(`Identity: ${identity.name} (${identity.role})`)
  if (identity.notes) lines.push(`Identity notes: ${identity.notes}`)

  // Current context (handoff from previous session)
  if (current.summary) {
    lines.push(`Previous session handoff: ${current.summary}`)
  }
  if (current.nextSteps?.length) {
    lines.push(`Pending next steps:`)
    for (const step of current.nextSteps) lines.push(`  - ${step}`)
  }

  // Recent sessions
  if (sessions.history?.length) {
    const recent = sessions.history.slice(-3)
    lines.push(`Recent sessions: ${recent.map((s) => `${s.id.slice(-8)}(${s.status})`).join(", ")}`)
  }

  // Latest actions (what was actually done)
  if (actions.items?.length) {
    const recent = actions.items.slice(-5)
    lines.push(`Latest actions:`)
    for (const a of recent) {
      lines.push(`  - [${a.type}] ${short(a.summary, 100)}`)
    }
  }

  // Latest user messages (what was asked)
  if (dialog.entries?.length) {
    const recent = dialog.entries.slice(-3)
    lines.push(`Recent user requests:`)
    for (const d of recent) {
      lines.push(`  - ${short(d.text, 100)}`)
    }
  }

  // Recurring patterns & errors
  if (patterns.recurring?.length) {
    lines.push(`Recurring errors: ${patterns.recurring.slice(-3).join("; ")}`)
  }
  if (patterns.errors?.length) {
    lines.push(`Recent errors seen: ${patterns.errors.slice(-3).join("; ")}`)
  }
  if (patterns.decisions?.length) {
    lines.push(`Key decisions: ${patterns.decisions.slice(-3).join("; ")}`)
  }

  return lines.join("\n")
}

/**
 * Extract heuristics from dialog/actions to auto-generate summary and next steps.
 */
function autoSummarize(actions, dialog) {
  const lastActions = actions.slice(-5)
  const lastDialog = dialog.slice(-3)

  const summaryParts = []
  if (lastDialog.length) {
    summaryParts.push(`Last asked: ${lastDialog.map((d) => short(d.text, 60)).join(" | ")}`)
  }
  if (lastActions.length) {
    summaryParts.push(`Last done: ${lastActions.map((a) => short(a.summary, 60)).join(" | ")}`)
  }
  const summary = summaryParts.join("; ") || "No significant activity."

  const nextSteps = []
  // Heuristic: if last action was an error, next step is to fix it
  const lastErr = lastActions.filter((a) => a.type === "error").pop()
  if (lastErr) nextSteps.push(`Investigate error: ${short(lastErr.summary, 80)}`)
  // Extract explicit next steps from last user messages
  for (const d of lastDialog) {
    const steps = extractNextSteps(d.text)
    nextSteps.push(...steps.filter((s) => !nextSteps.includes(s)))
  }

  return { summary, nextSteps }
}

/**
 * The autonomous plugin entry point.
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export async function PersistencePlugin(input, options = {}) {
  const { client, project, directory, serverUrl } = input
  await ensureStorage()

  // Load all memory
  const identity = await readJson(FILE_IDENTITY, {})
  const sessions = await readJson(FILE_SESSIONS, { history: [] })
  const actions = await readJson(FILE_ACTIONS, { items: [] })
  const dialog = await readJson(FILE_DIALOG, { entries: [] })
  const current = await readJson(FILE_CURRENT, { summary: "", nextSteps: [] })
  const patterns = await readJson(FILE_PATTERNS, { recurring: [], errors: [], decisions: [] })

  // Internal helper to append and persist
  async function pushAction(type, summary, meta = {}) {
    const cleanSummary = short(summary, 120)
    const a = await readJson(FILE_ACTIONS, { items: [] })
    a.items.push({ type, summary: cleanSummary, meta, at: new Date().toISOString() })
    a.items = cap(a.items, MAX_ACTIONS)
    await writeJson(FILE_ACTIONS, a)

    // Auto-learn patterns
    if (type === "error") {
      const p = await readJson(FILE_PATTERNS, { recurring: [], errors: [], decisions: [] })
      const errKey = cleanSummary.slice(0, 40)
      p.errors.push(errKey)
      p.errors = cap(p.errors, 10)
      // Detect recurring errors
      const count = p.errors.filter((e) => e === errKey).length
      if (count >= 3 && !p.recurring.includes(errKey)) {
        p.recurring.push(errKey)
        p.recurring = cap(p.recurring, 10)
      }
      await writeJson(FILE_PATTERNS, p)
    }
  }

  async function pushDialog(text, role = "user") {
    const cleanText = short(text, 500)
    const d = await readJson(FILE_DIALOG, { entries: [] })
    d.entries.push({ text: cleanText, role, at: new Date().toISOString() })
    d.entries = cap(d.entries, MAX_DIALOG_ENTRIES)
    await writeJson(FILE_DIALOG, d)

    // Auto-detect decisions
    const decisions = extractDecisions(cleanText)
    if (decisions.length) {
      const p = await readJson(FILE_PATTERNS, { recurring: [], errors: [], decisions: [] })
      for (const dec of decisions) {
        if (!p.decisions.includes(dec)) {
          p.decisions.push(dec)
        }
      }
      p.decisions = cap(p.decisions, 10)
      await writeJson(FILE_PATTERNS, p)
    }
  }

  async function updateCurrentContext() {
    const a = await readJson(FILE_ACTIONS, { items: [] })
    const d = await readJson(FILE_DIALOG, { entries: [] })
    const { summary, nextSteps } = autoSummarize(a.items, d.entries)
    const c = await readJson(FILE_CURRENT, { summary: "", nextSteps: [] })
    c.summary = summary
    c.nextSteps = nextSteps
    c.updatedAt = new Date().toISOString()
    await writeJson(FILE_CURRENT, c)
  }

  return {
    /**
     * AUTONOMOUS: Inject memory digest into every system prompt.
     */
    async "experimental.chat.system.transform"(input, output) {
      const sessionID = input.sessionID || "unknown"
      const digest = buildMemoryDigest({ identity, sessions, actions, dialog, current, patterns })
      output.system.push(`\n---\n${digest}\n---\n`)
    },

    /**
     * AUTONOMOUS: On every user message, log it and update context.
     */
    async "chat.message"(input, output) {
      const sessionID = input.sessionID
      const text = output.parts
        ?.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
      if (text?.trim()) {
        await pushDialog(text.trim(), "user")
        await updateCurrentContext()
      }
    },

    /**
     * AUTONOMOUS: After every tool execution, log the action.
     */
    async "tool.execute.after"(input, output) {
      const sessionID = input.sessionID
      const tool = input.tool
      const callID = input.callID
      const result = output.output || ""
      const isError = /error|failed|exception/i.test(String(result))
      const type = isError ? "error" : "action"
      const summary = `${tool}: ${short(result, 100)}`
      await pushAction(type, summary, { sessionID, tool, callID })
      await updateCurrentContext()
    },

    /**
     * AUTONOMOUS: On session compaction, force a handoff summary.
     */
    async "experimental.session.compacting"(input, output) {
      const sessionID = input.sessionID
      output.context.push(
        `[AUTONOMOUS PERSISTENCE] Session ${sessionID} is being compacted. ` +
        `Preserve key decisions, open questions, errors encountered, and explicit next steps ` +
        `in the compaction summary so the next context window can continue seamlessly.`,
      )
      await updateCurrentContext()
    },

    /**
     * AUTONOMOUS: Track session lifecycle.
     */
    async event({ event }) {
      if (event.type === "session.created") {
        const sessionID = event.properties?.sessionID
        if (sessionID) {
          const s = await readJson(FILE_SESSIONS, { history: [] })
          s.history.push({ id: sessionID, startedAt: new Date().toISOString(), status: "active" })
          s.history = cap(s.history, MAX_SESSIONS)
          await writeJson(FILE_SESSIONS, s)
        }
      }

      if (event.type === "session.deleted" || event.type === "session.compacted") {
        const sessionID = event.properties?.sessionID
        if (sessionID) {
          const s = await readJson(FILE_SESSIONS, { history: [] })
          const idx = s.history.findIndex((x) => x.id === sessionID)
          if (idx >= 0) {
            s.history[idx].status = event.type === "session.deleted" ? "deleted" : "compacted"
            s.history[idx].endedAt = new Date().toISOString()
            await writeJson(FILE_SESSIONS, s)
          }
          // Final context update before potential loss
          await updateCurrentContext()
        }
      }
    },

    /**
     * AUTONOMOUS: On dispose, ensure final state is saved.
     */
    async dispose() {
      await updateCurrentContext()
    },
  }
}

export default {
  id: "opencode-persistence-autonomous",
  server: PersistencePlugin,
}
