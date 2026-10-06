import { EventType, MemoryKind, type Event, type Memory } from "./types.js";

export interface ReflectionContext {
  agentId: string;
  scope: string;
  events: Event[];
  memories: Memory[];
  threshold: number;
  now: number;
}

export interface ReflectionDraft {
  title: string;
  content: string;
  kind: MemoryKind;
  confidence: number;
  importance: number;
  tags: string[];
  supportingEventIds: string[];
  rationale: string | null;
}

/**
 * A reflector turns recent episodes into candidate memories. The default
 * implementation is a local, deterministic heuristic. Hosts can inject their
 * own (e.g. an LLM-backed reflector) via `AgentMemoryOptions.reflector`.
 */
export interface Reflector {
  readonly id?: string;
  reflect(context: ReflectionContext): Promise<ReflectionDraft[]>;
}

/** Deterministic, offline reflector: finds recurring failure patterns. */
export class HeuristicReflector implements Reflector {
  readonly id = "heuristic-reflector-v1";

  async reflect(context: ReflectionContext): Promise<ReflectionDraft[]> {
    return reflectHeuristically(context);
  }
}

export function reflectHeuristically(context: ReflectionContext): ReflectionDraft[] {
  const groups = new Map<string, FailureGroup>();
  for (const event of context.events) {
    const failure = classifyFailure(event);
    if (failure === null) continue;
    const existing = groups.get(failure.signature) ?? { signature: failure.signature, label: failure.label, events: [] };
    existing.events.push(event);
    groups.set(failure.signature, existing);
  }

  const drafts: ReflectionDraft[] = [];
  for (const group of groups.values()) {
    const count = group.events.length;
    if (count < context.threshold) continue;
    const latest = group.events[0];
    const snippet = latest ? truncate(latest.content, 160) : group.label;
    drafts.push({
      title: `Recurring failure: ${group.label}`,
      content:
        `Observed ${count} similar failures in this scope (most recent: "${snippet}"). ` +
        `Before retrying, verify the preconditions for ${group.label} and add a guard so this is caught earlier.`,
      kind: MemoryKind.Procedure,
      confidence: clamp(0.45 + 0.1 * count, 0.5, 0.9),
      importance: clamp(0.5 + 0.1 * count, 0.5, 0.95),
      tags: ["reflection", "recurring-failure", slug(group.label)].filter((tag) => tag.length > 0),
      supportingEventIds: group.events.map((event) => event.id),
      rationale: `Pattern repeated ${count} times (threshold ${context.threshold}).`,
    });
  }

  drafts.sort((a, b) => b.importance - a.importance);
  return drafts.slice(0, 10);
}

interface FailureGroup {
  signature: string;
  label: string;
  events: Event[];
}

const FAILURE_PATTERN = /(error|fail|failed|failure|exception|denied|missing|refused|timeout|timed out|invalid|unable|cannot|unavailable)/i;

function classifyFailure(event: Event): { signature: string; label: string } | null {
  const data = event.data;
  const failed =
    event.type === EventType.Error ||
    data["success"] === false ||
    data["ok"] === false ||
    data["error"] !== undefined ||
    FAILURE_PATTERN.test(event.content);
  if (!failed) return null;

  const tool = firstString(data, ["tool", "toolName", "name", "command", "step"]);
  if (tool !== null) {
    return { signature: `tool:${tool.toLowerCase()}`, label: tool };
  }
  const keywords = significantWords(event.content).slice(0, 4).join(" ");
  return { signature: `text:${keywords || "unclassified"}`, label: keywords || "unclassified failure" };
}

function firstString(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was",
  "were", "be", "been", "this", "that", "it", "its", "at", "by", "from", "as", "not", "no",
]);

function significantWords(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    words.push(raw);
  }
  return words;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
