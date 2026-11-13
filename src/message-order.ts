import type { Platform } from "./contracts";

/** Platform message order only; event/edit IDs and local arrival times are not clocks. */
export function compareMessageIds(platform: Platform, left: string, right: string): -1 | 0 | 1 | null {
  if (platform === "discord" || platform === "telegram") {
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (platform !== "slack" || !/^\d+\.\d+$/.test(left) || !/^\d+\.\d+$/.test(right)) return null;
  const [leftSeconds, leftFraction] = left.split(".") as [string, string];
  const [rightSeconds, rightFraction] = right.split(".") as [string, string];
  const a = BigInt(leftSeconds);
  const b = BigInt(rightSeconds);
  if (a !== b) return a < b ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const fractionA = leftFraction.padEnd(width, "0");
  const fractionB = rightFraction.padEnd(width, "0");
  return fractionA < fractionB ? -1 : fractionA > fractionB ? 1 : 0;
}
