import { join } from 'path'
import { homedir } from 'os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  const subcommand = args[0]

  if (!subcommand || subcommand === 'list') {
    const packs = plur.listPacks()
    if (shouldOutputJson(flags)) {
      outputJson({ packs, count: packs.length })
    } else {
      if (packs.length === 0) {
        outputText('No packs installed.')
        return
      }
      for (const p of packs) {
        const version = p.manifest?.version ?? 'unknown'
        const creator = p.manifest?.creator ? ` by ${p.manifest.creator}` : ''
        const hash = p.integrity ? ` [${p.integrity.slice(0, 16)}]` : ''
        // 'unverified' used to print NOTHING, so a pack whose integrity baseline
        // had been destroyed looked identical to one that verified clean (#805,
        // F11). An unanswerable integrity question is reported as loudly as a
        // failed one — the two usually have the same cause.
        const integrityFlag = p.integrity_status === 'modified'
          ? ' ⚠️  MODIFIED — contents changed since install'
          : p.integrity_status === 'unverified'
            ? ' ⚠️  UNVERIFIED — no registry entry, integrity cannot be checked'
            : ''
        outputText(`${p.name} v${version}${creator} (${p.engram_count} engrams)${hash}${integrityFlag}`)
        if (p.installed_at) {
          const date = p.installed_at.slice(0, 10)
          const source = p.source ? ` from ${p.source}` : ''
          outputText(`  Installed: ${date}${source}`)
        }
      }
    }
    return
  }

  if (subcommand === 'preview' || subcommand === 'inspect') {
    const source = args[1]
    if (!source) {
      exit(1, 'Usage: plur packs preview <source> [--provenance]\n\n  --provenance  print the pack\'s full origin record, rather than a summary')
    }
    const preview = await plur.previewPack(source)
    // The full document is the deepest level and the largest by far. Give the
    // summary by default and the document only when somebody asks, so a routine
    // preview stays readable.
    const wantsRecord = args.includes('--provenance')
    if (shouldOutputJson(flags)) {
      outputJson(wantsRecord
        ? preview
        : { ...preview, provenance: { ...preview.provenance, pack_record: undefined } })
    } else if (wantsRecord) {
      outputText(JSON.stringify(preview.provenance.pack_record ?? { error: 'This pack carries no pack-level record.' }, null, 2))
    } else {
      outputText(`Pack: ${preview.manifest.name} v${preview.manifest.version}`)
      if (preview.manifest.creator) outputText(`Creator: ${preview.manifest.creator}`)
      if (preview.manifest.description) outputText(`Description: ${preview.manifest.description}`)
      outputText(`Engrams: ${preview.engram_count}`)
      outputText('')
      for (const e of preview.engrams) {
        const domain = e.domain ? ` [${e.domain}]` : ''
        const tags = e.tags.length > 0 ? ` {${e.tags.join(', ')}}` : ''
        outputText(`  ${e.id} (${e.type})${domain}${tags}`)
        outputText(`    ${e.statement}`)
      }
      if (!preview.security.clean) {
        outputText('')
        outputText('Security issues:')
        for (const issue of preview.security.issues) {
          outputText(`  ⚠ ${issue.engram_id}: ${issue.type} — ${issue.detail}`)
        }
      }
      if (preview.warnings.length > 0) {
        outputText('')
        outputText('Warnings:')
        for (const w of preview.warnings) {
          outputText(`  ⚠ ${w}`)
        }
      }

      // Where the contents came from, shown BEFORE anything is installed.
      // Deliberately no tick, no badge, no "verified" anywhere: nothing in a
      // pack is signed, so all of this is what the pack says about itself.
      const prov = preview.provenance
      outputText('')
      if (!prov.present) {
        outputText('Origin: this pack does not say where its contents came from.')
      } else {
        outputText('Origin (claimed by the pack, not verified):')
        outputText(`  Records        ${prov.record_count} of ${preview.engram_count} engram(s)`)
        if (prov.asserted_by.length) {
          outputText(`  Asserted by    ${prov.asserted_by.join(', ')}`)
        } else {
          outputText('  Asserted by    nobody named')
        }
        for (const l of prov.licences) {
          const chose = l.chosen ? '' : ' (nobody chose this; it is the default)'
          outputText(`  Licence        ${l.name} — ${l.count} engram(s)${chose}`)
        }
        for (const n of prov.notes) outputText(`  • ${n}`)
        outputText('')
        outputText(`  ${prov.verification_note}`)
      }
    }
    return
  }

  if (subcommand === 'export') {
    const name = args[1]
    if (!name) {
      exit(1, `Usage: plur packs export <name> [options]

Options:
  --domain <domain>    Filter by domain prefix (e.g. "mcp", "trading")
  --scope <scope>      Filter by scope (e.g. "global", "project:myapp")
  --tags <t1,t2>       Filter by tags (comma-separated)
  --type <type>        Filter by type (behavioral|procedural|architectural|terminological)
  --description <desc> Pack description
  --creator <name>     Creator name
  --output <dir>       Output directory (default: ~/plur-packs/<name>)
  --no-provenance      Leave out the record of where each engram came from.
                       Provenance is included by default: a pack is how engrams
                       leave your machine, which is where their origin starts
                       to matter to somebody else.`)
    }

    let domain: string | undefined
    let scope: string | undefined
    let tags: string[] | undefined
    let type: string | undefined
    let outputDir: string | undefined
    let description: string | undefined
    let creator: string | undefined
    let provenance = true
    let i = 2
    while (i < args.length) {
      if (args[i] === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
      else if (args[i] === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
      else if (args[i] === '--tags' && i + 1 < args.length) { tags = args[++i].split(',').map(t => t.trim()); i++ }
      else if (args[i] === '--type' && i + 1 < args.length) { type = args[++i]; i++ }
      else if (args[i] === '--output' && i + 1 < args.length) { outputDir = args[++i]; i++ }
      else if (args[i] === '--description' && i + 1 < args.length) { description = args[++i]; i++ }
      else if (args[i] === '--creator' && i + 1 < args.length) { creator = args[++i]; i++ }
      else if (args[i] === '--no-provenance') { provenance = false; i++ }
      // Accepted so an existing script that asks for it explicitly still works.
      else if (args[i] === '--provenance') { provenance = true; i++ }
      else { i++ }
    }

    // Default output to ~/plur-packs/<name> (visible, easy to access)
    if (!outputDir) {
      outputDir = join(homedir(), 'plur-packs', name)
    }

    // Filter engrams thematically
    let engrams = await plur.list({ domain, scope })

    // Additional filters not supported by list()
    if (tags) {
      engrams = engrams.filter(e =>
        e.tags && tags!.some(t => e.tags.includes(t))
      )
    }
    if (type) {
      engrams = engrams.filter(e => e.type === type)
    }

    if (engrams.length === 0) {
      exit(1, `No engrams match the given filters. Try broader criteria or check 'plur list'.`)
    }

    const result = plur.exportPack(engrams, outputDir, {
      name,
      version: '1.0.0',
      description,
      creator,
      provenance,
    })

    if (shouldOutputJson(flags)) {
      outputJson({
        path: result.path,
        engram_count: result.engram_count,
        integrity: result.integrity,
        match_terms: result.match_terms,
        ...(result.provenance_files ? { provenance_files: result.provenance_files } : {}),
        privacy: result.privacy,
        name,
      })
    } else {
      // Export confirmation → suppressed by --quiet; the privacy findings
      // below (blocked/warned engrams) stay loud — the pack differs from
      // what was requested (#730).
      outputInfo(`Exported pack "${name}":`, flags)
      outputInfo(`  Engrams:    ${result.engram_count}`, flags)
      outputInfo(`  Path:       ${result.path}`, flags)
      outputInfo(`  Integrity:  ${result.integrity}`, flags)
      outputInfo(`  Match terms: ${result.match_terms.join(', ') || '(none)'}`, flags)

      if (!result.privacy.clean) {
        const blocked = result.privacy.issues.filter(i => i.type === 'secret' || i.type === 'private_visibility')
        const warnings = result.privacy.issues.filter(i => i.type !== 'secret' && i.type !== 'private_visibility')
        if (blocked.length > 0) {
          outputText(``)
          outputText(`  Blocked (${blocked.length} engrams excluded):`)
          for (const issue of blocked) {
            outputText(`    ${issue.engram_id}: ${issue.type} — ${issue.detail}`)
          }
        }
        if (warnings.length > 0) {
          outputText(``)
          outputText(`  Warnings (included but review recommended):`)
          for (const issue of warnings) {
            outputText(`    ${issue.engram_id}: ${issue.type} — ${issue.detail}`)
          }
        }
      }
    }
    return
  }

  if (subcommand === 'install') {
    const source = args[1]
    if (!source) {
      exit(1, 'Usage: plur packs install <source>')
    }
    const result = await plur.installPack(source)
    if (shouldOutputJson(flags)) {
      outputJson(result)
    } else {
      // Install confirmation → suppressed by --quiet; security warnings and
      // conflicts below stay loud (#730).
      outputInfo(`Installed pack "${result.name}": ${result.installed} engrams`, flags)
      if (result.registry) {
        outputInfo(`  Integrity: ${result.registry.integrity}`, flags)
      }

      if (!result.security.clean) {
        const warnings = result.security.issues.filter(i => i.type !== 'secret')
        if (warnings.length > 0) {
          outputText(``)
          outputText(`Security warnings (${warnings.length}):`)
          for (const w of warnings) {
            outputText(`  ⚠ ${w.engram_id}: ${w.type} — ${w.detail}`)
          }
        }
      }

      if (result.conflicts.length > 0) {
        outputText(``)
        outputText(`Conflicts detected (${result.conflicts.length}):`)
        for (const c of result.conflicts) {
          const label = c.type === 'duplicate' ? 'DUPLICATE' : 'CONTRADICTION'
          outputText(`  [${label}] Pack: ${c.pack_engram_id} ↔ Existing: ${c.existing_engram_id}`)
          outputText(`    Pack:     ${c.pack_statement}`)
          outputText(`    Existing: ${c.existing_statement}`)
        }
        outputText(``)
        outputText(`Pack was installed. Review conflicts and use 'plur forget <id>' to resolve.`)
      }
    }
    return
  }

  if (subcommand === 'uninstall' || subcommand === 'remove') {
    const name = args[1]
    if (!name) {
      exit(1, `Usage: plur packs uninstall <name>

Use 'plur packs list' to see installed packs.`)
    }
    const result = plur.uninstallPack(name)
    if (shouldOutputJson(flags)) {
      outputJson(result)
    } else {
      outputInfo(`Uninstalled pack "${result.name}": ${result.engram_count} engrams removed`, flags)
    }
    return
  }

  exit(1, `Unknown packs subcommand: "${subcommand}". Use: list, preview, install, uninstall, export`)
}
