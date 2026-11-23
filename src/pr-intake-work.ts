import { routeKey, type InputRecord, type StorePort } from "./contracts";

// Controller receipts have no platform message/interaction and are never owner
// inputs. Only the restricted lane's exact native result has a delivery route.
export const intakeWorkPrefix = "pr-intake-work:";
export const intakeWorkId = (job: string, number: number, revision: string, head: string) => `${intakeWorkPrefix}${job}:${number}:${revision}:${head}`;
export const intakeThreadKey = (job: string, number: number) => `pr-intake-thread:${job}:${number}`;
export const intakeStatusKey = (job: string, number: number) => `pr-intake-status:${job}:${number}`;
export function prThreadTitle(repository: string, number: number): string {
  const suffix = ` #${number}`;
  return repository.slice(0, 100 - suffix.length) + suffix; // Discord thread title limit; GitHub slugs are ASCII.
}
export function unattendedSource(store: StorePort, input: InputRecord): string | null {
  const id = store.getMeta(`handoff-source:${input.id}`);
  return id?.startsWith(intakeWorkPrefix) ? id : null;
}

export function hasIntakeReplyRoute(store: StorePort, input: InputRecord, id: string): boolean {
  const source = store.input(id);
  const lane = input.target && input.target !== "main" ? store.lane(input.target) : null;
  const pointer = lane && store.getMeta(`pr-review-lane:${lane.id}`);
  const raw = pointer && store.getMeta(pointer);
  if (!raw || !lane || !source || source.messageId !== null || source.interactionId !== undefined
    || (source.state !== "pending" && source.state !== "done") || store.getMeta(`user-source:${id}`) !== null) return false;
  const round = JSON.parse(raw);
  return round.inputId === input.id && round.source === id && round.laneId === lane.id && !!round.automation
    && source.route.threadId === round.automation.anchor && routeKey(lane.route) === routeKey(source.route)
    && routeKey(input.route) === routeKey(lane.route);
}
