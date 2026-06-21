#!/usr/bin/env node
// Install the GOVERNANCE STRATEGY (hooks + CLAUDE.md rules) into this machine's ~/.claude —
// WITHOUT touching project memory (safe for a machine working on its own project).
// Installs: H1 contracts-block + H2 14-day PreToolUse/Bash hooks, H3 destructive-command
// permissions.ask rules, and the Sealed Credential section in CLAUDE.md. Idempotent; backs up
// every file before changing it. Uses only Node builtins (no DB, no deps).
//   node scripts/install-governance.mjs           # dry run (shows what it would do)
//   node scripts/install-governance.mjs --apply   # write changes (with backups)

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const APPLY = process.argv.includes('--apply')
const HOME = homedir()
const CLAUDE_DIR = join(HOME, '.claude')
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks')
const SETTINGS = join(CLAUDE_DIR, 'settings.json')
const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md')
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))   // scripts/.. = repo root
const SRC_HOOKS = join(REPO, 'governance', 'hooks')
const SRC_SECTION = join(REPO, 'governance', 'CLAUDE-credentials-section.md')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const fwd = (p) => p.replace(/\\/g, '/')                        // forward-slash path for the hook command
const log = []
const backup = (p) => { if (existsSync(p)) { copyFileSync(p, `${p}.bak-${stamp}`); log.push(`backed up ${p}`) } }

const H3_RULES = ['Bash(rm -rf*)', 'Bash(rm -fr*)', 'Bash(sudo rm -rf*)', 'Bash(git reset --hard*)',
                  'Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git clean -f*)']
const HOOK_FILES = [
  { file: 'contracts-block.py', timeout: 12, msg: 'Checking for contract/legal files (H1)...' },
  { file: 'package-14day.py',   timeout: 10, msg: '14-day package check (H2)...' },
]

// 1) hooks: copy *.py -> ~/.claude/hooks/
const plannedHookCopies = []
for (const { file } of HOOK_FILES) {
  const src = join(SRC_HOOKS, file), dest = join(HOOKS_DIR, file)
  plannedHookCopies.push({ src, dest, exists: existsSync(dest) })
}

// 2) settings.json: merge PreToolUse Bash hooks + permissions.ask (preserve everything)
let settings = {}
if (existsSync(SETTINGS)) { try { settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) } catch (e) { console.error(`settings.json is not valid JSON — aborting: ${e.message}`); process.exit(1) } }
settings.hooks ??= {}; settings.hooks.PreToolUse ??= []
let bash = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash')
if (!bash) { bash = { matcher: 'Bash', hooks: [] }; settings.hooks.PreToolUse.push(bash) }
bash.hooks ??= []
const hookAdds = []
for (const { file, timeout, msg } of HOOK_FILES) {
  if (!bash.hooks.some((h) => (h.command || '').includes(file))) {
    bash.hooks.push({ type: 'command', command: `python ${fwd(join(HOOKS_DIR, file))}`, timeout, statusMessage: msg })
    hookAdds.push(file)
  }
}
settings.permissions ??= {}; settings.permissions.ask ??= []
const permAdds = []
for (const r of H3_RULES) if (!settings.permissions.ask.includes(r)) { settings.permissions.ask.push(r); permAdds.push(r) }

// 3) CLAUDE.md: append the Sealed Credential section if missing
const section = readFileSync(SRC_SECTION, 'utf8').trim()
const claudeExisting = existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, 'utf8') : ''
const needSection = !claudeExisting.includes('Sealed Credential standard')

// ---- report / apply ----
console.log(APPLY ? '=== INSTALL GOVERNANCE (apply) ===' : '=== DRY RUN — pass --apply to write ===')
console.log(`target: ${CLAUDE_DIR}`)
plannedHookCopies.forEach((h) => console.log(`  hook ${h.exists ? 'overwrite' : 'install'}: ${h.dest}`))
console.log(`  settings.json: +${hookAdds.length} hook(s) [${hookAdds.join(', ') || 'none'}], +${permAdds.length} deny-rule(s)`)
console.log(`  CLAUDE.md: ${needSection ? 'append Sealed Credential section' : 'already present (skip)'}`)

if (!APPLY) { console.log('\n(no changes written)'); process.exit(0) }

mkdirSync(HOOKS_DIR, { recursive: true })
for (const h of plannedHookCopies) { copyFileSync(h.src, h.dest); log.push(`installed ${h.dest}`) }
if (hookAdds.length || permAdds.length) { backup(SETTINGS); writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf8'); log.push('updated settings.json') }
if (needSection) { backup(CLAUDE_MD); writeFileSync(CLAUDE_MD, (claudeExisting ? claudeExisting.replace(/\s*$/, '') + '\n\n' : '') + section + '\n', 'utf8'); log.push('appended CLAUDE.md section') }

console.log('\n' + log.map((l) => '  ' + l).join('\n'))
console.log('\nDONE. Restart Claude Code so the new hooks + CLAUDE.md take effect.')
console.log('NOTE: project memory was NOT touched — this machine keeps its own place.')
