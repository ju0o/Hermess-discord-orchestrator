import type { AgentId, Role } from "../../domain/types.js";
import type { ValidationEvidence } from "../../runtime/correction.js";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";

export const BOT_TYPES = ["MAIN", "ASUS", "CODEX", "CLAUDE", "OPENCODE", "COMMANDCODE", "ORCHESTRATOR"] as const;
export type BotType = (typeof BOT_TYPES)[number];

export const NATIVE_EVENT_TYPES = [
  "TASK", "ACK", "RESULT", "REVIEW", "QA_RESULT", "VERDICT", "COMPLETION", "HANDOFF", "REVISION_REQUEST", "REVISION_RESULT",
  "QUESTION", "ANSWER", "PROPOSAL", "OBJECTION", "CLARIFICATION", "CONSENSUS", "EXPERT_REQUEST", "EXPERT_INVITE", "EXPERT_RESULT",
  "MEETING_INVITE", "CAPABILITY_REPORT", "EXECUTION_PROPOSAL", "RESOURCE_REPORT", "MODEL_PROPOSAL", "PARALLEL_PLAN", "DEPENDENCY_REPORT", "BLOCKER", "COUNTER_PROPOSAL", "ROLE_ACCEPT",
] as const;
export type NativeEventType = (typeof NATIVE_EVENT_TYPES)[number];

export const INBOUND_REASON_CODES = [
  "ALLOW", "HUMAN_MESSAGE", "SELF_MESSAGE", "UNTRUSTED_BOT", "MENTION_REQUIRED", "UNKNOWN_RECIPIENT",
  "UNKNOWN_TASK", "DUPLICATE_MESSAGE", "LOOP_GUARD", "INVALID_EVENT", "ROLE_DENIED", "WRONG_WORKROOM",
  "TEAM_MEMBERSHIP_REQUIRED", "DISCUSSION_LIMIT_REACHED", "DISCUSSION_DUPLICATE", "EXPERT_DUPLICATE", "HUMAN_GATE_REQUIRED", "ACK_IDENTITY_MISMATCH", "TASK_THREAD_REQUIRED",
  // A multi-message envelope is legitimately incomplete until every physical fragment has
  // arrived. This is not a protocol error -- see EnvelopeFragmentBuffer -- so it is tracked
  // as its own reason code rather than folded into INVALID_EVENT (which stays reserved for
  // genuinely malformed/corrupt/tampered content).
  "FRAGMENT_PENDING",
] as const;
export type InboundReasonCode = (typeof INBOUND_REASON_CODES)[number];

export interface NativeEnvelope {
  event_type: NativeEventType;
  task_id: string;
  sender: BotType;
  recipient: BotType;
  role?: Role;
  sender_role?: Role;
  recipient_role?: Role;
  discussion_topic?: string;
  topic_id?: string;
  parent_event_id?: string;
  status?: string;
  next_owner?: BotType;
  round: number;
  message_id: string;
  thread_id?: string;
  created_at: string;
  payload: Record<string, unknown>;
  reported_by?: BotType;
  original_agent?: string;
  fallback_reason?: string;
}

export interface ReviewPayload {
  reviewer_agent: AgentId;
  reviewer_role: "REVIEWER" | "ARCHITECT";
  verdict: "REVIEW_PASS" | "REVISION_REQUIRED" | "BLOCKED";
  findings: string[];
  evidence: string[];
  validation_evidence?: ValidationEvidence[];
  next_owner: BotType;
  control_plane?: boolean;
}

export interface QaResultPayload {
  qa_agent: AgentId;
  status: "PASS" | "FAIL" | "BLOCKED";
  checks: string[];
  evidence: string[];
  validation_evidence?: ValidationEvidence[];
  next_owner: BotType;
  control_plane?: boolean;
}

export interface RevisionRequestPayload { findings: string[]; requested_changes: string[]; control_plane?: boolean; }
export interface RevisionResultPayload { changes: string[]; validation: string[]; next_owner: BotType; control_plane?: boolean; }

export function normalizeBotType(value: string): BotType | undefined {
  const normalized = value.trim().toUpperCase().replace(/[-_ ]/g, "");
  const aliases: Record<string, BotType> = {
    MAIN: "MAIN", ASUS: "ASUS", CODEX: "CODEX", CLAUDE: "CLAUDE", CLAUDECODE: "CLAUDE",
    OPENCODE: "OPENCODE", COMMANDCODE: "COMMANDCODE", ORCHESTRATOR: "ORCHESTRATOR", RUNTIME: "ORCHESTRATOR",
  };
  return aliases[normalized];
}

