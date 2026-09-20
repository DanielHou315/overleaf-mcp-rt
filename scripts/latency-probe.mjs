// Makes N small agent edits through a running scripts/agent-session.mjs bridge
// and prints when each was sent and when Overleaf confirmed it, so the times
// can be compared with when the text shows up in a browser editor.
// Usage: [PROBE_HOST=<host>] [PROBE_GAP_MS=400] node scripts/latency-probe.mjs <projectId> <path> <anchor> [n] [prefix] [port]
const [projectId, path, anchor, n = '10', prefix = 'LATENCY', port = '47811'] = process.argv.slice(2)
const host = process.env.PROBE_HOST
const gapMs = Number(process.env.PROBE_GAP_MS ?? 400)
const out = []
let last = anchor
for (let i = 1; i <= Number(n); i++) {
  const marker = ` ${prefix}-${i};`
  const body = JSON.stringify({
    name: 'overleaf_edit_doc',
    arguments: { ...(host ? { host } : {}), projectId, path, edits: [{ old_string: last, new_string: last + marker }] },
  })
  const sent = Date.now()
  const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body })
  const text = await res.text()
  out.push({ marker: marker.trim(), sent, confirmed: Date.now(), ok: text.startsWith('ok') })
  last += marker
  await new Promise((r) => setTimeout(r, gapMs))
}
console.log(JSON.stringify(out))
