/**
 * helpers.ts — pure, side-effect-free helpers for split-view.ts (unit-tested
 * in test/helpers.test.ts). No pi imports at runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** True if c is a UTF-16 high (lead) surrogate. */
export function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

/** True if c is a UTF-16 low (trail) surrogate. */
export function isLowSurrogate(c: number): boolean {
	return c >= 0xdc00 && c <= 0xdfff;
}

/** Collapse whitespace and cut to `max` UTF-16 units with an ellipsis,
 * never ending mid surrogate pair. */
export function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return flat.slice(0, end) + "…";
}

/** SV-16: storage cap for one tool's text (args JSON or result output). */
export const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** SV-16: keep the NEWEST suffix within the cap, prefixed by a truncation
 * marker; the cut is code-point aligned. Text within the cap is unchanged. */
export function capToolText(s: string, cap = MAX_TOOL_TEXT_CHARS): string {
	if (s.length <= cap) return s;
	const marker = `[truncated: newest ${cap} of ${s.length} chars]\n`;
	const budget = cap - marker.length;
	let end = s.length;
	let units = 0;
	while (end > 0 && units < budget) {
		const w = end >= 2 && isHighSurrogate(s.charCodeAt(end - 2)) ? 2 : 1;
		if (units + w > budget) break;
		units += w;
		end -= w;
	}
	return marker + s.slice(end);
}

/** Band split minimums (cols) below which the tools ratio clamps. */
export const MIN_THINK_COLS = 24;
export const MIN_TOOLS_COLS = 20;

/** Tools panel width (cols) for a band of `total` cols at `pct` percent,
 * with minimum clamps; falls back to the raw ratio when both minimums
 * cannot hold. */
export function bandToolsColsFor(total: number, pct: number): number {
	const raw = Math.round((total * pct) / 100);
	let toolsW = raw;
	let thinkW = total - toolsW;
	if (toolsW < MIN_TOOLS_COLS) {
		toolsW = MIN_TOOLS_COLS;
		thinkW = total - toolsW;
	}
	if (thinkW < MIN_THINK_COLS) {
		thinkW = MIN_THINK_COLS;
		toolsW = total - thinkW;
	}
	if (toolsW < MIN_TOOLS_COLS) toolsW = raw;
	return toolsW;
}

export const MIN_DOCK_COLS = 24;
/** Columns the transcript side keeps when the files dock is resized. */
export const DOCK_LEFT_RESERVE = 50;

/** Files dock width: auto = 25% clamped to 34–48 cols; a manual width is
 * clamped to [MIN_DOCK_COLS, cols - DOCK_LEFT_RESERVE]. */
export function dockColsFor(cols: number, manual: number | null = null): number {
	if (manual === null) return Math.max(34, Math.min(48, Math.floor(cols * 0.25)));
	const max = Math.max(MIN_DOCK_COLS, cols - DOCK_LEFT_RESERVE);
	return Math.max(MIN_DOCK_COLS, Math.min(max, Math.trunc(manual)));
}

/** Compact duration: 0.4s · 2.3s · 42s · 3m05s · 1h02m. `live` drops the
 * sub-second digit so a running counter ticks once per second. */
export function formatDuration(ms: number, live = false): string {
	const t = Math.max(0, ms);
	if (t < 10_000 && !live) return `${(Math.floor(t / 100) / 10).toFixed(1)}s`;
	const s = Math.floor(t / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Append a streamed delta to a newline-free tail, moving completed lines
 * into `lines` (mutated). Lines are split BEFORE the tail is capped, so a
 * large delta never loses complete lines. When the tail exceeds `maxTail` it
 * drops its older half (code-point aligned) in one step instead of sliding by
 * a few chars per delta — a sliding cut would re-flow every wrapped row of
 * the visible paragraph on each flush. Returns the new tail.
 */
export function appendStreamTail(
	lines: string[],
	tail: string,
	delta: string,
	maxTail: number,
): string {
	let t = tail + delta;
	let nl = t.indexOf("\n");
	while (nl !== -1) {
		const seg = t.slice(0, nl);
		lines.push(seg.endsWith("\r") ? seg.slice(0, -1) : seg);
		t = t.slice(nl + 1);
		nl = t.indexOf("\n");
	}
	if (t.length > maxTail) {
		let start = t.length - Math.floor(maxTail / 2);
		if (isLowSurrogate(t.charCodeAt(start))) start++;
		t = t.slice(start);
	}
	return t;
}

/** Cap one display line to its newest `max` UTF-16 units ("… " prefix). */
export function capDisplayLine(line: string, max: number): string {
	if (line.length <= max) return line;
	let start = line.length - (max - 2);
	if (isLowSurrogate(line.charCodeAt(start))) start++;
	return "… " + line.slice(start);
}

/** One inline-image block of a tool result (base64 data + MIME type). */
export interface ImageBlock {
	data: string;
	mimeType: string;
}

/** The LAST image block of a tool result's content, if any. Content is
 * either a plain string or an array of blocks; only well-formed image blocks
 * (string `data` + `mimeType`) count. Keeping the last one matches how pi's
 * transcript renders results (one image per `read`; rare multi-image results
 * keep the most recent). */
export function lastImageBlock(content: unknown): ImageBlock | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const c = content[i] as any;
		if (
			c?.type === "image" &&
			typeof c.data === "string" &&
			typeof c.mimeType === "string"
		)
			return { data: c.data, mimeType: c.mimeType };
	}
	return undefined;
}

/** The first `cap` lines of an already-trimmed output list, plus how many
 * lines were hidden (for the "+N more" marker). `cap <= 0` shows nothing. */
export function outputPreview(
	lines: string[],
	cap: number,
): { shown: string[]; hidden: number } {
	if (cap <= 0 || lines.length === 0) return { shown: [], hidden: lines.length };
	const shown = lines.slice(0, cap);
	return { shown, hidden: lines.length - shown.length };
}

/** pi auto-discovers every *.ts in an extensions dir; no-op factory. */
export default function (_pi: ExtensionAPI) {
	/* shared helper module, not a real extension */
}
