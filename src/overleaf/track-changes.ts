// Tracked changes ("suggestions" in the review panel) on ShareJS docs: the id
// seed a tracked update carries, and Overleaf's limits on a doc's changes.
//
// With `meta: { tc }`, document-updater applies the update as usual and also
// records each insert and delete as a change in the doc's ranges
// (RangesManager.applyUpdate). A tracked delete still removes the text; the
// change keeps it.
import { randomBytes } from 'node:crypto'
import { TrackChangesLimitError } from '../errors.js'
import type { OtOp } from './diff.js'
import type { TrackedChange } from './ot.types.js'

/**
 * The id seed for one update's changes, as RangesTracker.generateIdSeed
 * (libraries/ranges-tracker) makes it: the first 18 hex digits of a Mongo
 * ObjectId, 8 of Unix seconds and 10 random, leaving 6 for a counter.
 * real-time refuses any other shape (Router.js: `tc: zz.hex().length(18)`).
 * document-updater restarts the counter for every update (`setIdSeed(tc)`), so
 * a reused seed would mint the same change ids again.
 */
export function generateIdSeed(): string {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(5).toString('hex')
}

// Overleaf's limits on a doc's tracked changes. document-updater checks the
// change count and the ranges size only after ShareJS applied and published
// the update: the sender is confirmed, then every client on the doc gets
// `otUpdateError` and is disconnected, and the update is not stored. The
// length limit is the editor's: past it, nobody in the doc can type.

/** RangesManager.MAX_CHANGES: tracked changes per doc. */
export const MAX_CHANGES = 2000
/**
 * How far below MAX_CHANGES a tracked edit must stay. Edits that overtake ours
 * on the server can add changes too: their own suggestions, splits of existing
 * changes, and splits of our deletes by a concurrent insert.
 */
export const CHANGES_HEADROOM = 50

/**
 * Overleaf's default `max_doc_length`, in characters. document-updater refuses
 * longer text, and the editor counts pending tracked deletions too: once text
 * plus deletions reach it, every keystroke is refused ("Document too long")
 * until someone accepts the deletions. So a tracked replacement grows that
 * total by everything it inserts.
 */
export const MAX_DOC_LENGTH = 2 * 1024 * 1024
/** Room left for people to keep typing. */
export const DOC_LENGTH_HEADROOM = 64 * 1024

/** RedisManager.MAX_RANGES_SIZE: characters of a doc's changes and comments as JSON. */
export const MAX_RANGES_SIZE = 3 * 1024 * 1024
export const RANGES_SIZE_HEADROOM = 64 * 1024
/** A generous bound on the JSON a change or comment takes besides its text (id, position, metadata). */
const RANGE_JSON_OVERHEAD = 200

/**
 * Upper bounds on a doc's tracked changes: exact at join, then raised by the
 * most each op can add (see growth). Accepts and rejects only lower the real
 * values, so they are not followed.
 */
export interface TrackedBounds {
  /** Number of changes. */
  changes: number
  /** Characters of tracked-deleted text. */
  deletedLength: number
  /** Characters the changes take as JSON. */
  json: number
}

/**
 * Bounds from joinDoc's `ranges.changes`. Their text arrives latin1-packed
 * (encodeRanges), which is never shorter than the real text, so lengths
 * measured on it are safe upper bounds.
 */
export function boundsAtJoin(changes: TrackedChange[] = []): TrackedBounds {
  return {
    changes: changes.length,
    deletedLength: changes.reduce((n, c) => n + (c.op.d?.length ?? 0), 0),
    json: changes.length > 0 ? JSON.stringify(changes).length : 0,
  }
}

/**
 * The most `ops` can add to a doc's tracked changes, given `changes` existing
 * ones (RangesTracker applyInsertToChanges / applyDeleteToChanges):
 *
 * - an insert strictly inside a tracked insert splits it in two (+1 change, no
 *   new text) unless it is itself tracked and by the same user, which merges
 *   them. Change positions are not followed, so this is counted whenever the
 *   doc has any changes;
 * - a tracked insert adds a change holding its text, unless it merges;
 * - a tracked delete adds a change holding the text it removes, unless it
 *   merges or cancels out against an insert;
 * - an untracked delete only shrinks, moves or removes changes.
 */
