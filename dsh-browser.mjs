#!/usr/bin/env node
/**
 * dsh-browser — CLI shim the model invokes via the bash tool inside the
 * dsh runtime. POSTs the browser action to the bridge's loopback relay and
 * prints the result JSON to stdout.
 *
 * usage: dsh-browser '{"action":"tabs_list"}'
 *
 * Bridge coordinates come from <augmentor>/.browser-endpoint (written by
 * bridge.mjs; the harness scrubs DSH_* env vars from the bash tool's spawn,
 * so env cannot carry them). Env vars remain as a fallback.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}

let url = process.env['DSH_BROWSER_BRIDGE']
let secret = process.env['DSH_BROWSER_SECRET'] ?? ''
try {
  const endpoint = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.browser-endpoint'), 'utf8'),
  )
  url = endpoint.url
  secret = endpoint.secret
} catch {
  /* fall back to env / fail below */
}

if (!url) fail('no bridge endpoint found (.browser-endpoint missing and DSH_BROWSER_BRIDGE unset — bridge not running?)')

const body = process.argv[2]
if (!body) fail('usage: dsh-browser \'<single-line JSON>\'')

let params
try {
  params = JSON.parse(body)
} catch (e) {
  fail(`invalid JSON argument: ${e.message}`)
}

try {
  const res = await fetch(`${url}/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-augmentor-secret': secret },
    body,
    signal: AbortSignal.timeout(115000),
  })
  const text = await res.text()
  console.log(text)
  process.exit(res.ok ? 0 : 1)
} catch (e) {
  fail(String(e?.message ?? e))
}
