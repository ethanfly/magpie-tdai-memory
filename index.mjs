// The plugin's tools: magpie offers them to every agent through its plugin
// tools MCP server, so an agent whose model isn't served by magpie (Gemini
// CLI, Cursor, Copilot…) still reads and adds to the same memory.
//
// Unlike the requests the gateway hook sees, a tool call carries no origin,
// and magpie serves plugin tools to other computers that hold a gateway key
// as well. So there are no tools until the options turn them on.

import { KernelError, call, capture, cgCall, cgList, cgMatch, config, cut, matchRole, scope, wikiRead, wikiSearch } from "./lib.mjs"

// options are what the plugin's Options (or `magpie plugin options`) set,
// the same the gateway hook is handed as ctx.options (input.magpie.options is
// a provider's sign-in switches, not these); a change reloads the plugin.
export default async function tdaiMemory(input, options) {
  const o = config(options)
  if (!o.tools) return {}
  const fail = (e) => (e instanceof KernelError ? `memory-core ${e.kind} (${e.status})` : `memory-core error: ${e?.message ?? e}`)
  const list = (v) => (Array.isArray(v) ? v : [])
  const scopesFor = (ctx, query) => {
    const role = matchRole(o, { cwd: ctx?.cwd, query })
    const shared = scope(o, ctx?.agent)
    const roleScope = scope(o, ctx?.agent, role?.agentId)
    return roleScope.agent_id === shared.agent_id ? [shared] : [shared, roleScope]
  }
  // pick the repo graph for a code tool: the repo arg, else the cwd
  const pickGraph = async (args, ctx) => {
    if (!o.knowledgeKey) return { err: "knowledge service is not configured" }
    let items
    try {
      items = await cgList(o, ctx?.abort)
    } catch (e) {
      return { err: fail(e) }
    }
    const row = cgMatch(items, ctx?.cwd, args?.repo)
    if (!row) {
      const names = items.filter((r) => r && r.status !== "failed").map((r) => r.repo_name).join(", ") || "none"
      return { err: `no code graph matches ${args?.repo || ctx?.cwd || "(no cwd)"}; repos: ${names}` }
    }
    return { row }
  }
  const intIn = (v, lo, hi) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined
  }
  const KINDS = ["function", "method", "class", "interface", "type", "variable", "route", "component"]
  // read-only code-graph query. build() returns the tool params, or an error string.
  const codeTool = (tool, build, props, required, desc) => ({
    description: desc,
    args: {
      type: "object",
      properties: {
        repo: { type: "string", description: "repo folder name or code_graph_id, when the working directory is not that repo" },
        ...props,
      },
      required,
    },
    async execute(args, ctx) {
      for (const k of required) if (!String(args?.[k] ?? "").trim()) return `${k} is empty`
      const extra = build(args)
      if (typeof extra === "string") return extra
      const { row, err } = await pickGraph(args, ctx)
      if (err) return err
      try {
        const d = await cgCall(o, tool, { code_graph_id: row.code_graph_id, ...extra }, ctx?.abort)
        return d?.isError ? `tool failed: ${d.text}` : d?.text || "no results"
      } catch (e) {
        return fail(e)
      }
    },
  })
  const queryProp = { type: "string", description: "what to look up in this repo" }
  const symbolProp = { type: "string", description: "symbol name, as the code spells it" }
  return {
    tool: {
      search: {
        description: "Search the long-term memory every agent on this computer shares (TDAI memory-core): extracted memories (L1) and, optionally, raw past conversations (L0). Use it before starting work that someone may have done before, or when the user refers to earlier decisions.",
        args: {
          type: "object",
          properties: {
            query: { type: "string", description: "keywords or a question" },
            limit: { type: "integer", description: "results per layer, 1-20 (default 5)" },
            conversations: { type: "boolean", description: "also search raw past conversations (default false)" },
          },
          required: ["query"],
        },
        async execute(args, ctx) {
          const q = String(args?.query ?? "").trim().slice(0, 2048)
          if (!q) return "query is empty"
          // magpie hands the arguments on as they came: a number or a switch may be text
          const n = Number(args?.limit)
          const limit = Number.isInteger(n) && n > 0 ? Math.min(20, n) : 5
          const conversations = args?.conversations === true || args?.conversations === "true"
          const scs = scopesFor(ctx, q)
          try {
            const [l1s, l0s] = await Promise.all([
              Promise.all(scs.map((sc) => call(o, "atomic/search", { ...sc, query: q, limit }, ctx?.abort))),
              conversations
                ? Promise.all(scs.map((sc) => call(o, "conversation/search", { ...sc, query: q, limit }, ctx?.abort)))
                : [],
            ])
            const out = []
            const seen = new Set()
            for (const l1 of l1s) for (const m of list(l1?.items)) {
              if (seen.has(m?.content)) continue
              seen.add(m?.content)
              out.push(`- [${m?.type}] ${m?.content}${m?.updated_at ? ` (${String(m.updated_at).slice(0, 10)})` : ""}`)
            }
            for (const l0 of l0s) for (const m of list(l0?.messages)) out.push(`- [conversation ${m?.role} ${String(m?.timestamp ?? "").slice(0, 10)} ${m?.session_id ?? ""}] ${cut(m?.content, 600)}`)
            return out.length ? out.join("\n") : "nothing found"
          } catch (e) {
            return fail(e)
          }
        },
      },
      read_scene: {
        description: "Read one scene file (L2) of the shared memory, by the path the recalled <scenes> list gives (the core's scene_blocks/… paths work too).",
        args: { type: "object", properties: { path: { type: "string", description: "a path from the <scenes> list, such as deploy.md" } }, required: ["path"] },
        async execute(args, ctx) {
          // the kernel's L3 core names scenes by their file under scene_blocks/;
          // scenario/read takes the name inside it, as scenario/ls lists it
          const path = String(args?.path ?? "").trim().replace(/^(?:.*\/)?scene_blocks\//, "")
          if (!path) return "path is empty"
          try {
            const role = matchRole(o, { cwd: ctx?.cwd, query: path })
            const d = await call(o, "scenario/read", { ...scope(o, ctx?.agent, role?.agentId), path }, ctx?.abort)
            return typeof d?.content === "string" ? d.content : "no such scene"
          } catch (e) {
            return fail(e)
          }
        },
      },
      remember: {
        description: "Write something worth remembering into the shared memory: a decision, a fact about a project, a pitfall and its fix. The kernel's pipeline extracts it into memories other agents recall later (not at once).",
        args: {
          type: "object",
          properties: {
            content: { type: "string", description: "what to remember, self-contained" },
            project: { type: "string", description: "project or folder it is about (optional)" },
          },
          required: ["content"],
        },
        async execute(args, ctx) {
          const content = String(args?.content ?? "").trim()
          if (!content) return "content is empty"
          const agent = ctx?.agent || "agent"
          const project = String(args?.project ?? "").trim()
          const about = project ? ` about ${project}` : ""
          try {
            const role = matchRole(o, { cwd: ctx?.cwd, query: content })
            await capture(o, scope(o, ctx?.agent, role?.agentId), `remember:${agent}`, `Remember this${about}: ${content}`, "Noted.", ctx?.abort)
            return "saved to L0; it becomes a recallable memory once the kernel's pipeline runs"
          } catch (e) {
            return fail(e)
          }
        },
      },
      wiki_search: {
        description: "Search the team knowledge wiki: standing rules and runbooks, not chat memory. Returns page titles and snippets.",
        args: {
          type: "object",
          properties: {
            query: { type: "string", description: "keywords or a question" },
          },
          required: ["query"],
        },
        async execute(args, ctx) {
          const q = String(args?.query ?? "").trim()
          if (!q) return "query is empty"
          if (!o.wikiId) return "wiki is not configured"
          const pages = await wikiSearch(o, q, ctx?.abort)
          if (!pages.length) return "nothing found"
          return pages.map((p) => {
            const title = p.title || p.ref || p.path || "page"
            const bit = p.snippet || p.description || ""
            const ref = p.ref || p.path || ""
            return `- ${title}${ref ? ` (${ref})` : ""}${bit ? `: ${bit}` : ""}`
          }).join("\n")
        },
      },
      wiki_read: {
        description: "Read one knowledge-wiki page by the ref wiki_search returned, such as wiki/concepts/生产环境操作红线.md.",
        args: {
          type: "object",
          properties: {
            ref: { type: "string", description: "page ref from wiki_search" },
          },
          required: ["ref"],
        },
        async execute(args, ctx) {
          const ref = String(args?.ref ?? "").trim()
          if (!ref) return "ref is empty"
          if (!o.wikiId) return "wiki is not configured"
          const text = await wikiRead(o, ref, ctx?.abort)
          return text ? cut(text, 8000) : "no such page"
        },
      },
      code_explore: codeTool(
        "explore",
        (a) => {
          const maxFiles = intIn(a?.maxFiles, 1, 200)
          return { query: String(a.query).trim(), ...(maxFiles ? { maxFiles } : {}) }
        },
        { query: queryProp, maxFiles: { type: "integer", description: "max files, 1-200 (default 12)" } },
        ["query"],
        "Read-only. Explore the current repo's code graph and return the files and source relevant to a question. The graph follows the working directory; pass repo to name another. First choice for how something works in this repo.",
      ),
      code_search: codeTool(
        "search",
        (a) => {
          const kind = String(a?.kind ?? "")
          if (kind && !KINDS.includes(kind)) return `unknown kind: ${kind}`
          const limit = intIn(a?.limit, 1, 100)
          return { query: String(a.query).trim(), ...(kind ? { kind } : {}), ...(limit ? { limit } : {}) }
        },
        {
          query: queryProp,
          kind: { type: "string", description: "optional: function, method, class, interface, type, variable, route or component" },
          limit: { type: "integer", description: "max results, 1-100 (default 10)" },
        },
        ["query"],
        "Read-only. Search symbols by name in the current repo's code graph. Locations only, no source; use code_explore for source. The graph follows the working directory; pass repo to override.",
      ),
      code_callers: codeTool(
        "callers",
        (a) => {
          const limit = intIn(a?.limit, 1, 200)
          return { symbol: String(a.symbol).trim(), ...(limit ? { limit } : {}) }
        },
        { symbol: symbolProp, limit: { type: "integer", description: "max results, 1-200 (default 20)" } },
        ["symbol"],
        "Read-only. List functions that call this symbol in the current repo's code graph. The graph follows the working directory; pass repo to override.",
      ),
      code_callees: codeTool(
        "callees",
        (a) => {
          const limit = intIn(a?.limit, 1, 200)
          return { symbol: String(a.symbol).trim(), ...(limit ? { limit } : {}) }
        },
        { symbol: symbolProp, limit: { type: "integer", description: "max results, 1-200 (default 20)" } },
        ["symbol"],
        "Read-only. List functions this symbol calls, in the current repo's code graph. The graph follows the working directory; pass repo to override.",
      ),
      code_impact: codeTool(
        "impact",
        (a) => {
          const depth = intIn(a?.depth, 1, 10)
          return { symbol: String(a.symbol).trim(), ...(depth ? { depth } : {}) }
        },
        { symbol: symbolProp, depth: { type: "integer", description: "how many hops, 1-10 (default 2)" } },
        ["symbol"],
        "Read-only. What a change to this symbol can affect, in the current repo's code graph. The graph follows the working directory; pass repo to override.",
      ),
    },
  }
}
