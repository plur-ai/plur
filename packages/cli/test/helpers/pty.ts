/**
 * Run a command under a pseudo-terminal, so its stdin/stdout/stderr are a TTY
 * (what a person at a terminal has and an agent's shell tool does not). When
 * the output shows `prompt`, `answer` is typed followed by Enter. POSIX only
 * (Python's pty module); callers skip on Windows or without python3.
 */
import { spawn, spawnSync } from 'child_process'

const PY = `
import json, os, pty, select, sys, time
argv = json.loads(sys.argv[1]); prompt = sys.argv[2].encode(); answer = sys.argv[3]; deadline = time.time() + float(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, os.environ)
out = b''; sent = False
while True:
    if time.time() > deadline:
        os.kill(pid, 9); break
    r, _, _ = select.select([fd], [], [], 0.1)
    if not r:
        continue
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if not sent and answer != '-' and prompt in out:
        os.write(fd, (answer + '\\n').encode()); sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8))
`

export const ptyAvailable: boolean = process.platform !== 'win32'
  && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0

export function runInPty(
  argv: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; prompt?: string; answer?: string | null; timeoutMs?: number },
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PY, JSON.stringify(argv), opts.prompt ?? 'Type yes', opts.answer ?? '-', String((opts.timeoutMs ?? 40_000) / 1000)], {
      env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', c => { output += c })
    child.stderr.on('data', c => { output += c })
    child.once('error', reject)
    child.once('close', status => resolve({ status, output }))
  })
}
