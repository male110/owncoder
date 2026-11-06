// Patch node-pty to disable Spectre mitigation,
// which requires VS BuildTools components that may not be installed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(__dirname, '..')
const require = createRequire(import.meta.url)

let nodePtyDir
try {
  nodePtyDir = dirname(require.resolve('node-pty/package.json', { paths: [packageDir] }))
} catch (error) {
  throw new Error(`[patch-node-pty] Could not resolve node-pty from ${packageDir}: ${error.message}`)
}

// Each entry is [file, required]. Generated vcxproj files are optional:
// they only exist after gyp has run, and are regenerated from the patched
// .gyp sources, so a fresh install without a prior build is fine.
const patches = [
  // Main binding.gyp — controls conpty.vcxproj generation
  [join(nodePtyDir, 'binding.gyp'), true],
  // winpty sub-project gyp source — regenerates winpty.vcxproj /
  // winpty-agent.vcxproj on every rebuild; must be patched or gyp will
  // re-emit <SpectreMitigation>Spectre</SpectreMitigation> and MSBuild
  // fails with MSB8040 (missing Spectre-mitigated libraries).
  [join(nodePtyDir, 'deps', 'winpty', 'src', 'winpty.gyp'), true],
  // Pre-existing winpty sub-project vcxproj files (already generated)
  [join(nodePtyDir, 'build', 'deps', 'winpty', 'src', 'winpty.vcxproj'), false],
  [join(nodePtyDir, 'build', 'deps', 'winpty', 'src', 'winpty-agent.vcxproj'), false],
]

for (const [file, required] of patches) {
  if (!existsSync(file)) {
    if (required) {
      throw new Error(`[patch-node-pty] Required file is missing: ${file}`)
    }
    console.log(`[patch-node-pty] Skipping (not generated yet): ${file}`)
    continue
  }
  try {
    let content = readFileSync(file, 'utf8')
    const patched = content
      .replace(/<SpectreMitigation>\s*Spectre\s*<\/SpectreMitigation>/g, '<SpectreMitigation>false</SpectreMitigation>')
      .replace(/(['"]SpectreMitigation['"]\s*:\s*['"])Spectre(['"])/g, '$1false$2')
    if (patched !== content) {
      writeFileSync(file, patched)
      console.log(`[patch-node-pty] Patched ${file}`)
    } else {
      console.log(`[patch-node-pty] Already patched: ${file}`)
    }
  } catch (e) {
    throw new Error(`[patch-node-pty] Could not patch ${file}: ${e.message}`)
  }
}
