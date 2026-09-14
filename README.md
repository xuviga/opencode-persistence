# opencode-persistence

Autonomous, self-aware memory for [opencode](https://opencode.ai). Captures every session, decision, error, file change, and conversation — persists across restarts. Zero configuration. Zero dependencies. Queryable via built-in tools.

```
opencode session 1          opencode session 2          opencode session N
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  "Fix the auth" │────────>│  "Where were    │────────>│  "What decisions │
│  bug in login"  │ memory  │   we?"          │  memory │   did we make?" │
│                 │         │                 │         │                 │
│  ✎auth.js +45   │  ████   │  ▸ 5 actions    │  ████   │  ▸ 3 decisions  │
│  ✎config.go +12 │  ████   │  ▸ 2 errors     │  ████   │  ▸ 12 files     │
│  ✗ auth panic   │  ████   │  ▸ old session  │  ████   │  ▸ 8 knowledge  │
│                 │         │    resumed      │         │    facts        │
└─────────────────┘         └─────────────────┘         └─────────────────┘
         SQLite (memory.db) — single file, WAL mode, zero native deps
```

## Why

Every AI coding session starts from zero. No memory of yesterday's decisions, last week's errors, or which files you touched. This plugin fixes that — permanently.

- **Session continuity** — pick up exactly where you left off, across days and weeks
- **Error archaeology** — every crash, every fix, forever queryable
- **Decision tracking** — "why did we choose X?" is one command away
- **Knowledge base** — facts, conventions, and gotchas accumulate automatically
- **File forensics** — full modification history with diff stats
- **Self-aware digest** — injected into every system prompt, the AI knows its own history

## Install

```json
// opencode.json (global: ~/.config/opencode/opencode.json)
{
  "plugin": [
    "file:///path/to/opencode-persistence/index.js"
  ]
}
```

That's it. No `npm install`. No native modules. No config. Restart opencode.

## Tools

Five tools, registered automatically. All queryable by the AI agent mid-conversation.

| Tool | What it does |
|------|-------------|
| `memory_search` | Full-text search across actions, dialog, replies, knowledge, files, errors. Optional time-range filter. |
| `memory_decisions` | All recorded decisions, error frequency, action stats. |
| `memory_files` | File change history. `aggregate=true` for grouped stats per file. |
| `memory_errors` | Session errors, tool errors, grouped by type. Optional time-range. |
| `memory_sessions` | Session history, cross-session chains by project, per-session details. |

### Examples

```
# Search everything from today
memory_search(query="auth bug", since="2026-09-15T00:00:00Z")

# What have we been fixing?
memory_errors()

# Which files did we touch?
memory_files(aggregate=true)

# What decisions were made?
memory_decisions()

# Show all sessions for this project
memory_sessions()
```

## Architecture

Single file. Zero dependencies. Built for Bun runtime.

```
┌──────────────────────────────────────────────────────────┐
│                      opencode (Bun)                       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Persistence Plugin (index.js)          │  │
│  │                                                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │  │
│  │  │  Hooks   │  │  Digest  │  │  5 memory tools  │ │  │
│  │  │  (8 evt) │  │  builder │  │                  │ │  │
│  │  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │  │
│  │       │             │                  │           │  │
│  │  ┌────▼─────────────▼──────────────────▼─────────┐ │  │
│  │  │            Mutex-protected SQLite              │ │  │
│  │  │                  (bun:sqlite)                   │ │  │
│  │  │                                                │ │  │
│  │  │  13 tables · 8 indexes · WAL mode · prepared   │ │  │
│  │  │  statements · auto-flush 30s · zero deps       │ │  │
│  │  └────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  DB: %APPDATA%/opencode/memory/memory.db (SQLite WAL)   │
└──────────────────────────────────────────────────────────┘
```

## What gets captured

| Data | Source | When |
|------|--------|------|
| **Sessions** | `session.created` / `session.deleted` / `session.compacted` | Lifecycle events |
| **User messages** | `chat.message` | Every user input |
| **Assistant replies** | `message.updated` | On completion |
| **Tool calls + output** | `tool.execute.after` | Every tool execution |
| **Errors** | `tool.execute.after`, `session.error`, `message.updated` | Structural error detection |
| **File changes** | `file.edited`, `session.diff` | Every edit and diff |
| **Todos** | `todo.updated` | Every plan change |
| **Decisions** | `chat.message` | Regex extraction (EN+RU) |
| **Knowledge/facts** | `chat.message` | Regex extraction (EN+RU) |
| **Snapshots** | `message.part.updated` | Code snapshots |
| **Patches** | `message.part.updated` | Git patch hashes |

## Schema (13 tables)

```
identity ────── Agent name, role, notes (singleton)
sessions ────── ID, status, agent, model, project_dir, timestamps
actions ─────── Type, summary, tool, call_id, session ref
dialog ──────── User messages with session context
assistant_replies  AI responses, tool_calls JSON, model info
context ─────── Handoff summary + next_steps (singleton)
patterns ────── Decisions & recurring errors (deduped, counted)
knowledge ───── Extracted facts/conventions (deduped)
file_changes ── File path, change_type, additions/deletions
todos ───────── Plan snapshots per session
session_errors  Error type + message per session
snapshots ───── Code snapshots per message
patches ──────── Git patch hashes + file lists
```

All writes are mutex-queued. All reads use prepared statements. DB auto-flushes every 30 seconds with `unref()` so it never blocks exit.

## Digest injection

Every system prompt gets an automatic digest:

```
[AUTONOMOUS PERSISTENCE v4.1] Active. Full self-awareness enabled.
Identity: XuViGaN (autonomous_agent)
Previous session handoff: Asked: fix auth bug | Did: bash: grep auth.go, edit: auth.go +45 -12
Memory: 12 sessions, 347 actions, 89 dialog, 156 replies, 42 files, 3 errors
Recent sessions:
  a3f8c2d1(active) [nim-proxy/deepseek-v4-flash] 2026-09-15 14:30:22
  b7e1d4f2(compacted) [nim-proxy/kimi-k3-max] 2026-09-14 22:15:01
Latest actions:
  [action] edit: auth.go +45 -12
  [action] bash: go test ./...
  [error] bash: exit code 1
Key decisions: using SQLite over JSON; bun:sqlite over better-sqlite3
Accumulated knowledge:
  - always use prepared statements for sqlite
  - never commit .env files
```

## Evolution

| Version | What changed |
|---------|-------------|
| **v1.0** | JSON files, basic session/action/dialog capture |
| **v2.0** | Atomic writes, knowledge base, smarter error detection, batch I/O |
| **v3.0** | 11 JSON files, 5 memory tools, file tracking, model info, todo snapshots, error detection v2 |
| **v4.0** | SQLite migration (better-sqlite3), mutex queue, WAL mode, prepared statements, −546 lines |
| **v4.1** | `bun:sqlite` native — zero dependencies, NAPI crash fix, Bun-compatible |

## License

MIT
