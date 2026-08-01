/**
 * WS7 composite handoff contracts.
 *
 * Every `steps.<id>.outputs.<name>` reference inside action.yml is an edge from
 * a producing step to a consumer (a later step's `with:`/`env:` or the
 * composite `outputs:` block). This suite enumerates every edge mechanically
 * and asserts each one against the PRODUCING action's declared outputs, read
 * from the sibling checkout's action.yml (bootstrap, smoke-flow, repo-sync,
 * insights-onboarding) or, for local `run:` steps, from the literal
 * `$GITHUB_OUTPUT` writes in the step script. A renamed or dropped output in a
 * producer goes red here before it ships as a dangling `${{ }}` that GitHub
 * silently evaluates to an empty string.
 *
 * Golden-shape assertions pin the cross-action JSON payloads (`collections-json`,
 * `branch-decision`, `environment-uids-json`, `repo-sync-summary-json`) to the
 * exact key sets the producers serialize today, sourced from the sibling
 * src/index.ts serializers — see the SHAPES table.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const actionsRoot = path.resolve(repoRoot, '..');

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type ActionManifest = {
  runs: { using: string; steps?: Step[] };
  outputs?: Record<string, { description?: string; value?: string }>;
};

function loadManifest(): ActionManifest {
  return parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as ActionManifest;
}

/** Map step id -> sibling checkout directory holding the producing action. */
const SIBLING_PRODUCERS: Record<string, string> = {
  bootstrap: 'postman-bootstrap-action',
  smoke_flow: 'postman-smoke-flow-action',
  repo_sync: 'postman-repo-sync-action',
  insights_onboarding: 'postman-insights-onboarding-action'
};

function siblingManifestPath(dir: string): string {
  return path.join(actionsRoot, dir, 'action.yml');
}

function declaredOutputs(dir: string): Set<string> {
  const manifest = parse(readFileSync(siblingManifestPath(dir), 'utf8')) as ActionManifest;
  return new Set(Object.keys(manifest.outputs ?? {}));
}

/** Outputs a local `run:` step writes via `>> $GITHUB_OUTPUT` / appendFileSync(GITHUB_OUTPUT). */
function runStepOutputs(step: Step): Set<string> {
  const script = step.run ?? '';
  const names = new Set<string>();
  // shell form: echo "name=value" >> "$GITHUB_OUTPUT" (any quoting)
  for (const match of script.matchAll(/echo\s+"?([A-Za-z0-9_-]+)=[^\n]*?"?\s*>>\s*"?\$\{?GITHUB_OUTPUT\}?"?/g)) {
    names.add(match[1]!);
  }
  // node form: appendFileSync(process.env.GITHUB_OUTPUT, `a=...\nb=...`)
  for (const match of script.matchAll(/appendFileSync\(\s*process\.env\.GITHUB_OUTPUT\s*,\s*`([^`]*)`/g)) {
    for (const segment of match[1]!.split('\\n')) {
      const pair = segment.match(/^([A-Za-z0-9_-]+)=/);
      if (pair) names.add(pair[1]!);
    }
  }
  return names;
}

type Edge = { step: string; output: string; site: string };

/** Every steps.<id>.outputs.<name> reference in the manifest with its consuming site. */
function collectEdges(manifest: ActionManifest): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const record = (site: string, text: string) => {
    for (const match of text.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const key = `${match[1]}.${match[2]}@${site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ step: match[1]!, output: match[2]!, site });
    }
  };
  for (const [name, output] of Object.entries(manifest.outputs ?? {})) {
    record(`outputs.${name}`, output.value ?? '');
  }
  for (const step of manifest.runs.steps ?? []) {
    const site = `step ${step.id ?? '(anonymous)'}`;
    for (const [key, value] of Object.entries(step.with ?? {})) record(`${site} with.${key}`, value);
    for (const [key, value] of Object.entries(step.env ?? {})) record(`${site} env.${key}`, value);
    record(`${site} run`, step.run ?? '');
  }
  return edges;
}

describe('composite handoff edges', () => {
  const manifest = loadManifest();
  const steps = manifest.runs.steps ?? [];
  const stepById = new Map(steps.filter((step) => step.id).map((step) => [step.id!, step]));
  const edges = collectEdges(manifest);

  it('sibling checkouts exist for every uses-step producer', () => {
    for (const dir of Object.values(SIBLING_PRODUCERS)) {
      expect(existsSync(siblingManifestPath(dir)), `missing sibling checkout: ${dir}`).toBe(true);
    }
  });

  it('covers the full edge surface (ratchet: update this count when edges change)', () => {
    // Every distinct (producer step, output, consuming site) triple.
    expect(edges.length).toBe(48);
    const distinctPairs = new Set(edges.map((edge) => `${edge.step}.${edge.output}`));
    expect(distinctPairs.size).toBe(34);
  });

  it('every referenced step id exists in the composite', () => {
    for (const edge of edges) {
      expect(stepById.has(edge.step), `${edge.site} references unknown step ${edge.step}`).toBe(true);
    }
  });

  it('every uses-step edge resolves to a declared output of the producing action', () => {
    for (const edge of edges) {
      const producerDir = SIBLING_PRODUCERS[edge.step];
      if (!producerDir) continue;
      const declared = declaredOutputs(producerDir);
      expect(
        declared.has(edge.output),
        `${edge.site} references ${edge.step}.outputs.${edge.output}, not declared by ${producerDir}/action.yml`
      ).toBe(true);
    }
  });

  it('every run-step edge resolves to a literal GITHUB_OUTPUT write in that step', () => {
    for (const edge of edges) {
      if (SIBLING_PRODUCERS[edge.step]) continue;
      const producer = stepById.get(edge.step);
      expect(producer, `${edge.site} references unknown local step ${edge.step}`).toBeDefined();
      const written = runStepOutputs(producer!);
      expect(
        written.has(edge.output),
        `${edge.site} references ${edge.step}.outputs.${edge.output}, never written to GITHUB_OUTPUT by that step`
      ).toBe(true);
    }
  });

  it('every composite output forwards from a real producer output or a declared input', () => {
    for (const [name, output] of Object.entries(manifest.outputs ?? {})) {
      const value = output.value ?? '';
      const stepRefs = [...value.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)];
      const inputRefs = [...value.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)];
      const statusRefs = [...value.matchAll(/steps\.([A-Za-z0-9_-]+)\.(outcome|conclusion)/g)];
      expect(
        stepRefs.length + inputRefs.length + statusRefs.length,
        `composite output ${name} forwards nothing`
      ).toBeGreaterThan(0);
      // Status forwards must still point at a real step.
      for (const ref of statusRefs) {
        expect(stepById.has(ref[1]!), `output ${name} references unknown step ${ref[1]}`).toBe(true);
      }
    }
  });
});

