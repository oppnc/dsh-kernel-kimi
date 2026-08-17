import assert from 'node:assert/strict'
import path from 'node:path'
import * as pluginMod from '../lib/index.js'

let assertionCount = 0
function ok(value, message) {
  assertionCount += 1
  assert.ok(value, message)
}
function eq(actual, expected, message) {
  assertionCount += 1
  assert.equal(actual, expected, message)
}
function match(actual, re, message) {
  assertionCount += 1
  assert.match(String(actual), re, message)
}
function deep(actual, expected, message) {
  assertionCount += 1
  assert.deepEqual(actual, expected, message)
}

function keyOf(target) {
  if (typeof target === 'string') return path.normalize(target)
  if (target && typeof target.path === 'string') return path.normalize(target.path)
  return String(target)
}

function makeTarget(p) {
  const n = path.normalize(p)
  return { path: n, displayPath: n, targetKey: n }
}

function createHarness() {
  const workspaceRoot = '/workspace'
  const files = new Map()
  const registered = new Map()
  const sections = []
  const calls = {
    startContinuable: [],
    start: [],
    followup: [],
    interrupt: [],
    listChildren: [],
    list: [],
    writeText: [],
    editText: [],
    spawn: [],
    jobsStart: [],
    jobsRead: [],
    jobsKill: [],
  }

  const fs = {
    async resolve(p, opts) {
      const cwd = (opts && opts.cwd) || workspaceRoot
      const raw = String(p)
      if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return makeTarget(raw)
      return makeTarget(path.join(cwd, raw))
    },
    async readText(target) {
      const key = keyOf(target)
      if (!files.has(key)) {
        const err = new Error('FS_NOT_FOUND: ' + key)
        err.code = 'FS_NOT_FOUND'
        throw err
      }
      return files.get(key).text
    },
    async writeText(target, content) {
      const key = keyOf(target)
      const prev = files.get(key)
      files.set(key, { text: String(content), version: (prev ? prev.version : 0) + 1, type: 'file' })
      calls.writeText.push({ path: key, content: String(content) })
    },
    async editText(target, edit) {
      const key = keyOf(target)
      if (!files.has(key)) {
        const err = new Error('FS_NOT_FOUND: ' + key)
        err.code = 'FS_NOT_FOUND'
        throw err
      }
      const cur = files.get(key)
      const oldString = edit.oldString
      const newString = edit.newString
      let next
      if (edit.replaceAll) next = cur.text.split(oldString).join(newString)
      else {
        const idx = cur.text.indexOf(oldString)
        if (idx < 0) throw new Error('oldString not found in ' + key)
        next = cur.text.slice(0, idx) + newString + cur.text.slice(idx + oldString.length)
      }
      files.set(key, { text: next, version: cur.version + 1, type: 'file' })
      calls.editText.push({ path: key, edit })
    },
    async stat(target) {
      const key = keyOf(target)
      if (!files.has(key)) return null
      const rec = files.get(key)
      return { type: rec.type || 'file', size: Buffer.byteLength(rec.text || ''), version: rec.version }
    },
    async listDir(target) {
      const dir = keyOf(target).replace(/[\\/]+$/, '')
      const kids = new Map()
      for (const [p, rec] of files) {
        if (p === dir) continue
        const prefix = dir + path.sep
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const name = rest.split(/[\\/]/)[0]
        if (!name || kids.has(name)) continue
        const childPath = path.join(dir, name)
        const isDir = rest.includes(path.sep) || rec.type === 'directory'
        kids.set(name, {
          name,
          type: isDir ? 'directory' : 'file',
          target: makeTarget(childPath),
        })
      }
      return Array.from(kids.values())
    },
    async readBytes(target) {
      const text = await fs.readText(target)
      return Buffer.from(text)
    },
    processPath(target) { return keyOf(target) },
    contains() { return true },
  }

  const tools = {
    register(def) {
      if (!def || !def.name) throw new Error('tool missing name')
      if (registered.has(def.name)) throw new Error('already registered: ' + def.name)
      registered.set(def.name, def)
    },
    get(name) { return registered.get(name) },
  }

  const subagents = {
    list() {
      calls.list.push(true)
      return ['kimi-agent', 'kimi-explore', 'kimi-plan', 'spawn']
    },
    async startContinuable(req) {
      calls.startContinuable.push(req)
      return { childId: 'kimi-child-1' }
    },
    async start(provider, request) {
      calls.start.push({ provider, request })
      return {
        result: Promise.resolve({
          stopReason: 'max-tokens',
          output: [{ type: 'text', text: 'kimi partial answer' }],
        }),
        async dispose() {},
      }
    },
    async followup(agent, childId, blocks, opts) {
      calls.followup.push({ agent, childId, blocks, opts })
      return 'kimi-msg-1'
    },
    interrupt(agentId, info) { calls.interrupt.push({ agentId, info }) },
    async listChildren(parentId, signal) {
      calls.listChildren.push({ parentId, signal })
      return [{ id: 'kimi-child-1', label: 'demo', mode: 'continuable' }]
    },
  }

  const jobsStore = new Map()
  let jobSeq = 0
  const jobs = {
    start(spec) {
      const id = 'job-' + (++jobSeq)
      const handle = spec.run()
      jobsStore.set(id, { id, status: 'running', label: spec.label, handle })
      calls.jobsStart.push({ id, spec })
      return id
    },
    list() { return Array.from(jobsStore.values()).map((j) => ({ id: j.id, status: j.status, label: j.label })) },
    async read(id) {
      calls.jobsRead.push(id)
      const j = jobsStore.get(id)
      if (!j) throw new Error('job not found: ' + id)
      const text = j.handle && typeof j.handle.readOutput === 'function' ? j.handle.readOutput() : ''
      return { text, snapshot: { status: j.status, detail: '' } }
    },
    async wait() {},
    kill(id, agent, reason) {
      calls.jobsKill.push({ id, reason })
      const j = jobsStore.get(id)
      if (!j) throw new Error('job not found: ' + id)
      j.status = 'killed'
      if (j.handle && j.handle.cancel) j.handle.cancel(reason)
      return 'killed'
    },
  }

  const subprocess = {
    async resolveExecutable(name) { return '/mock/' + name },
    spawn(opts) {
      calls.spawn.push(opts)
      const stdout = { text: 'shell-ok\n', readFrom(off) { return { text: this.text.slice(off), nextOffset: this.text.length } } }
      const stderr = { text: '', readFrom(off) { return { text: this.text.slice(off), nextOffset: this.text.length } } }
      return {
        collected: { stdout, stderr },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    },
  }

  const services = {
    fs,
    tools,
    subprocess,
    web: {
      async search() { return { results: [] } },
      async fetch() { return { body: { content: '' } } },
    },
    jobs,
    planMode: { set() { return 'ok' } },
    subagents,
    sandboxPolicy: {
      workspaceRoot,
      resolve() { return { mode: 'danger-full-access', workspaceRoot } },
    },
    attachments: { async saveImage() { return { id: 'att-1' } } },
    userQuestions: { async ask() { return { answers: [] } } },
    systemPrompt: { section(s) { sections.push(s) } },
  }

  return {
    ctx: { get(name) { return services[name] } },
    registered,
    sections,
    calls,
    files,
    workspaceRoot,
    seed(rel, text) {
      const p = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel)
      files.set(path.normalize(p), { text, version: 1, type: 'file' })
      return path.normalize(p)
    },
    readSeed(rel) {
      const p = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel)
      const rec = files.get(path.normalize(p))
      return rec ? rec.text : undefined
    },
  }
}

