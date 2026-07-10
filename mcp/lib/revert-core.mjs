// Mnemosyne - revert core (Unit L, thread 0037). Pure/injectable and keyless-testable.
// Historical bodies can contain secrets even when the live entry is clean, so the selected version
// is scanned immediately after the RPC returns and before it is embedded, formatted, or output.

import { isUuid, scanSecret, slugify, MAX_NAME_LEN } from './remember-core.mjs'
import { MAX_CHANGE_REASON_LEN, runUpdate } from './update-core.mjs'

export function validateRevertArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('revert: arguments must be an object')
  for (const key of Object.keys(args)) {
    if (!['name', 'version_no', 'reason'].includes(key)) throw new Error(`revert: unexpected argument "${key}"`)
  }
  if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('revert: "name" must be a non-empty string')
  const name = slugify(args.name)
  if (!name) throw new Error('revert: "name" slugifies to empty')
  if (name.length > MAX_NAME_LEN) throw new Error(`revert: name exceeds ${MAX_NAME_LEN} chars`)
  if (!Number.isInteger(args.version_no) || args.version_no < 1 || args.version_no > 2147483647) {
    throw new Error('revert: "version_no" must be a positive 32-bit integer')
  }
  let reason
  if (args.reason !== undefined) {
    if (typeof args.reason !== 'string') throw new Error('revert: "reason" must be a string')
    reason = args.reason.trim() || undefined
  }
  const change_reason = `revert to v${args.version_no}${reason ? `: ${reason}` : ''}`
  if (change_reason.length > MAX_CHANGE_REASON_LEN) throw new Error(`revert: combined change reason exceeds ${MAX_CHANGE_REASON_LEN} chars`)
  return { name, version_no: args.version_no, change_reason }
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data
}

export async function runRevert(args, { embedDoc, rpc, actorId }) {
  if (!isUuid(actorId)) throw new Error('revert: no valid operator actor configured (OPERATOR_MEMBER_ID) - refusing to write')
  const { name, version_no, change_reason } = validateRevertArgs(args)

  const currentResult = await rpc('get_memory_entry', { p_name: name })
  if (currentResult.error) throw new Error(`get_memory_entry error: ${currentResult.error.message}`)
  const current = firstRow(currentResult.data)
  if (!current) throw new Error(`revert: no entry named "${name}"`)
  if (typeof current.updated_at !== 'string' || Number.isNaN(Date.parse(current.updated_at))) {
    throw new Error(`revert: current entry "${name}" returned an invalid updated_at concurrency token`)
  }

  const versionResult = await rpc('get_memory_version', { p_name: name, p_version_no: version_no })
  if (versionResult.error) throw new Error(`get_memory_version error: ${versionResult.error.message}`)
  const version = firstRow(versionResult.data)
  if (!version) throw new Error(`revert: version ${version_no} not found for "${name}"`)

  // This must be the first operation on the historical body. Refuse; never redact-and-proceed.
  if (typeof version.body !== 'string') throw new Error(`revert: version ${version_no} returned an invalid body`)
  const secretReason = scanSecret(version.body)
  if (secretReason) {
    throw new Error(`revert refused for "${name}" version ${version_no}: ${secretReason} - historical content contains a secret and must not be embedded or returned`)
  }

  if (version.name !== name) throw new Error(`revert: version ${version_no} belongs to a different entry`)
  if (typeof version.title !== 'string' || typeof version.kind !== 'string') throw new Error(`revert: version ${version_no} returned invalid title/kind fields`)

  const updateMessage = await runUpdate({
    name,
    title: version.title,
    body: version.body,
    kind: version.kind,
    change_reason,
    expected_updated_at: current.updated_at,
  }, { embedDoc, rpc, actorId })

  return `Reverted "${name}" to version ${version_no}. ${updateMessage}`
}
