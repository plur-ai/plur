// PLUR opencode probe — marker-echo test.
// Distinguishes "hook fired" (log file) from "hook output reached the model" (echo).
import { appendFileSync } from "fs"

const LOG = process.env.PLUR_PROBE_LOG || "/tmp/plur-probe.log"
const N = "7Q4X"
const log = (...a) => { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(" ")}\n`) } catch {} }

export const PlurProbe = async ({ project, client, $, directory, worktree }) => {
  log(`INIT ctx keys: project=${!!project} client=${!!client} $=${!!$} directory=${directory} worktree=${worktree}`)

  return {
    // --- Injection candidate A: append a Part to the user message ---
    "chat.message": async (input, output) => {
      if (process.env.PLUR_PROBE_NO_PART) { log("chat.message FIRED (inject skipped)"); return }
      const before = output.parts.length
      log(`chat.message SHAPE existing-part-id=${JSON.stringify(output.parts[0]?.id)} msg.id=${JSON.stringify(output.message?.id)} input.messageID=${JSON.stringify(input.messageID)}`)
      const rand = () => "prt_" + Math.random().toString(36).slice(2).padEnd(12, "0") + Date.now().toString(36)
      output.parts.push({
        id: rand(),
        sessionID: input.sessionID,
        messageID: input.messageID ?? output.message?.id,
        type: "text",
        text: `## PLUR MEMORY\n\nMARKER-CHATMSG-${N}\n`,
        synthetic: true,
      })
      log(`chat.message FIRED session=${input.sessionID} agent=${input.agent} parts ${before}->${output.parts.length}`)
    },

    // --- Injection candidate B: push into the system prompt array ---
    "experimental.chat.system.transform": async (input, output) => {
      // Logged on entry regardless of which branch runs below, so a run can
      // measure system[] length directly — the array accretion would happen
      // in, as opposed to the message-history meter below, which cannot see
      // system[] content by construction (see scripts/probes/README.md).
      const before = output.system.length
      if (process.env.PLUR_PROBE_NO_SYSTEM) {
        log(`system.transform FIRED (inject skipped) session=${input.sessionID} model=${input.model?.id} system.length-at-entry=${before}`)
        return
      }
      output.system.push(`## PLUR MEMORY\n\nMARKER-SYSTEM-${N}\n`)
      log(`system.transform FIRED session=${input.sessionID} model=${input.model?.id} system ${before}->${output.system.length}`)
    },

    // --- deterministic accretion meter: what the model ACTUALLY receives ---
    "experimental.chat.messages.transform": async (_input, output) => {
      let blocks = 0, msgs = 0
      for (const m of output.messages || []) {
        msgs++
        for (const p of m.parts || []) {
          if (p?.type === "text" && typeof p.text === "string" && p.text.includes("PLUR MEMORY")) blocks++
        }
      }
      log(`ACCRETION messages=${msgs} plur-blocks-in-history=${blocks} no_part=${!!process.env.PLUR_PROBE_NO_PART} no_system=${!!process.env.PLUR_PROBE_NO_SYSTEM}`)
    },

    // --- afterTurn learning path: can we read the assistant's output? ---
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "session.created") {
        log(`event ${event.type} ${JSON.stringify(event.properties || {}).slice(0, 200)}`)
      }
      if (event.type === "message.part.updated" && event.properties?.part?.type === "text") {
        const p = event.properties.part
        log(`STREAM part=${p.id} msg=${p.messageID} len=${(p.text || "").length} head=${JSON.stringify((p.text || "").slice(0, 24))} tail=${JSON.stringify((p.text || "").slice(-24))}`)
      }
    },

    // --- native tool surface (no MCP process) ---
    tool: {
      plur_probe_recall: {
        description: "Probe: return a marker from PLUR memory",
        args: {},
        async execute() { log("tool plur_probe_recall EXECUTED"); return `MARKER-TOOL-${N}` },
      },
    },

    "tool.execute.after": async (input) => { log(`tool.after ${input.tool}`) },
    dispose: async () => { log("dispose FIRED") },
  }
}
