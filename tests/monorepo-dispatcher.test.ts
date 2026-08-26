import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  'working-directory'?: string;
};

type Job = {
  needs?: string | string[];
  if?: string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  strategy?: { 'max-parallel'?: number; matrix?: Record<string, string> };
  outputs?: Record<string, string>;
  steps: Step[];
};

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const repoRoot = path.resolve(__dirname, '..');
const examplePath = path.join(repoRoot, 'examples', 'monorepo-dispatcher.yml');
const exampleText = readFileSync(examplePath, 'utf8');
const workflow = parse(exampleText) as Workflow;
const detectJob = workflow.jobs.detect;
const detector = detectJob?.steps.find((step) => step.id === 'changes')?.run ?? '';
const temporaryRoots: string[] = [];

function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }).trim();
}

function createFixture(): { root: string; initial: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'monorepo-dispatcher-'));
  temporaryRoots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture User']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  for (const service of ['orders', 'payments']) {
    mkdirSync(path.join(root, 'services', service, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'services', service, 'postman'), { recursive: true });
    mkdirSync(path.join(root, 'services', service, '.postman'), { recursive: true });
    writeFileSync(path.join(root, 'services', service, 'src', 'index.ts'), `export const name = '${service}';\n`);
    writeFileSync(path.join(root, 'services', service, 'openapi.yaml'), `openapi: 3.0.0\ninfo:\n  title: ${service}\n  version: 1.0.0\npaths: {}\n`);
    writeFileSync(path.join(root, 'services', service, 'postman', 'collection.yaml'), '$kind: collection\n');
    writeFileSync(path.join(root, 'services', service, '.postman', 'resources.yaml'), 'canonical: {}\n');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: seed services']);
  return { root, initial: git(root, ['rev-parse', 'HEAD']) };
}

function commit(root: string, message: string, committer?: { name: string; email: string }): string {
  git(root, ['add', '-A']);
  const env = committer
    ? {
        GIT_AUTHOR_NAME: committer.name,
        GIT_AUTHOR_EMAIL: committer.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      }
    : {};
  git(root, ['commit', '-m', message], env);
  return git(root, ['rev-parse', 'HEAD']);
}

