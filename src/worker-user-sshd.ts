import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";

/**
 * The worker account's own sshd (macOS, `omp-sa worker add --user-sshd`): a non-root OpenSSH that only this account can
 * log in to, listening on the worker's tailnet address at an unprivileged port, run by a LaunchAgent in the account's own
 * gui domain. macOS Remote Login needs an administrator and listens on every interface, and Tailscale SSH owns the
 * tailnet :22 and ignores authorized_keys options, so this is the path that needs no admin and no GUI step.
 *
 *   ~/.omp-sa-sshd/                    0700  ssh_host_ed25519_key(.pub), sshd_config 0600, sshd.pid, sshd.log
 *   ~/Library/LaunchAgents/<label>.plist     /usr/sbin/sshd -D -f <dir>/sshd_config -E <dir>/sshd.log
 */
export const USER_SSHD_LABEL = "com.omp-superagent.sshd";
export const USER_SSHD_DIRECTORY = ".omp-sa-sshd";
export const USER_SSHD_BINARY = "/usr/sbin/sshd";
/** launchd runs a non-root sshd as this account; binding below 1024 needs root. */
export const USER_SSHD_MIN_PORT = 1024;

export const userSshdDirectory = (home: string): string => join(home, USER_SSHD_DIRECTORY);
export const userSshdPlistPath = (home: string, label = USER_SSHD_LABEL): string => join(home, "Library", "LaunchAgents", `${label}.plist`);

/** `ListenAddress` value: an IPv6 literal needs brackets around the address before the port. */
export const listenAddress = (host: string, port: number): string => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

export interface UserSshdDesired {
  /** The worker's real home directory. */
  readonly home: string;
  readonly user: string;
  /** `ListenAddress` values, each `<address>:<port>` (see listenAddress). */
  readonly listen: readonly string[];
  readonly label?: string;
}

export function userSshdConfig({ home, user, listen }: UserSshdDesired): string {
  const directory = userSshdDirectory(home);
  return [
    "# Managed by omp-sa worker add --user-sshd; edits are replaced (the previous file is kept as sshd_config.bak-*).",
    ...listen.map(address => `ListenAddress ${address}`),
    `HostKey ${directory}/ssh_host_ed25519_key`,
    `PidFile ${directory}/sshd.pid`,
    "AuthorizedKeysFile .ssh/authorized_keys",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "UsePAM no",
    "PermitRootLogin no",
    `AllowUsers ${user}`,
    "UseDNS no",
    "StrictModes yes",
    "",
  ].join("\n");
}

const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function userSshdPlist({ home, label = USER_SSHD_LABEL }: UserSshdDesired): string {
  const directory = userSshdDirectory(home);
  const argv = [USER_SSHD_BINARY, "-D", "-f", `${directory}/sshd_config`, "-E", `${directory}/sshd.log`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${argv.map(entry => `\t\t<string>${xml(entry)}</string>`).join("\n")}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
</dict>
</plist>
`;
}

/** What the worker has now (null: absent); `launchd` is the agent's launchd state (`running`, `waiting`, ...) or null when it is not loaded. */
export interface UserSshdState {
  readonly config: string | null;
  readonly plist: string | null;
  readonly hostKey: string | null;
  readonly launchd: string | null;
}

type FileDecision = "create" | "unchanged" | "update";
export interface UserSshdPlan {
  readonly config: FileDecision;
  readonly plist: FileDecision;
  readonly hostKey: "keep" | "create";
  /** bootstrap: load the agent; kickstart: restart it to read a changed config; reload: the plist itself changed (bootout, then bootstrap). */
  readonly launchd: "none" | "bootstrap" | "kickstart" | "reload";
}

const decide = (current: string | null, desired: string): FileDecision => current === null ? "create" : current === desired ? "unchanged" : "update";

/** A matching, running agent is left alone; anything else is brought to the desired files and a running agent. */
export function planUserSshd(state: UserSshdState, desired: UserSshdDesired): UserSshdPlan {
  const config = decide(state.config, userSshdConfig(desired));
  const plist = decide(state.plist, userSshdPlist(desired));
  const launchd = state.launchd === null ? "bootstrap" : plist !== "unchanged" ? "reload"
    : config !== "unchanged" || state.launchd !== "running" ? "kickstart" : "none";
  return { config, plist, hostKey: state.hostKey === null ? "create" : "keep", launchd };
}

export interface UserSshdFacts {
  readonly state: string;
  /** Addresses the agent's sshd process is listening on (`<address>:<port>`). */
  readonly listening: string[];
}

function run(argv: string[]): { code: number | null; stdout: string } {
  const child = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  return { code: child.exitCode, stdout: child.stdout.toString("utf8") };
}

/**
 * The agent's state as the worker itself sees it (the account's own launchd domain), or null when the agent is not set up
 * here. Reads only launchd and the process's sockets; nothing here can raise a dialog.
 */
export function userSshdFacts(home = homedir(), uid = process.getuid!(), label = USER_SSHD_LABEL): UserSshdFacts | null {
  if (!existsSync(userSshdPlistPath(home, label))) return null;
  const printed = run(["/bin/launchctl", "print", `gui/${uid}/${label}`]);
  if (printed.code !== 0) return { state: "not loaded", listening: [] };
  const state = /^\s*state = (\S+)/m.exec(printed.stdout)?.[1] ?? "loaded";
  const pid = /^\s*pid = (\d+)/m.exec(printed.stdout)?.[1];
  if (!pid) return { state, listening: [] };
  const sockets = run(["/usr/sbin/lsof", "-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-Fn"]).stdout;
  return { state, listening: sockets.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1)) };
}
