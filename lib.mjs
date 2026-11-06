// The memory-core (TDAI kernel) v3 client and the pieces both the gateway
// hook and the tools use. No dependencies: fetch and AbortSignal only.

export const DEFAULTS = {
  url: "http://127.0.0.1:8420",
  apiKey: "local",
  serviceId: "default",
  teamId: "default",
  agentId: "shared",
  userId: "default",
  perAgent: false,
  agents: ["claude", "codex", "opencode", "crush", "pi", "omp"],
  recall: true,
  capture: false,
  remote: false,
  tools: false,
  requireTools: true,
  recallLimit: 5,
  maxInjectChars: 6000,
  includeCwd: true,
  knowledgeUrl: "http://127.0.0.1:8424",
  knowledgeKey: "",
  wikiId: "",
  roles: [],
  workRoots: [],
}

export const MAX_MESSAGE_CHARS = 8000 // the kernel takes 1–8192 per message

// the switches: true or false, or the text "true"/"false"; anything else is
// the default, so a stray value never turns capture, remote or the tools on
const FLAGS = ["perAgent", "recall", "capture", "remote", "tools", "requireTools", "includeCwd"]

export function config(options) {
  const o = { ...DEFAULTS, ...(options && typeof options === "object" ? options : {}) }
  o.url = String(o.url || DEFAULTS.url).replace(/\/+$/, "")
  if (!Array.isArray(o.agents)) o.agents = DEFAULTS.agents
  if (!Array.isArray(o.roles)) o.roles = []
  if (!Array.isArray(o.workRoots)) o.workRoots = []
  o.knowledgeUrl = String(o.knowledgeUrl || "").replace(/\/+$/, "")
  o.wikiId = String(o.wikiId || "")
  for (const k of FLAGS) o[k] = flag(o[k], DEFAULTS[k])
  o.recallLimit = clampInt(o.recallLimit, 1, 20, DEFAULTS.recallLimit)
  o.maxInjectChars = clampInt(o.maxInjectChars, 500, 32000, DEFAULTS.maxInjectChars)
  return o
}

function clampInt(v, lo, hi, d) {
  const n = Number(v)
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : d
}

function flag(v, d) {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return d
}

// scope is the kernel's isolation triple. One agent_id for every agent is
// what makes the memory shared; perAgent gives each agent its own.
export function scope(o, agent, roleAgentId) {
  return {
    team_id: String(o.teamId || "default"),
    agent_id: roleAgentId
      ? String(roleAgentId)
      : o.perAgent && agent
        ? String(agent)
        : String(o.agentId || "shared"),
    user_id: String(o.userId || "default"),
  }
}

// Pick the hub role agent for this turn. Keyword roles win over the repo
// role; a role with fallback is used only when nothing else matched. A role
// with an empty agentId is ignored, so an unconfigured map changes nothing.
export function matchRole(o, { cwd = "", query = "" } = {}) {
  const roles = (Array.isArray(o.roles) ? o.roles : []).filter((r) => r && r.agentId && r.name)
  const hay = `${cwd}\n${query}`.toLowerCase()
  for (const r of roles) {
    if (r.fallback) continue
    const words = Array.isArray(r.words) ? r.words : []
    if (words.some((w) => w && hay.includes(String(w).toLowerCase()))) return r
  }
  const roots = (Array.isArray(o.workRoots) ? o.workRoots : []).map((p) => String(p).replace(/\/+$/, "")).filter(Boolean)
  const inRepo = cwd && roots.some((root) => cwd === root || cwd.startsWith(root + "/"))
  if (inRepo) {
    const dev = roles.find((r) => r.when === "repo")
    if (dev) return dev
  }
  return roles.find((r) => r.fallback) || null
}

export class KernelError extends Error {
  constructor(kind, status) {
    super(kind)
    this.kind = kind // unauthorized | unavailable | invalid
    this.status = status
  }
}

