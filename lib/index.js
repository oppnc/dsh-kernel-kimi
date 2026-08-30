// dsh-kernel-kimi — "Kimi Code written in DSH form": the Kimi Code CLI 0.39.1
// (@moonshot-ai/kimi-code) tool surface registered as DSH tools with the SAME
// names, descriptions and parameter schemas, implemented directly on DSH
// services (fs/web/subprocess/jobs/attachments/userQuestions/goals/skills/
// subagents), so the surface survives toolFilter scoping. Descriptions and
// parameter schemas are VERBATIM upstream 0.39.1, generated from the live wire
// capture into lib/upstream-surface.js (never retype them by hand).
// WebSearch/FetchURL prefer the Moonshot endpoints (api.kimi.com/coding/v1/
// search|fetch) with the shared OAuth token, then fall back to a local GET.
import fsNative from 'node:fs'
import os from 'node:os'
import pathNative from 'node:path'
import { spawn } from 'node:child_process'
import { SYSTEM_PROMPT } from './system-prompt.js'
import { SUBAGENT_RECIPES } from './subagents.js'
import { UPSTREAM_SURFACE } from './upstream-surface.js'
import { ensureKernelMesh } from './ensure-mesh.js'

const KIMI_HOME = process.env.KIMI_CODE_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir()
const KIMI_SEARCH_URL = 'https://api.kimi.com/coding/v1/search'
const KIMI_FETCH_URL = 'https://api.kimi.com/coding/v1/fetch'

function curlBin() {
  return process.platform === 'win32'
    ? pathNative.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : 'curl'
}

function readTextFile(p) {
  try { return fsNative.readFileSync(p, 'utf8') } catch { return '' }
}

function kimiDeviceId() {
  const raw = readTextFile(pathNative.join(KIMI_HOME, '.kimi-code', 'device_id')).trim()
  return raw || 'dsh-kernel-kimi'
}

// X-Msh-* header set, 0.39.1 wire values (see REPORT.md §d / capture/req-*.json).
function kimiServiceHeaders(extra) {
  let deviceName = 'dsh-kernel-kimi'
  let deviceModel = process.platform === 'win32' ? 'Windows' : 'Linux'
  let osVersion = 'unknown'
  try { deviceName = os.hostname() || deviceName } catch {}
  try { deviceModel = os.type() + ' ' + os.release() + ' ' + os.arch() } catch {}
  try { osVersion = os.release() || osVersion } catch {}
  return Object.assign({
    'user-agent': 'kimi-code-cli/0.39.1 (dsh-kernel-kimi)',
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': '0.39.1',
    'X-Msh-Device-Name': deviceName,
    'X-Msh-Device-Model': deviceModel,
    'X-Msh-Os-Version': osVersion,
    'X-Msh-Device-Id': kimiDeviceId(),
  }, extra || {})
}

function loadKimiBearer() {
  try {
    const t = JSON.parse(readTextFile(pathNative.join(KIMI_HOME, '.kimi-code', 'credentials', 'kimi-code.json')))
    if (t && typeof t.access_token === 'string' && t.access_token) return t.access_token
  } catch {}
  try {
    const cfg = readTextFile(pathNative.join(KIMI_HOME, '.kimi-code', 'config.toml'))
    const m = /\[providers\.kimi-for-coding\]([\s\S]*?)(?=\r?\n\[|$)/.exec(cfg)
    const km = m && /api_key\s*=\s*"([^"]+)"/.exec(m[1])
    if (km && km[1]) return km[1]
  } catch {}
  return ''
}

function curlRequest(opts) {
  const argv = [curlBin(), '-sS', '-m', String(opts.timeoutSec || 90)]
  if (opts.method && opts.method !== 'GET') argv.push('-X', opts.method)
  for (const key of Object.keys(opts.headers || {})) argv.push('-H', key + ': ' + opts.headers[key])
  if (opts.body != null) argv.push('--data-binary', '@-')
  argv.push(opts.url)
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let aborted = false
    const onAbort = () => { aborted = true; try { child.kill() } catch {} }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.stdin.on('error', () => {})
    child.on('error', (e) => reject(new Error('curl spawn failed: ' + String(e))))
    child.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      const body = Buffer.concat(out).toString('utf8')
      if (aborted) { reject(new Error('aborted')); return }
      if (code !== 0) { reject(new Error('curl exit ' + code + ': ' + Buffer.concat(err).toString('utf8').slice(0, 300))); return }
      resolve(body)
    })
    if (opts.body != null) child.stdin.write(opts.body)
    child.stdin.end()
  })
}

function formatKimiSearchResults(results) {
  const rows = Array.isArray(results) ? results : []
  if (rows.length === 0) return '(no results)'
  let out = ''
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    if (i > 0) out += '---\n\n'
    out += 'Title: ' + (r.title || '') + '\nDate: ' + (r.date || '') + '\nURL: ' + (r.url || '') + '\nSummary: ' + (r.snippet || '') + '\n\n'
    if (r.content) out += r.content + '\n\n'
  }
  return out.trim() || '(no results)'
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

async function kimiSearchNative(query, signal) {
  const key = loadKimiBearer()
  if (!key) return null
  const raw = await curlRequest({
    url: KIMI_SEARCH_URL,
    method: 'POST',
    timeoutSec: 180,
    signal,
    headers: kimiServiceHeaders({
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'X-Msh-Tool-Call-Id': 'dsh-search',
    }),
    body: JSON.stringify({
      text_query: query,
      limit: 5,
      enable_page_crawling: false,
      timeout_seconds: 30,
    }),
  })
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('kimi search: bad JSON') }
  return formatKimiSearchResults(parsed && parsed.search_results)
}