export function agentToBotType(agentId: AgentId): BotType {
  return ({ CODEX: "CODEX", CLAUDE_CODE: "CLAUDE", OPENCODE: "OPENCODE", COMMAND_CODE: "COMMANDCODE" } as const)[agentId];
}

export function botTypeToAgent(type: BotType): AgentId | undefined {
  return ({ CODEX: "CODEX", CLAUDE: "CLAUDE_CODE", OPENCODE: "OPENCODE", COMMANDCODE: "COMMAND_CODE" } as const)[type as "CODEX" | "CLAUDE" | "OPENCODE" | "COMMANDCODE"];
}

export function ackIdentityMatches(sender: BotType, claimedBy: unknown, role: unknown, status: unknown): boolean {
  const expected = botTypeToAgent(sender); const claimed = String(claimedBy || "").toUpperCase().replace(/[- ]/g, "_");
  return Boolean(expected && claimed === expected && role && ["ACK", "CLAIMED"].includes(String(status || "").toUpperCase()));
}

export function blocksAutomaticReply(event: NativeEventType, status?: string): boolean {
  return event === "ACK" || event === "RESULT" || event === "QA_RESULT"
    || event === "CONSENSUS" || event === "EXPERT_RESULT"
    || (event === "VERDICT" && String(status).toUpperCase() === "PASS");
}

// --- Wire fragmentation -----------------------------------------------------
//
// Discord hard-caps a single message at ~2000 UTF-16 code units. The invisible
// envelope carried after the human-readable display text used to be emitted as
// one unbounded hidden blob; once display text was truncated to nothing, a
// sufficiently large envelope still overflowed the limit with no chunking of
// its own, so the send either threw or -- when it fell back to the external
// ASUS relay CLI -- got split by that opaque external process with no fragment
// metadata at all, and the receiver could never reassemble it (silent
// INVALID_EVENT, no ACK, no Worker process; see run01-dispatch-v3-status.json).
//
// The fix: this repo now always does its own bounded, metadata-tagged
// chunking before anything is handed to a transport, so no transport -- ours
// or the external CLI's -- ever needs to invent its own split. Every physical
// fragment carries a small fixed binary header (version, a random 16-byte
// envelope id, this fragment's index, the total fragment count, and a 4-byte
// integrity digest of the *complete* reassembled payload) ahead of its slice
// of the deflated envelope JSON, all inside the existing invisible
// variation-selector encoding. One logical envelope always round-trips to
// exactly one logical NativeEnvelope, however many physical messages it took.
const FRAGMENT_VERSION = 1;
const FRAGMENT_ENVELOPE_ID_BYTES = 16;
const FRAGMENT_DIGEST_BYTES = 4;
// Fixed binary header layout, in byte order: [version(1)][envelopeId(16)][index(1)][total(1)][digest(4)]
const OFFSET_VERSION = 0;
const OFFSET_ENVELOPE_ID = OFFSET_VERSION + 1;
const OFFSET_INDEX = OFFSET_ENVELOPE_ID + FRAGMENT_ENVELOPE_ID_BYTES;
const OFFSET_TOTAL = OFFSET_INDEX + 1;
const OFFSET_DIGEST = OFFSET_TOTAL + 1;
const FRAGMENT_HEADER_BYTES = OFFSET_DIGEST + FRAGMENT_DIGEST_BYTES;
const FRAGMENT_MAX_COUNT = 255;

export interface EnvelopeFragment { envelopeId: string; index: number; total: number; digest: Buffer; chunk: Buffer; }

function integrityDigest(payload: Buffer): Buffer { return createHash("sha256").update(payload).digest().subarray(0, FRAGMENT_DIGEST_BYTES); }

function hiddenEncodeBytes(bytes: Buffer): string {
  const encoded = bytes.toString("base64url");
  const hidden = [...encoded].map((char) => {
    const value = HIDDEN_BASE64.indexOf(char);
    return HIDDEN_SYMBOLS[(value >> 4) & 3]! + HIDDEN_SYMBOLS[(value >> 2) & 3]! + HIDDEN_SYMBOLS[value & 3]!;
  }).join("");
  return `${HIDDEN_EVENT_START}${hidden}${HIDDEN_EVENT_END}`;
}

