// Bonus demo: persists the conversation history to a JSON file on disk,
// so memory survives across separate process runs (a real CLI chat), not
// just across calls within a single script.
//
// Run: npm run chat -- "Read package.json and tell me the version"
// Run again later: npm run chat -- "Now bump it to the next minor"

import { createAgent, readFileTool, runShellCommandTool, defaultSystemPrompt, MaxTurnsError } from 'ollama-agent-kit'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// llama3.2 unreliably fakes tool calls as plain text instead of issuing real
// ones (confirmed empirically); qwen3, trained for tool calling, does not.
// Correctness matters more than speed here, so it's the default — override
// with OLLAMA_MODEL if you want a faster/lighter (but less reliable) model.
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b'
const HISTORY_FILE = path.join(process.cwd(), 'history.json')

// run_shell_command actually executes via cmd.exe on Windows (not PowerShell,
// not a Unix shell) — so the model needs to be told that explicitly, or it
// guesses differently each run and picks commands/flags that only work by
// accident (e.g. ls/awk, which exist here only because Git for Windows put
// them on PATH). This also stops it from silently giving up on a task, and
// from writing a fake tool call as plain text when no tool fits.
const systemPrompt = `${defaultSystemPrompt}

    Environment specifics:
    - This machine is Windows. run_shell_command executes through cmd.exe, not PowerShell and not a
      Unix shell. Unix-style commands (ls, awk, grep, du...) only work if they happen to be on PATH;
      prefer commands you know are available, or fall back to a Windows-native command if a Unix one
      fails.
    - cmd.exe's "dir" has no recursive total-size option: its summary line ("N Dir(s)  X bytes free")
      reports free space remaining on the drive, not the size of the folder — never read that number
      as a folder's size. For a folder's true total size (recursively, in bytes) on Windows, run:
      powershell -Command "(Get-ChildItem -Recurse -File | Measure-Object -Property Length -Sum).Sum"
    - When a command's output must be used in arithmetic (e.g. summing sizes), prefer requesting output
      already in one consistent numeric unit (raw bytes) over human-readable units like "1.8K"/"56K".
      If you only have mixed units, convert them yourself before summing — do not give up.
    - If a task genuinely cannot be done with the available tools, say so plainly. Never invent a tool
      call as plain text (e.g. writing out {"name": ...} yourself) — only real tool calls count.
    - If a tool call fails, immediately try a different, concrete approach via another real tool call.
      Do not describe a plan as if it were the final answer — an unexecuted plan is not a result.
    - For exact arithmetic or conversions (hex/decimal math, unit conversions, date/timestamp math,
      UUID field extraction, etc.), do not compute the result by reasoning alone — you are unreliable
      at multi-step arithmetic. Issue a run_shell_command call with a PowerShell one-liner that computes
      the exact value, then base your answer on that tool's output.
    - Never end a turn with a sentence describing what you are about to do ("let's", "next, we will",
      "now I will", "proceeding to") unless a real tool call is attached to that same turn. A stated
      intention with no tool call is not progress — it is a stall.
`

// Tracks whether the most recent tool call (in the current agent.run() attempt) failed
// and was never followed by a successful one. createAgent() only takes one onToolCall
// for the agent's whole lifetime (not per run() call), so this is reset at the start of
// each attempt in runResilient() below and read right after that attempt's run() resolves.
// Note: if a single turn issues multiple tool_calls, they settle concurrently (agent.js
// runs them via Promise.all), so "most recent" may not match the model's intended call
// order — acceptable here since the worst case is one extra bounded retry, or one missed
// retry that just falls back to returning the model's answer as-is.
//
// Two different failure shapes have to be checked, not just `error`: readFileTool throws
// on a bad path, which the framework catches and reports via onToolCall's `error` field —
// but runShellCommandTool never throws (confirmed by reading its source): a failed command
// still resolves normally, as `{ success: false, error, stdout, stderr }`. A command failure
// (e.g. an invalid PowerShell flag) is invisible to `error` and only shows up inside `result`.
let lastToolCallError = null

// Counts tool calls issued during the current agent.run() attempt (reset alongside
// lastToolCallError in runResilient). Needed to catch a second failure shape: the model
// answers with no tool call at all — just narration of what it's about to do (e.g. "Let's
// proceed with the conversion") — which agent.js treats as a valid final answer (see its
// `if (!message.tool_calls...) return message.content`). lastToolCallError alone can't see
// this, since no tool was ever attempted, so nothing failed by that definition. Reproduced:
// asking for a UUIDv1 timestamp conversion got a narrated plan and zero tool calls, twice.
let toolCallsThisAttempt = 0

