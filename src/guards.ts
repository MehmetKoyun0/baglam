/** Detects credentials in text so they never enter shared memory. Pure functions, no I/O. */

export interface SecretFinding {
  type: string;
  /** Safe to show: first 4 characters and an ellipsis. */
  masked: string;
}

/** A value that is clearly a placeholder in docs or config templates. */
const PLACEHOLDER_VALUE =
  /^(?:\[redacted\]|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|<[^>]*>|\{[^}]*\}|\*+|password|passwd|pass|pwd|secret|token|apikey|api_key|changeme|example|placeholder|dummy|fake|test|none|null|true|false|xxx+|your[_-].*)$/i;

interface SecretPattern {
  type: string;
  re: RegExp;
  accept?: (m: RegExpMatchArray) => boolean;
  /** Sub-range [offsetFromMatchStart, length] to replace when redacting (defaults to whole match). */
  redactPart?: (m: RegExpMatchArray) => [number, number];
}

// Order matters: more specific patterns first; overlapping later matches are ignored.
// `accept` filters out matches that only look like secrets.
const PATTERNS: SecretPattern[] = [
  {
    type: "Private key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:[\r\n]+[A-Za-z0-9+/=]{16,})+)?/g,
  },
  { type: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { type: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // Real keys always carry digits; plain kebab-case words after "sk-" are prose.
  { type: "OpenAI API key", re: /\bsk-(?:proj-)?(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { type: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { type: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { type: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g },
  { type: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { type: "Supabase token", re: /\bsbp_[a-f0-9]{40}\b/g },
  { type: "Groq API key", re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { type: "Resend API key", re: /\bre_[A-Za-z0-9_]{20,}\b/g },
  { type: "Telegram bot token", re: /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,38}\b/g },
  { type: "JWT", re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  {
    type: "Password in URL",
    re: /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@]+):([^\s@/]+)@/gi,
    accept: (m) => !PLACEHOLDER_VALUE.test(m[2]) && !/^<.*>$/.test(m[1]),
    redactPart: (m) => [m[0].lastIndexOf(m[2]), m[2].length],
  },
  {
    type: "Bearer token",
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/g,
    accept: (m) => !PLACEHOLDER_VALUE.test(m[1]) && !/^[a-z]+(?:[_-][a-z]+)+$/i.test(m[1]),
    redactPart: (m) => [m[0].lastIndexOf(m[1]), m[1].length],
  },
  {
    type: "Secret assignment",
    re: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|[A-Z0-9]+_TOKEN|ACCESS_KEY|STORAGE_KEY|ENCRYPTION_KEY|SIGNING_KEY|MASTER_KEY|PRIVATE_KEY|DB_PASS))\s*[:=]\s*["']?([^\s"'`,;]{8,})["']?/gi,
    accept: (m) => {
      const val = m[2];
      if (PLACEHOLDER_VALUE.test(val)) return false;
      if (looksLikeBase64Credential(val)) return true;
      if (val.includes("://") || val.startsWith("/") || val.startsWith(".")) return false;
      if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(val)) return false; // camelCase identifier
      return true;
    },
    redactPart: (m) => [m[0].lastIndexOf(m[2]), m[2].length],
  },
];

// No "/" here: slashes separate path and URL segments, which are checked one by one.
const BASE64_CANDIDATE = /(?<![\w./:+\-=])((?=[A-Za-z0-9+]*\/)[A-Za-z0-9+/]{32,}={0,2})(?![\w./+\-=])/g;
const CANDIDATE = /[A-Za-z0-9+=_-]{32,}/g;
const ENTROPY_THRESHOLD = 4.2;
const HASH_PREFIX = /^(?:sha(?:1|224|256|384|512)|md5)-/i;

/** True for identifiers built from word-like parts: getUserById2FA…, Release_x64_Win10SDK…. */
function wordLike(token: string): boolean {
  const parts = token
    .split(/[_-]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/)
    .filter(Boolean);
  if (parts.length < 3) return false;
  const avg = parts.reduce((n, p) => n + p.length, 0) / parts.length;
  return avg >= 2.5;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeBase64Credential(value: string): boolean {
  return value.length >= 32 && value.length % 4 === 0 && value.includes("/") &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) &&
    entropy(value) > ENTROPY_THRESHOLD;
}

/** Random-looking token: mixed case, several digits, not hex, high entropy. */
function looksRandom(token: string): boolean {
  if (/^[0-9a-f-]+$/i.test(token)) return false; // hashes, UUIDs
  if (HASH_PREFIX.test(token)) return false; // lockfile integrity values
  if (wordLike(token)) return false;
  const digits = (token.match(/[0-9]/g) ?? []).length;
  if (digits < 3 || !/[a-z]/.test(token) || !/[A-Z]/.test(token)) return false;
  return entropy(token) > ENTROPY_THRESHOLD;
}

const mask = (s: string) => `${s.slice(0, 4)}…`;

export const REDACTED = "[redacted]";

interface MatchSpan {
  type: string;
  masked: string;
  /** Exact span to replace in text when redacting. */
  redactStart: number;
  redactEnd: number;
}

function findSecretSpans(text: string): MatchSpan[] {
  const spans: MatchSpan[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);

  for (const { type, re, accept, redactPart } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index!, end = start + m[0].length;
      if (overlaps(start, end)) continue;
      if (accept && !accept(m)) {
        taken.push([start, end]); // a recognised placeholder: not a secret, and not "random" either
        continue;
      }
      taken.push([start, end]);
      const [relOff, relLen] = redactPart ? redactPart(m) : [0, m[0].length];
      spans.push({ type, masked: mask(m[0]), redactStart: start + relOff, redactEnd: start + relOff + relLen });
    }
  }
  for (const [pattern, accepts] of [[BASE64_CANDIDATE, looksLikeBase64Credential], [CANDIDATE, looksRandom]] as const) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index!, end = start + m[0].length;
      if (overlaps(start, end) || !accepts(m[0])) continue;
      taken.push([start, end]);
      spans.push({ type: "High-entropy string", masked: mask(m[0]), redactStart: start, redactEnd: end });
    }
  }
  return spans;
}

