// Dashboard server — Bun native (Bun.serve + WebSocket)
import { readFileSync, existsSync } from "fs"
import path from "path"

const PORT = 3457
const DASHBOARD_DIR = import.meta.dir

let db = null
let server = null
const clients = new Set()

export function init(database) {
  db = database
}

export function start() {
  if (server) return
  try {
    server = Bun.serve({
      port: PORT,
      fetch(req, srv) {
        const url = new URL(req.url)

        // WebSocket upgrade
        if (url.pathname === "/ws") {
          const upgraded = srv.upgrade(req)
          if (upgraded) return
          return new Response("WebSocket upgrade failed", { status: 400 })
        }

        // CORS
        const headers = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }

        if (req.method === "OPTIONS") return new Response(null, { status: 200, headers })

        // API
        if (url.pathname === "/api/graph") {
          return Response.json(getGraphData(), { headers })
        }
        if (url.pathname === "/api/stats") {
          return Response.json(getStats(), { headers })
        }

        // Static
        let filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
        const fullPath = path.join(DASHBOARD_DIR, filePath)

        if (!existsSync(fullPath)) return new Response("Not found", { status: 404, headers })

        const ext = path.extname(fullPath)
        const mime = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".json": "application/json"
        }[ext] || "text/plain"

        return new Response(readFileSync(fullPath), {
          headers: { ...headers, "Content-Type": mime }
        })
      },
      websocket: {
        open(ws) {
          clients.add(ws)
          ws.send(JSON.stringify({ type: "init", data: getGraphData() }))
        },
        close(ws) {
          clients.delete(ws)
        },
        message() {}
      }
    })
    console.log(`[Persistence Dashboard] Live at http://localhost:${PORT}`)
  } catch (e) {
    console.error(`[Persistence Dashboard] Failed to start: ${e.message}`)
  }
}

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    try { ws.send(data) } catch { clients.delete(ws) }
  }
}

export function onEvent(eventType, data) {
  broadcast({ type: "event", event: eventType, data, timestamp: Date.now() })

  // Push fresh graph on significant events
  if (["session_start", "session_end", "error", "file_edit"].includes(eventType)) {
    broadcast({ type: "graph_update", data: getGraphData() })
  }
}

// Throttled graph updates for high-frequency events (actions)
let lastGraphPush = 0
export function onActionEvent(data) {
  broadcast({ type: "event", event: "action", data, timestamp: Date.now() })
  const now = Date.now()
  if (now - lastGraphPush > 2000) {
    lastGraphPush = now
    broadcast({ type: "graph_update", data: getGraphData() })
  }
}

