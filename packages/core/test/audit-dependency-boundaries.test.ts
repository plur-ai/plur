import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('build dependency resource bounds', () => {
  it('terminates when generating a zero-length custom ID', () => {
    const require = createRequire(import.meta.url);
    const viteRequire = createRequire(require.resolve('vite/package.json'));
    const postcssRequire = createRequire(viteRequire.resolve('postcss/package.json'));
    const nanoid = postcssRequire.resolve('nanoid');
    // Run in a child so a reintroduced infinite loop cannot hang the suite.
    const result = spawnSync(process.execPath, ['-e',
      'const {customAlphabet}=require(process.argv[1]); process.stdout.write(JSON.stringify(customAlphabet("ab",0)()));',
      nanoid,
    ], { encoding: 'utf8', timeout: 2000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('""');
  });
});
