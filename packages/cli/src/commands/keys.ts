/**
 * `plur keys` — manage per-actor Ed25519 signing keys (#1055).
 *
 * Subcommands:
 *   plur keys init                   Generate a key pair for the configured identity
 *   plur keys init --identity <name> Override the identity for key generation
 *   plur keys list                   List registered public keys for this store
 *
 * Key storage:
 *   Private key: <keys-dir>/<identity>.key  (mode 0600, never in a store or repo)
 *   Public key:  <store-root>/keys.yaml     (tracked, per-store registry)
 *
 * The default keys directory is `<store-root>/keys`.  Use `--keys-dir <dir>`
 * to override (e.g. when the private key lives at `~/.plur/keys`).
 *
 * Exit codes: 0 ok, 1 error.
 */
import { join } from 'path'
import { homedir } from 'os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import { initActorKey, registerPublicKey, loadKeysRegistry, keyFingerprint } from '@plur-ai/core'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || subcommand === '--help' || subcommand === 'help') {
    outputText('plur keys — manage per-actor Ed25519 signing keys (#1055)')
    outputText('')
    outputText('Subcommands:')
    outputText('  init                   Generate a key pair for the configured identity')
    outputText('  init --identity <name> Override the identity for this init')
    outputText('  list                   List registered public keys for this store')
    outputText('')
    outputText('Keys directory (private keys): <store-root>/keys  (--keys-dir to override)')
    outputText('Public key registry:           <store-root>/keys.yaml')
    return
  }

  if (subcommand === 'list') {
    await runList(args.slice(1), flags)
    return
  }

  if (subcommand === 'init') {
    await runInit(args.slice(1), flags)
    return
  }

  outputText(`Unknown keys subcommand: ${subcommand}. Run 'plur keys --help'.`)
  process.exitCode = 1
}

async function runInit(args: string[], flags: GlobalFlags): Promise<void> {
  // Parse --identity and --keys-dir overrides.
  let identityOverride: string | undefined
  let keysDirOverride: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--identity' && args[i + 1]) { identityOverride = args[++i]; continue }
    if (args[i] === '--keys-dir' && args[i + 1]) { keysDirOverride = args[++i]; continue }
  }

  // Read-only engine to get the storage root and configured identity; we do
  // not need a write-capable engine just to read config and generate keys.
  const plur = createPlur(flags, { readonly: true })
  const storeRoot = plur.storageRoot

  // Identity resolution: --identity > config > fallback.
  const status = await plur.status()
  const configuredIdentity = status.provenance_identity
  const identity = identityOverride
    ?? (configuredIdentity && configuredIdentity !== 'agent:unidentified' ? configuredIdentity : undefined)
    ?? 'agent:unidentified'

  // Keys directory: --keys-dir > default (<store-root>/keys).
  // When the store lives at ~/.plur, this is ~/.plur/keys — the canonical path
  // documented in the runbook. `--keys-dir` allows running on a custom store
  // path without scattering key files next to arbitrary data.
  const keysDir = keysDirOverride ?? join(storeRoot, 'keys')

  let publicKeyB64: string
  try {
    publicKeyB64 = initActorKey(identity, keysDir)
  } catch (err) {
    outputText(`plur keys init: failed to initialise key for ${identity}`)
    outputText(`  ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  // Register the public key in the store's registry.
  try {
    registerPublicKey(storeRoot, identity, publicKeyB64)
  } catch (err) {
    outputText(`plur keys init: key generated but could not register public key in keys.yaml`)
    outputText(`  ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  const fingerprint = keyFingerprint(publicKeyB64)

  if (shouldOutputJson(flags)) {
    outputJson({ identity, fingerprint, public_key: publicKeyB64, keys_dir: keysDir, store_root: storeRoot })
    return
  }

  outputText(`plur keys init: OK`)
  outputText(`  identity   : ${identity}`)
  outputText(`  fingerprint: ${fingerprint}`)
  outputText(`  keys dir   : ${keysDir}`)
  outputText(`  registry   : ${join(storeRoot, 'keys.yaml')}`)
  outputText('')
  outputText('  Run `plur checkpoint` to emit a signed checkpoint.')
  outputText('  Run `plur verify --signatures` to verify checkpoint signatures.')
}

async function runList(args: string[], flags: GlobalFlags): Promise<void> {
  void args
  const plur = createPlur(flags, { readonly: true })
  const storeRoot = plur.storageRoot

  let registry
  try {
    registry = loadKeysRegistry(storeRoot)
  } catch (err) {
    outputText(`plur keys list: could not load keys.yaml`)
    outputText(`  ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  if (shouldOutputJson(flags)) {
    outputJson({ store_root: storeRoot, keys: registry.keys })
    return
  }

  if (registry.keys.length === 0) {
    outputText(`No keys registered for this store.`)
    outputText(`  Run 'plur keys init' to generate a key pair.`)
    return
  }

  outputText(`Keys registered in ${storeRoot}/keys.yaml:`)
  for (const entry of registry.keys) {
    const fp = keyFingerprint(entry.public_key)
    outputText(`  ${entry.identity}`)
    outputText(`    fingerprint: ${fp}`)
    outputText(`    added_at   : ${entry.added_at}`)
  }
}
