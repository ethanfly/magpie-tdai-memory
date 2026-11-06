// The plugin's tools: magpie offers them to every agent through its plugin
// tools MCP server, so an agent whose model isn't served by magpie (Gemini
// CLI, Cursor, Copilot…) still reads and adds to the same memory.

import { KernelError, call, capture, config, cut, scope } from "./lib.mjs"

// options are what the plugin's Options (or `magpie plugin options`) set,
// the same the gateway hook is handed as ctx.options (input.magpie.options is
// a provider's sign-in switches, not these); a change reloads the plugin.
export default async function tdaiMemory(input, options) {
  const opts = () => config(options)
  const fail = (e) => (e instanceof KernelError ? `memory-core ${e.kind} (${e.status})` : `memory-core error: ${e?.message ?? e}`)
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
          const o = opts()
          const sc = scope(o, ctx?.agent)
          const q = String(args?.query ?? "").trim().slice(0, 2048)
          if (!q) return "query is empty"
          const limit = Math.min(20, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 5))
          try {
            const [l1, l0] = await Promise.all([
              call(o, "atomic/search", { ...sc, query: q, limit }, ctx?.abort),
              args?.conversations ? call(o, "conversation/search", { ...sc, query: q, limit }, ctx?.abort) : null,
            ])
            const out = []
            for (const m of l1?.items ?? []) out.push(`- [${m.type}] ${m.content}${m.updated_at ? ` (${m.updated_at.slice(0, 10)})` : ""}`)
            if (l0) for (const m of l0.messages ?? []) out.push(`- [conversation ${m.role} ${String(m.timestamp ?? "").slice(0, 10)} ${m.session_id ?? ""}] ${cut(m.content, 600)}`)
            return out.length ? out.join("\n") : "nothing found"
          } catch (e) {
            return fail(e)
          }
        },
      },
      read_scene: {
        description: "Read one scene file (L2) of the shared memory, by the path the recalled <scenes> list gives.",
        args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        async execute(args, ctx) {
          const o = opts()
          try {
            const d = await call(o, "scenario/read", { ...scope(o, ctx?.agent), path: String(args?.path ?? "") }, ctx?.abort)
            return d?.content ?? "no such scene"
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
          const o = opts()
          const content = String(args?.content ?? "").trim()
          if (!content) return "content is empty"
          const agent = ctx?.agent || "agent"
          const about = args?.project ? ` about ${args.project}` : ""
          try {
            await capture(o, scope(o, ctx?.agent), `remember:${agent}`, `Remember this${about}: ${content}`, "Noted.", ctx?.abort)
            return "saved to L0; it becomes a recallable memory once the kernel's pipeline runs"
          } catch (e) {
            return fail(e)
          }
        },
      },
    },
  }
}