function runDetector(
  root: string,
  environment: Partial<Record<'EVENT_NAME' | 'BEFORE_SHA' | 'HEAD_SHA' | 'BASE_REF' | 'DEFAULT_BRANCH', string>>,
): Record<string, string[]> {
  const outputPath = path.join(root, 'github-output.txt');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', detector], {
    cwd: root,
    env: {
      ...process.env,
      EVENT_NAME: environment.EVENT_NAME ?? 'push',
      BEFORE_SHA: environment.BEFORE_SHA ?? '',
      HEAD_SHA: environment.HEAD_SHA ?? git(root, ['rev-parse', 'HEAD']),
      BASE_REF: environment.BASE_REF ?? '',
      DEFAULT_BRANCH: environment.DEFAULT_BRANCH ?? 'main',
      SYNC_COMMITTER_NAME: 'Postman',
      SYNC_COMMITTER_EMAIL: 'support@postman.com',
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: root,
    },
    encoding: 'utf8',
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const outputs: Record<string, string[]> = {};
  for (const line of readFileSync(outputPath, 'utf8').trim().split('\n')) {
    const separator = line.indexOf('=');
    outputs[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1)) as string[];
  }
  return outputs;
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('monorepo dispatcher example', () => {
  it('declares full-history detection and guards empty matrices', () => {
    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining(['pull_request', 'push', 'workflow_dispatch']),
    );
    const checkout = detectJob.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(detectJob.outputs).toEqual({
      'changed-code': '${{ steps.changes.outputs.changed-code }}',
      'changed-collections': '${{ steps.changes.outputs.changed-collections }}',
    });
    expect(workflow.jobs.onboard.if).toContain("changed-code != '[]'");
    expect(workflow.jobs.run.if).toContain("changed-collections != '[]'");
  });

  it('serializes mutating onboarding while leaving collection runs parallel', () => {
    const onboard = workflow.jobs.onboard;
    const run = workflow.jobs.run;
    expect(onboard.strategy?.['max-parallel']).toBe(1);
    expect(onboard.concurrency).toEqual({
      group: 'postman-sync-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    expect(run.strategy?.['max-parallel']).toBeUndefined();
    const action = onboard.steps.find((step) => step.uses?.includes('postman-api-onboarding-action'));
    expect(action?.uses).toBe('postman-cs/postman-api-onboarding-action@v3');
    expect(action?.with?.['working-directory']).toBe('services/${{ matrix.service }}');
    expect(action?.with?.['project-name']).toBe('${{ matrix.service }}');
    expect(action?.with?.['generate-ci-workflow']).toBe(false);
    expect(action?.with?.['postman-api-key']).toBe('${{ secrets.POSTMAN_API_KEY }}');
    expect(action?.with?.['postman-access-token']).toBeUndefined();
  });

  it('matches the loop backstop to the composite committer defaults', () => {
    const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
    };
    const changes = detectJob.steps.find((step) => step.id === 'changes');
    expect(changes?.env?.SYNC_COMMITTER_NAME).toBe(manifest.inputs['committer-name']?.default);
    expect(changes?.env?.SYNC_COMMITTER_EMAIL).toBe(manifest.inputs['committer-email']?.default);
    expect(detector).toContain('postman/*');
    expect(detector).toContain('.postman/*');
  });

  it('runs both tracked collections through the Postman CLI from service-local resources', () => {
    const run = workflow.jobs.run;
    const combined = run.steps.map((step) => step.run ?? '').join('\n');
    expect(combined).toContain("YAML.load_file('.postman/resources.yaml')");
    expect(combined).toContain('postman login --with-api-key "$POSTMAN_API_KEY"');
    expect(combined).toContain('postman collection run "$uid"');
    expect(combined).toContain('run_collection Smoke "$POSTMAN_SMOKE_COLLECTION_UID"');
    expect(combined).toContain('run_collection Contract "$POSTMAN_CONTRACT_COLLECTION_UID"');
    expect(combined).toContain('::group::');
    expect(combined).toContain('::endgroup::');
  });

  it('dispatches every existing service deterministically', () => {
    const { root } = createFixture();
    expect(runDetector(root, { EVENT_NAME: 'workflow_dispatch' })).toEqual({
      'changed-code': ['orders', 'payments'],
      'changed-collections': ['orders', 'payments'],
    });
  });

  it('classifies code for onboarding and generated artifacts for run-only checks', () => {
    const { root, initial } = createFixture();
    writeFileSync(path.join(root, 'services', 'payments', 'src', 'index.ts'), 'export const changed = true;\n');
    writeFileSync(path.join(root, 'services', 'payments', 'postman', 'collection.yaml'), '$kind: changed\n');
    writeFileSync(path.join(root, 'services', 'orders', '.postman', 'resources.yaml'), 'canonical: {changed: true}\n');
    const head = commit(root, 'feat: change service and generated state');

    expect(runDetector(root, { BEFORE_SHA: initial, HEAD_SHA: head })).toEqual({
      'changed-code': ['payments'],
      'changed-collections': ['orders', 'payments'],
    });
  });

  it('uses the default-branch merge base for a new branch push', () => {
    const { root } = createFixture();
    git(root, ['checkout', '-b', 'feature']);
    writeFileSync(path.join(root, 'services', 'orders', 'src', 'index.ts'), 'export const branch = true;\n');
    const head = commit(root, 'feat: branch change');

    expect(
      runDetector(root, {
        BEFORE_SHA: '0000000000000000000000000000000000000000',
        HEAD_SHA: head,
        DEFAULT_BRANCH: 'main',
      }),
    ).toEqual({
      'changed-code': ['orders'],
      'changed-collections': ['orders'],
    });
  });

  it('uses the pull-request merge base', () => {
    const { root } = createFixture();
    git(root, ['checkout', '-b', 'feature']);
    writeFileSync(path.join(root, 'services', 'payments', 'openapi.yaml'), 'openapi: 3.1.0\n');
    const head = commit(root, 'feat: update pull request spec');

    expect(
      runDetector(root, { EVENT_NAME: 'pull_request', BASE_REF: 'main', HEAD_SHA: head }),
    ).toEqual({
      'changed-code': ['payments'],
      'changed-collections': ['payments'],
    });
  });

  it('suppresses onboarding for the generated committer but preserves collection checks', () => {
    const { root, initial } = createFixture();
    writeFileSync(path.join(root, 'services', 'payments', 'src', 'index.ts'), 'export const generated = true;\n');
    const head = commit(root, 'chore: generated sync', {
      name: 'Postman',
      email: 'support@postman.com',
    });

    expect(runDetector(root, { BEFORE_SHA: initial, HEAD_SHA: head })).toEqual({
      'changed-code': [],
      'changed-collections': ['payments'],
    });
  });

  it('omits deleted services instead of producing an invalid matrix', () => {
    const { root, initial } = createFixture();
    rmSync(path.join(root, 'services', 'orders'), { recursive: true, force: true });
    const head = commit(root, 'chore: remove orders service');

    expect(runDetector(root, { BEFORE_SHA: initial, HEAD_SHA: head })).toEqual({
      'changed-code': [],
      'changed-collections': [],
    });
  });
});
