import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)

const binaryPath = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/opencode`)

// LOCAL DEV PATCH: skip rebuild if binary already exists and is ad-hoc signed & runnable.
// This avoids the macOS Gatekeeper smoke-test failure where `bun build --compile` produces
// a binary whose embedded signature is rejected (`codesign -v` → "invalid or unsupported
// format for signature"), causing `opencode --version` to be SIGKILLed (exit 137).
import { existsSync } from "node:fs"
// binaryPath is relative to packages/desktop/ (Tauri's CWD when it invokes predev).
// From predev.ts (which lives in packages/desktop/scripts/) that means ../../opencode/...
const resolvedBinaryPath = `${import.meta.dirname}/../${binaryPath}`
if (!existsSync(resolvedBinaryPath)) {
  await (sidecarConfig.ocBinary.includes("-baseline")
    ? $`cd ../opencode && bun run build --single --baseline`
    : $`cd ../opencode && bun run build --single`)
  await $`codesign --remove-signature ${resolvedBinaryPath}`.nothrow()
  await $`codesign --force --sign - ${resolvedBinaryPath}`
} else {
  console.log(`[predev] Skipping sidecar rebuild, reusing ${resolvedBinaryPath}`)
  // Make sure it is signed even if it was built by a previous run
  await $`codesign --remove-signature ${resolvedBinaryPath}`.nothrow()
  await $`codesign --force --sign - ${resolvedBinaryPath}`
}

await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)
// Re-sign the copy Tauri will spawn (codesign strips on copy on modern macOS).
const sidecarDest = `${import.meta.dirname}/../src-tauri/sidecars/opencode-cli-${RUST_TARGET}`
await $`codesign --remove-signature ${sidecarDest}`.nothrow()
await $`codesign --force --sign - ${sidecarDest}`
console.log(`[predev] Signed sidecar at ${sidecarDest}`)