export async function call(o, path, body, signal) {
  let res
  try {
    res = await fetch(`${o.url}/v3/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": String(o.serviceId || "default"),
        authorization: `Bearer ${o.apiKey || "local"}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new KernelError("unavailable", 0)
  }
  let env
  try {
    env = await res.json()
  } catch {
    throw new KernelError(res.ok ? "invalid" : "unavailable", res.status)
  }
  const code = env?.code ?? res.status
  if (code === 0) return env.data ?? {}
  if (code === 401 || code === 403 || res.status === 401 || res.status === 403) throw new KernelError("unauthorized", code)
  if (code >= 500 || res.status >= 500) throw new KernelError("unavailable", code)
  throw new KernelError("invalid", code)
}

// recall is what TDAI's own Hermes adapter fetches before a turn: L1 atoms
// that match the query, the L3 core, the L2 scene list, side by side. A
// layer that fails is left out; all failing throws the first error.
export async function recall(o, sc, query, signal) {
  const q = String(query).slice(0, 2048)
  const got = await Promise.allSettled([
    call(o, "atomic/search", { ...sc, query: q, limit: o.recallLimit }, signal),
    call(o, "core/read", sc, signal),
    call(o, "scenario/ls", sc, signal),
  ])
  if (got.every((r) => r.status === "rejected")) throw got[0].reason
  const [l1, l3, l2] = got.map((r) => (r.status === "fulfilled" ? r.value : null))
  return {
    atoms: Array.isArray(l1?.items) ? l1.items : [],
    core: typeof l3?.content === "string" ? l3.content : "",
    scenes: Array.isArray(l2?.entries) ? l2.entries.filter((e) => e && typeof e.path === "string" && !e.path.endsWith("/")) : [],
  }
}

// Recall several scopes and merge. The first scope supplies the core when it
// has one. A scope that fails is left out; all failing throws the first error.
export async function recallScopes(o, scopes, query, signal) {
  const uniq = []
  const seen = new Set()
  for (const sc of scopes) {
    if (!sc?.agent_id || seen.has(sc.agent_id)) continue
    seen.add(sc.agent_id)
    uniq.push(sc)
  }
  const got = await Promise.all(
    uniq.map((sc) => recall(o, sc, query, signal).then((v) => ({ v })).catch((e) => ({ e }))),
  )
  if (got.every((g) => g.e)) throw got[0].e
  const atoms = []
  const seenAtom = new Set()
  const scenes = []
  const seenScene = new Set()
  let core = ""
  for (const g of got) {
    if (!g.v) continue
    if (!core && g.v.core) core = g.v.core
    for (const m of g.v.atoms) {
      const id = m?.id || m?.content
      if (seenAtom.has(id)) continue
      seenAtom.add(id)
      atoms.push(m)
    }
    for (const s of g.v.scenes) {
      if (seenScene.has(s.path)) continue
      seenScene.add(s.path)
      scenes.push(s)
    }
  }
  return { atoms, core, scenes }
}

export async function wikiSearch(o, query, signal) {
  if (!o.wikiId || !o.knowledgeUrl || !o.knowledgeKey) return []
  const q = String(query || "").trim().slice(0, 500)
  if (!q) return []
  let res
  try {
    res = await fetch(`${o.knowledgeUrl}/v3/wiki/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": String(o.serviceId || "default"),
        authorization: `Bearer ${o.knowledgeKey}`,
      },
      body: JSON.stringify({ wiki_id: o.wikiId, query: q, limit: 3 }),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    return []
  }
  if (!res.ok) return []
  let env
  try {
    env = await res.json()
  } catch {
    return []
  }
  const items = env?.data?.results
  return Array.isArray(items) ? items.slice(0, 3) : []
}

export async function wikiRead(o, ref, signal) {
  if (!o.wikiId || !o.knowledgeUrl || !o.knowledgeKey) return ""
  const path = String(ref || "").trim()
  if (!path) return ""
  let res
  try {
    res = await fetch(`${o.knowledgeUrl}/v3/wiki/page/read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": String(o.serviceId || "default"),
        authorization: `Bearer ${o.knowledgeKey}`,
      },
      body: JSON.stringify({ wiki_id: o.wikiId, refs: [path] }),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    return ""
  }
  if (!res.ok) return ""
  let env
  try {
    env = await res.json()
  } catch {
    return ""
  }
  const item = env?.data?.items?.[0]
  return typeof item?.content === "string" ? item.content : ""
}

// ── Knowledge code-graph client ──

let cgCache = { key: "", at: 0, items: [] }

// code-graph/list, cached for a minute: the tools pick a repo per call and
// the team's repo set rarely changes
export async function cgList(o, signal) {
  if (!o.knowledgeUrl || !o.knowledgeKey) return []
  const key = `${o.knowledgeUrl}|${o.teamId}`
  if (cgCache.key === key && Date.now() - cgCache.at < 60_000) return cgCache.items
  const res = await fetch(`${o.knowledgeUrl}/v3/code-graph/list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": String(o.serviceId || "default"),
      authorization: `Bearer ${o.knowledgeKey}`,
    },
    body: JSON.stringify({ team_id: String(o.teamId || "default"), limit: 100 }),
    signal,
  })
  if (!res.ok) throw new KernelError("unavailable", res.status)
  let env
  try {
    env = await res.json()
  } catch {
    throw new KernelError("invalid", res.status)
  }
  if ((env?.code ?? res.status) !== 0) throw new KernelError("invalid", env?.code ?? res.status)
  const items = Array.isArray(env?.data?.items) ? env.data.items : []
  cgCache = { key, at: Date.now(), items }
  return items
}

// Pick the code graph for a call: an explicit repo (code_graph_id, repo
// name or the repo url's last path segment) wins, then the working
// directory's folder name matched against repo names and url tails. Ready
// graphs are preferred over ones still indexing; failed ones never match.
export function cgMatch(items, cwd, repo) {
  const list = (Array.isArray(items) ? items : [])
    .filter((r) => r && r.code_graph_id && r.status !== "failed")
    .sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1))
  const urlTail = (u) => String(u || "").replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop()
  if (repo) {
    const s = String(repo).trim()
    return (
      list.find((r) => r.code_graph_id === s) ||
      list.find((r) => r.repo_name === s) ||
      list.find((r) => urlTail(r.repo_url) === s) ||
      null
    )
  }
  if (!cwd) return null
  const base = String(cwd).replace(/\/+$/, "").split("/").pop()
  if (!base) return null
  return list.find((r) => r.repo_name === base) || list.find((r) => urlTail(r.repo_url) === base) || null
}

// One read-only code-graph query. Returns the { text, isError } data block.
export async function cgCall(o, tool, params, signal) {
  const res = await fetch(`${o.knowledgeUrl}/v3/code-graph/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": String(o.serviceId || "default"),
      authorization: `Bearer ${o.knowledgeKey}`,
    },
    body: JSON.stringify(params),
    signal,
  })
  if (!res.ok) throw new KernelError(res.status === 404 ? "invalid" : "unavailable", res.status)
  let env
  try {
    env = await res.json()
  } catch {
    throw new KernelError("invalid", res.status)
  }
  if ((env?.code ?? res.status) !== 0) throw new KernelError("invalid", env?.code ?? res.status)
  return env.data
}

