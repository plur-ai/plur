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
 * `"<host> (Windows|macOS|Linux|Linux (WSL))"`, at most 80 characters. A long
 * host name is cut so the platform suffix survives; control characters in the
 * host name are dropped.
 */
export function deviceName(hostname: string, platform: NodeJS.Platform, isWsl: boolean): string {
  const label = platform === 'linux' && isWsl ? 'Linux (WSL)' : PLATFORM_LABEL[platform] ?? platform
  const suffix = ` (${label})`
  // eslint-disable-next-line no-control-regex
  const host = hostname.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'unknown host'
  return host.slice(0, Math.max(1, DEVICE_NAME_MAX - suffix.length)) + suffix
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
