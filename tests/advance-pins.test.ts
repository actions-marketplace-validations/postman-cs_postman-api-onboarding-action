/**
 * Sibling pin auto-advance contract.
 *
 * Pins the invariants that keep the pin-advance path safe: an advance never
 * crosses the recorded major, never touches rolling aliases, and the
 * advance-pins workflow validates the moved pins with the sibling-pin gate
 * and the full test suite before anything is pushed or a PR is opened.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractPins,
  latestImmutableForMajor,
  planAdvance,
  rewritePinLiterals
} from '../scripts/advance-pins.mjs';

const repoRoot = process.cwd();
const advanceWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/advance-pins.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const actionManifest = readFileSync(join(repoRoot, 'action.yml'), 'utf8');

describe('pin extraction', () => {
  it('extracts every immutable sibling pin from the real manifest', () => {
    const pins = extractPins(actionManifest);
    const repos = pins.map((pin) => pin.repo).sort();
    expect(repos).toEqual([
      'postman-bootstrap-action',
      'postman-insights-onboarding-action',
      'postman-repo-sync-action',
      'postman-smoke-flow-action'
    ]);
    for (const pin of pins) {
      expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(pin.major).toBe(Number(pin.tag.slice(1).split('.')[0]));
    }
  });

  it('rejects conflicting pins for the same sibling', () => {
    const text = [
      'uses: postman-cs/postman-bootstrap-action@v2.13.7',
      'uses: postman-cs/postman-bootstrap-action@v2.13.8'
    ].join('\n');
    expect(() => extractPins(text)).toThrow(/conflicting pins/);
  });
});

describe('advance planning', () => {
  const tags = ['v1.9.9', 'v2.13.8', 'v2.14.0', 'v3.0.0', 'v2.14', 'v2', 'not-a-tag'];

  it('selects the newest immutable tag of the recorded major only', () => {
    expect(latestImmutableForMajor(tags, 2)).toBe('v2.14.0');
    expect(latestImmutableForMajor(tags, 3)).toBe('v3.0.0');
    expect(latestImmutableForMajor(tags, 4)).toBeNull();
  });

  it('advances within the major and never across it', () => {
    const pins = [{ repo: 'postman-bootstrap-action', tag: 'v2.13.8', major: 2 }];
    const plan = planAdvance(pins, new Map([['postman-bootstrap-action', tags]]));
    expect(plan).toEqual([{ repo: 'postman-bootstrap-action', from: 'v2.13.8', to: 'v2.14.0' }]);
  });

  it('plans nothing when the pin is already newest in its major', () => {
    const pins = [{ repo: 'postman-bootstrap-action', tag: 'v2.14.0', major: 2 }];
    expect(planAdvance(pins, new Map([['postman-bootstrap-action', tags]]))).toEqual([]);
  });
});

describe('pin literal rewriting', () => {
  it('rewrites every immutable literal but leaves rolling aliases alone', () => {
    const text = [
      'uses: postman-cs/postman-bootstrap-action@v2.13.7',
      '`postman-cs/postman-bootstrap-action@v2.13.7`',
      'postman-cs/postman-bootstrap-action@v2',
      'postman-cs/postman-repo-sync-action@v2.6.8'
    ].join('\n');
    const result = rewritePinLiterals(text, 'postman-bootstrap-action', 'v2.13.8');
    expect(result).toContain('uses: postman-cs/postman-bootstrap-action@v2.13.8');
    expect(result).toContain('`postman-cs/postman-bootstrap-action@v2.13.8`');
    expect(result).toContain('postman-cs/postman-bootstrap-action@v2\n');
    expect(result).toContain('postman-cs/postman-repo-sync-action@v2.6.8');
  });
});

describe('advance-pins workflow', () => {
  it('listens for sibling release dispatches with a cron backstop and manual trigger', () => {
    expect(advanceWorkflow).toContain('repository_dispatch');
    expect(advanceWorkflow).toContain('sibling-release');
    expect(advanceWorkflow).toContain('schedule:');
    expect(advanceWorkflow).toContain('workflow_dispatch');
  });

  it('validates moved pins with the sibling-pin gate and full tests before pushing', () => {
    const validate = advanceWorkflow.indexOf('node scripts/check-sibling-pins.mjs');
    const fullTests = advanceWorkflow.indexOf('npm test');
    const push = advanceWorkflow.indexOf('git push origin HEAD:main');
    expect(validate).toBeGreaterThan(-1);
    expect(fullTests).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(push);
    expect(fullTests).toBeLessThan(push);
  });

  it('commits with a conventional fix scope so Auto Release cuts a patch', () => {
    expect(advanceWorkflow).toContain('fix(deps): advance sibling pins');
  });

  it('falls back to a pull request when main cannot be pushed directly', () => {
    expect(advanceWorkflow).toContain('gh pr create');
  });
});
