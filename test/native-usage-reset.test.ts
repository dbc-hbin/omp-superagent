import { expect, test } from "bun:test";
import { mkdir, mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nativeTestArgv } from "./fixtures/native-command";

// Seatbelt provides a kernel-enforced outbound allowlist for the stock CLI and
// its descendants, including any fallback to an official provider endpoint.
const nativeTest = process.platform === "darwin" && process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("stock usage reset lists without spending and redeems only the selected OAuth account", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), "omp-sa-reset-"));
  const root = await realpath(scratch.path);
  const home = join(root, "home");
  const profile = "usage-reset-fixture";
  const agentDir = join(home, ".omp", "profiles", profile, "agent");
  const phaseFile = join(root, "phase");
  const accountFixtures = [
    { name: "unselected", saved: 3 },
    { name: "selected", saved: 2 },
  ].map(({ name, saved }) => ({
    name, saved, spent: false,
    access: `sk-ant-oat01-synthetic-reset-${name}`,
    accountId: `fixture-account-${name}`,
    orgId: `fixture-org-${name}`,
    grantId: `fixture-grant-${name}`,
  }));
  const reads: { readonly phase: string; readonly name: string }[] = [];
  const posts: { readonly phase: string; readonly name: string; readonly route: string }[] = [];
  const unexpected: string[] = [];
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(phaseFile, "import");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const phase = await readFile(phaseFile, "utf8");
      const url = new URL(request.url);
      const account = accountFixtures.find(row => request.headers.get("authorization") === `Bearer ${row.access}`);
      if (account && request.method === "GET" && url.pathname === "/api/oauth/usage" &&
          url.searchParams.get("cedar_ember") === "1" && url.searchParams.get("skip_spend") === "1") {
        reads.push({ phase, name: account.name });
        return Response.json({
          five_hour: { utilization: account.spent ? 0 : 100, resets_at: "2099-01-01T00:00:00Z" },
          cedar_ember: {
            eligible: true,
            next_grant_id: account.grantId,
            grants: [{
              id: account.grantId,
              resets_left: account.saved,
              usable_now: !account.spent,
              clears: ["five_hour"],
              blocking: account.spent ? [] : ["five_hour"],
            }],
          },
        });
      }
      if (account && request.method === "POST") {
        posts.push({ phase, name: account.name, route: url.pathname });
        const body: unknown = await request.json();
        if (phase === "redeem" && !account.spent &&
            url.pathname === `/api/organizations/${account.orgId}/reset_rate_limits` &&
            body && typeof body === "object" &&
            "program" in body && body.program === "cedar_ember" &&
            "grant_id" in body && body.grant_id === account.grantId) {
          account.saved -= 1;
          account.spent = true;
          return Response.json({ result: "reset", cleared: ["five_hour"] });
        }
      }
      unexpected.push(`${phase}: ${request.method} ${url.pathname}${url.search}`);
      // Discovery does not treat this status as permission to try a different host.
      return Response.json({ error: "unexpected fixture request" }, { status: 500 });
    },
  });
  try {
    await writeFile(join(agentDir, "models.yml"), `providers:\n  anthropic:\n    baseUrl: ${server.url.origin}/v1\n`);
    await writeFile(join(root, "credentials.json"), JSON.stringify({
      version: 1,
      credentials: accountFixtures.map(({ name, access, accountId, orgId }) => ({
        provider: "anthropic",
        credential: {
          type: "oauth", access, refresh: `synthetic-refresh-${name}`, expires: Date.UTC(2099, 0, 1),
          accountId, orgId, email: `${name}@example.invalid`,
        },
      })),
    }), { mode: 0o600 });
    const [executable] = nativeTestArgv();
    if (!executable) throw new Error("No stock OMP executable configured");
    const child = Bun.spawn([
      "/usr/bin/sandbox-exec", "-p",
      `(version 1) (allow default) (deny network*) (allow network-outbound (remote tcp "localhost:${server.port}"))`,
      process.execPath, "--no-env-file", resolve(import.meta.dir, "fixtures/native-usage-reset.ts"),
      executable, profile,
    ], {
      cwd: root,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home, USERPROFILE: home, TMPDIR: root,
        PI_CODING_AGENT_DIR: join(root, "default-agent"),
        PI_NATIVES_DIR: join(root, "natives"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        NO_COLOR: "1",
      },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
      timeout: 150_000, killSignal: "SIGKILL",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Isolated OMP failed (exit ${code}): ${stderr}\n${JSON.stringify({ reads, posts, unexpected })}`);
    expect(unexpected).toEqual([]);
    expect(reads.filter(row => row.phase === "import")).toEqual([]);
    for (const phase of ["list", "readback"]) {
      expect(reads.filter(row => row.phase === phase).map(row => row.name).sort()).toEqual(["selected", "unselected"]);
    }
    expect(posts).toEqual([{
      phase: "redeem", name: "selected", route: "/api/organizations/fixture-org-selected/reset_rate_limits",
    }]);
  } finally {
    await server.stop(true);
  }
}, 160_000);
