import { describe, it, expect } from "vitest";
import { describeFindings, redactSecrets, scanEntryFields, scanSecrets } from "../src/guards.js";

// Fakes are assembled at runtime so this file itself never contains a real-looking secret.
const join = (...p: string[]) => p.join("");
const FAKES: [string, string][] = [
  ["AWS access key", join("AKIA", "IOSFODNN7EXAMPLE")],
  ["GitHub token", join("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")],
  ["GitHub token", join("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK")],
  ["Anthropic API key", join("sk-ant-", "api03-AbCdEfGhIjKlMnOpQrStUvWx")],
  ["OpenAI API key", join("sk-", "proj-AbCdEfGhIjKlMnOpQrStUvWx12")],
  ["Google API key", join("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")],
  ["Stripe key", join("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc")],
  ["Slack token", join("xoxb-", "123456789012-abcdefABCDEF")],
  ["npm token", join("npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")],
  ["Hugging Face token", join("hf_", "AbCdEfGhIjKlMnOpQrStUvWx12")],
  ["Supabase token", join("sbp_", "0123456789abcdef0123456789abcdef01234567")],
  ["Groq API key", join("gsk_", "AbCdEfGhIjKlMnOpQrStUvWx1234")],
  ["Resend API key", join("re_", "AbCdEfGhIjKlMnOpQrStUvWx1234")],
  ["Telegram bot token", join("123456789", ":AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")],
  ["Private key", join("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEow")],
  ["JWT", join("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")],
  ["Password in URL", join("postgres://", "admin:", "hunter2pass", "@db.example.com:5432/app")],
  ["Bearer token", join("Bearer ", "AbCdEf1234567890GhIjKlMnOp")],
  ["Secret assignment", join("DB_PASS", "=", "MyRealPass99!")],
  ["High-entropy string", join("Zx9", "Qw7rT2mN8vB4kL6pH3sD5fG1jA0cE9uY")],
];

