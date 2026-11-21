import { basename, dirname, join } from "node:path";
import type { LanePresetSnapshot } from "./contracts";

export const HEAD_ROTATION_KEY = "gateway:head-rotation";
export const HEAD_SESSION_FILE_KEY = "main:sessionFile";
export const HEAD_ROTATION_PROBE = "superagent:head-rotation-probe";
export const HEAD_ROTATION_GUARD = "superagent:head-rotation-guard";
export const MIN_HEAD_IDLE_MS = 30 * 60 * 1000;

export interface RotationSelection {
  readonly provider: string;
  readonly modelId: string;
  readonly reasoning: boolean;
  readonly thinkingLevel: string | null;
  readonly configuredThinkingLevel: string | null;
  readonly modelSettings: LanePresetSnapshot;
}

export interface RotationNative {
  readonly hostPid: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly nativeRun: number;
  readonly contextPercent: number;
  readonly selection: RotationSelection;
}

export interface RotationResident {
  readonly id: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly inputId?: string;
  readonly requestIds: readonly string[];
  readonly result?: { readonly status: string; readonly agentInvoked: boolean; readonly goalResume?: true };
  readonly ownedRuns: number;
  readonly assistantOutcome?: { readonly status: "completed" | "error" | "aborted"; readonly run: number };
  readonly entryId?: string;
}

export interface RotationAttestation {
  readonly generation: number;
  readonly nativeRun: number;
  readonly idleMs: number;
  readonly contextPercent: number;
  readonly selection: RotationSelection;
  readonly residents: readonly RotationResident[];
}

export interface HeadRotation {
  readonly id: string;
  readonly stage: "stopping" | "starting" | "launching" | "complete" | "refused";
  readonly original: {
    readonly pid: number;
    readonly sessionId: string;
    readonly sessionFile: string;
  };
  readonly sessionFile: string;
  readonly stopBoundary: string | null;
  readonly attestation: RotationAttestation;
  readonly replacementSessionId: string | null;
}

export interface RotationProbeEvent {
  readonly state: RotationNative;
  readonly respond: (attestation: Promise<RotationAttestation | null>) => void;
}

export interface RotationGuardEvent {
  readonly id: string;
  readonly state: RotationNative;
  readonly respond: (allowed: boolean) => void;
}

export function readHeadRotation(encoded: string | null): HeadRotation | null {
  return encoded === null ? null : JSON.parse(encoded);
}

export function activeHeadSessionFile(stateDir: string, value: string | null): string {
  const base = join(stateDir, "sessions", "main");
  if (value === null) return join(base, "session.jsonl");
  const id = basename(dirname(value));
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
    || value !== join(base, "rotated", id, "session.jsonl")) {
    throw new Error("Invalid managed HEAD session file");
  }
  return value;
}
