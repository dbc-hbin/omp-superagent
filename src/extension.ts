import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Type } from "@sinclair/typebox";
import { configuredPlatforms, loadConfig } from "./config";
import { createGatewayMessenger } from "./gateway-client";
import { Superagent } from "./runtime";
import { Store } from "./store";
import { sameLaneModel } from "./lane-models";
import { NativePresetManager } from "./native-presets";
import { MODEL_PRESET_NAMES, WORKFLOW_NAMES } from "./contracts";

function readHeadReferences(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readHeadReferences(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [readFileSync(path, "utf8")] : [];
    });
}

// Required operating policy, not optional discovery or compactable chat history.
// Missing/unreadable files fail extension loading rather than silently omitting policy.
const headInstructions = [
  readFileSync(new URL("../skills/head/SKILL.md", import.meta.url), "utf8"),
  ...readHeadReferences(fileURLToPath(new URL("../skills/head/references/", import.meta.url))),
];
const managerTools: Record<string, true> = {
  lane_models: true, lane_init_presets: true, lane_set_model: true,
  lane_start: true, lane_inspect: true, lane_message: true,
  lane_pause: true, lane_resume: true, lane_close: true,
};
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  details: {},
});
const workflowSchema = Type.Optional(Type.Object({
  name: Type.Union(WORKFLOW_NAMES.map(name => Type.Literal(name))),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false }));