function hiddenDecodeBytes(content: string): Buffer | undefined {
  const hidden = content.match(new RegExp(`${escapeRegExp(HIDDEN_EVENT_START)}([\\s\\S]*?)${escapeRegExp(HIDDEN_EVENT_END)}`));
  if (!hidden) return undefined;
  const hiddenPayload = [...hidden[1]!];
  if (hiddenPayload.length === 0 || hiddenPayload.length % 3 !== 0) return undefined;
  const encoded = Array.from({ length: hiddenPayload.length / 3 }, (_, index) => {
    const offset = index * 3;
    const a = HIDDEN_SYMBOLS.indexOf(hiddenPayload[offset]!); const b = HIDDEN_SYMBOLS.indexOf(hiddenPayload[offset + 1]!); const c = HIDDEN_SYMBOLS.indexOf(hiddenPayload[offset + 2]!);
    if (a < 0 || b < 0 || c < 0) return undefined;
    return HIDDEN_BASE64[(a << 4) | (b << 2) | c];
  });
  if (encoded.some((char) => char === undefined)) return undefined;
  try { return Buffer.from(encoded.join(""), "base64url"); } catch { return undefined; }
}

/** Split a NativeEnvelope into 1+ self-describing wire fragments, none longer than `maxFragmentChars`. */
export function buildEnvelopeWireFragments(envelope: NativeEnvelope, maxFragmentChars: number): string[] {
  const payload = deflateRawSync(Buffer.from(JSON.stringify(envelope), "utf8"));
  const digest = integrityDigest(payload);
  const envelopeIdBytes = randomBytes(FRAGMENT_ENVELOPE_ID_BYTES);
  // wire.length = 4 (delimiters) + 3 * base64Chars(header+chunk); floor at every step so the
  // real wire never exceeds the caller's budget, even after base64/hidden expansion rounding.
  const encodedBudget = Math.max(0, Math.floor((maxFragmentChars - 4) / 3));
  const rawBudget = Math.floor((encodedBudget * 3) / 4);
  const maxChunkBytes = Math.max(1, rawBudget - FRAGMENT_HEADER_BYTES);
  const total = Math.max(1, Math.ceil(payload.length / maxChunkBytes));
  if (total > FRAGMENT_MAX_COUNT) throw new Error(`ENVELOPE_TOO_LARGE_FOR_FRAGMENTATION: ${payload.length} bytes needs ${total} fragments`);
  const fragments: string[] = [];
  for (let index = 0; index < total; index++) {
    const chunk = payload.subarray(index * maxChunkBytes, (index + 1) * maxChunkBytes);
    const header = Buffer.alloc(FRAGMENT_HEADER_BYTES);
    header.writeUInt8(FRAGMENT_VERSION, OFFSET_VERSION); envelopeIdBytes.copy(header, OFFSET_ENVELOPE_ID);
    header.writeUInt8(index, OFFSET_INDEX); header.writeUInt8(total, OFFSET_TOTAL); digest.copy(header, OFFSET_DIGEST);
    fragments.push(hiddenEncodeBytes(Buffer.concat([header, chunk])));
  }
  return fragments;
}

export function serializeEnvelope(envelope: NativeEnvelope): string {
  // The structured event remains in the durable protocol/evidence layer. The
  // Discord surface carries it as an invisible variation-selector payload so
  // Worker Bots can still consume native events without exposing JSON to staff.
  // Unbounded budget: single-message callers (tests, CLIs, and any envelope
  // small enough to fit) always get exactly one self-contained fragment.
  return buildEnvelopeWireFragments(envelope, Number.MAX_SAFE_INTEGER)[0]!;
}

/** Decode one physical message's hidden payload as a raw fragment, without requiring completeness. */
export function decodeEnvelopeFragment(content: string): EnvelopeFragment | undefined {
  const bytes = hiddenDecodeBytes(content);
  if (!bytes || bytes.length < FRAGMENT_HEADER_BYTES) return undefined;
  if (bytes.readUInt8(OFFSET_VERSION) !== FRAGMENT_VERSION) return undefined;
  const envelopeIdBytes = bytes.subarray(OFFSET_ENVELOPE_ID, OFFSET_ENVELOPE_ID + FRAGMENT_ENVELOPE_ID_BYTES);
  const index = bytes.readUInt8(OFFSET_INDEX); const total = bytes.readUInt8(OFFSET_TOTAL);
  const digest = bytes.subarray(OFFSET_DIGEST, OFFSET_DIGEST + FRAGMENT_DIGEST_BYTES);
  if (total < 1 || total > FRAGMENT_MAX_COUNT || index >= total) return undefined;
  return { envelopeId: envelopeIdBytes.toString("hex"), index, total, digest, chunk: bytes.subarray(FRAGMENT_HEADER_BYTES) };
}

