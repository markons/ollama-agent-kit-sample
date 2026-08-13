# ollama-agent-kit — Persistent Conversations Sample

A sample **Node** app built on [ollama-agent-kit](https://github.com/niceunderground/ollama-agent-kit),
demonstrating its **persistent conversations** feature: pass the same `messages`
array into `agent.run()` across multiple calls and the agent remembers prior turns.
It grew, through real testing against local Ollama models, into a small case study
of what it takes to make a local-LLM tool-calling agent actually reliable.

## Architecture

Two independent scripts, both built on the same library primitive
(`createAgent()` + `agent.run()`); neither depends on the other.

```
src/index.js              — walks through the three "persistent conversations"
                             patterns from the library's own docs, back to back,
                             in a single process. Nothing is saved between runs.

src/persist-to-disk.js    — a real CLI chat tool. Each invocation is a separate
                             OS process, so conversation memory is persisted to
                             history.json on disk instead of just an in-memory
                             array, and it grants a shell-execution tool so the
                             agent can decide *how* to answer things itself.
```

`src/persist-to-disk.js`'s request flow:

```
npm run chat -- "your message"
        │
        ▼
loadHistory()  ◀── history.json (previous conversation, if any)
        │
        ▼
runResilient(prompt, history)                 ┐
        │  attempt 1:                         │
        │  agent.run(prompt, {messages:hist}) │  up to 3 attempts —
        │        │                            │  see "Retry on
        │        ▼                            │  abandoned tool
        │  Ollama (qwen3:8b) ──tool call──▶ read_file /            │  failures" below
        │        │              run_shell_command                 │
        │        ◀────────── tool result ─────┘                   │
        │        │                                                │
        │        ▼                                                │
        │  final answer  OR  narration with no tool call ─────────┘
        │        (if the latter: nudge appended to history, retry)
        ▼
answer + elapsed time printed
        │
        ▼
saveHistory()  ──▶ history.json (so the next invocation remembers this one)
```

## Install

1. Install [Ollama](https://ollama.com) and start it:
   
   ```
   ollama serve
   ```
2. Pull the models the two scripts use:
   
   ```
   ollama pull llama3.2
   ollama pull qwen3:8b
   ```
   
   (Override either script's model at runtime with `OLLAMA_MODEL=<name>` — see
   "Design decisions" below for why they default to different models.)

   No access to `registry.ollama.ai` (e.g. a locked-down corporate network
   that only allows `github.com`)? Install `qwen3:8b` from this repo's
   [offline install bundle](../../releases/tag/qwen3-8b-offline) instead —
   same weights, split into GitHub-Release-sized parts with a ready-made
   `Modelfile`.
3. Optional — `nomic-embed-text`, an embedding model (not currently used by
   either script, pulled here for future embedding-based work):

   ```
   ollama pull nomic-embed-text
   ```

   Same offline path applies: [offline install bundle](../../releases/tag/nomic-embed-text-offline)
   — a single ~274MB `.gguf` (under GitHub's 2GB-per-asset limit, so no
   splitting needed) plus a ready-made `Modelfile`.
4. Install dependencies:
   
   ```
   npm install
   ```

## Usage

### `npm start` — `src/index.js`, the three doc patterns in one script

1. **Single task** — `agent.run(prompt)` with no `messages`, so nothing is
   remembered between calls.
2. **Persistent conversation** — a shared `history` array is passed as
   `{ messages: history }` on every call; the agent recalls its own previous
   answer (e.g. "bump it to the next minor" only makes sense because it
   remembers the version from the prior turn).
3. **Manual array management** — same idea, but you push a message onto
   `history` yourself and pass the array directly as `agent.run(history)`.

### `npm run chat -- "message"` — `src/persist-to-disk.js`, a real CLI chat

```
npm run chat -- "Read package.json and tell me the version"
npm run chat -- "Now bump it to the next minor"
```

Each invocation loads `history.json` (created on first run), passes it to
`agent.run()`, and writes it back — so conversation memory survives across
separate process invocations, not just within one script. It also has
`run_shell_command` (real shell execution — scoped to start in the project
folder, but not sandboxed beyond that: a command can still `cd ..` or use an
absolute path), so it can act on requests `read_file` alone can't answer, and
it prints how long the whole exchange took.

## Design decisions

These came out of actually testing the app against local models, not
up-front guesses — see the test log below for the failures that motivated
each one.

- **`think: false`** — `qwen3:8b` has hidden chain-of-thought reasoning on by
  default, which is expensive on CPU-only hardware (verified: 437 reasoning
  tokens for "what is 2+2" alone, 166s+ here). Disabling it was confirmed to
  cost nothing in tool-call correctness while cutting latency 3.75–7x.
- **`temperature: 0.3`** — lower than the library default (`0.8`), for more
  consistent tool-command choices run to run.
- **A Windows-specific system prompt** — `run_shell_command` actually
  executes through `cmd.exe`, not PowerShell and not a Unix shell; Unix-style
  commands only work if they happen to be on `PATH` (confirmed: `ls`/`awk`
  worked only because Git for Windows put them there, not because they're
  native). The prompt also corrects a specific, verified wrong-answer trap:
  `dir`'s "bytes free" summary line is the *drive's* free space, not a
  folder's size — and gives a working PowerShell one-liner for the real
  thing.
- **`qwen3:8b` over `llama3.2`** for this script, despite being far slower —
  `llama3.2` was tested and unreliably fakes a tool call by writing JSON as
  plain text instead of issuing a real one; `qwen3` is trained for tool
  calling and didn't do this in testing. `src/index.js`'s simpler,
  single-file-read tasks don't need this, so it stays on the faster
  `llama3.2`.
- **Retry on abandoned tool failures** — the library's run loop stops the
  instant a model response has no tool call (confirmed by reading
  `agent.js`); nothing forces the model to keep trying after a failed one, so
  it can hand back a narrated plan instead of a real answer. `runResilient()`
  in `persist-to-disk.js` tracks tool-call failures (via `onToolCall`'s
  `error` field *and* `run_shell_command`'s in-band `{ success: false }`
  result shape — it never throws, even on failure, so `error` alone misses
  it) and, if the model stops without resolving one, appends a corrective
  nudge to `history` and retries, up to 3 attempts, before giving up
  gracefully. No retry fires on the common path (success, or no tool needed).

## Test log

Everything below was actually run against local models on this machine, not
hypothesized. Kept as a record of what broke, why, and what fixed it.

| #   | Tried                                                                       | Result                                                                                                                                           | Root cause                                                                                                                                                                              | Fix                                                                                  |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | "tell me the size of the current directory" (only `readFileTool` available) | Model wrote a fake `{"name": "exec", ...}` tool call as plain text instead of a real one                                                         | No tool existed for this; the model hallucinated one instead of saying so                                                                                                               | Added `runShellCommandTool`                                                          |
| 2   | Same question again                                                         | `ls -l \| awk` — worked, real tool call                                                                                                          | —                                                                                                                                                                                       | —                                                                                    |
| 3   | Same question, different run                                                | `ls -lh \| awk` — human-readable sizes (`1.8K`, `47K`...) couldn't be summed; model replied "Failed to retrieve directory size"                  | Non-numeric units defeat arithmetic                                                                                                                                                     | System prompt: prefer raw-byte output for arithmetic; `temperature` lowered to `0.3` |
| 4   | Same question, different run                                                | `dir /ad /w` → answered "81,438,982,144 bytes" — wrong by ~17,000x                                                                               | Misread `dir`'s "N Dir(s) X bytes free" (drive free space) as folder size; cmd.exe has no recursive-size command at all                                                                 | System prompt explicitly names this trap and gives a working PowerShell one-liner    |
| 5   | Same question, different run                                                | Model echoed that exact PowerShell command back as fake JSON text, never actually called it                                                      | `llama3.2` capability ceiling for structured tool calling                                                                                                                               | Switched `persist-to-disk.js`'s default model to `qwen3:8b`                          |
| 6   | Same question with `qwen3:8b`                                               | Correct real tool call, correct answer (4,943,611 bytes) — but took 271.63s                                                                      | `qwen3:8b` thinks by default; CPU-only inference                                                                                                                                        | (led to next finding)                                                                |
| 7   | Isolated test: `ollama run qwen3:8b "what is 2+2"`                          | 437 hidden reasoning tokens, 131.9s, for a trivial question                                                                                      | Thinking mode on by default, ~3.5 tok/s on this CPU-only machine                                                                                                                        | `think: false`                                                                       |
| 8   | Re-ran #6 and #7 with thinking off                                          | 2+2: 3.8s (was 131.9s). Directory size: 72.24s (was 271.63s), still correct                                                                      | —                                                                                                                                                                                       | Confirmed no correctness loss from disabling thinking                                |
| 9   | "what java version do i have on this windows pc?"                           | Wrong registry-key guess failed; model then narrated "let's try a different approach" as its final answer, without retrying                      | Library's run loop stops the instant a response has no tool call; nothing forces continuation after a failure                                                                           | Added `runResilient()` retry wrapper (tracks `onToolCall`'s `error` field)           |
| 10  | Re-ran #9                                                                   | `java -version` on the first attempt — correct (`OpenJDK 21.0.11`)                                                                               | —                                                                                                                                                                                       | —                                                                                    |
| 11  | "can you copy the smallest file in this directory to c:/temp?"              | `Sort-Object -Ascending` (invalid flag) failed; model narrated a corrected command instead of running it — **and the retry wrapper never fired** | `runShellCommandTool` never throws on a failed command (confirmed by reading its source) — it resolves normally as `{ success: false, ... }`, invisible to `onToolCall`'s `error` field | Broadened failure detection to also check `result.success === false`                 |
| 12  | Re-ran #11                                                                  | Model retried with corrected syntax *within the same run* and copied the file — verified the file actually landed in `C:\temp`                   | —                                                                                                                                                                                       | Confirmed fix closes the gap                                                         |

**One honest caveat**: row 4's fix (hand-writing the correct PowerShell
command into the system prompt) made that specific question reliable, but it
was really the model following a hint, not proving it could derive the
approach unaided. Row 9 (no hints given) was a truer test of that, and it
initially failed — which is what motivated the general retry mechanism
(rows 9–12) instead of continuing to hand-feed answers for each new
question.

## Notes

- Both scripts use the bundled `readFileTool` and read relative to the
  project's own `package.json`, so nothing external is required for `npm
  start`.
- `history.json` is git-ignored — it's local, generated conversation state.
