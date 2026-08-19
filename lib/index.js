// dsh-kernel-kimi — "Kimi Code written in DSH form": the kimi-cli tool surface
// registered as DSH tools with the SAME names, schemas and semantics, implemented
// directly on DSH services (fs/web/subprocess/jobs/attachments/userQuestions),
// so the surface survives toolFilter scoping. Schemas distilled from
// kimi-cli/src/kimi_cli/tools/* (Pydantic Params classes). SearchWeb/FetchURL
// prefer kimi-cli's own Moonshot endpoints (api.kimi.com/coding/v1/search|fetch)
// with the shared OAuth token, then fall back to ctx.web / a local GET.
import fsNative from 'node:fs'
import os from 'node:os'
import pathNative from 'node:path'
import { spawn } from 'node:child_process'
import { SYSTEM_PROMPT } from './system-prompt.js'
import { SUBAGENT_RECIPES } from './subagents.js'

const KIMI_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
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

function kimiServiceHeaders(extra) {
  return Object.assign({
    'user-agent': 'kimi-cli/1.49.0 (dsh-kernel-kimi)',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': '1.49.0',
    'X-Msh-Device-Name': 'dsh-kernel-kimi',
    'X-Msh-Device-Model': process.platform === 'win32' ? 'Windows' : 'Linux',
    'X-Msh-Os-Version': 'unknown',
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

async function kimiSearchNative(args, signal) {
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
      text_query: args.query,
      limit: args.limit || 5,
      enable_page_crawling: args.include_content === true,
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
  return text.length === 0 ? error : error + '\nPartial output before the run ended:\n' + text
}

function textOf(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

const name = 'dsh-kernel-kimi'
const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']

async function apply(ctx, config = {}) {
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
    if (!tools || !fs) return

    // When mounted as a subagent surface, only register the tools the
    // subagent type is allowed to use (config.tools whitelist).
    const register = (t) => {
      if (config.tools && !config.tools.includes(t.name)) return
      tools.register(t)
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', '.venv', '__pycache__', 'dist'])
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
    async function walk(dirTarget, rel, out, max, signal, depth, seen) {
      if (out.length >= max || (depth || 0) > 64) return
      const visited = seen || new Set()
      let entries
      try { entries = await fs.listDir(dirTarget, signal) } catch { return }
      for (const e of entries || []) {
        if (out.length >= max) return
        const name = e.name
        if (SKIP_DIRS.has(name)) continue
        const isDir = e.type === 'directory'
        const childRel = rel ? rel + '/' + name : name
        if (isDir) {
          const key = e.target && e.target.targetKey ? e.target.targetKey : childRel
          if (visited.has(key)) continue
          visited.add(key)
          try { await walk(e.target, childRel, out, max, signal, (depth || 0) + 1, visited) } catch {}
        } else {
          out.push({ rel: childRel, target: e.target })
        }
      }
    }

    // ---- ReadFile (read.py) ----
    register(strDef({
      name: 'ReadFile',
      description: 'Reads a file from the local filesystem. Absolute paths are required when reading files outside the working directory. Reads up to 1000 lines by default; use line_offset (negative reads from the end, e.g. -100 reads the last 100 lines) and n_lines for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to read. Absolute paths are required when reading files outside the working directory.' },
          line_offset: { type: 'integer', description: 'The line number to start reading from. By default read from the beginning of the file. Negative values read from the end of the file (e.g. -100 reads the last 100 lines).', default: 1 },
          n_lines: { type: 'integer', description: 'The number of lines to read. By default read up to 1000 lines.', default: 1000 },
        },
        required: ['path'],
      },
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

    // ---- WriteFile (write.py) ----
    register(strDef({
      name: 'WriteFile',
      description: 'Writes a file to the local filesystem. Absolute paths are required when writing files outside the working directory. Two modes: overwrite (default) or append. The parent directory must exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to write. Absolute paths are required when writing files outside the working directory.' },
          content: { type: 'string', description: 'The content to write to the file.' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'The mode to use: overwrite for overwriting the whole file and append for appending to the end of an existing file.', default: 'overwrite' },
        },
        required: ['path', 'content'],
      },
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
            if (code === 'FS_NOT_FOUND') { oldText = ''; exists = false } else { return 'WriteFile append error: ' + String(e) }
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

    // ---- StrReplaceFile (replace.py) ----
    register(strDef({
      name: 'StrReplaceFile',
      description: 'Performs exact string replacements in an existing file. You can provide a single edit or a list of edits. Each edit replaces `old` with `new` (both can be multi-line); set replace_all to replace all occurrences.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to edit. Absolute paths are required when editing files outside the working directory.' },
          edit: {
            description: 'The edit(s) to apply to the file. A single edit object or a list of edit objects.',
            oneOf: [
              { type: 'object', properties: { old: { type: 'string', description: 'The old string to replace. Can be multi-line.' }, new: { type: 'string', description: 'The new string to replace with. Can be multi-line.' }, replace_all: { type: 'boolean', description: 'Whether to replace all occurrences.', default: false } }, required: ['old', 'new'], additionalProperties: false },
              { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old', 'new'], additionalProperties: false } },
            ],
          },
        },
        required: ['path', 'edit'],
      },
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        const edits = Array.isArray(args.edit) ? args.edit : [args.edit]
        for (const e of edits) {
          await fs.editText(target, { oldString: e.old, newString: e.new, replaceAll: e.replace_all === true }, undefined, exec.signal, policy)
        }
        return 'File successfully edited: ' + args.path + ' (' + edits.length + ' edit(s) applied).'
      },
    }))

    // ---- Glob (glob.py) ----
    register(strDef({
      name: 'Glob',
      description: 'Finds files and directories matching a glob pattern. Returns up to 1000 matches, sorted. On Windows the directory parameter accepts both native (C:\\Users) and POSIX (/c/Users) forms.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files/directories.' },
          directory: { type: 'string', description: 'Absolute path to the directory to search in (defaults to working directory).' },
          include_dirs: { type: 'boolean', description: 'Whether to include directories in results.', default: true },
        },
        required: ['pattern'],
      },
      execute: async (args, exec) => {
        const re = globToRegex(args.pattern)
        if (!re) return 'Invalid glob pattern: ' + args.pattern
        const base = args.directory || cwdOf(exec)
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        const out = []
        const MAX = 1000
        const seen = new Set()
        async function rec(dirTarget, rel, depth) {
          if (out.length >= MAX || depth > 64) return
          const entries = await fs.listDir(dirTarget, exec.signal)
          for (const e of entries || []) {
            if (out.length >= MAX) return
            if (SKIP_DIRS.has(e.name)) continue
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

    // ---- Grep (grep_local.py) ----
    register(strDef({
      name: 'Grep',
      description: 'Searches file contents with a regular expression. output_mode: `files_with_matches` (default) shows file paths, `content` shows matching lines, `count_matches` shows total matches. Use `glob` to filter files (e.g. `*.js`).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents.' },
          path: { type: 'string', description: 'File or directory to search in. Defaults to current working directory. If specified, it must be an absolute path.', default: '.' },
          glob: { type: 'string', description: 'Glob pattern to filter files (e.g. `*.js`, `*.{ts,tsx}`). No filter by default.' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count_matches'], description: '`content`: Show matching lines; `files_with_matches`: Show file paths; `count_matches`: Show total number of matches. Defaults to `files_with_matches`.', default: 'files_with_matches' },
          '-B': { type: 'integer', description: 'Number of lines to show before each match (best-effort in DSH form).' },
          '-A': { type: 'integer', description: 'Number of lines to show after each match (best-effort in DSH form).' },
          '-C': { type: 'integer', description: 'Number of lines to show before and after each match (best-effort in DSH form).' },
          head_limit: { type: 'integer', description: 'Maximum number of matching lines/files to return.' },
        },
        required: ['pattern'],
      },
      execute: async (args, exec) => {
        let re
        try { re = new RegExp(args.pattern) } catch (e) { return 'Invalid regex: ' + String(e) }
        let filter = null
        if (args.glob) {
          filter = globToRegex(args.glob)
          if (!filter) return 'Invalid glob: ' + args.glob
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
          await walk(root, '', files, 2000, exec.signal)
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
          let text
          try {
            const info = await fs.stat(item.target, exec.signal)
            if (info && info.size > 512 * 1024) continue
            text = await fs.readText(item.target, exec.signal)
          } catch { continue }
          const fileLines = text.split(/\r?\n/)
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i])) {
              count += 1
              lines.push(rel + ':' + fileLines[i])
              hits.push({ rel, idx: i, fileLines })
              if (matchedFiles.indexOf(rel) < 0) matchedFiles.push(rel)
            }
          }
        }
        if (args.output_mode === 'count_matches') return 'Total matches: ' + count
        if (args.output_mode === 'content') {
          const B = args['-B'] || 0
          const A = args['-A'] || 0
          const C = args['-C'] || 0
          const before = Math.max(B, C)
          const after = Math.max(A, C)
          if (before > 0 || after > 0) {
            const out = []
            for (const h of hits) {
              const start = Math.max(0, h.idx - before)
              const end = Math.min(h.fileLines.length, h.idx + after + 1)
              for (let i = start; i < end; i++) {
                out.push(h.rel + ':' + (i + 1) + (i === h.idx ? ':' : '-') + h.fileLines[i])
              }
              out.push('--')
            }
            return (args.head_limit ? out.slice(0, args.head_limit) : out.slice(0, 1000)).join('\n') || '(no matches)'
          }
          const out = args.head_limit ? lines.slice(0, args.head_limit) : lines.slice(0, 500)
          return out.join('\n') || '(no matches)'
        }
        const out = args.head_limit ? matchedFiles.slice(0, args.head_limit) : matchedFiles
        return out.join('\n') || '(no matches)'
      },
    }))

    // ---- Shell (shell/__init__.py) via subprocess + jobs ----
    register(strDef({
      name: 'Shell',
      description: 'Executes a shell command (PowerShell on this machine). timeout in seconds (default 60). run_in_background=true runs the command as a background task; description is required then. Use TaskList/TaskOutput/TaskStop to manage background tasks.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute.' },
          timeout: { type: 'integer', description: 'The timeout in seconds for the command to execute. If the command takes longer than this, it will be killed.', default: 60 },
          run_in_background: { type: 'boolean', description: 'Whether to run the command as a background task.', default: false },
          description: { type: 'string', description: 'A short description for the background task. Required when run_in_background=true.', default: '' },
        },
        required: ['command'],
      },
      execute: async (args, exec) => {
        if (!subprocess) return 'Error: subprocess service unavailable.'
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
            label: String(args.description || args.command).slice(0, 120) || 'Shell',
            owner: exec.agent,
            run: () => {
              handle = subprocess.spawn({ argv, cwd: cwdOf(exec), stdio: stdioSpec, graceMs: 3000 })
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
        const handle = subprocess.spawn({ argv, cwd: cwdOf(exec), stdio: stdioSpec, graceMs: 3000, signal: exec.signal })
        const doneSafe = handle.done.then(
          (o) => ({ ok: true, o }),
          (e) => ({ ok: false, e }),
        )
        let timer = null
        let outcome
        try {
          outcome = await Promise.race([
            doneSafe,
            new Promise((resolve) => {
              timer = setTimeout(() => {
                try { handle.terminate() } catch {}
                resolve(null)
              }, (args.timeout || 60) * 1000)
            }),
          ])
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
          return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[timed out after ' + (args.timeout || 60) + 's]'
        }
        if (!outcome.ok) {
          return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[spawn failed: ' + String(outcome.e) + ']'
        }
        return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[exit code: ' + outcome.o.exitCode + ']'
      },
    }))

    // ---- ReadMediaFile (read_media.py) via attachments ----
    register({
      name: 'ReadMediaFile',
      description: 'Reads an image file so the model can see it (PNG/JPEG/WebP/GIF; video not supported in DSH form).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'The path to the file to read. Absolute paths are required when reading files outside the working directory.' } },
        required: ['path'],
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, additionalProperties: true },
        render: (a, v) => {
          if (v && v.attachment) return [{ type: 'image', attachment: v.attachment }]
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
          const ref = await attachments.saveImage({ data, mediaType, name: args.path.split(/[\\/]/).pop() })
          return { ok: true, attachment: ref }
        } catch (e) {
          return { ok: false, error: 'Failed to read media: ' + String(e) }
        }
      },
    })

    // ---- SearchWeb / FetchURL: Moonshot first, ctx.web as fallback ----
    register(strDef({
      name: 'SearchWeb',
      description: 'Searches the web and returns results with title, URL and snippet. limit: number of results (default 5). include_content: whether to also fetch and include page content (costs many tokens).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query text to search for.' },
          limit: { type: 'integer', description: 'The number of results to return.', default: 5 },
          include_content: { type: 'boolean', description: 'Whether to include the content of the web pages in the results.', default: false },
        },
        required: ['query'],
      },
      execute: async (args, exec) => {
        try {
          const native = await kimiSearchNative(args, exec && exec.signal)
          if (native != null) return native
        } catch (e) {
          // Fall through to ctx.web so a transient Moonshot outage still
          // returns something rather than a hard tool error.
          if (!web) return 'Search request failed: ' + String(e)
        }
        if (!web) return 'Search service is not configured. You may want to try other methods to search.'
        const res = await web.search({ query: args.query, maxResults: args.limit || 5 }, exec.signal)
        let out = ''
        for (const s of res.sources || []) {
          out += '- [' + (s.title || s.url) + '](' + s.url + ')' + (s.snippet ? '\n  ' + s.snippet : '') + '\n'
        }
        if (args.include_content && res.sources) {
          for (const s of res.sources.slice(0, 3)) {
            try {
              const f = await web.fetch({ url: s.url }, exec.signal)
              const content = f.body && typeof f.body.content === 'string' ? f.body.content.slice(0, 2000) : ''
              if (content) out += '\n--- ' + s.url + ' ---\n' + content + '\n'
            } catch {}
          }
        }
        return out || '(no results)'
      },
    }))
    register(strDef({
      name: 'FetchURL',
      description: 'Fetches content from a URL and returns the decoded body text. Prefers kimi-cli\'s Moonshot fetch service (same OAuth as the Kimi CLI), then a local HTTP GET.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to fetch content from.' } },
        required: ['url'],
      },
      execute: async (args, exec) => {
        try {
          return await kimiFetchNative(args.url, exec && exec.signal)
        } catch (e) {
          if (web) {
            try {
              const f = await web.fetch({ url: args.url }, exec.signal)
              const content = f.body && typeof f.body.content === 'string' ? f.body.content : ''
              if (content) return content.slice(0, 20000)
            } catch {}
          }
          return 'Failed to fetch URL: ' + String(e)
        }
      },
    }))

    // ---- TaskList / TaskOutput / TaskStop via jobs service ----
    register(strDef({
      name: 'TaskList',
      description: 'Lists background tasks. active_only: whether to list only non-terminal tasks (default true). limit: maximum number of tasks (default 20).',
      parameters: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean', description: 'Whether to list only non-terminal background tasks.', default: true },
          limit: { type: 'integer', description: 'Maximum number of tasks to return.', default: 20 },
        },
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        let list = jobs.list(exec.agent)
        if (args.active_only !== false) list = list.filter((j) => j.status === 'running' || j.status === 'stopping')
        list = list.slice(0, args.limit || 20)
        return list.map((j) => '- ' + j.id + ' [' + j.status + '] ' + (j.label || '')).join('\n') || '(no background tasks)'
      },
    }))
    register(strDef({
      name: 'TaskOutput',
      description: 'Reads the output of a background task. block: whether to wait for the task to finish before returning (default false). timeout: maximum seconds to wait when block=true (default 30).',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The background task ID to inspect.' },
          block: { type: 'boolean', description: 'Whether to wait for the task to finish before returning.', default: false },
          timeout: { type: 'integer', description: 'Maximum number of seconds to wait when block=true.', default: 30 },
        },
        required: ['task_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        try {
          if (args.block === true) await jobs.wait(args.task_id, (args.timeout || 30) * 1000, exec.agent, exec.signal)
          const read = await jobs.read(args.task_id, exec.agent)
          return read.text || '[' + read.snapshot.status + '] ' + (read.snapshot.detail || '')
        } catch (e) {
          return 'TaskOutput error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'TaskStop',
      description: 'Stops a background task by ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The background task ID to stop.' },
          reason: { type: 'string', description: 'Short reason recorded when the task is stopped.', default: 'Stopped by TaskStop' },
        },
        required: ['task_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        const outcome = jobs.kill(args.task_id, exec.agent, args.reason)
        return 'TaskStop: ' + outcome
      },
    }))

    // ---- SetTodoList (todo/__init__.py) with plugin-local store ----
    const todoStore = new Map()
    register(strDef({
      name: 'SetTodoList',
      description: 'Updates the todo list. status: pending | in_progress | done. If todos is not provided, returns the current list without making changes.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The updated todo list. If not provided, returns the current todo list without making changes.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'The title of the todo.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'The status of the todo.' },
              },
              required: ['title', 'status'],
              additionalProperties: false,
            },
          },
        },
      },
      execute: async (args, exec) => {
        const key = exec.agent && exec.agent.id != null ? String(exec.agent.id) : 'default'
        if (Array.isArray(args.todos)) todoStore.set(key, args.todos)
        const list = todoStore.get(key) || []
        if (list.length === 0) return '(todo list is empty)'
        return list.map((t) => '- [' + t.status + '] ' + t.title).join('\n')
      },
    }))

    // ---- AskUserQuestion (ask_user/__init__.py) via userQuestions ----
    register(strDef({
      name: 'AskUserQuestion',
      description: 'Asks the user one or more questions (1-4). Each question needs 2-4 meaningful, distinct options; do NOT include an "Other" option — the system adds one automatically. If you recommend an option, append "(Recommended)" to its label.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'The questions to ask the user (1-4 questions).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id echoed in the answer; generated when omitted.' },
                question: { type: 'string', description: 'A specific, actionable question. End with "?".' },
                header: { type: 'string', description: 'Short category tag (max 12 chars, e.g. "Auth", "Style").', default: '' },
                options: {
                  type: 'array',
                  description: '2-4 meaningful, distinct options.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Concise display text (1-5 words). If recommended, append "(Recommended)".' },
                      description: { type: 'string', description: 'Brief explanation of trade-offs or implications of choosing this option.', default: '' },
                    },
                    required: ['label'],
                    additionalProperties: false,
                  },
                },
                multi_select: { type: 'boolean', description: 'Whether the user can select multiple options.', default: false },
              },
              required: ['question', 'options'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
      },
      execute: async (args, exec) => {
        if (!userQuestions) return '(user questions unavailable)'
        try {
          const answer = await userQuestions.ask({
            questions: (args.questions || []).map((q, i) => ({
              id: String(q.id || 'q' + (i + 1)),
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

    // ---- Agent (tools/agent) via subagents ----
    // kimi's three built-in subagent types map onto the single source of truth
    // in lib/subagents.js (upstream kimi-code coder/explore/plan.yaml). The
    // recipe's persona/toolFilter are set EXPLICITLY on every request because
    // DSH's continuable (background) route never invokes provider.start() — the
    // continuation manager rebuilds the child from the request fields recorded
    // in the durable descriptor.
    const KIMI_TYPE_TO_RECIPE = { coder: 'kimi-agent', explore: 'kimi-explore', plan: 'kimi-plan' }
    register(strDef({
      name: 'Agent',
      // Wording mirrors the stock `subagent` tool (backgroundMode: 'continuable')
      // plus kimi's resume-by-agent-id and coder/explore/plan types.
      description: 'Delegates a focused subtask to a subagent instance (kimi coder/explore/plan subagent types). Provide a complete prompt with all necessary context because a newly created subagent instance does not automatically see your current context. This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; resume (or send_message) starts a later turn in the same child conversation. Set run_in_background: false only when your next action depends on receiving the result.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short (3-5 word) description of the task.' },
          prompt: { type: 'string', description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
          subagent_type: { type: 'string', description: 'The built-in agent type to use: coder (default) | explore | plan.', default: 'coder' },
          model: { type: 'string', description: 'Optional model override for this subagent.' },
          resume: { type: 'string', description: 'Optional agent ID of a background subagent to resume instead of creating a new instance; prompt becomes its next turn.' },
          run_in_background: { type: 'boolean', description: 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.', default: true },
          timeout: { type: 'integer', description: 'Timeout in seconds for the agent task (foreground only; background subagents are not time-capped).' },
        },
        required: ['description', 'prompt'],
      },
      // Background starts and sibling foreground runs overlap safely under the
      // loop's rolling pool, exactly like the native delegation tool.
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        const recipeName = KIMI_TYPE_TO_RECIPE[args.subagent_type || 'coder'] || 'kimi-agent'
        const recipe = SUBAGENT_RECIPES[recipeName]
        const names = subagents.list()
        let providerName = names.indexOf(recipeName) >= 0 ? recipeName : (names.indexOf('spawn') >= 0 ? 'spawn' : null)
        if (!providerName) return 'Error: no usable subagent provider (available: ' + (names.join(', ') || 'none') + ').'

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

        // Build the FULL child request here: persona/toolFilter/agentOptions/
        // maxDepth must be set by the caller because the continuable route
        // never invokes provider.start() — the durable descriptor records
        // exactly these fields for cold resume. maxDepth matches the native
        // default delegation-depth cap.
        const label = String(args.description || recipeName).slice(0, 80)
        const request = {
          label,
          prompt: [{ type: 'text', text: String(args.prompt) }],
          parent: exec.agent,
          agentOptions: { provider: recipe.provider, model: args.model || recipe.model },
          persona: recipe.persona,
          toolFilter: recipe.toolFilter,
          maxDepth: 3,
        }

        // Background-first (native default): establish a durable continuable
        // child and return at inbox acceptance. The child owns its turns from
        // here — no in-tool await, and the runtime delivers the settlement
        // notice itself.
        if (args.run_in_background !== false) {
          try {
            const started = await subagents.startContinuable({ provider: providerName, label, request, signal: exec.signal })
            return 'started background subagent ' + started.childId + '. It runs independently; you will receive a notice with its outcome and final message when it settles. Use Agent with resume="' + started.childId + '" to send it follow-up messages.'
          } catch (e) {
            return 'Error: background start failed: ' + String(e)
          }
        }

        // Foreground override: collect the result and dispose, preserving the
        // child's partial output on a non-completed stop (native semantics).
        const run = await subagents.start(providerName, { ...request, signal: exec.signal })
        try {
          let result
          if (args.timeout && args.timeout > 0) {
            let tt = null
            const timeoutP = new Promise((_, reject) => {
              tt = setTimeout(() => reject(Object.assign(new Error('subagent timeout'), { code: 'SUBAGENT_TIMEOUT' })), args.timeout * 1000)
              if (exec.signal) {
                if (exec.signal.aborted) {
                  clearTimeout(tt)
                  reject(Object.assign(new Error('aborted'), { code: 'SUBAGENT_ABORTED' }))
                  return
                }
                exec.signal.addEventListener('abort', () => {
                  clearTimeout(tt)
                  reject(Object.assign(new Error('aborted'), { code: 'SUBAGENT_ABORTED' }))
                }, { once: true })
              }
            })
            try {
              result = await Promise.race([run.result, timeoutP])
            } finally {
              if (tt) clearTimeout(tt)
            }
          } else {
            result = await run.result
          }
          const out = textOf(result.output)
          const error = stopReasonError(result)
          if (error !== undefined) return withPartialText(error, result.output)
          return out
        } catch (e) {
          if (e && e.code === 'SUBAGENT_TIMEOUT') return '[subagent timed out after ' + args.timeout + 's]'
          if (e && e.code === 'SUBAGENT_ABORTED') return '[subagent aborted]'
          throw e
        } finally {
          try { await run.dispose() } catch {}
        }
      },
    }))

    // Native parity: a prompt section teaches the background-first calling
    // convention while the tool is visible (dsh-tool-subagent does the same
    // for `subagent` at order 116.5).
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
        text: (context) => (tools.get('Agent', context && context.scope) === undefined ? '' : 'Use Agent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent\'s result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; use Agent with resume="<id>" (or send_message) to give it more work.'),
      })
    }

    // ---- ExitPlanMode / EnterPlanMode via planMode ----
    if (planMode) {
      register(strDef({
        name: 'ExitPlanMode',
        description: 'Exits plan mode. In plan mode you plan and do not edit; call this once the plan is ready (the plan itself is presented in your response text). When the plan contains multiple alternative approaches, list them as options (2-3, distinct labels; never use "Reject"/"Revise"/"Approve" as labels).',
        parameters: {
          type: 'object',
          properties: {
            options: {
              type: 'array',
              description: 'When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. 2-3 options.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short name for this option (1-8 words). Append "(Recommended)" if you recommend this option.' },
                  description: { type: 'string', description: 'Brief summary of this approach and its trade-offs.', default: '' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
          },
        },
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
        description: 'Enters plan mode: from now on you plan the implementation instead of executing it, and use only non-mutating tools until ExitPlanMode succeeds.',
        parameters: { type: 'object', properties: {} },
        execute: async (args, exec) => {
          if (!exec.agent) return 'Error: no caller agent.'
          const outcome = planMode.set(exec.agent, true)
          return 'Plan mode entered (' + outcome + ').'
        },
      }))
    }
}

const _test = { formatKimiSearchResults, htmlToText, loadKimiBearer }
export { name, inject, apply, _test }