export function growth(ops: OtOp[], tracked: boolean, changes: number): TrackedBounds {
  const added: TrackedBounds = { changes: 0, deletedLength: 0, json: 0 }
  for (const op of ops) {
    if (op.i !== undefined) {
      if (changes > 0) {
        added.changes += 1
        added.json += RANGE_JSON_OVERHEAD
      }
      if (tracked) {
        added.changes += 1
        added.json += JSON.stringify(op.i).length + RANGE_JSON_OVERHEAD
      }
    } else if (op.d !== undefined && tracked) {
      added.changes += 1
      added.deletedLength += op.d.length
      added.json += JSON.stringify(op.d).length + RANGE_JSON_OVERHEAD
    }
  }
  return added
}

/** Raise `bounds` by what `ops`, now applied to the doc, can have added. */
export function grow(bounds: TrackedBounds, ops: OtOp[], tracked: boolean): void {
  const added = growth(ops, tracked, bounds.changes)
  bounds.changes += added.changes
  bounds.deletedLength += added.deletedLength
  bounds.json += added.json
}

/** Characters the doc's comments take in its ranges JSON (each holds the text it is anchored to). */
function commentsJsonLength(comments: Array<{ text: string }>): number {
  return comments.reduce((n, c) => n + JSON.stringify(c.text).length + RANGE_JSON_OVERHEAD, 0)
}

/** Which limit a refusal is about: the change count, text plus pending deletions, or the ranges JSON. */
type TrackedLimit = 'changes' | 'docLength' | 'rangesSize'

/**
 * The refusal for sending `ops` as tracked changes when they could take `doc`
 * past one of the limits (less its headroom), or null. `doc.text` must be the
 * text the ops were built against, its comments count towards the ranges
 * size, and `path` names the doc in the message.
 */
export function trackedLimitError(
  doc: { trackedBounds: TrackedBounds; text: string; comments: Array<{ text: string }> },
  ops: OtOp[],
  path: string | null,
): TrackChangesLimitError | null {
  const bounds = doc.trackedBounds
  const docLength = doc.text.length
  const added = growth(ops, true, bounds.changes)
  // Deleted text stays counted, so only what is inserted makes the doc longer.
  const inserted = ops.reduce((n, op) => n + (op.i?.length ?? 0), 0)
  const name = path ?? 'This doc'
  const refuse = (limit: TrackedLimit, message: string) =>
    new TrackChangesLimitError(`${message}: too close to the limit to send safely. Nothing was sent.`, {
      path, limit, changeCount: bounds.changes, couldAdd: added.changes, deletedLength: bounds.deletedLength,
    })
  if (bounds.changes + added.changes > MAX_CHANGES - CHANGES_HEADROOM) {
    return refuse('changes', `Overleaf keeps at most ${MAX_CHANGES} tracked changes per document. ${name} has ${bounds.changes}, and this edit could add up to ${added.changes}`)
  }
  if (inserted > 0 && docLength + bounds.deletedLength + inserted > MAX_DOC_LENGTH - DOC_LENGTH_HEADROOM) {
    return refuse('docLength', `Overleaf counts pending tracked deletions towards a document's length, which the editor caps at ${MAX_DOC_LENGTH} characters: past that nobody in the document can type. ${name} has ${docLength} characters of text and up to ${bounds.deletedLength} of pending deletions, and this edit inserts ${inserted}`)
  }
  if (bounds.json + added.json + commentsJsonLength(doc.comments) > MAX_RANGES_SIZE - RANGES_SIZE_HEADROOM) {
    return refuse('rangesSize', `Overleaf stores at most ${MAX_RANGES_SIZE} characters of tracked changes and comments per document, and this edit could take ${path ?? 'this doc'} past that`)
  }
  return null
}
