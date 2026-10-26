import { spawnSync as nativeSpawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Capture CLI output through regular files. This avoids pipe/epoll restrictions in sandboxed test runners. */
export function spawnSync(command: string, args: readonly string[] = [], options: SpawnSyncOptions = {}): SpawnSyncReturns<string> {
  const dir = mkdtempSync(join(tmpdir(), 'swift-test-process-'));
  const stdoutPath = join(dir, 'stdout'); const stderrPath = join(dir, 'stderr');
  const out = openSync(stdoutPath, 'w'); const err = openSync(stderrPath, 'w');
  let input: number | 'ignore' = 'ignore';
  try {
    if (options.input !== undefined) { const path = join(dir, 'stdin'); writeFileSync(path, options.input); input = openSync(path, 'r'); }
    const result = nativeSpawnSync(command, args, { ...options, stdio: [input, out, err], encoding: 'utf8' });
    const stdout = readFileSync(stdoutPath, 'utf8'); const stderr = readFileSync(stderrPath, 'utf8');
    return { ...result, stdout, stderr, output: [null, stdout, stderr] };
  } finally {
    closeSync(out); closeSync(err); if (input !== 'ignore') closeSync(input);
    rmSync(dir, { recursive: true, force: true });
  }
}
export function execFileSync(command: string, args: readonly string[] = [], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Child exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}
