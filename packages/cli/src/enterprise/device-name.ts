/**
 * The device name a sign-in sends, and whether a browser can be opened here
 * (#1638, plan C Task 3). Pure: the caller passes the host name, platform and
 * environment.
 */

/** Longest device name the server accepts (`/api/v1/auth/device`, C3). */
export const DEVICE_NAME_MAX = 80

const PLATFORM_LABEL: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

/**
 * The characters the server refuses in a device name (it is shown to the
 * approving user): control, format (bidi overrides), surrogate, line and
 * paragraph separator characters. The server's own rule, `deviceNameOf`.
 */
const SERVER_REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * `"<host> (Windows|macOS|Linux|Linux (WSL))"`, at most 80 characters (UTF-16
 * units, as the server counts). A long host name is cut so the platform suffix
 * survives, never inside a surrogate pair; the characters the server refuses
 * are dropped from the host name.
 *
 * Only the first label of a dotted host name is used (`Mac-0142.local` gives
 * `Mac-0142`), like `hostname -s`. The domain part says nothing about the
 * device, and the install hello carries this name: a `.local`, `.lan`, `.corp`
 * or similar suffix would make the privacy check keep the hello on this device
 * (#1732). An IPv4 address is kept whole.
 */
export function deviceName(hostname: string, platform: NodeJS.Platform, isWsl: boolean): string {
  const label = platform === 'linux' && isWsl ? 'Linux (WSL)' : PLATFORM_LABEL[platform] ?? platform
  const suffix = ` (${label})`
  const full = hostname.replace(SERVER_REFUSED, '').trim()
  const host = (IPV4.test(full) ? full : full.split('.')[0].trim()) || 'unknown host'
  const room = Math.max(1, DEVICE_NAME_MAX - suffix.length)
  let cut = ''
  for (const ch of host) {   // whole code points
    if (cut.length + ch.length > room) break
    cut += ch
  }
  return (cut.trim() || 'unknown host').slice(0, room) + suffix
}

/**
 * True when no browser can be opened for the user here: an SSH session
 * (`SSH_CONNECTION` or `SSH_TTY`), or Linux with neither `DISPLAY` nor
 * `WAYLAND_DISPLAY`. The sign-in link and code are printed either way.
 */
export function isHeadless(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

/**
 * True in a VS Code Remote-SSH terminal (`SSH_CONNECTION` and
 * `VSCODE_IPC_HOOK_CLI` both set): the tools in that window run on this remote
 * machine, so this is the right place to sign in and install.
 */
export function isVsCodeRemote(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION && env.VSCODE_IPC_HOOK_CLI)
}

/** True under WSL: the kernel release names Microsoft, or WSL set its distro variable. */
export function isWslRelease(osRelease: string, env: NodeJS.ProcessEnv): boolean {
  return /microsoft/i.test(osRelease) || Boolean(env.WSL_DISTRO_NAME)
}