function getStats() {
  if (!db) return {}
  try {
    return db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) as sessions,
        (SELECT COUNT(*) FROM actions) as actions,
        (SELECT COUNT(*) FROM dialog) as dialogs,
        (SELECT COUNT(*) FROM session_errors) as errors,
        (SELECT COUNT(DISTINCT project_dir) FROM sessions) as projects,
        (SELECT COUNT(DISTINCT file) FROM file_changes) as files,
        (SELECT SUM(CAST((julianday(COALESCE(ended_at, datetime('now'))) - julianday(started_at)) * 86400 AS INTEGER)) FROM sessions) as total_seconds
    `).get()
  } catch (e) {
    return { error: e.message }
  }
}

function getGraphData() {
  if (!db) return { nodes: [], links: [], projects: [] }

  try {
    const nodes = []
    const links = []
    const nodeSet = new Set()
    const projectsList = []

    // Projects
    const projects = db.prepare(`
      SELECT project_dir, COUNT(*) as session_count
      FROM sessions
      WHERE project_dir IS NOT NULL
      GROUP BY project_dir
    `).all()

    projects.forEach(p => {
      const name = p.project_dir.split(/[\\/]/).pop() || p.project_dir
      const id = "proj_" + Buffer.from(p.project_dir).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)
      if (nodeSet.has(id)) return
      nodeSet.add(id)
      nodes.push({
        id, type: "project", label: name, path: p.project_dir,
        sessions: p.session_count,
        size: Math.min(45, 18 + p.session_count * 4),
        color: "#00f0ff"
      })
      projectsList.push({ id, label: name, path: p.project_dir })
      nodeSet.add(p.project_dir + "=>" + id)
    })

    // ... rest of the function remains the same ...

    // Sessions (recent 60)
    const sessions = db.prepare(`
      SELECT id, project_dir, started_at, ended_at, status, agent, model_provider, model_id
      FROM sessions
      ORDER BY started_at DESC
      LIMIT 60
    `).all()

    const sessionMap = new Map()
    sessions.forEach(s => {
      const projId = nodes.find(n => n.type === "project" && n.path === s.project_dir)?.id
      if (!projId) return

      const shortId = s.id.slice(-6)
      const sid = "sess_" + shortId
      if (nodeSet.has(sid)) return
      nodeSet.add(sid)

      // Count session's actions and errors
      let actionCount = 0, errorCount = 0
      try {
        actionCount = db.prepare("SELECT COUNT(*) as c FROM actions WHERE session_id = ?").get(s.id)?.c || 0
        errorCount = db.prepare("SELECT COUNT(*) as c FROM session_errors WHERE session_id = ?").get(s.id)?.c || 0
      } catch {}

      nodes.push({
        id: sid, type: "session", label: shortId,
        status: s.status, agent: s.agent,
        model: (s.model_provider || "") + "/" + (s.model_id || "?"),
        actions: actionCount, errors: errorCount,
        started: s.started_at,
        size: Math.min(25, 9 + actionCount / 3),
        color: s.status === "active" ? "#00ff88" : errorCount > 0 ? "#ff3366" : "#8866ff"
      })
      links.push({ source: projId, target: sid, type: "contains" })
      sessionMap.set(s.id, sid)
    })

    // Actions (recent 80, only for visible sessions)
    const actions = db.prepare(`
      SELECT id, session_id, tool, summary, type, created_at
      FROM actions
      ORDER BY created_at DESC
      LIMIT 80
    `).all()

    actions.forEach(a => {
      const sessId = sessionMap.get(a.session_id)
      if (!sessId) return
      const aid = "act_" + a.id
      if (nodeSet.has(aid)) return
      nodeSet.add(aid)

      const isError = a.type === "error"
      nodes.push({
        id: aid, type: isError ? "error" : "action",
        label: a.tool || "action",
        summary: (a.summary || "").slice(0, 100),
        time: a.created_at,
        size: isError ? 13 : 6,
        color: isError ? "#ff0044" : "#ffaa00"
      })
      links.push({ source: sessId, target: aid, type: isError ? "threw" : "executes" })
    })

    // Files (top 25 by edit count)
    const files = db.prepare(`
      SELECT file, COUNT(*) as edit_count
      FROM file_changes
      GROUP BY file
      ORDER BY edit_count DESC
      LIMIT 25
    `).all()

    files.forEach(f => {
      const fileId = "file_" + Buffer.from(f.file).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)
      if (nodeSet.has(fileId)) return
      nodeSet.add(fileId)

      const fname = f.file.split(/[\\/]/).pop()
      nodes.push({
        id: fileId, type: "file", label: fname,
        path: f.file, edits: f.edit_count,
        size: Math.min(20, 6 + f.edit_count * 2),
        color: "#ffcc00"
      })

      // Link to sessions that touched this file
      const touched = db.prepare(`
        SELECT DISTINCT session_id FROM file_changes WHERE file = ? LIMIT 5
      `).all(f.file)
      touched.forEach(t => {
        const sessId = sessionMap.get(t.session_id)
        if (sessId) links.push({ source: sessId, target: fileId, type: "modifies" })
      })
    })

    return { nodes, links, projects: projectsList, timestamp: Date.now() }
  } catch (e) {
    return { nodes: [], links: [], projects: [], error: e.message }
  }
}