/**
 * Golden shapes: exact key sets of the cross-action JSON payloads, pinned to
 * the producing serializers:
 * - collections-json: bootstrap src/index.ts (all three serialization sites emit {baseline, contract, smoke})
 * - branch-decision: composite branch_decision run step + repo-sync src/lib/repo/branch-decision.ts BranchDecision
 * - environment-uids-json: repo-sync setOutput(JSON.stringify(envUids)) — flat name->uid string map
 * - repo-sync-summary-json: repo-sync createRepoSummary + the gated-skip variant
 */
describe('golden handoff shapes', () => {
  const COLLECTIONS_JSON_KEYS = ['baseline', 'contract', 'smoke'] as const;
  const BRANCH_DECISION_REQUIRED = ['tier', 'strategy', 'identity', 'reason'] as const;
  const BRANCH_DECISION_OPTIONAL = ['canonicalBranch', 'channel'] as const;
  const REPO_SYNC_SUMMARY_KEYS = [
    'commitSha',
    'environmentCount',
    'environmentSyncStatus',
    'mockEnvironmentStatus',
    'mockEnvironmentUid',
    'mockAuthRequired',
    'mockUrl',
    'mockVisibility',
    'monitorId',
    'pushed',
    'resolvedCurrentRef',
    'workspaceLinkStatus'
  ] as const;
  const REPO_SYNC_SUMMARY_GATED_KEYS = ['status', 'reason'] as const;

  function sourceOf(dir: string, file: string): string {
    return readFileSync(path.join(actionsRoot, dir, file), 'utf8');
  }

  it('collections-json: every bootstrap serialization site emits exactly {baseline, contract, smoke}', () => {
    const source = sourceOf('postman-bootstrap-action', 'src/index.ts');
    const sites = [...source.matchAll(/'collections-json'\]?\s*[:=]\s*JSON\.stringify\(\{([^}]*)\}/g)];
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const site of sites) {
      const keys = [...site[1]!.matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((match) => match[1]).sort();
      expect(keys).toEqual([...COLLECTIONS_JSON_KEYS].sort());
    }
  });

  it('branch-decision: the composite decide step serializes the repo-sync BranchDecision key set', () => {
    const manifest = loadManifest();
    const decide = (manifest.runs.steps ?? []).find((step) => step.id === 'branch_decision');
    expect(decide?.run).toBeDefined();
    // The literal serialized object in the decide step.
    expect(decide!.run).toContain(
      "const decision = { tier, strategy, identity, canonicalBranch, ...(channel && tier === 'channel' ? { channel } : {}), reason };"
    );
    // And the repo-sync consumer type declares the same keys, nothing more.
    const bdSource = sourceOf('postman-repo-sync-action', 'src/lib/repo/branch-decision.ts');
    const block = bdSource.match(/export interface BranchDecision \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    const declared = [...block![1]!.matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm)].map((match) => match[1]).sort();
    expect(declared).toEqual(
      [...BRANCH_DECISION_REQUIRED, ...BRANCH_DECISION_OPTIONAL].sort()
    );
  });

  it('environment-uids-json: repo-sync emits a flat JSON map (JSON.stringify of the envUids record)', () => {
    const source = sourceOf('postman-repo-sync-action', 'src/index.ts');
    expect(source).toContain("setOutput('environment-uids-json', JSON.stringify(envUids))");
    // Input side re-parses the same flat map.
    expect(source).toContain("parseJsonMap(getInput('environment-uids-json', env) || '{}')");
  });

  it('repo-sync-summary-json: the summary serializer emits exactly the pinned key set', () => {
    const source = sourceOf('postman-repo-sync-action', 'src/index.ts');
    const summary = source.match(/function createRepoSummary\([\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}\);/);
    expect(summary).not.toBeNull();
    const keys = [...summary![1]!.matchAll(/^\s*([A-Za-z0-9_]+)[,:]/gm)].map((match) => match[1]).sort();
    expect(keys).toEqual([...REPO_SYNC_SUMMARY_KEYS].sort());
  });

  it('repo-sync-summary-json: the gated-skip variant emits exactly {status, reason}', () => {
    const source = sourceOf('postman-repo-sync-action', 'src/index.ts');
    const gated = source.match(
      /outputs\['repo-sync-summary-json'\] = JSON\.stringify\(\{\s*status: 'skipped-branch-gate',\s*reason: decision\.reason\s*\}\);/
    );
    expect(gated, 'gated-skip summary shape changed').not.toBeNull();
    void REPO_SYNC_SUMMARY_GATED_KEYS;
  });
});
