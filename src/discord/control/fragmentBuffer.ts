import { decodeEnvelopeFragment, finalizeEnvelopeFromFragments, type NativeEnvelope } from "./types.js";

export type FragmentIngestResult =
  | { status: "COMPLETE"; envelope: NativeEnvelope }
  | { status: "PENDING" }
  | { status: "INVALID" }
  // `content` had no fragment/hidden-envelope marker at all (e.g. a legacy SYMPHONY_EVENT
  // text line, or ordinary chat) -- caller should fall back to its own legacy parse path.
  | { status: "NOT_A_FRAGMENT" };

interface FragmentSet {
  total: number; digest: Buffer; authorId: string; chunks: Map<number, Buffer>; firstSeenAt: number;
  // Set once every fragment has arrived and reassembly has verified. Kept (not deleted) so this
  // buffer is idempotent: callers in this codebase legitimately re-evaluate the very same
  // physical Discord message more than once within one message-handling cycle (the gateway's
  // own onMessage() check, then WorkerContract.receive()'s independent re-check of the same
  // input) -- without this cache, the second call would see an already-consumed pending set,
  // re-buffer the lone repeated fragment as PENDING, and the Worker would silently never ACK.
  envelope?: NativeEnvelope;
}

const TTL_MS = 5 * 60 * 1000; // an entry (pending or completed) not touched again within 5 minutes is dropped
const MAX_PENDING_SETS = 500; // bound worst-case memory regardless of TTL races or a misbehaving sender

/**
 * Reassembles a NativeEnvelope from one or more physical Discord messages ("fragments").
 * ONE logical Runtime Event always resolves to exactly one NativeEnvelope here, however many
 * physical messages carried it -- see buildEnvelopeWireFragments in types.ts for the send side.
 *
 * Safety properties enforced here:
 *  - an incomplete fragment set never yields COMPLETE (no admission, no ACK, ever)
 *  - fragments are placed by their explicit index, so out-of-order physical delivery still
 *    reassembles correctly without relying on arrival order
 *  - once complete, an envelope id keeps returning the SAME reconstructed envelope for any
 *    further fragment that resolves to it (idempotent decode -- see FragmentSet.envelope above).
 *    This buffer does NOT itself decide whether a *genuine* duplicate/retried delivery should
 *    re-admit the Task: that is InboundGuard's own discord_message_id and logical-key dedup,
 *    exactly as it already is for a single-fragment (unfragmented) envelope. Keeping duplicate
 *    prevention in one place, downstream, means fragmented and unfragmented envelopes are
 *    deduplicated identically instead of by two different mechanisms.
 *  - fragments cannot be mixed across logical envelopes: a fresh random 16-byte envelope id
 *    scopes every fragment, and any fragment claiming that id but disagreeing on total count,
 *    integrity digest, or originating Discord author invalidates and drops the whole set
 *  - final integrity is verified (sha256-derived digest of the complete reassembled payload)
 *    before the bytes are ever inflated or parsed as JSON
 */
export class EnvelopeFragmentBuffer {
  private readonly sets = new Map<string, FragmentSet>();

  ingest(content: string, authorId: string, discord: { messageId: string; threadId?: string; createdAt: string }): FragmentIngestResult {
    this.evictStale();
    const fragment = decodeEnvelopeFragment(content);
    if (!fragment) return { status: "NOT_A_FRAGMENT" };
    if (fragment.total === 1) {
      const envelope = finalizeEnvelopeFromFragments([fragment.chunk], fragment.digest, discord);
      return envelope ? { status: "COMPLETE", envelope } : { status: "INVALID" };
    }
    let set = this.sets.get(fragment.envelopeId);
    if (set && (set.total !== fragment.total || !set.digest.equals(fragment.digest) || set.authorId !== authorId)) {
      // Cross-message contamination guard: everything claiming this envelope id must agree.
      this.sets.delete(fragment.envelopeId);
      return { status: "INVALID" };
    }
    if (set?.envelope) return { status: "COMPLETE", envelope: set.envelope }; // already reassembled; re-serve idempotently
    if (!set) {
      if (this.sets.size >= MAX_PENDING_SETS) return { status: "INVALID" }; // refuse rather than grow unbounded
      set = { total: fragment.total, digest: fragment.digest, authorId, chunks: new Map(), firstSeenAt: Date.now() };
      this.sets.set(fragment.envelopeId, set);
    }
    set.chunks.set(fragment.index, fragment.chunk);
    if (set.chunks.size < set.total) return { status: "PENDING" };
    const ordered: Buffer[] = [];
    for (let index = 0; index < set.total; index++) { const chunk = set.chunks.get(index); if (!chunk) return { status: "INVALID" }; ordered.push(chunk); }
    const envelope = finalizeEnvelopeFromFragments(ordered, set.digest, discord);
    if (!envelope) { this.sets.delete(fragment.envelopeId); return { status: "INVALID" }; }
    set.envelope = envelope; // cache for idempotent re-serving; entry still ages out via TTL below
    return { status: "COMPLETE", envelope };
  }

  private evictStale(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, set] of this.sets) if (set.firstSeenAt < cutoff) this.sets.delete(key);
  }
}
