import type { DialogResponse, GatewayRestartNotice, GatewayRestartRecord, Inbound, Route } from "./contracts";
import type { HeadRotation } from "./head-rotation";
import type { ManagedUlwStatus } from "./managed-ulw";

export type HeadInitialization = {
  readonly sessionId: string;
  readonly state: "checking" | "running" | "complete" | "blocked" | "failed" | "uncertain";
  readonly requestId?: string;
  /** Durable fence survives a crash during a later startup's checking phase. */
  readonly replayBlocked?: boolean;
  readonly detail: string;
};

export type GatewayStatus = {
  readonly gateway: {
    readonly pid: number;
    readonly ready: boolean;
    readonly admissionReady: boolean;
    readonly pendingEvents: number;
    readonly unresolvedEvents?: number;
    readonly stopping: boolean;
  };
  readonly head: {
    readonly pid: number | null;
    readonly ready: boolean;
    readonly connected: boolean;
    readonly socketPath: string;
    readonly error: string | null;
    readonly initialization?: HeadInitialization;
    readonly rotation?: Pick<HeadRotation, "id" | "stage" | "replacementSessionId"> & {
      readonly previousSessionId: string;
    };
  };
  readonly ulw?: ManagedUlwStatus;
  readonly restart?: Omit<GatewayRestartRecord, "sessionFile">;
};

export type GatewayEvent =
  | { readonly kind: "message"; readonly input: Inbound }
  | { readonly kind: "answer"; readonly approvalId: string; readonly response: DialogResponse; readonly route: Route }
  | ({ readonly kind: "restart" } & GatewayRestartNotice)
  | { readonly kind: "reconnect"; readonly barrier?: string };
export type GatewayReceipt = "accepted" | "rejected" | "unresolved";
export type QueuedEvent = {
  readonly sequence: number;
  readonly event: GatewayEvent;
  readonly reconciliation?: true;
};
