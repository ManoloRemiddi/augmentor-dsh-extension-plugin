#!/usr/bin/env node
/**
 * dsh-browser — CLI shim the model invokes via the bash tool inside the
 * dsh runtime. POSTs the browser action to the bridge's loopback relay and
 * prints the result JSON to stdout.
 *
 * usage: dsh-browser '{"action":"tabs_list"}'
 *
 * The harness scrubs DSH_* (and credential-shaped) env vars from the bash
 * tool's spawn, so env cannot carry the bridge coordinates. Each bridge
 * instance registers its relay at trace/bridge-endpoints/<pid>.json; this
 * CLI walks its own ancestor process tree to find the bridge instance that
 * spawned the runtime it runs in, so concurrent bridge instances can never
 * point it at the wrong relay. Env vars (DSH_BROWSER_BRIDGE /
 * DSH_BROWSER_SECRET) remain as an override.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}

const ENDPOINT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'trace', 'bridge-endpoints')

/**
 * Walk the ancestor process tree (Linux /proc) to find the bridge instance
 * that owns this CLI. For each ancestor pid, a registration file
 * <endpoint-dir>/<pid>.json is authoritative only if the live process with
 * that pid is actually bridge.mjs (guards against pid reuse).
 * @returns {{url: string, secret: string} | null}
 */
function findAncestorBridge() {
  let pid = process.ppid
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const file = path.join(ENDPOINT_DIR, `${pid}.json`)
    try {
      if (existsSync(file)) {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        if (cmdline.includes('bridge.mjs')) {
          const reg = JSON.parse(readFileSync(file, 'utf8'))
          if (reg?.url && typeof reg.secret === 'string') return { url: reg.url, secret: reg.secret }
        }
      }
    } catch {
      /* unreadable entry — keep walking */
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may contain
      // spaces/parens, so split after the LAST ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      pid = Number(fields[1])
    } catch {
      break // chain exhausted or unreadable
    }
  }
  return null
}

function resolveEndpoint() {
  if (process.env['DSH_BROWSER_BRIDGE']) {
    return { url: process.env['DSH_BROWSER_BRIDGE'], secret: process.env['DSH_BROWSER_SECRET'] ?? '' }
  }
  return findAncestorBridge()
}

const endpoint = resolveEndpoint()
if (!endpoint) fail(`no bridge relay found (no DSH_BROWSER_BRIDGE env and no live bridge ancestor registered in ${ENDPOINT_DIR} — is the Augmentor bridge running?)`)

const body = process.argv[2]
if (!body) fail('usage: dsh-browser \'<single-line JSON>\'')

let params
try {
  params = JSON.parse(body)
} catch (e) {
  fail(`invalid JSON argument: ${e.message}`)
}

try {
  const res = await fetch(`${endpoint.url}/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-augmentor-secret': endpoint.secret },
    body,
    signal: AbortSignal.timeout(115000),
  })
  const text = await res.text()
  if (res.status === 403) fail(`bridge relay at ${endpoint.url} rejected the secret (stale endpoint registration? endpoint: ${ENDPOINT_DIR})`)
  console.log(text)
  process.exit(res.ok ? 0 : 1)
} catch (e) {
  fail(`bridge relay unreachable at ${endpoint.url}: ${String(e?.message ?? e)}`)
}