async function kimiFetchNative(url, signal) {
  const key = loadKimiBearer()
  if (key) {
    try {
      const raw = await curlRequest({
        url: KIMI_FETCH_URL,
        method: 'POST',
        timeoutSec: 180,
        signal,
        headers: kimiServiceHeaders({
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          accept: 'text/markdown',
          'X-Msh-Tool-Call-Id': 'dsh-fetch',
        }),
        body: JSON.stringify({ url }),
      })
      if (raw && raw.trim()) return raw
    } catch {}
  }
  const raw = await curlRequest({
    url,
    method: 'GET',
    timeoutSec: 180,
    signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    },
  })
  const trimmed = String(raw || '').trim()
  if (!trimmed) return '(empty body)'
  if (/^\s*</.test(trimmed)) {
    const text = htmlToText(trimmed)
    return text ? text.slice(0, 20000) : '(empty body)'
  }
  return trimmed.slice(0, 20000)
}

function globFragment(p) {
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += 1; if (p[i + 1] === '/') i += 1 } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end > i) {
        const opts = p.slice(i + 1, end).split(',').map((o) => globFragment(o))
        re += '(' + opts.join('|') + ')'
        i = end
      } else re += '\\{'
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

function globToRegex(pattern) {
  const p = String(pattern).replace(/\\/g, '/')
  try { return new RegExp('^' + globFragment(p) + '$') } catch { return null }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return 'subagent run ended abnormally (' + String(result.stopReason) + ')'
  }
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 * Wording matches the stock `subagent` tool.
 */
function withPartialText(error, output) {
  const blocks = Array.isArray(output) ? output : []
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
  return text.length === 0 ? error : error + '\n\nPartial output before the run ended:\n' + text
}

