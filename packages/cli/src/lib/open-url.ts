/**
 * The command that opens `url` in the default browser, as an argument array
 * for a no-shell spawn. Windows uses `rundll32 url.dll,FileProtocolHandler`,
 * never `cmd /c start`, which would split a URL at `&`.
 */
export function urlOpener(url: string, plat: NodeJS.Platform = process.platform): [string, string[]] {
  if (plat === 'darwin') return ['open', [url]]
  if (plat === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}