const EXPECTED_TOOLS = [
  'ReadFile', 'WriteFile', 'StrReplaceFile', 'Glob', 'Grep', 'Shell',
  'ReadMediaFile', 'SearchWeb', 'FetchURL', 'TaskList', 'TaskOutput', 'TaskStop',
  'SetTodoList', 'AskUserQuestion', 'Agent', 'ExitPlanMode', 'EnterPlanMode',
]

async function main() {
  const plugin = pluginMod
  ok(plugin, 'plugin module loads')
  eq(plugin.name, 'dsh-kernel-kimi', 'plugin.name')
  ok(typeof plugin.apply === 'function', 'plugin.apply is a function')
  ok(Array.isArray(plugin.inject), 'plugin.inject is metadata')

  const h = createHarness()
  await plugin.apply(h.ctx)

  for (const name of EXPECTED_TOOLS) {
    ok(h.registered.has(name), 'registers ' + name)
  }
  eq(h.registered.size, EXPECTED_TOOLS.length, 'expected tool count')

  for (const [name, def] of h.registered) {
    ok(def.output && typeof def.output === 'object', name + ' has output')
    ok(def.output.schema, name + ' has output.schema')
    ok(typeof def.output.render === 'function', name + ' has output.render')
    const rendered = def.output.render({}, 'ok')
    ok(Array.isArray(rendered), name + ' render returns blocks')
  }

  const exec = { agent: { id: 'parent-session' }, signal: new AbortController().signal }
  const Agent = h.registered.get('Agent')
  ok(typeof Agent.isConcurrencySafe === 'function', 'Agent.isConcurrencySafe is a function')
  eq(Agent.isConcurrencySafe(), true, 'Agent.isConcurrencySafe() === true')

  const bg = await Agent.execute({
    description: 'smoke child',
    prompt: 'do the work',
  }, exec)
  eq(h.calls.startContinuable.length, 1, 'default background calls startContinuable once')
  eq(h.calls.start.length, 0, 'default background does not call start')
  const started = h.calls.startContinuable[0]
  ok(started && started.request, 'startContinuable receives a request')
  deep(started.request.agentOptions, { provider: 'kimi-kernel', model: 'k3-256k' }, 'explicit agentOptions')
  ok(typeof started.request.persona === 'string' && started.request.persona.length > 0, 'request.persona set')
  ok(started.request.toolFilter && Array.isArray(started.request.toolFilter.allow), 'request.toolFilter set')
  eq(started.request.maxDepth, 3, 'request.maxDepth is 3')
  match(bg, /kimi-child-1/, 'background return text contains durable child id')

  const resumed = await Agent.execute({
    description: 'resume',
    prompt: 'continue please',
    resume: 'kimi-child-1',
  }, exec)
  eq(h.calls.followup.length, 1, 'resume path calls subagents.followup')
  eq(h.calls.followup[0].childId, 'kimi-child-1', 'followup child id')
  eq(h.calls.followup[0].blocks[0].text, 'continue please', 'followup prompt text')
  match(resumed, /kimi-msg-1/, 'resume text mentions message id')

  const fg = await Agent.execute({
    description: 'wait',
    prompt: 'finish this',
    run_in_background: false,
  }, exec)
  eq(h.calls.start.length, 1, 'foreground calls subagents.start')
  match(fg, /Partial output before the run ended:/, 'foreground max-tokens includes partial-output wording')
  match(fg, /kimi partial answer/, 'foreground includes partial child text')

  eq(h.sections.length, 1, 'systemPrompt.section registered once')
  eq(h.sections[0].name, 'tool:Agent', 'systemPrompt section name')
  eq(h.sections[0].order, 116.5, 'systemPrompt section order')
  ok(typeof h.sections[0].text === 'function', 'systemPrompt section text is a function')

  h.seed('numbered.txt', 'alpha\nbeta\ngamma\ndelta')
  const ReadFile = h.registered.get('ReadFile')
  const slice = await ReadFile.execute({ path: 'numbered.txt', line_offset: 2, n_lines: 2 }, exec)
  eq(slice, 'beta\ngamma', 'ReadFile returns a raw line slice (no line-number prefix)')
  const head = await ReadFile.execute({ path: 'numbered.txt', n_lines: 1 }, exec)
  eq(head, 'alpha', 'ReadFile default offset is the first line')

  const WriteFile = h.registered.get('WriteFile')
  const written = await WriteFile.execute({ path: 'out.txt', content: 'hello-kimi' }, exec)
  match(written, /overwritten/, 'WriteFile overwrite confirmation')
  eq(h.readSeed('out.txt'), 'hello-kimi', 'WriteFile persisted via mock fs.writeText')
  const reread = await ReadFile.execute({ path: 'out.txt' }, exec)
  eq(reread, 'hello-kimi', 'ReadFile sees WriteFile content')

  const Shell = h.registered.get('Shell')
  const sh = await Shell.execute({ command: 'echo hi' }, exec)
  eq(h.calls.spawn.length, 1, 'Shell foreground uses subprocess.spawn')
  match(sh, /\[exit code: 0\]/, 'Shell reports exit code')

  const { formatKimiSearchResults, htmlToText } = plugin._test
  eq(formatKimiSearchResults([]), '(no results)', 'empty kimi search')
  match(formatKimiSearchResults([{ title: 'T', url: 'https://ex', snippet: 'S', date: '2026' }]), /Title: T/, 'kimi search title')
  match(formatKimiSearchResults([{ title: 'T', url: 'https://ex', snippet: 'S', date: '2026' }]), /URL: https:\/\/ex/, 'kimi search url')
  eq(htmlToText('<html><script>x</script><p>Hello&nbsp;world</p></html>'), 'Hello world', 'htmlToText strips tags')

  console.log('dsh-kernel-kimi smoke: ' + assertionCount + ' assertions ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