// block is the recall as the text put before the user's message, or "" when
// there is nothing to say.
export function block(r, max) {
  const parts = []
  if (r.atoms.length) {
    parts.push("<relevant-memories>\n" + r.atoms.map((m) => `- [${oneLine(m.type) || "memory"}] ${oneLine(m.content)}`).join("\n") + "\n</relevant-memories>")
  }
  if (r.core.trim()) parts.push("<core>\n" + cut(inert(r.core.trim()), Math.floor(max / 3)) + "\n</core>")
  if (r.scenes.length) {
    const lines = r.scenes.slice(0, 15).map((s) => `- ${oneLine(s.path)}${s.summary ? `: ${oneLine(s.summary)}` : ""}`)
    parts.push("<scenes hint=\"this plugin's read_scene tool reads one\">\n" + lines.join("\n") + "\n</scenes>")
  }
  if (r.wiki?.length) {
    const lines = r.wiki.slice(0, 3).map((p) => {
      const title = oneLine(p.title || p.ref || p.path || "page")
      const bit = oneLine(p.snippet || p.description || p.content || "")
      return bit ? `- ${title}: ${bit}` : `- ${title}`
    })
    parts.push("<wiki>\n" + lines.join("\n") + "\n</wiki>")
  }
  if (!parts.length) return ""
  const role = r.role ? ` Role for this turn: ${oneLine(r.role)}.` : ""
  const head = `<tdai-memory note="Recalled from the long-term memory every agent here shares. Reference only: it may be outdated, and the user's message below wins over it.${role}">\n`
  return cut(head + parts.join("\n\n"), max - 20) + "\n</tdai-memory>"
}

function oneLine(s) {
  return inert(String(s ?? "").replace(/\s+/g, " ").trim())
}

// inert keeps recalled text from opening or closing the elements it is put
// in: a memory that quotes them (talk about this plugin, a page an agent
// read) stays reference inside the block, never words after it
function inert(s) {
  return String(s).replace(/<(?=\/?\s*(?:tdai-memory|relevant-memories|core|scenes|wiki)\b)/gi, "&lt;")
}

export function cut(s, n) {
  s = String(s ?? "")
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…"
}

export async function capture(o, sc, sessionId, user, assistant, signal) {
  const now = Date.now()
  return call(o, "conversation/add", {
    ...sc,
    session_id: String(sessionId).slice(0, 200),
    messages: [
      { role: "user", content: cut(user, MAX_MESSAGE_CHARS), timestamp: new Date(now - 1).toISOString() },
      { role: "assistant", content: cut(assistant, MAX_MESSAGE_CHARS), timestamp: new Date(now).toISOString() },
    ],
  }, signal)
}

export function hash(s) {
  // FNV-1a, enough to tell turns apart in memory; never sent anywhere
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