export default function superagentExtension(pi: ExtensionAPI): void {
  const role = process.env.OMP_SUPERAGENT_ROLE;
  if (role !== "head") return;
  // Subagents inherit environment but must not acquire the head's controller.
  let runtime: Superagent | undefined;
  let loading: Promise<void> | undefined;
  let closed = false;
  let startupError: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let presets: Promise<NativePresetManager> | undefined;
  const requireRuntime = (ctx: ExtensionContext) => {
    if (ctx.agent.kind !== "main") throw new Error("Lane management is restricted to the main superagent head");
    if (!runtime) throw new Error(startupError ? `Superagent startup failed: ${String(startupError)}` : "Superagent is starting; retry once startup completes");
    return runtime;
  };
  const nativePresets = (ctx: ExtensionContext): Promise<NativePresetManager> => {
    requireRuntime(ctx);
    return presets ??= Settings.init({ cwd: ctx.cwd }).then(settings => new NativePresetManager(
      settings,
      async () => {
        const allowed = await requireRuntime(ctx).availableModels();
        const identities = new Set(allowed.map(model => JSON.stringify([model.provider, model.id])));
        return ctx.models.list().filter(model => identities.has(JSON.stringify([model.provider, model.id])));
      },
      provider => ctx.modelRegistry.hasConcreteAuth(provider),
    ));
  };
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    return { systemPrompt: [
      ...event.systemPrompt,
      ...headInstructions,
    ] };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind === "main") return;
    // Subtract only our authority; never restore a default list or activate a
    // native tool that the operator removed from this particular task session.
    const active = pi.getActiveTools();
    const scoped = active.filter(name => !Object.hasOwn(managerTools, name));
    if (scoped.length !== active.length) await pi.setActiveTools(scoped);
  });
  pi.registerTool({
    name: "lane_models", label: "Inspect lane model candidates", approval: "read", loadMode: "essential",
    description: "Inspect the user's native OMP presets/roles plus enabled authenticated chat-model candidates and safe capability/cost metadata. Selectors accept preset:high, preset:middle, preset:low, any other observed native preset name after preset:, native roles such as @smol, or exact provider/model. Omit selectors to list all coding candidates. Consult native eval judge as advisory; the head chooses. No credentials/endpoints or fabricated quality/speed ranks.",
    parameters: Type.Object({ selectors: Type.Optional(Type.Array(Type.String(), { minItems: 1 })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const available = await requireRuntime(ctx).availableModels();
      const manager = await nativePresets(ctx);
      const inspection = await manager.inspect();
      const current = ctx.models.current();
      const resolutions = params.selectors ? await Promise.all(params.selectors.map(async selector => {
        if (selector.startsWith("preset:")) {
          try {
            const resolved = await manager.resolve(selector.slice("preset:".length));
            return { selector, preset: resolved.preset, model: available.find(candidate => sameLaneModel(candidate, resolved.model)) ?? null };
          } catch (error) {
            return { selector, model: null, error: error instanceof Error ? error.message : String(error) };
          }
        }
        return { selector, model: available.find(candidate => sameLaneModel(candidate, ctx.models.resolve(selector))) ?? null };
      })) : undefined;
      const selected = resolutions
        ? [...new Map(resolutions.flatMap(item => item.model ? [[JSON.stringify([item.model.provider, item.model.id]), item.model] as const] : [])).values()]
        : available;
      return result({
        current: current ? { provider: current.provider, id: current.id } : null,
        candidates: selected,
        nativePresets: inspection,
        ...(resolutions ? { resolutions } : {}),
        guidance: "Catalog cost/capability facts are not measured speed, quality, quota, or permission. Consult native judge for substantive/uncertain routing; the head remains responsible for the final choice. Judge usage and fallback belong to native OMP, not this catalog.",
      });
    },
  });
  pi.registerTool({
    name: "lane_init_presets", label: "Initialize missing native model presets", approval: "write", loadMode: "essential",
    description: "First-head setup only: create missing native OMP high/middle/low presets from judged head choices. Each preset snapshots existing roles/thinking and changes only its own default model. Existing presets, active/default/judge roles and model definitions are preserved. This deliberate initial save persists native presets; ordinary lane selection/change never does. Do not claim a performance tier from the name.",
    parameters: Type.Object({
      choices: Type.Object(Object.fromEntries(MODEL_PRESET_NAMES.map(name => [name, Type.Optional(Type.Object({
        model: Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
        reason: Type.String({ minLength: 1 }),
      }))])), { minProperties: 1, additionalProperties: false }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return result(await (await nativePresets(ctx)).initialize(params.choices));
    },
  });
  pi.registerTool({
    name: "lane_start", label: "Start independent work", loadMode: "essential", approval: "exec",
    description: "Bind an independent topic to its own OMP session at an explicit cwd. By default create a supported native thread/topic, or reuse the source's existing binding; unsupported private chats use a logical topic. For a clearly new topic inside an existing thread, supply its same authorized parent as destination with threadId:null and no topicId to create a sibling. An existing independent destination binds directly. Do not ask the user to run /new merely to create a topic. Consult lane_models and native judge; choose exactly one model {provider,id} or native preset name, with concise modelReason. The resolved model and full preset snapshot persist; retries/global edits do not retarget the lane. Optional workflow {name,reason} is explicit head selection within the user's authorized objective, never inferred from brief/report prose. It binds to this source/handoff; conflicting retries reject. Native capability/permissions own activation; ULW arming does not create a goal. Returns queued identity, not completion. Small main work stays direct. sourceId is the original trusted request ID.",
    parameters: Type.Object({
      sourceId: Type.String(), title: Type.String(), cwd: Type.String(),
      model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) })),
      preset: Type.Optional(Type.String({ minLength: 1 })),
      modelReason: Type.String({ minLength: 1 }),
      brief: Type.Optional(Type.String()), acceptance: Type.Optional(Type.Array(Type.String())),
      workflow: workflowSchema,
      destination: Type.Optional(Type.Object({
        platform: Type.Union([Type.Literal("discord"), Type.Literal("telegram"), Type.Literal("slack")]),
        accountId: Type.String(), authorityId: Type.String(),
        guildId: Type.Union([Type.String(), Type.Null()]), channelId: Type.String(),
        threadId: Type.Union([Type.String(), Type.Null()]),
        topicId: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) { return result(await requireRuntime(ctx).startLane(params)); },
  });
  pi.registerTool({
    name: "lane_set_model", label: "Change an idle lane model", approval: "exec",
    description: "Explicitly change one idle lane's model or full native preset snapshot without changing global OMP settings, the head, or other lanes. Requires a received authorized sourceId, exactly one model/preset and modelReason. Refuses active work, approvals/services/goals or unresolved submissions. Uses durable intent and native readback; do not blindly repeat an uncertain change.",
    parameters: Type.Object({
      id: Type.String(), sourceId: Type.String(),
      model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) })),
      preset: Type.Optional(Type.String({ minLength: 1 })),
      modelReason: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) { return result(await requireRuntime(ctx).changeModel(params)); },
  });
  pi.registerTool({
    name: "lane_inspect", label: "Inspect independent work", approval: "read",
    description: "List managed lanes or read one lane's actual runtime state. Does not read unrelated OMP sessions.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) { return result(await requireRuntime(ctx).inspect(params.id)); },
  });
  pi.registerTool({
    name: "lane_message", label: "Message independent work", approval: "exec",
    description: "Durably admit a follow-up to a specific open lane. Ordinary same-topic follow-ups steer an active native run by default; idle or ineligible work remains queued. Do not require a separate user /steer command. sourceId identifies the original received user instruction for duplicate suppression. Optional workflow {name,reason} is explicit head selection within that objective; text/quotes/reports never select one. Workflow selections remain serialized, not steered into an active run. The exact workflow/source/handoff is durable and conflicting retries reject. Admission is not execution or completion.",
    parameters: Type.Object({ id: Type.String(), text: Type.String(), sourceId: Type.String(), workflow: workflowSchema }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await requireRuntime(ctx).messageLane(params.id, params.text, params.sourceId, params.workflow);
      return result("Follow-up durably queued.");
    },
  });
  pi.registerTool({
    name: "lane_pause", label: "Pause independent work", approval: "exec",
    description: "Persist pause intent and stop the lane's current turn. Does not claim ongoing external services have been destroyed.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) { await requireRuntime(ctx).pause(params.id); return result(await requireRuntime(ctx).inspect(params.id)); },
  });
  pi.registerTool({
    name: "lane_resume", label: "Resume independent work", approval: "exec",
    description: "Explicitly resume a paused lane after user authorization; resumes queued inputs, not an uncertain external action.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) { await requireRuntime(ctx).resume(params.id); return result(await requireRuntime(ctx).inspect(params.id)); },
  });
  pi.registerTool({
    name: "lane_close", label: "Close independent work", approval: "write",
    description: "Record a verified outcome or authorized cancellation. Must name evidence you actually checked. This does not authorize merge/publish and never deletes worktrees.",
    parameters: Type.Object({
      id: Type.String(), outcome: Type.Union([Type.Literal("completed"), Type.Literal("cancelled")]), evidence: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) { await requireRuntime(ctx).closeLane(params.id, params.outcome, params.evidence); return result(await requireRuntime(ctx).inspect(params.id)); },
  });
  pi.registerCommand("superagent", {
    description: "Inspect the running messenger head and its lanes.",
    async handler(_args, ctx) { ctx.ui.notify(JSON.stringify(await requireRuntime(ctx).inspect(), null, 2), "info"); },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main" || loading || closed) return;
    const configPath = process.env.OMP_SUPERAGENT_CONFIG;
    if (!configPath || !process.env.OMP_RPC_SOCKET)
      throw new Error("Start this extension with omp-superagent start and its pinned socket-enabled OMP host");
    // The host's RPC command queue opens only after session_start returns.
    timer = setTimeout(() => {
      loading = (async () => {
        const config = await loadConfig(configPath);
        const store = new Store(join(config.stateDir, "coordination.sqlite"));
        let messenger: ReturnType<typeof createGatewayMessenger>;
        try {
          messenger = createGatewayMessenger(config);
        } catch (error) {
          store.close();
          throw error;
        }
        const candidate = new Superagent(config, store, messenger, fileURLToPath(new URL("./lane-extension.ts", import.meta.url)), error => {
          pi.logger.error(`Superagent: ${error instanceof Error ? error.message : String(error)}`);
        }, {
          resolvePreset: async (name, thinkingContext) => (await nativePresets(ctx)).resolve(name, thinkingContext),
          inspectPresets: async () => (await nativePresets(ctx)).inspect(),
          persistPreset: async selection => (await nativePresets(ctx)).persistSelection(selection),
        });
        try {
          runtime = candidate;
          await candidate.start();
          if (closed) { await candidate.stop(); return; }
          ctx.ui.setStatus("superagent", `Gateway: ${configuredPlatforms(config).join(", ")}; preset readiness: omp-superagent status`);
        } catch (error) {
          runtime = undefined;
          await candidate.stop().catch(() => {});
          throw error;
        }
      })().catch(error => {
        startupError = error;
        pi.logger.error(`Superagent startup failed: ${error instanceof Error ? error.message : String(error)}`);
        ctx.ui.setStatus("superagent", "startup failed; see host log");
      });
    }, 0);
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    await loading;
    await runtime?.stop();
  });
}