function textOf(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

const name = 'dsh-kernel-kimi'
const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']

async function apply(ctx, config = {}) {
  await ensureKernelMesh(ctx, 'dsh-kernel-kimi')
    const fs = ctx.get('fs')
    const tools = ctx.get('tools')
    const web = ctx.get('web')
    const planMode = ctx.get('planMode')
    const subagents = ctx.get('subagents')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const subprocess = ctx.get('subprocess')
    const jobs = ctx.get('jobs')
    const attachments = ctx.get('attachments')
    const userQuestions = ctx.get('userQuestions')
    const goals = ctx.get('goals')
    const skills = ctx.get('skills')
    if (!tools || !fs) return

    // When mounted as a subagent surface, only register the tools the
    // subagent type is allowed to use (config.tools whitelist).
    const register = (t) => {
      if (config.tools && !config.tools.includes(t.name)) return
      tools.register(t)
    }

    // Upstream-verbatim description and parameter schema for one tool name.
    const surface = (toolName) => {
      const s = UPSTREAM_SURFACE[toolName]
      if (!s) throw new Error('upstream surface missing for tool ' + toolName)
      return s
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', '.venv', '__pycache__', 'dist'])
    // Upstream: include_ignored searches ignored directories too, but VCS
    // metadata (.git) is always skipped.
    const skipFor = (includeIgnored) => includeIgnored === true
      ? (n) => n === '.git'
      : (n) => SKIP_DIRS.has(n)
    const policyFor = (exec) => {
      try {
        if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
          return sandboxPolicy.resolve(exec && exec.agent && exec.agent.session ? { session: exec.agent.session } : {})
        }
      } catch {}
      return undefined
    }
    const cwdOf = (exec) => {
      const policy = policyFor(exec)
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
      try { if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string') return sandboxPolicy.workspaceRoot } catch {}
      try { return process.cwd() } catch {}
      return 'C:\\'
    }
    const strDef = (t) => {
      t.output = { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] }
      return t
    }

    // shared recursive walker over fs.listDir (listDir already returns resolved child targets).
    // A depth cap plus a visited-target set break junction/symlink cycles back to an ancestor.
    async function walk(dirTarget, rel, out, max, signal, depth, seen, skip) {
      if (out.length >= max || (depth || 0) > 64) return
      const visited = seen || new Set()
      const shouldSkip = skip || ((n) => SKIP_DIRS.has(n))
      let entries
      try { entries = await fs.listDir(dirTarget, signal) } catch { return }
      for (const e of entries || []) {
        if (out.length >= max) return
        const name = e.name
        if (shouldSkip(name)) continue
        const isDir = e.type === 'directory'
        const childRel = rel ? rel + '/' + name : name
        if (isDir) {
          const key = e.target && e.target.targetKey ? e.target.targetKey : childRel
          if (visited.has(key)) continue
          visited.add(key)
          try { await walk(e.target, childRel, out, max, signal, (depth || 0) + 1, visited, shouldSkip) } catch {}
        } else {
          out.push({ rel: childRel, target: e.target })
        }
      }
    }

    // ---- Read ----
    register(strDef({
      name: 'Read',
      description: surface('Read').description,
      parameters: surface('Read').parameters,
      execute: async (args, exec) => {
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        const raw = await fs.readText(target, exec.signal)
        const lines = raw.split(/\r?\n/)
        const off = args.line_offset || 1
        const n = Math.max(1, args.n_lines || 1000)
        const start = off > 0 ? off - 1 : Math.max(0, lines.length + off)
        if (start >= lines.length) return ''
        return lines.slice(start, start + n).join('\n')
      },
    }))

    // ---- Write ----
    register(strDef({
      name: 'Write',
      description: surface('Write').description,
      parameters: surface('Write').parameters,
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        if (args.mode === 'append') {
          // Only a genuinely absent file counts as "empty"; any other read
          // failure (binary, unreadable, too large) must not silently overwrite.
          let oldText = ''
          let exists = true
          try {
            oldText = await fs.readText(target, exec.signal)
          } catch (e) {
            const code = e && e.code ? e.code : ''
            if (code === 'FS_NOT_FOUND') { oldText = ''; exists = false } else { return 'Write append error: ' + String(e) }
          }
          // Version-guard the append so a concurrent writer between read and
          // write is detected instead of silently clobbered.
          let expected
          try {
            const info = await fs.stat(target, exec.signal)
            if (info && info.version !== undefined) expected = { kind: 'replaceIfVersion', version: info.version }
          } catch {}
          await fs.writeText(target, oldText + args.content, exists ? expected : undefined, exec.signal, policy)
        } else {
          await fs.writeText(target, args.content, undefined, exec.signal, policy)
        }
        return 'File successfully ' + (args.mode === 'append' ? 'appended to' : 'overwritten') + ': ' + args.path
      },
    }))

    // ---- Edit ----
    // 0.39.1 Edit replaces the old StrReplaceFile: a single edit per call with
    // old_string/new_string/replace_all (no edit-array param).
    register(strDef({
      name: 'Edit',
      description: surface('Edit').description,
      parameters: surface('Edit').parameters,
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        await fs.editText(target, { oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all === true }, undefined, exec.signal, policy)
        return 'File successfully edited: ' + args.path
      },
    }))

    // ---- Glob ----
    register(strDef({
      name: 'Glob',
      description: surface('Glob').description,
      parameters: surface('Glob').parameters,
      execute: async (args, exec) => {
        const re = globToRegex(args.pattern)
        if (!re) return 'Invalid glob pattern: ' + args.pattern
        const base = args.path || cwdOf(exec)
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        const shouldSkip = skipFor(args.include_ignored)
        const out = []
        const MAX = 1000
        const seen = new Set()
        async function rec(dirTarget, rel, depth) {
          if (out.length >= MAX || depth > 64) return
          const entries = await fs.listDir(dirTarget, exec.signal)
          for (const e of entries || []) {
            if (out.length >= MAX) return
            if (shouldSkip(e.name)) continue
            const isDir = e.type === 'directory'
            const childRel = rel ? rel + '/' + e.name : e.name
            if (isDir) {
              if (args.include_dirs !== false && re.test(childRel)) out.push(childRel + '/')
              const key = e.target && e.target.targetKey ? e.target.targetKey : childRel
              if (seen.has(key)) continue
              seen.add(key)
              try { await rec(e.target, childRel, depth + 1) } catch {}
            } else if (re.test(childRel)) {
              out.push(childRel)
            }
          }
        }
        try {
          await rec(root, '', 0)
        } catch (e) {
          return 'Glob error: ' + String(e)
        }
        return out.sort().join('\n') || '(no matches)'
      },
    }))

    // ---- Grep ----
    // ripgrep `type` aliases: a small honest map of the common kinds; unknown
    // kinds return an error instead of silently widening the search.
    const GREP_TYPES = {
      js: ['.js', '.jsx', '.mjs', '.cjs'],
      ts: ['.ts', '.tsx', '.mts', '.cts'],
      py: ['.py', '.pyi'],
      go: ['.go'],
      rust: ['.rs'],
      rs: ['.rs'],
      java: ['.java'],
      c: ['.c', '.h'],
      cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
      json: ['.json'],
      md: ['.md', '.markdown'],
      html: ['.html', '.htm'],
      css: ['.css'],
      sh: ['.sh', '.bash'],
      yaml: ['.yaml', '.yml'],
      toml: ['.toml'],
      xml: ['.xml'],
    }
    register(strDef({
      name: 'Grep',
      description: surface('Grep').description,
      parameters: surface('Grep').parameters,
      execute: async (args, exec) => {
        const flags = (args['-i'] === true ? 'i' : '') + (args.multiline === true ? 'ms' : '')
        let re
        try { re = new RegExp(args.pattern, flags) } catch (e) { return 'Invalid regex: ' + String(e) }
        let filter = null
        if (args.glob) {
          filter = globToRegex(args.glob)
          if (!filter) return 'Invalid glob: ' + args.glob
        }
        let typeExts = null
        if (args.type) {
          typeExts = GREP_TYPES[String(args.type).toLowerCase()]
          if (!typeExts) return 'Unknown file type: ' + args.type + ' (supported: ' + Object.keys(GREP_TYPES).sort().join(', ') + ')'
        }
        const base = args.path && args.path !== '.' ? args.path : cwdOf(exec)
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        let files
        let singleFile = false
        let rootInfo
        try { rootInfo = await fs.stat(root, exec.signal) } catch { rootInfo = null }
        if (rootInfo && rootInfo.type === 'file') {
          files = [{ rel: String(args.path), target: root }]
          singleFile = true
        } else {
          files = []
          await walk(root, '', files, 2000, exec.signal, 0, undefined, skipFor(args.include_ignored))
        }
        const lines = []
        const hits = []
        const matchedFiles = []
        let count = 0
        for (const item of files) {
          const rel = item.rel
          const baseName = rel.split('/').pop()
          const filterTarget = singleFile ? String(args.path).split(/[\\/]/).pop() : rel
          if (filter && !filter.test(filterTarget) && !filter.test(baseName)) continue
          if (typeExts && typeExts.indexOf('.' + baseName.split('.').pop().toLowerCase()) < 0 && baseName.indexOf('.') >= 0) continue
          if (typeExts && baseName.indexOf('.') < 0) continue
          let text
          try {
            const info = await fs.stat(item.target, exec.signal)
            if (info && info.size > 5 * 1024 * 1024) continue
            text = await fs.readText(item.target, exec.signal)
          } catch { continue }
          if (args.multiline === true) {
            // Multiline mode: match across the whole file; report the line
            // number of each match start.
            re.lastIndex = 0
            const fileLines = text.split(/\r?\n/)
            let m
            while ((m = re.exec(text)) !== null) {
              const before = text.slice(0, m.index)
              const lineIdx = before.split(/\r?\n/).length - 1
              count += 1
              lines.push(rel + ':' + (lineIdx + 1) + ':' + (fileLines[lineIdx] || ''))
              hits.push({ rel, idx: lineIdx, fileLines })
              if (matchedFiles.indexOf(rel) < 0) matchedFiles.push(rel)
              if (m.index === re.lastIndex) re.lastIndex += 1
            }
          } else {
            const fileLines = text.split(/\r?\n/)
            for (let i = 0; i < fileLines.length; i++) {
              re.lastIndex = 0
              if (re.test(fileLines[i])) {
                count += 1
                lines.push(rel + ':' + (i + 1) + ':' + fileLines[i])
                hits.push({ rel, idx: i, fileLines })
                if (matchedFiles.indexOf(rel) < 0) matchedFiles.push(rel)
              }
            }
          }
        }
        if (args.output_mode === 'count_matches') return 'Total matches: ' + count
        const offset = Math.max(0, args.offset || 0)
        const headLimit = args.head_limit === undefined ? 250 : Math.max(0, args.head_limit)
        const window = (arr) => {
          const sliced = arr.slice(offset)
          return headLimit === 0 ? sliced : sliced.slice(0, headLimit)
        }
        if (args.output_mode === 'content') {
          const B = args['-B'] || 0
          const A = args['-A'] || 0
          const C = args['-C'] || 0
          const before = Math.max(B, C)
          const after = Math.max(A, C)
          if (before > 0 || after > 0) {
            const out = []
            for (const h of window(hits)) {
              const start = Math.max(0, h.idx - before)
              const end = Math.min(h.fileLines.length, h.idx + after + 1)
              for (let i = start; i < end; i++) {
                out.push(h.rel + ':' + (i + 1) + (i === h.idx ? ':' : '-') + h.fileLines[i])
              }
              out.push('--')
            }
            return out.join('\n') || '(no matches)'
          }
          return window(lines).join('\n') || '(no matches)'
        }
        return window(matchedFiles).join('\n') || '(no matches)'
      },
    }))

    // ---- Bash ----
    register(strDef({
      name: 'Bash',
      description: surface('Bash').description,
      parameters: surface('Bash').parameters,
      execute: async (args, exec) => {
        if (!subprocess) return 'Error: subprocess service unavailable.'
        let cwd = cwdOf(exec)
        if (typeof args.cwd === 'string' && args.cwd) {
          cwd = (pathNative.isAbsolute(args.cwd) || /^[A-Za-z]:[\\/]/.test(args.cwd))
            ? args.cwd
            : pathNative.join(cwd, args.cwd)
        }
        const timeoutSec = args.disable_timeout === true ? 0 : (args.timeout || 60)
        let pwshBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        try { const r = await subprocess.resolveExecutable('pwsh.exe', undefined, exec.signal); if (r) pwshBin = r } catch {}
        const argv = [pwshBin, '-NoProfile', '-NonInteractive', '-Command', args.command]
        const stdioSpec = { stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 100000 } }
        if (args.run_in_background === true) {
          if (!jobs) return 'Error: jobs service unavailable.'
          if (exec.signal && exec.signal.aborted) return 'Error: aborted before start.'
          // Spawn INSIDE run(): jobs.start preflights first and only then calls
          // run(), so a preflight failure can never leak a live process tree.
          // Background spawns carry no exec.signal: only TaskStop (handle.terminate)
          // may kill them.
          let handle = null
          let cursor = 0
          let errCursor = 0
          const id = jobs.start({
            kind: 'shell',
            label: String(args.description || args.command).slice(0, 120) || 'Bash',
            owner: exec.agent,
            run: () => {
              handle = subprocess.spawn({ argv, cwd, stdio: stdioSpec, graceMs: 3000 })
              return {
                cancel: (reason) => { try { handle.terminate() } catch {} },
                done: handle.done.then(
                  (o) => ({ status: o.exitCode === 0 ? 'completed' : 'failed', detail: 'exit ' + o.exitCode }),
                  (e) => ({ status: 'failed', detail: String(e) }),
                ),
                readOutput: () => {
                  const rd = handle.collected.stdout ? handle.collected.stdout.readFrom(cursor) : { text: '', nextOffset: cursor }
                  cursor = rd.nextOffset
                  const er = handle.collected.stderr ? handle.collected.stderr.readFrom(errCursor) : { text: '', nextOffset: errCursor }
                  errCursor = er.nextOffset
                  return rd.text + (er.text ? '\n[stderr]\n' + er.text : '')
                },
              }
            },
          })
          return 'Background task started: ' + id
        }
        const handle = subprocess.spawn({ argv, cwd, stdio: stdioSpec, graceMs: 3000, signal: exec.signal })
        const doneSafe = handle.done.then(
          (o) => ({ ok: true, o }),
          (e) => ({ ok: false, e }),
        )
        let timer = null
        let outcome
        try {
          const racers = [doneSafe]
          if (timeoutSec > 0) {
            racers.push(new Promise((resolve) => {
              timer = setTimeout(() => {
                try { handle.terminate() } catch {}
                resolve(null)
              }, timeoutSec * 1000)
            }))
          }
          outcome = await Promise.race(racers)
        } finally {
          if (timer) clearTimeout(timer)
        }
        if (outcome === null) {
          // Terminate escalates asynchronously (grace → force); wait briefly (or
          // until the turn aborts) so collected output is complete.
          const grace = new Promise((resolve) => {
            const t = setTimeout(resolve, 4000)
            if (exec.signal) exec.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
          })
          await Promise.race([handle.done.catch(() => {}), grace])
        }
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        if (outcome === null) {
          return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[timed out after ' + timeoutSec + 's]'
        }
        if (!outcome.ok) {
          return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[spawn failed: ' + String(outcome.e) + ']'
        }
        return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[exit code: ' + outcome.o.exitCode + ']'
      },
    }))

    // ---- ReadMediaFile via attachments ----
    // Upstream `region` crops and `full_resolution` disables downscaling; the
    // DSH attachments service has no crop pipeline, so both are accepted (the
    // model may send them) but not honored — the whole image is attached and a
    // note is appended to the text output.
    register({
      name: 'ReadMediaFile',
      description: surface('ReadMediaFile').description,
      parameters: surface('ReadMediaFile').parameters,
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' }, note: { type: 'string' } }, additionalProperties: true },
        render: (a, v) => {
          const blocks = []
          if (v && v.attachment) blocks.push({ type: 'image', attachment: v.attachment })
          if (v && typeof v.note === 'string' && v.note) blocks.push({ type: 'text', text: v.note })
          if (blocks.length > 0) return blocks
          return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }]
        },
      },
      execute: async (args, exec) => {
        if (!attachments) return { ok: false, error: 'attachments service unavailable' }
        const lower = String(args.path).toLowerCase()
        const mediaType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.gif') ? 'image/gif' : ''
        if (!mediaType) return { ok: false, error: 'Unsupported media type (image only in DSH form): ' + args.path }
        try {
          const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
          const data = await fs.readBytes(target, exec.signal, 20 * 1024 * 1024)
          const ref = await attachments.saveImage({ data, mediaType, name: String(args.path).split(/[\\/]/).pop() })
          const note = (args.region !== undefined || args.full_resolution === true)
            ? '[DSH form: region/full_resolution are accepted but not honored — the whole image is attached.]'
            : undefined
          return { ok: true, attachment: ref, note }
        } catch (e) {
          return { ok: false, error: 'Failed to read media: ' + String(e) }
        }
      },
    })

    // ---- WebSearch ----
    register(strDef({
      name: 'WebSearch',
      description: surface('WebSearch').description,
      parameters: surface('WebSearch').parameters,
      execute: async (args, exec) => {
        try {
          const native = await kimiSearchNative(String(args.query || ''), exec && exec.signal)
          if (native != null) return native
        } catch (e) {
          // Fall through to ctx.web so a transient Moonshot outage still
          // returns something rather than a hard tool error.
          if (!web) return 'Search request failed: ' + String(e)
        }
        if (!web) return 'Search service is not configured. You may want to try other methods to search.'
        const res = await web.search({ query: String(args.query || ''), maxResults: 5 }, exec.signal)
        let out = ''
        for (const s of res.sources || []) {
          out += '- [' + (s.title || s.url) + '](' + s.url + ')' + (s.snippet ? '\n  ' + s.snippet : '') + '\n'
        }
        return out || '(no results)'
      },
    }))

    // ---- FetchURL ----
    register(strDef({
      name: 'FetchURL',
      description: surface('FetchURL').description,
      parameters: surface('FetchURL').parameters,
      execute: async (args, exec) => {
        try {
          return await kimiFetchNative(String(args.url || ''), exec.signal)
        } catch (e) {
          return 'FetchURL error: ' + String(e)
        }
      },
    }))

    // ---- TaskList / TaskOutput / TaskStop / WaitFor via jobs ----
    register(strDef({
      name: 'TaskList',
      description: surface('TaskList').description,
      parameters: surface('TaskList').parameters,
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        try {
          const list = await jobs.list(exec.agent)
          if (!Array.isArray(list) || list.length === 0) return '(no background tasks)'
          return list.map((j) => j.id + ' [' + (j.status || '') + '] ' + (j.label || '')).join('\n')
        } catch (e) {
          return 'TaskList error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'TaskOutput',
      description: surface('TaskOutput').description,
      parameters: surface('TaskOutput').parameters,
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        try {
          // 0.39.1 removed block/timeout — waiting is WaitFor's job. The DSH
          // jobs service has no log-file path to surface as output_path, so the
          // buffered output text is returned directly.
          const read = await jobs.read(args.task_id, exec.agent)
          return read.text || '[' + read.snapshot.status + '] ' + (read.snapshot.detail || '')
        } catch (e) {
          return 'TaskOutput error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'TaskStop',
      description: surface('TaskStop').description,
      parameters: surface('TaskStop').parameters,
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        // Upstream `timeout` waits for graceful shutdown before force-kill; the
        // DSH jobs.kill escalation is internal (grace → force), so the value is
        // accepted but not threaded through.
        const outcome = jobs.kill(args.task_id, exec.agent, args.reason)
        return 'TaskStop: ' + outcome
      },
    }))
    register(strDef({
      name: 'WaitFor',
      description: surface('WaitFor').description,
      parameters: surface('WaitFor').parameters,
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        const timeoutMs = (args.timeout || 30) * 1000
        const describe = async (id) => {
          try {
            const read = await jobs.read(id, exec.agent)
            const snap = read.snapshot || {}
            return id + ' settled with status "' + (snap.status || 'unknown') + '"' + (snap.detail ? ' (' + snap.detail + ')' : '')
          } catch {
            return id + ' settled'
          }
        }
        try {
          if (args.task_id) {
            await jobs.wait(args.task_id, timeoutMs, exec.agent, exec.signal)
            return await describe(args.task_id)
          }
          // No task_id: wait for ANY active task to settle (upstream semantics).
          const list = await jobs.list(exec.agent)
          const ids = (Array.isArray(list) ? list : [])
            .filter((j) => j && j.id != null && ['running', 'pending', 'active', 'queued'].indexOf(String(j.status || 'running')) >= 0)
            .map((j) => String(j.id))
          if (ids.length === 0) return 'No active background tasks.'
          const settled = await Promise.race(ids.map((id) => jobs.wait(id, timeoutMs, exec.agent, exec.signal).then(() => id, () => id)))
          if (!settled) return 'No task settled within ' + (args.timeout || 30) + 's.'
          return await describe(settled)
        } catch (e) {
          return 'WaitFor error: ' + String(e)
        }
      },
    }))

    // ---- TodoList with plugin-local store ----
    const todoStore = new Map()
    register(strDef({
      name: 'TodoList',
      description: surface('TodoList').description,
      parameters: surface('TodoList').parameters,
      execute: async (args, exec) => {
        const key = exec.agent && exec.agent.id != null ? String(exec.agent.id) : 'default'
        if (Array.isArray(args.todos)) {
          if (args.todos.length === 0) todoStore.delete(key)
          else todoStore.set(key, args.todos)
        }
        const list = todoStore.get(key) || []
        if (list.length === 0) return '(todo list is empty)'
        return list.map((t) => '- [' + t.status + '] ' + t.title).join('\n')
      },
    }))

    // ---- AskUserQuestion via userQuestions ----
    register(strDef({
      name: 'AskUserQuestion',
      description: surface('AskUserQuestion').description,
      parameters: surface('AskUserQuestion').parameters,
      execute: async (args, exec) => {
        if (!userQuestions) return '(user questions unavailable)'
        // Upstream `background` files the question without blocking; the DSH
        // userQuestions service has no background ask, so questions are always
        // asked in the foreground.
        try {
          const answer = await userQuestions.ask({
            questions: (args.questions || []).map((q, i) => ({
              id: 'q' + (i + 1),
              question: q.question,
              header: q.header || undefined,
              options: (q.options || []).map((o) => ({ label: o.label, description: o.description || undefined })),
              multiSelect: q.multi_select === true,
            })),
            agent: exec.agent,
            signal: exec.signal,
          })
          return JSON.stringify(answer)
        } catch (e) {
          return 'AskUserQuestion error: ' + String(e)
        }
      },
    }))

    // ---- Agent via subagents ----
    // kimi's three built-in subagent types map onto the single source of truth
    // in lib/subagents.js (upstream kimi-code 0.39.1 coder/explore/plan
    // profiles). The recipe's persona is set EXPLICITLY on every request
    // because DSH's continuable (background) route never invokes
    // provider.start() — the continuation manager rebuilds the child from the
    // request fields recorded in the durable descriptor. toolFilter is
    // deliberately NOT set on the request: since dsh-tools 0.1.1-rc.2,
    // tools.restrict() accepts only GLOBAL tool names and rejects scope-local
    // (vendor) names; the mesh agent/created listener applies the child tool
    // mask instead (mesh AGENTS.md §6).
    const KIMI_TYPE_TO_RECIPE = { coder: 'kimi-agent', explore: 'kimi-explore', plan: 'kimi-plan' }
    const subagentProviderFor = () => {
      const names = subagents ? subagents.list() : []
      if (names.indexOf('kimi-agent') >= 0) return 'kimi-agent'
      return names.indexOf('spawn') >= 0 ? 'spawn' : null
    }
    const startKimiChild = (args, exec, promptText, label) => {
      const recipeName = KIMI_TYPE_TO_RECIPE[args.subagent_type || 'coder'] || 'kimi-agent'
      const recipe = SUBAGENT_RECIPES[recipeName]
      const providerName = subagentProviderFor()
      if (!providerName) return Promise.reject(new Error('no usable subagent provider'))
      return subagents.startContinuable({
        provider: providerName,
        label,
        request: {
          label,
          prompt: [{ type: 'text', text: promptText }],
          parent: exec.agent,
          agentOptions: { provider: recipe.provider, model: recipe.model },
          persona: recipe.persona,
          maxDepth: 3,
        },
        signal: exec.signal,
      })
    }
    register(strDef({
      name: 'Agent',
      // Description is VERBATIM upstream 0.39.1 (foreground-first wording), per
      // the sync decision; the DSH implementation below keeps the native
      // background-first behavior (durable id at inbox acceptance), which the
      // tool:Agent prompt section documents while the tool is visible.
      description: surface('Agent').description,
      parameters: surface('Agent').parameters,
      // Background starts and sibling foreground runs overlap safely under the
      // loop's rolling pool, exactly like the native delegation tool.
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        const recipeName = KIMI_TYPE_TO_RECIPE[args.subagent_type || 'coder'] || 'kimi-agent'
        const providerName = subagentProviderFor()
        if (!providerName) return 'Error: no usable subagent provider (available: ' + (subagents.list().join(', ') || 'none') + ').'

        // resume: deliver prompt as the existing continuable subagent's next
        // turn (the DSH-standard continuation channel, same as send_message).
        if (args.resume) {
          try {
            const messageId = await subagents.followup(exec.agent, String(args.resume), [{ type: 'text', text: String(args.prompt) }], {
              source: { kind: 'coordinator', form: 'relay', senderSessionId: exec.agent.id },
              signal: exec.signal,
            })
            return 'resumed subagent ' + args.resume + ' — message queued as its next turn (messageId: ' + messageId + '). You will receive a notice when it settles.'
          } catch (e) {
            return 'Error: resume failed: ' + String(e)
          }
        }

        const label = String(args.description || recipeName).slice(0, 80)

        // Background-first (DSH default, matching the stock `subagent` tool):
        // establish a durable continuable child and return at inbox acceptance.
        // The child owns its turns from here — no in-tool await, and the
        // runtime delivers the settlement notice itself.
        if (args.run_in_background !== false) {
          try {
            const started = await startKimiChild(args, exec, String(args.prompt), label)
            return 'started background subagent ' + started.childId + '. It runs independently; you will receive a notice with its outcome and final message when it settles. Use Agent with resume="' + started.childId + '" to send it follow-up messages.'
          } catch (e) {
            return 'Error: background start failed: ' + String(e)
          }
        }

        // Foreground override: collect the result and dispose, preserving the
        // child's partial output on a non-completed stop (native semantics).
        const recipe = SUBAGENT_RECIPES[recipeName]
        const run = await subagents.start(providerName, {
          label,
          prompt: [{ type: 'text', text: String(args.prompt) }],
          parent: exec.agent,
          agentOptions: { provider: recipe.provider, model: recipe.model },
          persona: recipe.persona,
          maxDepth: 3,
          signal: exec.signal,
        })
        try {
          const result = await run.result
          const out = textOf(result.output)
          const error = stopReasonError(result)
          if (error !== undefined) return withPartialText(error, result.output)
          return out
        } finally {
          try { await run.dispose() } catch {}
        }
      },
    }))

    // ---- AgentSwarm via subagents (fan-out mapping) ----
    // DSH form: one continuable background subagent per item (prompt_template
    // with {{item}} substituted), the same spawn path the Agent tool uses;
    // resume_agent_ids fans one follow-up message out to existing children.
    // Upstream's `fork` param is feature-gated OFF in 0.39.1 and not registered.
    register(strDef({
      name: 'AgentSwarm',
      description: surface('AgentSwarm').description,
      parameters: surface('AgentSwarm').parameters,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        if (Array.isArray(args.resume_agent_ids) && args.resume_agent_ids.length > 0) {
          const lines = []
          for (const id of args.resume_agent_ids.slice(0, 128)) {
            try {
              const messageId = await subagents.followup(exec.agent, String(id), [{ type: 'text', text: String(args.prompt_template || '') }], {
                source: { kind: 'coordinator', form: 'relay', senderSessionId: exec.agent.id },
                signal: exec.signal,
              })
              lines.push('resumed ' + id + ' (messageId: ' + messageId + ')')
            } catch (e) {
              lines.push('resume failed for ' + id + ': ' + String(e))
            }
          }
          return lines.join('\n')
        }
        const items = Array.isArray(args.items) ? args.items.slice(0, 128) : []
        if (items.length === 0) return 'Error: provide items (max 128) to fan out over, or resume_agent_ids to continue an existing swarm.'
        const lines = []
        for (let i = 0; i < items.length; i++) {
          const item = String(items[i])
          const prompt = String(args.prompt_template || '').split('{{item}}').join(item)
          const label = (String(args.description || 'swarm').slice(0, 60) + ' [' + (i + 1) + '/' + items.length + ']').slice(0, 80)
          try {
            const started = await startKimiChild(args, exec, prompt, label)
            lines.push(started.childId + '  ' + item)
          } catch (e) {
            lines.push('start failed for "' + item + '": ' + String(e))
          }
        }
        return 'AgentSwarm fan-out started (' + items.length + ' background subagent(s), one per item):\n' + lines.join('\n') + '\nUse WaitFor to wait for the first to settle, Agent with resume="<agent_id>" for a single follow-up, or AgentSwarm with resume_agent_ids to fan one message out to all of them.'
      },
    }))

    // ---- Skill via the DSH skills service ----
    register(strDef({
      name: 'Skill',
      description: surface('Skill').description,
      parameters: surface('Skill').parameters,
      execute: async (args, exec) => {
        if (!skills) return 'Skill unavailable: the DSH skills service is not registered.'
        let def
        try {
          def = await skills.get(String(args.skill), { scope: exec.agent && exec.agent.ctx, cwd: cwdOf(exec), signal: exec.signal })
        } catch {
          try { def = await skills.get(String(args.skill)) } catch (e) { return 'Skill error: ' + String(e) }
        }
        if (!def) {
          let names = []
          try {
            const list = await skills.list({ cwd: cwdOf(exec) })
            names = (Array.isArray(list) ? list : []).map((s) => s && s.name).filter(Boolean)
          } catch {}
          return 'Skill not found: ' + args.skill + (names.length > 0 ? '. Available skills: ' + names.join(', ') : '')
        }
        const body = typeof def.body === 'string' ? def.body : (typeof def.content === 'string' ? def.content : '')
        if (!body) return 'Skill "' + args.skill + '" has no readable body.'
        // Upstream appends the args for templates without a placeholder; the
        // DSH skill body has no placeholder protocol, so args are appended.
        return args.args ? body + '\n\nARGUMENTS: ' + args.args : body
      },
    }))

    // ---- Goal tools via the DSH goals service ----
    const goalLeaf = (view) => {
      // Copy only primitive leaf fields (a GoalView is live runtime data).
      const out = {}
      if (!view || typeof view !== 'object') return out
      for (const key of ['id', 'revision', 'objective', 'phase', 'status', 'state', 'rounds', 'completedRounds', 'maxRounds', 'max_goal_rounds', 'roundsCompleted', 'roundsLimit']) {
        const v = view[key]
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v
      }
      return out
    }
    const goalRefOf = (view) => ({ id: view.id, revision: view.revision })
    register(strDef({
      name: 'CreateGoal',
      description: surface('CreateGoal').description,
      parameters: surface('CreateGoal').parameters,
      execute: async (args, exec) => {
        if (!goals) return 'CreateGoal unavailable: the DSH goals service is not registered.'
        if (!exec.agent) return 'Error: no caller agent.'
        // DSH CreateGoalRequest carries {objective, max_goal_rounds?}; the
        // upstream completionCriterion has no dedicated field, so it is folded
        // into the objective text.
        let objective = String(args.objective)
        if (args.completionCriterion) objective += '\n\nCompletion criterion: ' + String(args.completionCriterion)
        const existing = goals.get(exec.agent)
        if (existing && args.replace !== true) return 'A goal already exists for this session; pass replace: true to clear and replace it.'
        try {
          if (existing) goals.clear(exec.agent, goalRefOf(existing))
          const view = goals.create(exec.agent, { objective })
          return 'Goal created and armed. ' + JSON.stringify(goalLeaf(view))
        } catch (e) {
          return 'CreateGoal error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'GetGoal',
      description: surface('GetGoal').description,
      parameters: surface('GetGoal').parameters,
      execute: async (args, exec) => {
        if (!goals) return 'GetGoal unavailable: the DSH goals service is not registered.'
        if (!exec.agent) return 'Error: no caller agent.'
        const view = goals.get(exec.agent)
        if (!view) return '(no current goal)'
        return JSON.stringify(goalLeaf(view))
      },
    }))
    register(strDef({
      name: 'SetGoalBudget',
      description: surface('SetGoalBudget').description,
      parameters: surface('SetGoalBudget').parameters,
      execute: async (args, exec) => {
        if (!goals) return 'SetGoalBudget unavailable: the DSH goals service is not registered.'
        if (!exec.agent) return 'Error: no caller agent.'
        const view = goals.get(exec.agent)
        if (!view) return '(no current goal — create one with CreateGoal first)'
        // The DSH goal runtime only exposes a round cap; `turns` maps onto it.
        // Token and wall-clock budgets have no DSH counterpart (documented gap).
        if (args.unit !== 'turns') {
          return 'SetGoalBudget with unit "' + args.unit + '" is not supported by the DSH goal runtime: only turn budgets (unit "turns") map onto the goal round cap.'
        }
        try {
          const next = goals.edit(exec.agent, goalRefOf(view), { max_goal_rounds: Math.floor(args.value) })
          return 'Goal budget set to ' + Math.floor(args.value) + ' turns (round cap). ' + JSON.stringify(goalLeaf(next))
        } catch (e) {
          return 'SetGoalBudget error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'UpdateGoal',
      description: surface('UpdateGoal').description,
      parameters: surface('UpdateGoal').parameters,
      execute: async (args, exec) => {
        if (!goals) return 'UpdateGoal unavailable: the DSH goals service is not registered.'
        if (!exec.agent) return 'Error: no caller agent.'
        const view = goals.get(exec.agent)
        if (!view) return '(no current goal)'
        const ref = goalRefOf(view)
        try {
          if (args.status === 'active') {
            const next = goals.resume(exec.agent, ref)
            return 'Goal resumed (active). ' + JSON.stringify(goalLeaf(next))
          }
          if (args.status === 'complete') {
            const next = goals.complete(exec.agent, ref)
            return 'Goal marked complete. ' + JSON.stringify(goalLeaf(next))
          }
          const next = goals.block(exec.agent, ref, { code: 'agent-reported', message: 'Blocked reported by the agent via UpdateGoal; the agent explains the blocker in its next message.' })
          return 'Goal marked blocked. ' + JSON.stringify(goalLeaf(next))
        } catch (e) {
          return 'UpdateGoal error: ' + String(e)
        }
      },
    }))

    // ---- Cron tools: honest stubs ----
    // Upstream 0.39.1 schedules persisted jobs through the host's cron
    // scheduler. The DSH runtime has NO cron service (verified via the Service
    // inspect provider), so these register with the verbatim upstream surface
    // and return a clear explanation instead of pretending to schedule.
    const CRON_UNAVAILABLE = 'Cron jobs are not available in this DSH kernel form: the DSH runtime has no cron/scheduler service. CreateGoal/SetGoalBudget cover autonomous continuation of THIS session; for wall-clock scheduling use the host operating system scheduler (e.g. schtasks / cron) via Bash.'
    register(strDef({
      name: 'CronCreate',
      description: surface('CronCreate').description,
      parameters: surface('CronCreate').parameters,
      execute: async () => CRON_UNAVAILABLE,
    }))
    register(strDef({
      name: 'CronList',
      description: surface('CronList').description,
      parameters: surface('CronList').parameters,
      execute: async () => CRON_UNAVAILABLE,
    }))
    register(strDef({
      name: 'CronDelete',
      description: surface('CronDelete').description,
      parameters: surface('CronDelete').parameters,
      execute: async () => CRON_UNAVAILABLE,
    }))

    // Native parity: a prompt section documents the DSH calling convention
    // while the tool is visible. The Agent description is upstream-verbatim
    // (foreground-first) but the DSH implementation is background-first
    // (stock `subagent` semantics), so the runtime truth lives here.
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      // The kernel's own system prompt, shadowing the deployment persona.
      // `complete: true` makes it the SOLE system-prompt section and
      // `suppressRuntimeContext()` drops the runtime-context snapshot, so a
      // session on this kernel sees ONLY the upstream Kimi Code CLI prompt.
      if (!(config && config.skipPersona)) {
        systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          text: (config && config.persona) || SYSTEM_PROMPT,
          complete: true,
        })
        if (typeof systemPrompt.suppressRuntimeContext === 'function') systemPrompt.suppressRuntimeContext()
      }
      systemPrompt.section({
        name: 'tool:Agent',
        order: 116.5,
        text: (context) => (tools.get('Agent', context && context.scope) === undefined ? '' : 'DSH runtime note: Agent and AgentSwarm in this kernel form run background-first — omitting run_in_background (or setting it true) returns a durable subagent id immediately, and the runtime sends you a notice with the outcome and final message when a child settles. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent\'s result. Use Agent with resume="<id>" to give a child more work, and WaitFor to wait for background tasks to settle.'),
      })
    }

    // ---- ExitPlanMode / EnterPlanMode via planMode ----
    if (planMode) {
      register(strDef({
        name: 'ExitPlanMode',
        description: surface('ExitPlanMode').description,
        parameters: surface('ExitPlanMode').parameters,
        execute: async (args, exec) => {
          if (!exec.agent) return 'Error: no caller agent.'
          let choice = ''
          if (Array.isArray(args.options) && args.options.length > 0 && userQuestions) {
            try {
              const answer = await userQuestions.ask({
                questions: [{
                  id: 'plan-approach',
                  header: 'Choose approach',
                  question: 'Which approach should the plan execute?',
                  options: args.options.map((o) => ({ label: o.label, description: o.description || undefined })),
                }],
                agent: exec.agent,
                signal: exec.signal,
              })
              const sel = answer && Array.isArray(answer.answers) ? answer.answers[0] : undefined
              if (sel && sel.selected) choice = ' Selected approach: ' + sel.selected
            } catch {}
          }
          const outcome = planMode.set(exec.agent, false)
          return 'Plan mode exited (' + outcome + ').' + choice
        },
      }))
      register(strDef({
        name: 'EnterPlanMode',
        description: surface('EnterPlanMode').description,
        parameters: surface('EnterPlanMode').parameters,
        execute: async (args, exec) => {
          if (!exec.agent) return 'Error: no caller agent.'
          const outcome = planMode.set(exec.agent, true)
          return 'Plan mode entered (' + outcome + ').'
        },
      }))
    }
}

const _test = { formatKimiSearchResults, htmlToText, loadKimiBearer, UPSTREAM_SURFACE }
export { name, inject, apply, _test }