/** Concatenate ordered fragment chunks, verify integrity, and validate/build the NativeEnvelope. Returns undefined on any corruption/tamper/malformed content -- never throws. */
export function finalizeEnvelopeFromFragments(orderedChunks: Buffer[], expectedDigest: Buffer, discord: { messageId: string; threadId?: string; createdAt: string }): NativeEnvelope | undefined {
  try {
    const payload = Buffer.concat(orderedChunks);
    if (!integrityDigest(payload).equals(expectedDigest)) return undefined;
    const value = JSON.parse(inflateRawSync(payload).toString("utf8")) as Record<string, unknown>;
    return buildEnvelopeFromValue(value, discord);
  } catch { return undefined; }
}

function buildEnvelopeFromValue(value: Record<string, unknown>, discord: { messageId: string; threadId?: string; createdAt: string }): NativeEnvelope | undefined {
  const eventType = String(value.event_type || "") as NativeEventType;
  const sender = normalizeBotType(String(value.sender || "")); const recipient = normalizeBotType(String(value.recipient || ""));
  if (!NATIVE_EVENT_TYPES.includes(eventType) || !sender || !recipient || !value.task_id) return undefined;
  const round = Number(value.round ?? 0); if (!Number.isInteger(round) || round < 0) return undefined;
  return {
    event_type: eventType, task_id: String(value.task_id), sender, recipient,
    ...(value.role ? { role: String(value.role).toUpperCase() as Role } : {}),
    ...(value.sender_role ? { sender_role: String(value.sender_role).toUpperCase() as Role } : {}),
    ...(value.recipient_role ? { recipient_role: String(value.recipient_role).toUpperCase() as Role } : {}),
    ...(value.discussion_topic ? { discussion_topic: String(value.discussion_topic) } : {}),
    ...(value.topic_id ? { topic_id: String(value.topic_id) } : {}),
    ...(value.parent_event_id ? { parent_event_id: String(value.parent_event_id) } : {}),
    ...(value.status ? { status: String(value.status) } : {}),
    ...(value.next_owner && normalizeBotType(String(value.next_owner)) ? { next_owner: normalizeBotType(String(value.next_owner))! } : {}),
    round, message_id: discord.messageId, ...(discord.threadId ? { thread_id: discord.threadId } : {}),
    created_at: String(value.created_at || discord.createdAt),
    payload: value.payload && typeof value.payload === "object" ? value.payload as Record<string, unknown> : {},
    ...(value.reported_by && normalizeBotType(String(value.reported_by)) ? { reported_by: normalizeBotType(String(value.reported_by))! } : {}),
    ...(value.original_agent ? { original_agent: String(value.original_agent) } : {}),
    ...(value.fallback_reason ? { fallback_reason: String(value.fallback_reason) } : {}),
  };
}

/** Single-message decode: returns a NativeEnvelope only when `content` alone is a *complete*
 *  envelope (a whole legacy-text event, or a fragment whose header says total===1). A genuine
 *  multi-fragment message correctly returns undefined here -- an incomplete set must never
 *  produce a valid envelope; see EnvelopeFragmentBuffer for real multi-message reassembly. */
export function parseEnvelope(content: string, discord: { messageId: string; threadId?: string; createdAt: string }): NativeEnvelope | undefined {
  const fragment = decodeEnvelopeFragment(content);
  if (fragment) return fragment.total === 1 ? finalizeEnvelopeFromFragments([fragment.chunk], fragment.digest, discord) : undefined;
  try {
    // Backward-compatible read path for already-published protocol messages.
    const line = content.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith("SYMPHONY_EVENT ") || item.startsWith("<!-- SYMPHONY_EVENT "));
    if (!line) return undefined;
    const raw = line.startsWith("<!-- ") ? line.slice("<!-- ".length, -" -->".length) : line;
    const value = JSON.parse(raw.slice("SYMPHONY_EVENT ".length)) as Record<string, unknown>;
    return buildEnvelopeFromValue(value, discord);
  } catch { return undefined; }
}

// Discord normalizes supplementary variation selectors out of message
// content. These four zero-width format characters survive readback and are
// used as a compact base-4 alphabet; the delimiters are also invisible.
const HIDDEN_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HIDDEN_SYMBOLS = ["\u200B", "\u200C", "\u200D", "\u2060"];
const HIDDEN_EVENT_START = "\u2063\u2062";
const HIDDEN_EVENT_END = "\u2063\u2061";
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
