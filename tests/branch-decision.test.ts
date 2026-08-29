import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(__dirname, '..');

function branchDecisionScript(): string {
  const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as {
    runs: { steps: Array<{ id?: string; run?: string }> };
  };
  const run = manifest.runs.steps.find((step) => step.id === 'branch_decision')?.run ?? '';
  const match = run.match(/^node <<'NODE'\n(?<script>[\s\S]*?)\nNODE\s*$/);
  if (!match?.groups?.script) throw new Error('branch_decision Node script not found');
  return match.groups.script;
}

function decide(headRepo: string): Record<string, unknown> {
  const root = mkdtempSync(path.join(tmpdir(), 'branch-decision-'));
  try {
    const eventPath = path.join(root, 'event.json');
    const outputPath = path.join(root, 'output.txt');
    const envPath = path.join(root, 'env.txt');
    writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { default_branch: 'main', full_name: 'postman-cs/example' },
        pull_request: {
          head: { repo: { full_name: headRepo } },
          base: { repo: { full_name: 'postman-cs/example' } },
        },
      }),
    );
    const result = spawnSync(process.execPath, ['-e', branchDecisionScript()], {
      env: {
        ...process.env,
        BRANCH_STRATEGY: 'publish-gate',
        CANONICAL_BRANCH: 'main',
        CHANNELS: '',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: 'refs/pull/1/merge',
        GITHUB_REF_NAME: '1/merge',
        GITHUB_HEAD_REF: 'release/attacker-controlled',
        GITHUB_SHA: '0123456789abcdef',
        GITHUB_OUTPUT: outputPath,
        GITHUB_ENV: envPath,
      },
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const serialized = readFileSync(outputPath, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('branch-decision='))
      ?.slice('branch-decision='.length);
    if (!serialized) throw new Error('branch-decision output not found');
    return JSON.parse(serialized) as Record<string, unknown>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('branch decision fork gating', () => {
  it('keeps a fork PR gated even when its head branch matches the release channel', () => {
    const decision = decide('attacker/fork');
    expect(decision.tier).toBe('gated');
    expect(decision.reason).toBe('fork PR: credentialed tiers are ineligible');
    expect(decision).not.toHaveProperty('channel');
  });

  it('still assigns a same-repository release branch to the injected RC channel', () => {
    const decision = decide('postman-cs/example');
    expect(decision.tier).toBe('channel');
    expect(decision.channel).toEqual({ pattern: 'release/*', code: 'RC' });
  });
});
