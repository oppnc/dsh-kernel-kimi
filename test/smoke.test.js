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
  let suppressed = false
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
    systemPrompt: { section(s) { sections.push(s) }, suppressRuntimeContext() { suppressed = true } },
  }

  return {
    ctx: { get(name) { return services[name] } },
    registered,
    sections,
    get suppressed() { return suppressed },
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

// The full 0.39.1 default-on surface (26 upstream wire tools) + WebSearch
// (upstream gates WebSearch on a configured search provider; the DSH form has
// a web-service fallback, so it registers unconditionally — see AGENTS.md).
const EXPECTED_TOOLS = [
  'Agent', 'AgentSwarm', 'AskUserQuestion', 'Bash', 'CreateGoal', 'CronCreate',
  'CronDelete', 'CronList', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'FetchURL',
  'GetGoal', 'Glob', 'Grep', 'Read', 'ReadMediaFile', 'SetGoalBudget', 'Skill',
  'TaskList', 'TaskOutput', 'TaskStop', 'TodoList', 'UpdateGoal', 'WaitFor',
  'WebSearch', 'Write',
]
// Renamed-away 1.49 names must NOT be present.
const REMOVED_TOOLS = ['ReadFile', 'WriteFile', 'StrReplaceFile', 'Shell', 'SearchWeb', 'SetTodoList']

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
  for (const name of REMOVED_TOOLS) {
    ok(!h.registered.has(name), 'does NOT register removed 1.49 tool ' + name)
  }

  // Every description and parameter schema is verbatim upstream 0.39.1
  // (generated surface module), except ReadMediaFile's capabilities paragraph.
  const { UPSTREAM_SURFACE } = plugin._test
  for (const [name, def] of h.registered) {
    const s = UPSTREAM_SURFACE[name]
    ok(s, name + ' has an upstream surface record')
    if (name === 'ReadMediaFile') {
      match(def.description, /DSH form supports image files only/, 'ReadMediaFile description carries the DSH capabilities note')
      ok(def.description.startsWith(s.description.split('**Capabilities**')[0].trim().slice(0, 40)), 'ReadMediaFile description prefix matches upstream')
    } else {
      eq(def.description, s.description, name + ' description is verbatim upstream')
    }
    deep(def.parameters, s.parameters, name + ' parameters are verbatim upstream')
  }

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
  ok(!('toolFilter' in started.request), 'request.toolFilter deliberately unset '
    + '(dsh-tools 0.1.1-rc.2 restrict() rejects scope-local names; the mesh agent/created '
    + 'listener applies the child mask)')
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

  eq(h.sections.length, 2, 'systemPrompt registers persona + tool section')
  eq(h.sections[0].name, 'deployment:persona', 'persona section name')
  eq(h.sections[0].order, 0, 'persona section order')
  eq(h.sections[0].complete, true, 'persona section is complete')
  ok(typeof h.sections[0].text === 'string', 'persona text is a string')
  eq(h.sections[1].name, 'tool:Agent', 'tool section name')
  eq(h.sections[1].order, 116.5, 'tool section order')
  ok(typeof h.sections[1].text === 'function', 'tool section text is a function')
  ok(h.suppressed, 'runtime context suppressed')

  h.seed('numbered.txt', 'alpha\nbeta\ngamma\ndelta')
  const Read = h.registered.get('Read')
  const slice = await Read.execute({ path: 'numbered.txt', line_offset: 2, n_lines: 2 }, exec)
  eq(slice, 'beta\ngamma', 'Read returns a raw line slice (no line-number prefix)')
  const head = await Read.execute({ path: 'numbered.txt', n_lines: 1 }, exec)
  eq(head, 'alpha', 'Read default offset is the first line')

  const Write = h.registered.get('Write')
  const written = await Write.execute({ path: 'out.txt', content: 'hello-kimi' }, exec)
  match(written, /overwritten/, 'Write overwrite confirmation')
  eq(h.readSeed('out.txt'), 'hello-kimi', 'Write persisted via mock fs.writeText')
  const reread = await Read.execute({ path: 'out.txt' }, exec)
  eq(reread, 'hello-kimi', 'Read sees Write content')

  const Edit = h.registered.get('Edit')
  const edited = await Edit.execute({ path: 'out.txt', old_string: 'kimi', new_string: 'code' }, exec)
  match(edited, /edited/, 'Edit confirmation')
  eq(h.readSeed('out.txt'), 'hello-code', 'Edit applied old_string/new_string')

  const TodoList = h.registered.get('TodoList')
  await TodoList.execute({ todos: [{ title: 'first', status: 'in_progress' }] }, exec)
  const queried = await TodoList.execute({}, exec)
  match(queried, /- \[in_progress\] first/, 'TodoList query mode returns the stored list')
  const cleared = await TodoList.execute({ todos: [] }, exec)
  match(cleared, /empty/, 'TodoList with [] clears the list')

  const Bash = h.registered.get('Bash')
  const sh = await Bash.execute({ command: 'echo hi' }, exec)
  eq(h.calls.spawn.length, 1, 'Bash foreground uses subprocess.spawn')
  match(sh, /\[exit code: 0\]/, 'Bash reports exit code')

  // WaitFor on an existing background job (harness jobs.wait resolves immediately).
  const bgsh = await Bash.execute({ command: 'sleep 1', run_in_background: true, description: 'bg' }, exec)
  match(bgsh, /Background task started: job-1/, 'Bash background returns a task id')
  const waited = await h.registered.get('WaitFor').execute({ task_id: 'job-1', timeout: 5 }, exec)
  match(waited, /job-1 settled/, 'WaitFor reports the settled task')

  // Cron tools are honest stubs (no DSH cron service).
  const cron = await h.registered.get('CronCreate').execute({ name: 'x', schedule: '* * * * *', prompt: 'p' }, exec)
  match(cron, /no cron\/scheduler service/, 'CronCreate honestly reports the missing service')
  match(await h.registered.get('CronList').execute({}, exec), /no cron\/scheduler service/, 'CronList stub')
  match(await h.registered.get('CronDelete').execute({ id: 'x' }, exec), /no cron\/scheduler service/, 'CronDelete stub')

  // Goal tools degrade honestly without a goals service (harness omits it).
  match(await h.registered.get('GetGoal').execute({}, exec), /goals service is not registered/, 'GetGoal without service')
  match(await h.registered.get('CreateGoal').execute({ objective: 'o' }, exec), /goals service is not registered/, 'CreateGoal without service')
  match(await h.registered.get('UpdateGoal').execute({ status: 'complete' }, exec), /goals service is not registered/, 'UpdateGoal without service')
  match(await h.registered.get('SetGoalBudget').execute({ value: 3, unit: 'turns' }, exec), /goals service is not registered/, 'SetGoalBudget without service')

  // Skill degrades honestly without a skills service.
  match(await h.registered.get('Skill').execute({ skill: 'x' }, exec), /skills service is not registered/, 'Skill without service')

  // AgentSwarm fan-out: one startContinuable per item with {{item}} substituted.
  const swarm = await h.registered.get('AgentSwarm').execute({
    description: 'swarm demo',
    prompt_template: 'handle {{item}} carefully',
    items: ['a.ts', 'b.ts'],
  }, exec)
  match(swarm, /2 background subagent/, 'AgentSwarm fan-out summary')
  const swarmCalls = h.calls.startContinuable.filter((c) => /\[\d\/2\]/.test(c.label))
  eq(swarmCalls.length, 2, 'AgentSwarm starts one child per item')
  eq(swarmCalls[0].request.prompt[0].text, 'handle a.ts carefully', 'AgentSwarm substitutes {{item}}')
  eq(swarmCalls[1].request.prompt[0].text, 'handle b.ts carefully', 'AgentSwarm substitutes {{item}} for each item')
  const swarmResume = await h.registered.get('AgentSwarm').execute({
    description: 'swarm resume',
    prompt_template: 'follow up on this',
    resume_agent_ids: ['kimi-child-1'],
  }, exec)
  match(swarmResume, /resumed kimi-child-1/, 'AgentSwarm resume_agent_ids fans follow-ups out')

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
