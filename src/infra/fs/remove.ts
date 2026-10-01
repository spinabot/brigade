/**
 * Verified file removal.
 *
 * Why a helper rather than a bare `fs.rmSync(file)`:
 *
 * `fs.rmSync` can return WITHOUT deleting the file and WITHOUT throwing. On
 * Windows it does exactly that for any path containing a non-ASCII character —
 * reproduce with a file named `café.md` and `fs.rmSync` leaves it on disk while
 * `fs.unlinkSync` removes it. The call reports success either way, so the
 * caller cannot tell "removed" from "left behind" and code that counts the call
 * as a successful delete silently OVERSTATES what it erased.
 *
 * That matters most where a delete is an INTEGRITY step rather than
 * housekeeping. The markdown vault's prune is the counterpart to a crypto-shred:
 * it exists so a purged fact's plaintext note does not survive on disk. Note
 * filenames are derived from fact CONTENT, so any fact containing an em dash, an
 * accent, an emoji, or CJK text produces exactly the kind of path `fs.rmSync`
 * refuses to remove — and the prune reported `pruned: N` while leaving the
 * plaintext in place.
 *
 * So the contract here is a VERIFICATION, not a better call: invoke the delete,
 * then ask the filesystem whether the path is actually gone. A deletion API
 * returning without throwing is not evidence that anything was deleted.
 */

import fs from "node:fs";

/**
 * Delete `file`, returning `true` only when it is really gone.
 *
 *   - `true`  — the path does not exist when this returns, including "it was
 *               already absent" (gone is gone; a re-run stays successful).
 *   - `false` — the path is still there: locked by another process, unwritable,
 *               or a directory handed to a file-only delete.
 *
 * Never throws: callers use the return value to decide whether to count the
 * removal, so an exception is just another way of saying "not removed".
 *
 * `fs.unlinkSync` is the primitive used — it is the one that deletes a file, and
 * on Windows it removes the non-ASCII paths `fs.rmSync` silently skips. A
 * directory is deliberately NOT deleted (and reported as a failure): every
 * caller here is removing a rendered artifact, so a recursive delete would turn
 * a bug in their derived filename into data loss.
 */
export function removeFileSync(file: string): boolean {
	try {
		fs.unlinkSync(file);
	} catch {
		// Locked, a directory, or already gone. Swallowing is deliberate — the
		// caller's question is "is it gone?", and only the filesystem answers it.
	}
	return !fs.existsSync(file);
}