export function scanSecrets(text: string): SecretFinding[] {
  return findSecretSpans(text).map(({ type, masked }) => ({ type, masked }));
}

/** Replace only the secret parts in `text` with `[redacted]`, preserving the surrounding plan/notes. */
export function redactSecrets(text: string): { text: string; redacted: boolean; findings: SecretFinding[] } {
  const spans = findSecretSpans(text);
  if (!spans.length) return { text, redacted: false, findings: [] };
  const ordered = [...spans].sort((a, b) => a.redactStart - b.redactStart);
  let out = "";
  let pos = 0;
  for (const s of ordered) {
    if (s.redactStart < pos) continue;
    out += text.slice(pos, s.redactStart) + REDACTED;
    pos = s.redactEnd;
  }
  out += text.slice(pos);
  return { text: out, redacted: true, findings: spans.map(({ type, masked }) => ({ type, masked })) };
}

export function scanEntryFields(f: {
  title: string;
  body: string;
  rationale?: string | null;
  tags?: string[];
  audience?: string[];
}): SecretFinding[] {
  return [f.title, f.body, f.rationale ?? "", ...(f.tags ?? []), ...(f.audience ?? [])].flatMap((t) => scanSecrets(t));
}

export const MAX_DECISION_NOTE = 1000;

export function validateDecisionNote(note?: string | null): void {
  if (!note) return;
  if (note.length > MAX_DECISION_NOTE) throw new Error("decision note exceeds 1000 characters");
  if (scanSecrets(note).length) throw new Error("decision note contains a possible secret");
}

export function describeFindings(findings: SecretFinding[]): string {
  return findings.map((f) => `${f.type} (${f.masked})`).join(", ");
}
