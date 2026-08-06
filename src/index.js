// Demonstrates ollama-agent-kit's "persistent conversations" feature.
//
// Prerequisites: `ollama serve` running, and a model pulled
// (e.g. `ollama pull llama3.2`). Override the model with OLLAMA_MODEL.
//
// Run: npm start

import { createAgent, readFileTool } from 'ollama-agent-kit'

const MODEL = process.env.OLLAMA_MODEL || 'llama3.2'

const agent = createAgent({
  model: MODEL,
  tools: [readFileTool],
  workdir: process.cwd(), // readFileTool reads relative to this folder
})

async function singleTaskDemo() {
  console.log('\n=== 1. Single task: no memory between runs ===')
  const answer = await agent.run('Summarize package.json in one sentence.')
  console.log('Agent:', answer)
}

async function persistentConversationDemo() {
  console.log('\n=== 2. Persistent conversation: pass the same array every time ===')
  const history = []

  console.log('User: Read package.json and tell me the version.')
  const a1 = await agent.run('Read package.json and tell me the version.', { messages: history })
  console.log('Agent:', a1)

  // The agent recalls a1's answer from `history` instead of re-reading the file.
  console.log('User: Now bump it to the next minor.')
  const a2 = await agent.run('Now bump it to the next minor.', { messages: history })
  console.log('Agent:', a2)
}

async function manualHistoryDemo() {
  console.log('\n=== 3. Equivalent: manage the array yourself, pass it as the input ===')
  const history = []
  await agent.run('Read package.json and tell me the version.', { messages: history })
  await agent.run('Now bump it to the next minor.', { messages: history })

  history.push({ role: 'user', content: 'And what dependencies does it have?' })
  const a3 = await agent.run(history)
  console.log('User: And what dependencies does it have?')
  console.log('Agent:', a3)
}

async function main() {
  await singleTaskDemo()
  await persistentConversationDemo()
  await manualHistoryDemo()
}

main().catch((err) => {
  console.error('\nError:', err.message)
  console.error('Is `ollama serve` running, and is the model pulled? Try: ollama pull ' + MODEL)
  process.exit(1)
})
