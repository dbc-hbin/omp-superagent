/** Supported owner controls shared by each platform's command picker. */
export const MESSENGER_COMMANDS = [
  { name: "help", description: "Show Superagent commands and their scope." },
  { name: "status", description: "Inspect Superagent HEAD and this conversation's lane, including while busy." },
  { name: "restart", description: "Restart Superagent Gateway and HEAD together when idle, preserving the session." },
  { name: "context", description: "Inspect Superagent HEAD context without starting a model turn." },
  { name: "usage", description: "Inspect Superagent HEAD usage without starting a model turn." },
  { name: "resume", description: "Resume the Superagent lane bound to this conversation." },
  { name: "main", description: "Select the main Superagent topic in this owner DM." },
  { name: "model", description: "Inspect or change the Superagent HEAD model or named preset.", text: "Query, exact provider/model, or preset selection (including an optional --global)." },
  { name: "effort", description: "Inspect or change the Superagent HEAD thinking effort.", text: "An exact advertised effort level; omit to inspect the current effort." },
  { name: "compact", description: "Compact Superagent HEAD context when idle.", text: "Optional compaction instructions, including multiple lines." },
  { name: "stop", description: "Stop Superagent HEAD work or pause a bound or explicitly named lane.", text: "head or an actual lane ID; omit to use this conversation's lane, otherwise HEAD." },
  { name: "new", description: "Start a new Superagent topic in this owner DM, optionally with a request.", text: "An optional first request for the new topic." },
] as const;