describe("scanSecrets", () => {
  for (const [type, value] of FAKES) {
    it(`detects ${type}: ${value.slice(0, 8)}…`, () => {
      const found = scanSecrets(`Here it is: ${value} — use it.`);
      expect(found.map((f) => f.type)).toContain(type);
      const f = found.find((x) => x.type === type)!;
      expect(f.masked).toMatch(/^.{1,4}…$/);
      expect(f.masked).not.toContain(value.slice(4, 8));
    });
  }

  it("reports an Anthropic key once, not also as OpenAI", () => {
    const found = scanSecrets(join("key ", "sk-ant-", "api03-AbCdEfGhIjKlMnOpQrStUvWx"));
    expect(found.map((f) => f.type)).toEqual(["Anthropic API key"]);
  });

  it("detects and completely redacts slash-containing Base64 and credential assignments", () => {
    const token = ["AbCdeFgHiJ", "kLMnOpQrSt", "/vWxYZaBcD", "eFgHiJkLmN"].join("");
    for (const value of [token, token + "hA=="]) expect(redactSecrets(value).text).toBe("[redacted]");
    for (const key of ["AWS_SECRET_ACCESS_KEY", "AZURE_STORAGE_KEY", "SIGNING_KEY", "ENCRYPTION_KEY",
      "MASTER_KEY", "REFRESH_TOKEN", "SESSION_TOKEN", "BOT_TOKEN"]) {
      expect(redactSecrets(key + "=" + token).text).toBe(key + "=[redacted]");
      expect(scanSecrets(key + "=changeme")).toEqual([]);
    }
  });

  it("does not flag hashes, uuids, paths or prose", () => {
    const benign = [
      "Commit 3ec4eb0f1f64e74a1b2c3d4e5f60718293a4b5c6 fixed it.",
      "Project id 8a97f68e-97b5-4ddf-9978-e1ae025dd821.",
      String.raw`Run C:\Users\ev\Desktop\BAĞLAM\dist\cli.js mcp`,
      "Install @modelcontextprotocol/sdk and zod, see pnpm-lock.yaml.",
      "Bu projede paket yöneticisi olarak pnpm kullanıyoruz; package-lock.json oluşturmayın.",
      "Use the useEffectEventHandlerWithCleanupAndRetry hook in components.",
      "https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md",
    ];
    for (const text of benign) expect(scanSecrets(text), text).toEqual([]);
  });

  it("does not flag forward-slash paths, URLs, identifiers or lockfile hashes", () => {
    const benign = [
      "/Users/ev/Desktop/BAGLAM/docs/superpowers/plans/2026-11-17-m3-guards-trust.md",
      "/api/v2/Users/GetProfile/2024/Settings_OAuth2",
      "https://github.com/OpenAI/Repo/blob/2458367/src/clients/CodexAdapter2024.ts",
      "Release_x64_Win10SDK_2024Q3_NodeV24",
      "getUserById2FAEnabledV3WithRetry123",
      "integrity sha512-Kq5sNclPz7QV2+lfQIuqNHUY3pCrnKz7nVyFvBYgvMBbmhoZnqnG6zMH3H4mFmuEuMB2Y4Eh0zg0uOnrsSZtw==",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
      "Use postgres://user:password@localhost:5432/app in .env.example",
      "DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app",
      "mysql://<user>:<pass>@host/db",
      "Prefix keys with sk-proj-placeholder-example-value in docs",
      "DB_PASSWORD=changeme in .env.example",
      "API_KEY=${MY_API_KEY} and PRIVATE_KEY=/etc/ssl/private.pem",
      "Authorization: Bearer your_token_here_please",
    ];
    for (const text of benign) expect(scanSecrets(text), text).toEqual([]);
  });

  it("redactSecrets replaces only the secret, keeps the surrounding text, and leaves zero scan findings", () => {
    const aws = join("AKIA", "IOSFODNN7EXAMPLE");
    const db = join("postgres://", "admin:", "hunter2pass", "@db.example.com:5432/app");
    const envLine = join("DB_PASSWORD", "=", "MyRealPass99!");
    const text = `Plan:\n1. Use ${aws} for S3\n2. Connect ${db}\n3. Set ${envLine}\n4. Run tests.`;
    const r = redactSecrets(text);
    expect(r.redacted).toBe(true);
    expect(r.text).toBe("Plan:\n1. Use [redacted] for S3\n2. Connect postgres://admin:[redacted]@db.example.com:5432/app\n3. Set DB_PASSWORD=[redacted]\n4. Run tests.");
    expect(scanSecrets(r.text)).toEqual([]);
  });

  it("still catches a random token next to slashes", () => {
    const tok = ["Zx9", "Qw7rT2mN8vB4kL6pH3sD5fG1jA0cE9uY"].join("");
    expect(scanSecrets(`token: ${tok}/`).map((f) => f.type)).toEqual(["High-entropy string"]);
  });

  it("matches URL passwords case-insensitively", () => {
    expect(scanSecrets(["Postgres://", "admin:", "hunter2pass", "@db.example.com"].join("")).map((f) => f.type)).toEqual([
      "Password in URL",
    ]);
  });
});

describe("scanEntryFields", () => {
  const key = join("AKIA", "IOSFODNN7EXAMPLE");
  it("scans every field", () => {
    expect(scanEntryFields({ title: "t", body: "b", rationale: `because ${key}` })).toHaveLength(1);
    expect(scanEntryFields({ title: "t", body: "b", tags: ["x", key] })).toHaveLength(1);
    expect(scanEntryFields({ title: key, body: "b" })).toHaveLength(1);
    expect(scanEntryFields({ title: "t", body: "b", audience: ["cursor", key] })).toHaveLength(1);
    expect(scanEntryFields({ title: "t", body: "b" })).toEqual([]);
  });
});

describe("describeFindings", () => {
  it("formats a comma list", () => {
    expect(describeFindings([{ type: "AWS access key", masked: "AKIA…" }, { type: "JWT", masked: "eyJh…" }])).toBe(
      "AWS access key (AKIA…), JWT (eyJh…)",
    );
  });
});
