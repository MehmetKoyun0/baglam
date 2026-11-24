import type { ContextStore, Entry, NewEntry, TrustRule } from "./store.js";
import { scanEntryFields, type SecretFinding } from "./guards.js";

export type ProposalOutcome =
  | { status: "blocked"; findings: SecretFinding[] }
  | { status: "refused"; reason: string }
  /** `similar`: open look-alikes; `closed`: rejected/superseded look-alikes. For the owner, not the agent. */
  | { status: "pending"; entry: Entry; similar: Entry[]; closed: Entry[] }
  | { status: "auto-approved"; entry: Entry; rule: TrustRule }
  /** Autonomous mode: shared now, the owner reviews it afterwards. */
  | { status: "auto-shared"; entry: Entry };

export interface PolicyContext {
  /** True only when the agent's name came from BAGLAM_AGENT (set by setup), not from the client. */
  agentVerified: boolean;
  floodLimit: number;
  /** The project shares verified agents' records now and the owner reviews them afterwards. */
  autonomous?: boolean;
}

export const DEFAULT_FLOOD_LIMIT = 20;

export function floodLimitFromEnv(): number {
  const n = Number(process.env.BAGLAM_FLOOD_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FLOOD_LIMIT;
}

/**
 * Decide what happens to an agent's proposal, in this order:
 * secrets → flood limit → similar records → trust rule → pending review.
 */
export function submitProposal(
  store: ContextStore,
  input: NewEntry & { sourceAgent: string },
  ctx: PolicyContext,
): ProposalOutcome {
  const findings = scanEntryFields(input);
  if (findings.length) return { status: "blocked", findings };

  const text = { title: input.title, body: input.body };
  const similar = store.findSimilar(input.project, text, { kind: input.kind });
  // Look-alikes of records the owner already rejected or replaced: never let a rule bring those back.
  const closed = store.findClosedSimilar(input.project, text, { kind: input.kind });
  const entry = store.proposeWithinLimit({ ...input, similarTo: [...similar, ...closed].map((e) => e.id) }, ctx.floodLimit);

  if (typeof entry === "number") {
    return {
      status: "refused",
      reason: `${entry} proposals are already waiting for review; stop proposing until the owner reviews them.`,
    };
  }

  // Autonomous mode: share now, review afterwards; only something the owner already rejected waits.
  if (ctx.autonomous && ctx.agentVerified && !store.findRejectedSimilar(input.project, text, { kind: input.kind }).length) {
    return { status: "auto-shared", entry: store.approve(entry.id, "autonomous-mode", undefined, { auto: true, review: true }) };
  }

  // Trust rules only shortcut clean, additive records: never replacements, never look-alikes.
  const rule =
    ctx.agentVerified && !input.supersedes && !similar.length && !closed.length
      ? store.matchTrustRule(input.project, input.sourceAgent, input.kind)
      : undefined;
  if (rule) {
    return { status: "auto-approved", entry: store.approve(entry.id, `trust-rule:${rule.id}`, undefined, { auto: true }), rule };
  }
  return { status: "pending", entry, similar, closed };
}