// Matches a final answer that reads as a stated intention rather than a completed result —
// "let's compute X", "next we will Y", "proceeding to Z" — with nothing after it. Heuristic,
// not exhaustive: false negatives just mean one un-retried stall; false positives cost one
// bounded extra attempt. Anchored near the end of the string since these phrases legitimately
// appear mid-explanation too.
const UNFINISHED_PLAN_RE = /\b(let'?s|let us|we will|we'll|i will|i'll|now,? (?:let|i)|next,? we|proceeding to)\b[^.!?]*[.!?]?\s*$/i

function looksLikeUnfinishedPlan(content) {
  return typeof content === 'string' && content.trim().length > 0 && UNFINISHED_PLAN_RE.test(content.trim())
}

const agent = createAgent({
  model: MODEL,
  temperature: 0.3,
  // qwen3 thinks by default: it burned 437 hidden reasoning tokens on "what is
  // 2+2" alone. On this machine (CPU-only, no GPU, ~3.5 tok/s) that took 2m12s;
  // with thinking off the same question took 3.8s. Tool-call reliability comes
  // from the model's training, not from thinking, so this is off by default.
  think: false,
  systemPrompt,
  tools: [readFileTool, runShellCommandTool],
  workdir: process.cwd(),
  onToolCall: ({ error, result }) => {
    toolCallsThisAttempt++
    const resultFailed = result && typeof result === 'object' && result.success === false
    lastToolCallError = error ?? (resultFailed ? new Error(result.error || 'Tool reported failure') : null)
  },
})

// The library's run loop stops the instant a model response has no tool_calls — nothing
// forces it to keep trying after a failed tool call, so a model can "give up" mid-task
// and hand back a narrated plan instead of a real answer (confirmed: asking "what java
// version do i have" produced a wrong registry-lookup tool call, then a plain-text "let's
// try a different approach" as the final answer, with no further tool call). This wrapper
// detects that pattern via lastToolCallError and nudges the model to actually retry.
//
// maxAttempts bounds worst-case latency on this slow (CPU-only) machine — but note each
// attempt can itself cost up to `maxTurns` model round-trips, so worst case is roughly
// maxAttempts * maxTurns model calls, not maxAttempts * one call.
async function runResilient(prompt, history, maxAttempts = 3) {
  let answer
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastToolCallError = null
    toolCallsThisAttempt = 0
    try {
      answer = attempt === 1 ? await agent.run(prompt, { messages: history }) : await agent.run(history)
    } catch (err) {
      if (!(err instanceof MaxTurnsError)) throw err
      lastToolCallError = err // exhausted its turn budget while still failing; treat like an unresolved error
    }

    const stalledOnPlan = toolCallsThisAttempt === 0 && looksLikeUnfinishedPlan(answer)
    if (!lastToolCallError && !stalledOnPlan) return answer // success, or no tool was needed at all

    if (attempt === maxAttempts) {
      console.log(`(gave up after ${stalledOnPlan ? 'an unexecuted plan' : 'a tool error'} on attempt ${attempt}/${maxAttempts} — returning the model's last answer as-is)`)
      return answer ?? "I couldn't complete this after retrying — the last attempt failed without producing an answer."
    }

    const nudge = stalledOnPlan
      ? 'You described a plan but issued no tool call. Do not narrate further — actually issue a tool call now (e.g. run_shell_command) that computes or performs it.'
      : 'That failed. Do not just describe what you plan to try next — actually issue another tool call with a different, more direct approach.'
    console.log(`(${stalledOnPlan ? 'the model stated a plan without calling a tool' : 'a tool call failed and the model stopped without retrying'} — nudging it to try again: attempt ${attempt + 1}/${maxAttempts})`)
    history.push({ role: 'user', content: nudge })
  }
  return answer
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, 'utf8'))
  } catch {
    return []
  }
}

async function saveHistory(history) {
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2))
}

async function main() {
  const prompt = process.argv.slice(2).join(' ')
  if (!prompt) {
    console.error('Usage: npm run chat -- "your message"')
    process.exit(1)
  }

  const history = await loadHistory()
  console.log('User:', prompt)

  const startedAt = Date.now()
  const answer = await runResilient(prompt, history)
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)

  console.log('Agent:', answer)
  console.log(`Execution time: ${elapsedSeconds}s`)

  await saveHistory(history)
  console.log(`\n(history saved to ${HISTORY_FILE} — run again to continue this conversation)`)
}

main().catch((err) => {
  console.error('\nError:', err.message)
  console.error('Is `ollama serve` running, and is the model pulled? Try: ollama pull ' + MODEL)
  process.exit(1)
})
