/**
 * split-view.ts — unified panel TUI extension
 *
 * One extension owns the whole "split the main window" surface:
 *   - thinking panel  (top-left band)
 *   - tools panel     (top-right band)
 *   - files panel     (right dock side column, with an edit-diff subpanel)
 *
 * Layout (fullscreen, composed in ONE layer owned by layout-manager):
 *
 *   band on?  files on?
 *   ─────────────────────────────────────
 *   both  → HStack(VStack(band, transcript), filesDock)
 *   band  → VStack(band, transcript)
 *   files → HStack(transcript, filesDock)
 *   none  → transcript (no layer)
 *
 * With trimResponse on, "transcript" above is replaced by the response doc
 * ScrollView + the base root's reused editor dock (works standalone, without
 * band or files).
 *
 * Regular (non-fullscreen) mode: the files panel falls back to a non-capturing
 * overlay; the band needs the layout engine and only works in fullscreen.
 *
 * Commands:
 *   /split              toggle the band (thinking+tools) on/off
 *   /split-thinking     toggle the thinking panel within the band
 *   /split-tools        toggle the tools panel within the band
 *   /files              toggle the files panel (dock in fullscreen, overlay otherwise)
 *   /split-tools-view   toggle tool panel compact ↔ full detail
 *   /split-trim-response toggle panel C: pi transcript ↔ response-only view
 *   /split-height <n>   set the top band height in rows (6–40)
 *   /split-save       persist current layout as startup defaults for NEW
 *                     windows (toggles are session-local by default, so
 *                     concurrent pi windows don't clobber each other)
 *
 * Panels use the measurement-safe architecture: no separate border-column
 * flanks; the ScrollView's always-on scrollbar (track styled as border) IS the right frame
 * edge, and MeasurementSafeVStack subclasses make the engine's discarded
 * intrinsic-height measurement passes O(1) instead of eagerly rendering whole
 * subtrees (panels + transcript) every keystroke frame. Bodies render a
 * newest-first row-capped window (~96 rows). Full history stays in the
 * transcript; the band is a recent-history view.
 *
 * Panel C trim mode (trimResponse): the transcript region of pi's base root is
 * swapped for an extension-owned ScrollView over a document of user / assistant
 * messages (reused from branch + streamed live via pi's own message
 * components), so rendering matches the native transcript minus tool calls,
 * thinking blocks and extension custom entries. The editor dock
 * (pending/status/editor/footer) is reused verbatim, so input is untouched.
 *
 * Response-only is native-parity BY DESIGN (SV-09/SV-10/SV-18, USER DECISION
 * 2026-10-07, decisions/E-policy.md): it shows TEXT content only — pi's own
 * transcript renders user messages as text and drops non-text blocks, so
 * image-only user turns render nothing there either; it keeps FULL scrollback
 * (unbounded — pi's own transcript is unbounded and offers no virtualization
 * primitive, so this matches the platform's cost model, a constant factor
 * only); and it preserves the NUMERIC scroll offset across branch switches —
 * the ScrollView clamps the old offset into the new content, exactly like
 * the native transcript on the same /tree switch. Toggling trim itself does
 * not move the response doc's scroll position.
 *
 * Single-TUI-context assumption (SV-20): this extension and layout-manager.ts
 * assume ONE interactive TUI context per process. Module state (tuiRef, panel
 * flags, buffers) and the shared layout manager (one tuiRef / baseRoot / layer
 * map on globalThis) are singletons. pi does not guarantee this upstream, and
 * simultaneous TUI contexts in one process are unverified and unsupported.
 *
 * Performance: pi's renderCache is fresh every frame, so panels cache their
 * wrapped/styled output on a (version, width) key; unchanged frames are O(1).
 * requestRender() is gated on any panel being active.
 *
 * Shortcuts (ctrl+o/ctrl+t) are dropped: reserved built-ins, un-registrable.
 */

import {
	generateDiffString,
	renderDiff,
	AssistantMessageComponent,
	UserMessageComponent,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	HStack,
	ScrollView,
	Spacer,
	VStack,
	type Component,
	type OverlayHandle,
	wrapTextWithAnsi,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	loadUiPanelsConfig,
	saveUiPanelsConfig,
	normalizeConfig,
	type ToolMode as ToolModeCfg,
} from "./ui-panels-config.ts";
import {
	getBaseRoot,
	initLayoutManager,
	setLayoutLayer,
	isLayoutLayerActive,
	selfHealLayout,
} from "./layout-manager.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
// Display window (logical lines) for the thinking panel. The full transcript
// keeps everything; the band is a recent-history view. Must stay small: the
// per-flush render cost is dominated by wrapping the visible window.
const MAX_LINES = 400;
// A newline-free streaming tail grows char by char; every flush re-wraps it
// (its key changes each time). Render only its recent suffix so per-flush
// work is bounded even for one giant paragraph.
const MAX_TAIL_CHARS = 2000;
const MAX_FILES = 500;
const MAX_WIDGET_NAMES = 3;
const MIN_TERM_WIDTH = 90;
const MAX_TOOL_OUTPUT_LINES = 20;
// OracleSpec body window: hard cap on FINAL VISUAL rows rendered by band
// panels (logical lines can wrap into many). ~2 viewports of scrollback.
const MAX_BODY_ROWS = 96;
// Hard cap on raw chars processed per logical line (giant-line guard).
const MAX_LINE_CHARS = 600;

/** Legend shown at the bottom of the files list. */
const LEGEND = "r read · w write · s seen(bash) · a subagent";

// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: any;
let widgetSet = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** SV-14: the saved startup composition is still unapplied. Armed in
 * session_start before reconstruct(); consumed by the widget factory (the
 * first point where the fullscreen root is available, BEFORE the first
 * paint) or by the deferred startup timer as a fallback. */
let startupPending = false;

// Overlay registry for the regular-mode files panel (survives /reload).
const REG_KEY = Symbol.for("pi.explored-files");
interface Registry {
	gen: number;
	active?: OverlayHandle | null;
	activeGen?: number;
	/** The overlay's component, stored so the extension — the valid lifecycle
	 * owner — can dispose it on close/shutdown (Option C: no ctx.ui.custom()
	 * promise exists to dispose it for us). decisions/D-overlay-lifecycle.md */
	panel?: FilesPanel | null;
}
const G = globalThis as Record<symbol, Registry>;
const REG: Registry = G[REG_KEY] ?? { gen: 0 };
G[REG_KEY] = REG;
const MY_GEN = ++REG.gen;

/** Terminal height, captured by the overlay's visible callback each render. */
let termHeight = 0;

// Panel enable flags (kept in sync with config; thinking/tools default true).
let thinkingOn = true;
let toolsOn = true;
let filesOn = false;
let toolMode: ToolModeCfg = "compact";
/** Panel C: response-only view instead of pi's transcript (persisted). */
let trimResponse = false;
/** Top band height in rows (6–40, persisted; /split-height). */
let bandHeight = 14;
/** F: tools panel's share of the band width in percent (20–60, default 35,
 * persisted as toolsWidthPct; session-local, only /split-save writes it). */
let toolsWidthPct = 35;

/** SV-08: fingerprint of the live theme's panel-relevant colors, captured
 * when the composition was built. pi replaces the global theme object on a
 * theme change (extensions receive no event), and components/caches capture
 * ANSI at build time — so the widget render compares this fingerprint and
 * recomposes theme-dependent components on a change ONLY. */
let composedThemeFp: string | null = null;

function themeFingerprint(theme: Theme): string {
	return [
		theme.fg("border", "x"),
		theme.fg("accent", "x"),
		theme.fg("muted", "x"),
		theme.fg("thinkingText", "x"),
		theme.fg("toolOutput", "x"),
		theme.fg("success", "x"),
		theme.fg("error", "x"),
		theme.fg("warning", "x"),
		theme.fg("dim", "x"),
		theme.fg("text", "x"),
	].join("|");
}

// ─── thinking buffer ─────────────────────────────────────────────────────────

interface ThinkingBlock {
	lines: string[];
	tail: string;
	complete: boolean;
}

/**
 * Coalesce streaming appends: each token bumps `version`, which invalidates the
 * panel's (version, width) render cache → full re-wrap of all lines per frame.
 * During a stream we bump at most every THINK_RAF_MS instead, so keystroke
 * frames don't queue behind 5000-line re-wraps. Complete blocks + end() are
 * unaffected (they bump synchronously).
 */
const THINK_RAF_MS = 100;
let thinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
let thinkDirty = false;

function flushThinking(): void {
	thinkFlushTimer = null;
	if (!thinkDirty) return;
	thinkDirty = false;
	thinking.version++;
	requestRender();
}

function cancelPendingThinkFlush(): void {
	thinkDirty = false;
	if (thinkFlushTimer) {
		clearTimeout(thinkFlushTimer);
		thinkFlushTimer = null;
	}
}

/**
 * Tools-side twin of the thinking flush: tool_execution_update can fire many
 * times per second while a command streams output; each bump would re-wrap
 * the tools window + repaint. Coalesce to ≤1 version bump per TOOLS_FLUSH_MS.
 * start/end stay synchronous (entry appears / finalizes immediately).
 */
const TOOLS_FLUSH_MS = 100;
let toolsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let toolsDirty = false;

function flushTools(): void {
	toolsFlushTimer = null;
	if (!toolsDirty) return;
	toolsDirty = false;
	toolsVersionCounter++;
	requestRender();
}

function cancelPendingToolsFlush(): void {
	toolsDirty = false;
	if (toolsFlushTimer) {
		clearTimeout(toolsFlushTimer);
		toolsFlushTimer = null;
	}
}

function markToolsDirty(): void {
	toolsDirty = true;
	if (!toolsFlushTimer) toolsFlushTimer = setTimeout(flushTools, TOOLS_FLUSH_MS);
}

const thinking = {
	blocks: [] as ThinkingBlock[],
	current: null as ThinkingBlock | null,
	streaming: false,
	version: 0,
	start() {
		if (this.current && (this.current.lines.length || this.current.tail)) {
			this.current.complete = true;
			this.blocks.push(this.current);
		}
		this.current = { lines: [], tail: "", complete: false };
		this.streaming = true;
		this.version++;
	},
	append(delta: string) {
		if (!this.current) this.current = { lines: [], tail: "", complete: false };
		this.current.tail += delta;
		if (this.current.tail.length > MAX_TAIL_CHARS)
			this.current.tail = this.current.tail.slice(-MAX_TAIL_CHARS);
		let nl = this.current.tail.indexOf("\n");
		while (nl !== -1) {
			this.current.lines.push(this.current.tail.slice(0, nl));
			this.current.tail = this.current.tail.slice(nl + 1);
			nl = this.current.tail.indexOf("\n");
		}
		this.trim();
		thinkDirty = true;
		if (!thinkFlushTimer)
			thinkFlushTimer = setTimeout(flushThinking, THINK_RAF_MS);
	},
	end(text: string) {
		cancelPendingThinkFlush();
		if (this.current) {
			if (text) {
				// Authoritative final content: replace the accumulated buffer.
				this.current.lines = text.split(/\r?\n/);
				this.current.tail = "";
			} else if (this.current.tail) {
				// SV-21: an empty/omitted end payload must not wipe streamed
				// text — finalize the accumulated tail into the current block.
				this.current.lines.push(this.current.tail);
				this.current.tail = "";
			}
			this.current.complete = true;
			this.blocks.push(this.current);
			this.current = null;
			this.trim();
		}
		this.streaming = false;
		this.version++;
	},
	trim() {
		// Hard-bound the whole display buffer (oldest lines first, splicing
		// partially into the front/current block so a giant block trims instead
		// of vanishing). The old version only evicted whole completed blocks, so
		// an oversized current block or reconstruct() output could blow past
		// MAX_LINES.
		let excess = this.countLines() - MAX_LINES;
		while (excess > 0) {
			const b = this.blocks[0];
			if (!b) {
				if (this.current) {
					const cut = Math.min(excess, this.current.lines.length);
					this.current.lines.splice(0, cut);
					excess -= cut;
				}
				break;
			}
			if (b.lines.length <= excess) {
				this.blocks.shift();
				excess -= b.lines.length;
			} else {
				b.lines.splice(0, excess);
				excess = 0;
			}
		}
	},
	countLines() {
		let total = 0;
		for (const b of this.blocks) total += b.lines.length;
		if (this.current) total += this.current.lines.length;
		return total;
	},
	reset() {
		cancelPendingThinkFlush();
		this.blocks = [];
		this.current = null;
		this.streaming = false;
		this.version++;
	},
};

function thinkingLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const sep = theme.fg("dim", "─".repeat(Math.max(8, Math.min(60, width - 3))));
	for (const b of thinking.blocks) {
		if (out.length) out.push("");
		out.push(sep);
		for (const l of b.lines) out.push(l);
	}
	if (thinking.current) {
		if (out.length) out.push("");
		for (const l of thinking.current.lines) out.push(l);
		if (thinking.current.tail) out.push(thinking.current.tail);
	}
	return out;
}

// ─── response doc (panel C trim mode) ───────────────────────────────

/**
 * Panel C's document: user + assistant messages only, rendered with pi's own
 * transcript components. Built from the branch (session start / tree) and
 * streamed live (message_start/update/end). Assistant content is filtered to
 * drop thinking blocks (panel A owns those) — tool calls never render here
 * (panel B owns those), so an assistant message with no text is skipped.
 */
const responseDoc = new Container();
let streamingResponseComponent: AssistantMessageComponent | null = null;

function messageText(msg: any): string {
	const c = msg?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c))
		return c
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("");
	return "";
}

/** Content with thinking blocks and tool calls stripped (panel C is response-only). */
function responseContent(msg: any): any[] {
	return (Array.isArray(msg?.content) ? msg.content : []).filter(
		(c: any) => c?.type !== "thinking" && c?.type !== "toolCall",
	);
}

/** Append a message to the response doc (user or assistant). */
function addResponseMessage(msg: any): void {
	try {
		if (msg.role === "user") {
			const text = messageText(msg);
			if (!text.trim()) return;
			if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
			responseDoc.addChild(new UserMessageComponent(text, getMarkdownTheme()));
			return;
		}
		if (msg.role === "assistant") {
			const content = responseContent(msg);
			const hasText = content.some(
				(c: any) =>
					c?.type === "text" && typeof c.text === "string" && c.text.trim(),
			);
			// Keep empty-text messages whose stopReason shows an error marker.
			if (!hasText && msg.stopReason !== "error" && msg.stopReason !== "aborted")
				return;
			if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
			// toolCalls are stripped too so the component's error/abort markers
			// render (it suppresses them when toolCalls exist — in the full
			// transcript the tool components show errors instead).
			responseDoc.addChild(
				new AssistantMessageComponent(
					{ ...msg, content },
					true,
					getMarkdownTheme(),
					"Thinking…",
					1,
					[],
				),
			);
		}
	} catch {
		/* theme not ready yet — skipped; rebuilt on next reconstruct */
	}
}

/** Rebuild the whole response doc from the current branch. */
function rebuildResponseDoc(ctx: ExtensionContext): void {
	responseDoc.clear();
	streamingResponseComponent = null;
	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg) addResponseMessage(msg);
	}
}

/** Live-stream an assistant message into the doc (lazy: created on first visible text). */
function responseMessageUpdate(msg: any): void {
	if (msg?.role !== "assistant") return;
	const stripped = { ...msg, content: responseContent(msg) };
	const hasVisible = stripped.content.some(
		(c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim(),
	);
	if (!streamingResponseComponent) {
		// Pure tool-call / thinking rounds never create a component — no stray
		// spacers accumulate in the doc.
		if (!hasVisible) return;
		try {
			if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
			streamingResponseComponent = new AssistantMessageComponent(
				undefined as any,
				true,
				getMarkdownTheme(),
				"Thinking…",
				1,
				[],
			);
			responseDoc.addChild(streamingResponseComponent);
		} catch {
			/* theme not ready */
			return;
		}
	}
	try {
		streamingResponseComponent.updateContent(stripped, true);
	} catch {
		/* ignore */
	}
}

function responseMessageEnd(msg: any): void {
	if (msg?.role !== "assistant") return;
	if (streamingResponseComponent) {
		try {
			streamingResponseComponent.updateContent(
				{ ...msg, content: responseContent(msg) },
				false,
			);
		} catch {
			/* ignore */
		}
		streamingResponseComponent = null;
	} else {
		// No component was streamed (no update fired, or thinking/tool-only
		// round): finalize from the full message — addResponseMessage itself
		// skips empty text and keeps error/abort markers.
		addResponseMessage(msg);
	}
}

// ─── tool buffer ─────────────────────────────────────────────────────────────

let toolsVersionCounter = 0;

interface ToolEntry {
	id: string;
	name: string;
	args: string;
	output: string;
	active: boolean;
	isError: boolean;
	subagent?: boolean;
	agent?: string;
}
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

/** True if c is a UTF-16 high (lead) surrogate — the first half of an astral
 * code point. Used to keep truncation cuts off surrogate-pair boundaries. */
function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	// Never end mid surrogate pair (a lone trailing half renders as U+FFFD).
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return flat.slice(0, end) + "…";
}

/** SV-16: storage cap for one tool's text (args JSON or result output), in
 * UTF-16 code units (≈ in-memory size of the stored string). Below pi's own
 * bash-output cap (50KB) so even maximal tool output is bounded here, and
 * ~2.7× the maximum displayed content (20 lines × 600 chars). */
const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** SV-16: bound one tool text to MAX_TOOL_TEXT_CHARS, keeping the NEWEST
 * suffix and prepending an explicit truncation marker. The cut is aligned to
 * a code point so a UTF-16 surrogate pair is never split. Text within the
 * cap passes through unchanged (byte-identical). */
function capToolText(s: string): string {
	if (s.length <= MAX_TOOL_TEXT_CHARS) return s;
	const total = s.length;
	const marker = `[truncated: newest ${MAX_TOOL_TEXT_CHARS} of ${total} chars]\n`;
	const budget = MAX_TOOL_TEXT_CHARS - marker.length;
	let end = s.length;
	let units = 0;
	while (end > 0 && units < budget) {
		// Width of the code point ENDING at `end`: an astral char occupies
		// end-2..end-1 (lead surrogate at end-2), so a pair is never split.
		const w = end >= 2 && isHighSurrogate(s.charCodeAt(end - 2)) ? 2 : 1;
		if (units + w > budget) break;
		units += w;
		end -= w;
	}
	return marker + s.slice(end);
}

function resultText(r: any): string {
	let text: string;
	if (typeof r === "string") text = r;
	else {
		const content = r?.content;
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("");
		} else text = "";
	}
	// SV-16: bound the stored text before the caller splits/keeps lines.
	return capToolText(text);
}

function argsJson(args: any): string {
	try {
		// SV-16: bound the stored args JSON (newest suffix + marker).
		return capToolText(JSON.stringify(args ?? {}));
	} catch {
		return "";
	}
}

function setToolOutput(e: ToolEntry, text: string): void {
	// SV-16: cap BEFORE splitting so the split never sees unbounded text.
	const lines = capToolText(text).split(/\r?\n/);
	e.output = lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
}

/** SV-17: ingest one tool call through the SAME path for live events and
 * branch reconstruction (resume / session_tree), so the bounded buffer,
 * the newest-first display and the MAX_TOOLS eviction (oldest shifted out)
 * behave identically for resumed and live entries. */
function ingestToolCall(id: string, name: string, args: any): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name,
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
	});
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift()!;
		toolsBy.delete(evict);
	}
}

/** SV-17: ingest one tool result, correlated to its call by id (live event
 * or resumed branch entry). A result whose call is not in the bounded buffer
 * (evicted or unknown) is ignored. */
function ingestToolResult(id: string, result: any, isError: boolean): void {
	const e = toolsBy.get(id);
	if (!e) return;
	const text = resultText(result);
	if (text) setToolOutput(e, text);
	e.active = false;
	e.isError = isError;
	cancelPendingToolsFlush();
	toolsVersionCounter++;
}

function toolLines(theme: Theme, width: number): string[] {
	const th = theme;
	const out: string[] = [];
	const full = toolMode === "full";
	// Text budget inside the frame: 1 col inset + ≥2 trailing pad cols
	// (the transient scrollbar paints over the pad, never the frame).
	const textWidth = Math.max(8, width - 3);
	for (const id of toolOrder) {
		const e = toolsBy.get(id);
		if (!e) continue;
		const mark = e.active
			? th.fg("warning", "●")
			: e.isError
				? th.fg("error", "✗")
				: th.fg("success", "✓");
		const name = e.active
			? th.fg("accent", e.name)
			: e.isError
				? th.fg("error", e.name)
				: th.fg("success", e.name);
		const badge = e.subagent ? th.fg("muted", `[${e.agent ?? "sub"}]`) : "";
		const prefix = `${mark} ${name}${badge}`;
		const room = textWidth - visibleWidth(prefix) - 1;
		const args =
			e.args && room >= 8
				? th.fg("muted", ` ${truncateInline(e.args, room)}`)
				: "";
		out.push(prefix + args);
		if (!full) {
			if (out.length > 1) out.splice(out.length - 1, 0, "");
			continue;
		}
		const content = (e.output || "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (content.length === 0) {
			if (e.active) out.push(th.fg("dim", "  · …"));
		} else {
			for (const l of content.slice(0, 2))
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (content.length > 2)
				out.push(th.fg("dim", `  · +${content.length - 2} more`));
		}
	}
	return out;
}

const toolsVersion = () => toolsVersionCounter;

// ─── files buffer ────────────────────────────────────────────────────────────

interface FileEntry {
	path: string;
	ops: string;
	count: number;
}
const files = new Map<string, FileEntry>();
let filesVersion = 0;

function pathsFrom(
	toolName: string,
	input: any,
): { abs: string; op: string }[] {
	const out: { abs: string; op: string }[] = [];
	if (toolName === "bash") {
		const cmd = typeof input?.command === "string" ? input.command : "";
		for (const raw of cmd.split(/\s+/)) {
			const tok = raw.replace(/^[("'`]+/, "").replace(/[)"'`;:,]+$/, "");
			if (!tok || tok.startsWith("-") || /[|&><`$*?]/.test(tok)) continue;
			try {
				const abs = path.resolve(tok);
				if (existsSync(abs) && statSync(abs).isFile()) out.push({ abs, op: "s" });
			} catch {
				/* skip */
			}
		}
		return out;
	}
	const add = (v: unknown, op: string, unconditional: boolean) => {
		if (typeof v !== "string" || !v) return;
		try {
			const abs = path.resolve(v);
			if (!unconditional && (!existsSync(abs) || !statSync(abs).isFile())) return;
			out.push({ abs, op });
		} catch {
			/* skip */
		}
	};
	if (toolName === "read") {
		add(input?.path, "r", true);
		return out;
	}
	if (toolName === "write" || toolName === "edit") {
		add(input?.path, "w", true);
		return out;
	}
	for (const key of ["path", "filePath", "file_path", "imagePath"])
		add(input?.[key], "r", false);
	for (const key of ["paths", "files", "filePaths"]) {
		if (Array.isArray(input?.[key]))
			for (const v of input[key]) add(v, "r", false);
	}
	return out;
}

function record(toolName: string, input: any): void {
	const seen = new Set<string>();
	for (const { abs, op } of pathsFrom(toolName, input)) {
		if (seen.has(abs)) continue;
		seen.add(abs);
		const prev = files.get(abs);
		if (prev) {
			files.delete(abs);
			prev.count++;
			if (!prev.ops.includes(op)) prev.ops += op;
			files.set(abs, prev);
		} else {
			if (files.size >= MAX_FILES)
				files.delete(files.keys().next().value as string);
			files.set(abs, { path: abs, ops: op, count: 1 });
		}
	}
	filesVersion++;
}

function bumpFilesVersion(): void {
	filesVersion++;
}

const recentEntries = (): FileEntry[] => [...files.values()].reverse();

function displayPath(abs: string): string {
	const rel = path.relative(process.cwd(), abs);
	if (rel && !rel.startsWith("..")) return rel;
	const home = homedir();
	if (abs.startsWith(home + path.sep)) return `~${abs.slice(home.length)}`;
	return abs;
}

function widgetLines(theme: Theme, width: number): string[] {
	const entries = recentEntries();
	if (entries.length === 0) return [];
	const names = entries
		.slice(0, MAX_WIDGET_NAMES)
		.map((e) => path.basename(e.path));
	const rest = entries.length - names.length;
	let text = `📂 ${entries.length}`;
	if (names.length) text += `  ${names.join(" · ")}`;
	if (rest > 0) text += `  +${rest}`;
	return [truncateToWidth(theme.fg("dim", text), width)];
}

// ─── edit-diff buffer ────────────────────────────────────────────────────────

/**
 * Raw (unrendered) diff state for the files panel's bottom subpanel.
 * We store raw text (not ANSI) so it survives theme changes; `renderDiff` is
 * applied at draw time. A monotonic token guards against out-of-order async
 * diff computations overwriting a newer edit with a stale older one.
 */
const editDiff = {
	path: "" as string,
	diff: "" as string,
	version: 0,
	token: 0,
};
let pendingDiffToken = 0;
/** SV-23: edit preview/result correlation. Every edit tool_call gets a
 * monotonically increasing generation and owns the preview; a tool_result
 * applies its authoritative diff only when its toolCallId maps to the current
 * generation, so an older, slower edit can never overwrite a newer preview. */
let editGeneration = 0;
const editGenByCallId = new Map<string, number>();

function setEditDiff(p: string, diff: string): void {
	editDiff.path = p;
	editDiff.diff = diff;
	editDiff.version++;
}

function clearEditDiff(): void {
	editDiff.path = "";
	editDiff.diff = "";
	editDiff.version++;
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

const anyPanelActive = () =>
	isLayoutLayerActive("ui") || isLayoutLayerActive("files") || !!REG.active;
// SV-01: "band on" is derived from the band itself, NOT from the shared "ui"
// layout layer — that layer is also installed for trimResponse/files, so it
// must not be read as band state (a files-only or trim-only layout used to
// make /split report "off" for an already-off band and refuse to turn it on).
// The layer check stays in use only for layout ownership.
const bandActive = () => thinkingOn || toolsOn;
const filesActive = () => isLayoutLayerActive("files") || !!REG.active;

// ─── framed panel components ─────────────────────────────────────────────────

class BorderTop {
	constructor(
		private theme: Theme,
		private title: string,
		private color: "accent" | "muted",
		private streaming: () => boolean,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const contentWidth = Math.max(1, width - 2);
		const title = th.fg(this.color, ` ${this.title} `);
		const dot = this.streaming() ? th.fg("warning", "●") : "";
		const label = truncateToWidth(title + dot, contentWidth);
		const fill = th.fg(
			"border",
			"─".repeat(Math.max(0, contentWidth - visibleWidth(label))),
		);
		return [th.fg("border", "╭") + label + fill + th.fg("border", "╮")];
	}
	invalidate(): void {}
	dispose(): void {}
}

class BorderBottom {
	constructor(private theme: Theme) {}
	render(width: number): string[] {
		return [
			this.theme.fg("border", "╰") +
				this.theme.fg("border", "─".repeat(Math.max(0, width - 2))) +
				this.theme.fg("border", "╯"),
		];
	}
	invalidate(): void {}
	dispose(): void {}
}

/**
 * OracleSpec: a VStack whose component-level render() is a constant sentinel.
 * The layout engine checks LAYOUT_NODE before plain render (layoutComponent),
 * so real layout/painting is untouched — but the engine's DISCARDED intrinsic-
 * height measurement passes (hstack node branch) call component.render() and
 * now cost O(1) instead of eagerly rendering the whole subtree (band panels,
 * and via the dock, the full transcript) on every keystroke frame.
 */
class MeasurementSafeVStack extends VStack {
	render(_width: number): string[] {
		return [""];
	}
}

/**
 * OracleSpec body: renders the recent window with a left │ edge only — the
 * ScrollView's always-on scrollbar column is the right frame edge (track
 * styled as border, so the frame reads as complete; thumb slides when
 * overflowing). Pads every row to EXACT width and always emits at least
 * `minRows` rows so the left edge is continuous when content is short. No
 * per-line memo: the window is small, a (version, width) cache suffices.
 */
class RecentBody {
	private cacheVersion = -1;
	/** SV-19: bounded width cache — keep the current width plus a small LRU of
	 * recent widths so resize cycling cannot grow it unbounded. */
	private cacheByWidth = new Map<number, string[]>();
	private static readonly MAX_CACHED_WIDTHS = 4;
	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		private lines: (width: number) => string[],
		private version: () => number,
		private empty: string,
		/** Rows to guarantee so the left edge has no gaps (viewport height). */
		private minRows: () => number,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		if (v !== this.cacheVersion) {
			this.cacheVersion = v;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			// SV-19: refresh recency so eviction is genuinely LRU, not FIFO —
			// delete+set moves this width to the Map's newest position.
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			return cached;
		}
		const edge = th.fg("border", "│");
		const pad = (s: string) =>
			" ".repeat(Math.max(0, width - 1 - visibleWidth(s)));
		// Wrap newest-first, keep only the newest MAX_BODY_ROWS visual rows;
		// giant logical lines are suffix-capped before wrapping.
		// SV-03/SV-04: fragments of ONE source line are wrapped as a group and
		// the group is inserted in order (an individual unshift reversed the
		// fragments of one line); the MAX_BODY_ROWS cap counts VISUAL rows, not
		// source lines, so one long line cannot blow past the cap at narrow
		// widths. A group that would straddle the cap is skipped whole (no
		// fragment is ever split); the newest groups always fit. A single group
		// larger than the whole cap keeps only its newest fragments.
		const src = this.lines(width);
		const groups: string[][] = [];
		let used = 0;
		for (let i = src.length - 1; i >= 0; i--) {
			const line =
				src[i].length > MAX_LINE_CHARS
					? "… " + src[i].slice(-MAX_LINE_CHARS + 1)
					: src[i];
			const frags = wrapTextWithAnsi(
				this.style(line),
				Math.max(1, width - 3),
			).map((w: string) => " " + w);
			if (used + frags.length > MAX_BODY_ROWS) {
				if (groups.length === 0 && frags.length > MAX_BODY_ROWS)
					groups.push(frags.slice(frags.length - MAX_BODY_ROWS));
				break;
			}
			groups.push(frags);
			used += frags.length;
		}
		const rows: string[] = [];
		for (let g = groups.length - 1; g >= 0; g--)
			for (const f of groups[g]) rows.push(f);
		let out: string[];
		if (rows.length === 0) {
			const empty = " " + th.fg("dim", this.empty);
			out = [edge + empty + pad(empty)];
		} else {
			out = rows.map((r) => edge + r + pad(r));
		}
		// Guarantee a continuous left edge: fill short content up to minRows.
		const min = Math.max(1, this.minRows());
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		while (out.length < min) out.push(filler);
		this.cacheByWidth.set(width, out);
		// SV-19: bound the number of cached widths (Map preserves insertion
		// order; hits refresh recency above, so the first key is least-recent
		// and eviction is true LRU).
		while (this.cacheByWidth.size > RecentBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return out;
	}
	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
	}
	dispose(): void {}
}

// ─── files panel (list + edit-diff subpanel) ──────────────────────────────────

class FilesPanel {
	private cacheKey = "";
	private cacheLines: string[] = [];

	constructor(
		private theme: Theme,
		/** Fullscreen dock: live terminal rows. Overlay: undefined. */
		private heightProvider?: () => number,
	) {}

	// No handleInput: the regular-mode overlay is nonCapturing, so it never
	// receives keys — Escape belongs to the editor/Pi, and /files is the
	// close/reopen path (Option C, decisions/D-overlay-lifecycle.md).

	render(width: number): string[] {
		if (REG.gen !== MY_GEN) return [];
		const height =
			this.heightProvider?.() || termHeight || recentEntries().length + 12;
		// Cache key MUST include height: a height-only terminal resize changes
		// the list/diff row split without bumping filesVersion or width.
		const key = `${filesVersion}|${editDiff.version}|${width}|${height}`;
		if (key === this.cacheKey) return this.cacheLines;

		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const pad = (s: string) =>
			s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const row = (c: string) =>
			th.fg("border", "│") + pad(truncateToWidth(c, inner)) + th.fg("border", "│");

		const entries = recentEntries();
		// Reserve the bottom half for the edit diff (min 2 list rows).
		const half = Math.max(6, Math.floor(height / 2));
		const listRows = Math.max(2, half - 4);
		// SV-06: exact row accounting so the bottom border lands on the last
		// allocated row. Fixed chrome is 6 rows (top, title, list separator,
		// diff separator, diff title, bottom border) and the list always pads
		// to listRows, so the diff section gets exactly what remains. Without
		// this a short diff left an unframed hole between the panel and the
		// viewport bottom (the old diffRows budget was never padded when a diff
		// existed, only when it did not).
		const diffRows = Math.max(0, height - listRows - 6);

		const meta = (e: FileEntry) =>
			th.fg("muted", `${e.ops}${e.count > 1 ? `×${e.count}` : ""}`);

		const rows: { line: string; files: number }[] = [];
		let i = 0;
		while (i < entries.length) {
			const dir = path.dirname(entries[i].path);
			let j = i;
			while (j < entries.length && path.dirname(entries[j].path) === dir) j++;
			const run = entries.slice(i, j);
			if (run.length > 3) {
				const label = displayPath(dir);
				rows.push({
					line: row(` ${th.fg("accent", label === "." ? "./" : `${label}/`)}`),
					files: 0,
				});
				for (const e of run)
					rows.push({
						line: row(`   ${meta(e)} ${th.fg("text", path.basename(e.path))}`),
						files: 1,
					});
			} else {
				for (const e of run)
					rows.push({
						line: row(` ${meta(e)} ${th.fg("text", path.basename(e.path))}`),
						files: 1,
					});
			}
			i = j;
		}

		const body: string[] = [];
		let filesShown = 0;
		for (const r of rows) {
			if (body.length >= listRows - 2) break;
			body.push(r.line);
			filesShown += r.files;
		}
		if (body.length === 0 && entries.length === 0)
			body.push(row(` ${th.fg("dim", "No files touched yet")}`));
		if (entries.length > filesShown)
			body.push(row(` ${th.fg("dim", `… +${entries.length - filesShown} more`)}`));
		body.push(row(` ${th.fg("dim", LEGEND)}`));
		while (body.length < listRows) body.push(row(""));

		// ── edit-diff subpanel ──
		const diffBody: string[] = [];
		diffBody.push(th.fg("border", `├${"─".repeat(inner)}┤`));
		// SV-05: truncate the title by DISPLAY COLUMNS (wide/CJK/emoji paths)
		// and compute the fill from the truncated title's visible width, so the
		// title can never overrun the fill and collide with the right border.
		// Budget: leading " ✎ " + trailing " " around the path text.
		const title = editDiff.path
			? th.fg("accent", ` ✎ ${truncateToWidth(displayPath(editDiff.path), inner - 4, "…")} `)
			: th.fg("dim", " Last Edit ");
		const titleFill = "─".repeat(
			Math.max(0, inner - visibleWidth(title)),
		);
		diffBody.push(
			th.fg("border", "│") +
				title +
				th.fg("border", titleFill) +
				th.fg("border", "│"),
		);

		if (editDiff.diff) {
			const rendered = renderDiff(editDiff.diff).split(/\r?\n/);
			// SV-06: cap content one row below the pad target so the "… +N more"
			// marker always fits; the section is then padded to diffRows so the
			// frame closes on the last row.
			const shown = rendered.slice(0, Math.max(0, diffRows - 1));
			for (const l of shown) diffBody.push(row(` ${l}`));
			if (rendered.length > shown.length && diffRows > 0)
				diffBody.push(
					row(` ${th.fg("dim", `… +${rendered.length - shown.length} more`)}`),
				);
			while (diffBody.length < diffRows + 2) diffBody.push(row(""));
		} else {
			if (diffRows > 0)
				diffBody.push(row(` ${th.fg("dim", "No edit yet")}`));
			while (diffBody.length < diffRows + 2) diffBody.push(row(""));
		}

		const out = [
			th.fg("border", `╭${"─".repeat(inner)}╮`),
			row(` ${th.fg("accent", `📂 Files (${entries.length})`)}`),
			th.fg("border", `├${"─".repeat(inner)}┤`),
			...body,
			...diffBody,
			th.fg("border", `╰${"─".repeat(inner)}╯`),
		];
		this.cacheKey = key;
		this.cacheLines = out;
		return out;
	}

	invalidate(): void {
		this.cacheKey = "";
	}
	dispose(): void {}
}

// ─── layout composition (one layer) ──────────────────────────────────────────

/**
 * Panel scaffold: no separate border columns, no inner HStack — the always-on
 * scrollbar column is the right frame edge (track styled as border; the idle
 * full-height thumb is border-colored too, accent only while actively
 * scrolling), so nothing ever paints over a frame line and there is no
 * second composite layer. The MeasurementSafeVStack wrapper keeps the
 * engine's discarded measurement passes O(1).
 */
function framedPanel(
	theme: Theme,
	top: Component,
	body: RecentBody,
): Component {
	const scroll = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		// SV-25: the layout engine paints the idle thumb as "┃" (heavy) while
		// the track is "│" (light) — same border color, different glyph, so the
		// right frame edge read as broken at the thumb's rows. Map the IDLE
		// thumb to the track's glyph so the edge is a uniform │ column at rest;
		// the ACTIVE thumb keeps "█" in accent for scroll feedback. No second
		// edge column, no track/color change, design unchanged.
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	return new MeasurementSafeVStack([
		{ component: top, basis: 1, grow: 0, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new BorderBottom(theme), basis: 1, grow: 0, shrink: 0 },
	]);
}

function buildBand(theme: Theme, inner: Component): Component {
	const panels: { component: Component; basis: number; grow: number }[] = [];
	const minRows = () => Math.max(1, bandHeight - 2);

	const defs: {
		title: string;
		color: "accent" | "muted";
		streaming: () => boolean;
		style: (line: string) => string;
		lines: (width: number) => string[];
		version: () => number;
		empty: string;
	}[] = [];
	if (thinkingOn)
		defs.push({
			title: "Thinking",
			color: "accent",
			streaming: () => thinking.streaming,
			style: (l) => theme.fg("thinkingText", l),
			lines: (w) => thinkingLines(theme, w),
			version: () => thinking.version,
			empty: "Thinking idle",
		});
	if (toolsOn)
		defs.push({
			title: "Tool Usage",
			color: "muted",
			streaming: () => toolOrder.some((id) => toolsBy.get(id)?.active),
			style: (l) => l,
			lines: (w) => toolLines(theme, w),
			version: toolsVersion,
			empty: "No tools called yet",
		});

	// F/F2: explicit tunable width split — no equal-flex weights or engine
	// content measurement. toolsWidthPct % of the ALLOCATED band width goes
	// to the tools panel, thinking gets the rest (minimum clamps inside the
	// helper). F2: the base is the allocated band region — with the files dock
	// visible (filesOn, ≥ MIN_TERM_WIDTH) that is the terminal width minus the
	// dock columns (the SV-07 clamp), not the full terminal width.
	// Single-panel bands keep the full width (no ratio involved).
	const termCols = tuiRef?.terminal?.columns ?? 120;
	const dockVisible = filesOn && termCols >= MIN_TERM_WIDTH;
	const base = termCols - (dockVisible ? dockColsFor(termCols) : 0);
	const splitBand = defs.length === 2;
	const toolsW = splitBand ? bandToolsColsFor(base) : -1;
	const thinkW = base - toolsW;
	composedBandTermCols = termCols;

	let di = 0;
	for (const d of defs) {
		const top = new BorderTop(theme, d.title, d.color, d.streaming);
		// defs order: thinking first (when on), then tools.
		const w = splitBand ? (di === 0 ? thinkW : toolsW) : 1;
		panels.push({
			component: framedPanel(
				theme,
				top,
				new RecentBody(theme, d.style, d.lines, d.version, d.empty, minRows),
			),
			basis: w,
			grow: splitBand ? 0 : 1,
		});
		di++;
	}

	// No enabled sub-panels → no band at all.
	if (panels.length === 0) return inner;

	// A single panel needs no HStack wrapper at all.
	const band =
		panels.length === 1
			? panels[0]!.component
			: new HStack(panels.map((p) => ({ ...p, shrink: 1, minSize: 1 })));
	const sep = new (class implements Component {
		invalidate(): void {}
		dispose(): void {}
		render(w: number): string[] {
			return [
				theme.fg("border", "╭") +
					theme.fg("border", "─".repeat(Math.max(0, w - 2))) +
					theme.fg("border", "╮"),
			];
		}
	})();
	return new VStack([
		{
			component: band,
			basis: bandHeight,
			grow: 0,
			shrink: 1,
			minSize: Math.min(6, bandHeight),
		},
		{ component: sep, basis: 1, grow: 0, shrink: 0 },
		{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
}

/** Dock width (clamped, 34–48) that the current composition was built with.
 *  SV-07: the dock basis is captured at compose time; the widget render
 *  compares it against the live terminal width and recomposes on change. */
let composedDockCols = -1;

/** F: explicit band split — minimum panel widths (cols) below which the
 * toolsWidthPct ratio clamps, so neither panel degenerates at narrow
 * terminals. */
const MIN_THINK_COLS = 24;
const MIN_TOOLS_COLS = 20;

/** F: tools panel width (cols) for the given terminal width under the
 * current toolsWidthPct, with the minimum clamps. When both minimums
 * cannot hold (very narrow terminals) the raw ratio is used — the panels
 * share whatever is available. */
function bandToolsColsFor(total: number): number {
	const raw = Math.round((total * toolsWidthPct) / 100);
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
	if (toolsW < MIN_TOOLS_COLS) {
		toolsW = raw;
		thinkW = total - toolsW;
	}
	return toolsW;
}

/** TERMINAL width the current band composition was built with. F2: the
 * widget render recomposes on any terminal-width change, so a resize never
 * leaves a stale basis — even when the tools cols round to the same value
 * (e.g. 101→102 cols at 50%). */
let composedBandTermCols = -1;

/** F2: the files dock's clamped width (SV-07) for a terminal width — shared
 * by buildFilesDock and buildBand so the band split uses the SAME allocated
 * base the dock actually takes. */
function dockColsFor(cols: number): number {
	return Math.max(34, Math.min(48, Math.floor(cols * 0.25)));
}

function buildFilesDock(theme: Theme, inner: Component): Component {
	const cols = tuiRef?.terminal?.columns ?? 120;
	const panelCols = dockColsFor(cols);
	composedDockCols = panelCols;
	const panel = new FilesPanel(theme, () => tuiRef?.terminal?.rows ?? 0);
	// Wrap the left subtree in a MeasurementSafeVStack — the dock
	// HStack's discarded intrinsic-height measurement would otherwise eagerly
	// render the ENTIRE left side (band + transcript) every keystroke frame.
	// ENTRY FORM MATTERS: a bare component defaults to grow:0, and this
	// wrapper's sentinel render measures as 1 row — with grow:0 a SHORTER-
	// than-screen left subtree (e.g. trim mode's response doc) would collapse
	// to its intrinsic height instead of stretching, blanking the left side.
	const left = new MeasurementSafeVStack([
		{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	return new HStack([
		{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: panel,
			basis: panelCols,
			grow: 0,
			shrink: 0,
			minSize: panelCols,
			visible: (v: { width: number }) => v.width >= MIN_TERM_WIDTH,
		},
	]);
}

/**
 * Panel C trim mode: replace the transcript region of the base root with a
 * ScrollView over our response doc. The editor dock (pending/status/editor/
 * widgets/footer) is reused verbatim from the base root's second entry, so
 * input is untouched and the composition stays lossless to toggle.
 */
let responseScrollView: ScrollView | null = null;

/** Extract the editor dock from pi's base root (VStack[transcript, dock]). */
function baseDockOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	// The transcript entry holds the ScrollView (own `child`); the dock is the
	// other entry.
	for (const e of entries) {
		const c = e?.component;
		if (!c) continue;
		if (!Object.hasOwn(c, "child")) return c as Component; // not a ScrollView → dock
	}
	return null;
}

/** Build the trimmed inner: VStack([responseScroll, dock]) like pi's viewport. */
function buildTrimInner(theme: Theme): Component | null {
	const base = getBaseRoot();
	if (!base) return null;
	const dock = baseDockOf(base);
	if (!dock) return null;
	if (!responseScrollView) {
		responseScrollView = new ScrollView(responseDoc, {
			follow: "end",
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (t: string) => theme.fg("dim", t),
			scrollbarThumbStyle: (t: string) => theme.fg("accent", t),
		});
	}
	return new VStack([
		{ component: responseScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
}

/** Build the full composed layout root based on enabled panels. */
function composeLayout(theme: Theme, inner: Component): Component {
	// Trim mode swaps pi's transcript for the response doc; the base root's
	// dock (editor/footer) is preserved inside the swapped inner.
	let root = inner;
	if (trimResponse) {
		const trimmed = buildTrimInner(theme);
		if (trimmed) root = trimmed;
	}
	const wantBand = thinkingOn || toolsOn;
	if (wantBand) root = buildBand(theme, root);
	if (filesOn && tuiRef && typeof tuiRef.setLayoutRoot === "function")
		root = buildFilesDock(theme, root);
	return root;
}

/** Reconcile the single "ui" layout layer with the current panel flags. */
function reconcileLayout(theme: Theme): void {
	const wantAny = thinkingOn || toolsOn || filesOn || trimResponse;
	if (!wantAny || !tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		return;
	}
	setLayoutLayer("ui", (inner: Component) => composeLayout(theme, inner));
	// SV-08: remember the theme this composition was built with.
	composedThemeFp = themeFingerprint(theme);
}

// ─── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-split", {
		description: "Start bare: skip the split-view panels (thinking/tools/files)",
		type: "boolean",
		default: false,
	});

	const ensureWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || widgetSet) return;
		widgetSet = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				tuiRef = tui;
				initLayoutManager(tui);
				// SV-14: apply the still-pending startup composition here. The
				// factory runs synchronously during session_start (before the
				// first paint) and the fullscreen root is available right now, so
				// the saved panels land in the FIRST painted frame. The deferred
				// startupTimer remains as the fallback for a later-ready root.
				if (startupPending && REG.gen === MY_GEN) {
					startupPending = false;
					reconcileLayout(tui?.theme ?? ctx.ui.theme);
				}
				return {
					render: (width: number) => {
						selfHealLayout();
						// SV-08: pi swaps the global theme object on a theme change
						// (extensions get no event) and the composition + response doc
						// capture ANSI at build time. Compare a color fingerprint and
						// recompose with the live theme ONLY on a change — ordinary
						// state changes never rebuild the tree.
						const liveTheme = tuiRef?.theme ?? ctx.ui.theme;
						const fp = themeFingerprint(liveTheme);
						if (composedThemeFp === null) composedThemeFp = fp;
						else if (fp !== composedThemeFp) {
							composedThemeFp = fp;
							if (anyPanelActive()) {
								rebuildResponseDoc(ctx);
								reconcileLayout(liveTheme);
							}
						}
						// SV-07: the dock basis is captured at compose time, so a resize
						// used to leave the width frozen. Compare the clamped width the
						// composition would use now and recompose on change; the 34–48
						// clamp and the <90 hide rule are preserved (hide/show stays
						// dynamic via the entry's visible callback).
						if (
							filesOn &&
							typeof tuiRef?.setLayoutRoot === "function" &&
							isLayoutLayerActive("ui")
						) {
							const cols = tuiRef?.terminal?.columns ?? 120;
							const want = Math.max(
								34,
								Math.min(48, Math.floor(cols * 0.25)),
							);
							if (want !== composedDockCols)
								reconcileLayout(tuiRef?.theme ?? ctx.ui.theme);
						}
							// F2: same recompose hook for the band's explicit width split,
							// keyed on the TERMINAL width — any resize recomposes, even
							// when the tools cols round to the same value (101→102 at 50%).
							if (
								thinkingOn &&
								toolsOn &&
								typeof tuiRef?.setLayoutRoot === "function" &&
								isLayoutLayerActive("ui")
							) {
								const cols = tuiRef?.terminal?.columns ?? 120;
								if (cols !== composedBandTermCols)
									reconcileLayout(tuiRef?.theme ?? ctx.ui.theme);
							}
						return widgetLines(liveTheme, width);
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	/** Rebuild all buffers from the current branch (start / reload / tree). */
	const reconstruct = (ctx: ExtensionContext) => {
		thinking.reset();
		toolsBy.clear();
		toolOrder.length = 0;
		toolsVersionCounter++;
		files.clear();
		bumpFilesVersion();
		clearEditDiff();
		rebuildResponseDoc(ctx);

		const branch = ctx.sessionManager.getBranch();
		const thoughts: string[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = (entry as any).message;
			if (!msg) continue;
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c?.type === "thinking" && typeof c.thinking === "string")
						thoughts.push(c.thinking);
					if (c?.type === "toolCall" && c.name) {
						try {
							// SV-17: rebuild the bounded tools buffer from the
							// branch through the same ingest path live events use.
							if (typeof c.id === "string")
								ingestToolCall(c.id, c.name, c.arguments ?? {});
							record(c.name, c.arguments ?? {});
						} catch {
							/* skip */
						}
					}
				}
			}
			// Reconstruct the last edit diff from persisted tool-result details.
			if (msg.role === "toolResult" && msg.toolName === "edit") {
				const d = msg.details;
				if (d?.diff) {
					const p = (msg.input && msg.input.path) || editDiff.path;
					setEditDiff(p, d.diff);
				}
			}
			// SV-17: rebuild tool outputs from persisted results, correlated
			// to their calls by toolCallId.
			if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				try {
					ingestToolResult(msg.toolCallId, msg.content, msg.isError);
				} catch {
					/* skip */
				}
			}
		}
		if (thoughts.length) {
			for (const t of thoughts) {
				thinking.current = { lines: t.split(/\r?\n/), tail: "", complete: true };
				thinking.blocks.push(thinking.current);
				thinking.current = null;
			}
			thinking.trim();
			thinking.version++;
		}
		ensureWidget(ctx);
		if (anyPanelActive()) requestRender();
	};

	pi.on("session_start", (_e, ctx) => {
		let cfg = normalizeConfig(loadUiPanelsConfig());
		if (pi.getFlag("no-split")) {
			// --no-split: start bare, ignoring the saved ui-panels.json defaults.
			cfg = {
				...cfg,
				split: false,
				thinking: false,
				tools: false,
				files: false,
				trimResponse: false,
			};
		}
		thinkingOn = cfg.thinking;
		toolsOn = cfg.tools;
		toolMode = cfg.toolMode;
		bandHeight = cfg.bandHeight;
		toolsWidthPct = cfg.toolsWidthPct;
		filesOn = cfg.files;
		trimResponse = cfg.trimResponse;
		// SV-14: arm the startup composition BEFORE reconstruct — the widget
		// factory runs synchronously inside it and is the first point where the
		// fullscreen root is available (before the first paint). The deferred
		// timer below used to be the ONLY composition point, but it fires after
		// the first paint, so the first screen never showed the saved panels.
		startupPending = ctx.mode === "tui";
		reconstruct(ctx);
		// Reapply the saved composition after the fullscreen root is ready.
		if (ctx.mode === "tui") {
			if (startupTimer) clearTimeout(startupTimer);
			startupTimer = setTimeout(() => {
				startupTimer = null;
				if (REG.gen !== MY_GEN) return;
				try {
					if (tuiRef && typeof tuiRef.setLayoutRoot === "function") {
						// SV-14: fallback — the factory composes when the root is
						// already available there; this timer only composes if
						// that has not happened yet.
						if (startupPending) {
							startupPending = false;
							reconcileLayout(ctx.ui.theme);
						}
						if (cfg.split) ctx.ui.notify("Split view on", "info");
					} else if (cfg.files) {
						// Regular mode uses an overlay; filesOn is already the saved
						// state, so clear it before calling the toggle.
						filesOn = false;
						toggleFilesPanel(ctx);
					}
				} catch {
					/* never crash pi from a deferred callback */
				}
			}, 0);
		}
	});
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	// Thinking stream.
	pi.on("message_update", (event) => {
		const d = (event as any).assistantMessageEvent;
		if (d) {
			if (d.type === "thinking_start") thinking.start();
			else if (d.type === "thinking_delta") thinking.append(d.delta ?? "");
			else if (d.type === "thinking_end") thinking.end(d.content ?? "");
		}
		responseMessageUpdate((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Response stream (panel C trim mode): mirror user/assistant messages into
	// the response doc. Always maintained so toggling trim mid-turn is seamless.
	// Assistant components are created lazily on first visible text (update),
	// so tool-only / thinking-only rounds add nothing to the doc.
	pi.on("message_start", (event) => {
		const msg = (event as any).message;
		if (msg?.role === "user") addResponseMessage(msg);
		if (anyPanelActive()) requestRender();
	});
	pi.on("message_end", (event) => {
		responseMessageEnd((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Tool stream.
	pi.on("tool_execution_start", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolCall(event.toolCallId, event.toolName, event.args);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_update", (event) => {
		const e = toolsBy.get(event.toolCallId);
		if (e) {
			setToolOutput(e, resultText((event as any).partialResult));
			markToolsDirty();
		}
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_end", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolResult(event.toolCallId, (event as any).result, event.isError);
		if (anyPanelActive()) requestRender();
	});

	// Edit diff: preview on tool_call (preflight args), authoritative on result.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "edit") {
			// Still record files for non-edit tools (write/read/bash/grep...).
			try {
				record(event.toolName, event.input ?? {});
			} catch {
				/* skip */
			}
			bumpFilesVersion();
			if (anyPanelActive()) requestRender();
			return;
		}
		const input = event.input ?? {};
		const p = typeof input.path === "string" ? input.path : "";
		const edits = Array.isArray(input.edits) ? input.edits : [];
		const token = ++pendingDiffToken;
		// SV-23: this call is the newest edit — it owns the preview; forget
		// older generations so a late result from an older edit cannot match.
		const gen = ++editGeneration;
		editGenByCallId.clear();
		if (typeof event.toolCallId === "string")
			editGenByCallId.set(event.toolCallId, gen);
		// Compute a diff from the edit pairs (synchronous, no file read needed).
		// generateDiffString(oldText, newText, contextLines) produces a unified diff.
		const parts: string[] = [];
		for (const e of edits) {
			const o = typeof e.oldText === "string" ? e.oldText : "";
			const n = typeof e.newText === "string" ? e.newText : "";
			if (o !== n) parts.push(generateDiffString(o, n, 3).diff);
		}
		if (token !== pendingDiffToken) return;
		if (parts.length) setEditDiff(p, parts.join("\n"));
		try {
			record("edit", input);
		} catch {
			/* skip */
		}
		bumpFilesVersion();
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit") return;
		// Authoritative diff from the result details (branch-correct).
		const d = (event as any).details;
		if (d?.diff) {
			// SV-23: apply only when this result belongs to the current edit
			// generation (its own preview); an older result never overwrites a
			// newer preview. A result with no/unknown ID applies only when
			// unambiguous (a single edit generation, no recorded ID).
			const id = (event as any).toolCallId;
			const gen = typeof id === "string" ? editGenByCallId.get(id) : undefined;
			const applies =
				gen === editGeneration ||
				(gen === undefined &&
					editGeneration === 1 &&
					editGenByCallId.size === 0);
			if (applies) {
				const p = (event.input && event.input.path) || editDiff.path;
				setEditDiff(p, d.diff);
				if (anyPanelActive()) requestRender();
			}
		}
	});

	// Subagent tool calls: record files with "a" op AND tool panel entries.
	pi.events.on("subagents:tool_call", (data) => {
		const { toolName, input, agent } = (data ?? {}) as {
			toolName?: string;
			input?: unknown;
			agent?: string;
		};
		if (!toolName) return;
		// Files tracking with "a" op.
		try {
			for (const { abs } of pathsFrom(toolName, input ?? {})) {
				const prev = files.get(abs);
				if (prev) {
					files.delete(abs);
					prev.count++;
					if (!prev.ops.includes("a")) prev.ops += "a";
					files.set(abs, prev);
				} else {
					if (files.size >= MAX_FILES)
						files.delete(files.keys().next().value as string);
					files.set(abs, { path: abs, ops: "a", count: 1 });
				}
			}
			bumpFilesVersion();
		} catch {
			/* never break the listener */
		}
		// Tool panel entry with [agent] badge.
		const id = `sub:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
		toolOrder.push(id);
		toolsBy.set(id, {
			id,
			name: toolName,
			args: argsJson(input),
			output: "",
			active: false,
			isError: false,
			subagent: true,
			agent,
		});
		toolsVersionCounter++;
		if (toolOrder.length > MAX_TOOLS) {
			const evict = toolOrder.shift()!;
			toolsBy.delete(evict);
		}
		if (anyPanelActive()) requestRender();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = null;
		}
		// SV-02/SV-15 (Option C): retire the overlay through the same valid
		// owner for the CURRENT generation AND for a stale one. The
		// identity-specific handle's hide() removes only its own entry (a safe
		// no-op if Pi already removed it — it never pops an unrelated topmost
		// overlay), and the stored component is disposed with it. Never merely
		// forget REG.active: an undisposed stale-generation panel keeps
		// rendering blank.
		if (REG.active) {
			REG.active.hide();
			REG.active = null;
		}
		if (REG.panel) {
			REG.panel.dispose();
			REG.panel = null;
		}
		REG.activeGen = undefined;
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetSet = false;
	});

	// ── panel toggles ──

	/** Toggle the files panel (dock in fullscreen, overlay in regular). */
	const toggleFilesPanel = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/files requires interactive mode", "error");
			return filesActive();
		}
		// Fullscreen: use the composed layer.
		if (tuiRef && typeof tuiRef.setLayoutRoot === "function") {
			if (filesOn) {
				filesOn = false;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Files panel closed", "info");
				return false;
			}
			filesOn = true;
			reconcileLayout(ctx.ui.theme);
			// SV-24: be truthful when the dock is composed but gated invisible
			// — the entry's visible callback hides it below MIN_TERM_WIDTH, so
			// "docked right" alone would overstate what the user sees.
			const dockCols = tuiRef?.terminal?.columns ?? 0;
			if (dockCols > 0 && dockCols < MIN_TERM_WIDTH) {
				ctx.ui.notify(
					`Files panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${dockCols})`,
					"warning",
				);
			} else {
				ctx.ui.notify("Files panel docked right", "info");
			}
			return true;
		}
		// Regular mode: passive TUI overlay (Option C — decisions/D-overlay-lifecycle.md).
		// No ctx.ui.custom() promise is created, so nothing can be stranded; the
		// extension owns the lifecycle: the identity-specific OverlayHandle is
		// the only close path, and the panel component is disposed with it.
		// Escape belongs to the editor/Pi — /files is the close/reopen path.
		if (REG.active) {
			const wasStale = REG.activeGen !== MY_GEN;
			// SV-15: retire even a stale-generation overlay through the same
			// valid owner (handle hide + component dispose) instead of merely
			// forgetting REG.active.
			REG.active.hide();
			REG.panel?.dispose();
			REG.active = null;
			REG.panel = null;
			REG.activeGen = undefined;
			if (!wasStale) {
				ctx.ui.notify("Files panel closed", "info");
				return false;
			}
			// A stale overlay was retired — fall through and open a fresh one
			// so a single /files leaves exactly one live overlay.
		}
		if ((process.stdout.columns ?? 0) < MIN_TERM_WIDTH) {
			ctx.ui.notify(`Terminal too narrow (min ${MIN_TERM_WIDTH} cols)`, "warning");
			return false;
		}
		if (!tuiRef || typeof tuiRef.showOverlay !== "function") {
			ctx.ui.notify("/files requires interactive mode", "error");
			return false;
		}
		const panel = new FilesPanel(ctx.ui.theme);
		const cols = tuiRef?.terminal?.columns ?? process.stdout.columns ?? 0;
		REG.panel = panel;
		REG.active = tuiRef.showOverlay(panel, {
			anchor: "top-right",
			width: Math.max(34, Math.min(48, Math.floor(cols * 0.25))),
			margin: 0,
			maxHeight: "100%",
			nonCapturing: true,
			visible: (w: number, h: number) => {
				termHeight = h;
				return w >= MIN_TERM_WIDTH;
			},
		});
		REG.activeGen = MY_GEN;
		return true;
	};

	pi.registerCommand("split", {
		description: "Toggle the thinking+tools band on/off",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split requires fullscreen mode", "warning");
				return;
			}
			const wasOn = bandActive();
			if (wasOn) {
				thinkingOn = false;
				toolsOn = false;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view off", "info");
			} else {
				thinkingOn = true;
				toolsOn = true;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view on", "info");
			}
		},
	});

	pi.registerCommand("split-thinking", {
		description: "Toggle the thinking panel within the band",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			thinkingOn = !thinkingOn;
			if (thinkingOn || toolsOn) {
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify(`Thinking ${thinkingOn ? "on" : "off"}`, "info");
			} else {
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Band off (no panels)", "info");
			}
		},
	});

	pi.registerCommand("split-tools", {
		description: "Toggle the tools panel within the band",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			toolsOn = !toolsOn;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Tools ${toolsOn ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("files", {
		description: "Toggle the files panel (dock or overlay)",
		handler: async (_args, ctx) => {
			toggleFilesPanel(ctx);
		},
	});

	pi.registerCommand("split-tools-view", {
		description: "Toggle tool panel compact ↔ full detail",
		handler: async (_args, ctx) => {
			toolMode = toolMode === "compact" ? "full" : "compact";
			toolsVersionCounter++;
			ctx.ui.notify(`Tool panel: ${toolMode}`, "info");
			requestRender();
		},
	});

	pi.registerCommand("split-height", {
		description: "Set the top band height in rows (6-40)",
		handler: async (args, ctx) => {
			const n = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify(
					`Band height: ${bandHeight} rows (usage: /split-height 6-40)`,
					"info",
				);
				return;
			}
			bandHeight = Math.max(6, Math.min(40, n));
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Band height: ${bandHeight} rows`, "info");
		},
	});

	pi.registerCommand("split-tools-width", {
		description: "Set tools panel width as % of the band (20-60, default 35)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim();
			if (!arg) {
				ctx.ui.notify(
					`Tools panel width: ${toolsWidthPct}% of the band (usage: /split-tools-width 20-60)`,
					"info",
				);
				return;
			}
			const n = Number.parseInt(arg, 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify(
					"Invalid percentage (usage: /split-tools-width 20-60)",
					"error",
				);
				return;
			}
			toolsWidthPct = Math.max(20, Math.min(60, n));
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Tools panel width: ${toolsWidthPct}%`, "info");
		},
	});

	pi.registerCommand("split-trim-response", {
		description:
			"Panel C: full transcript ↔ response-only (on|off) — response-only: text-only (native parity), full scrollback, scroll offset preserved on branch switch",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split-trim-response requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split-trim-response requires fullscreen mode", "warning");
				return;
			}
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !trimResponse;
			if (next) {
				const base = getBaseRoot();
				if (!base) {
					ctx.ui.notify("Layout root not ready yet", "warning");
					return;
				}
				// SV-22: trim mode swaps the transcript for the response doc and
				// keeps only the extracted editor dock. If the dock cannot be
				// extracted, fail loudly instead of silently leaving the native
				// transcript while claiming response-only.
				if (!baseDockOf(base)) {
					ctx.ui.notify(
						"Panel C unavailable: editor dock not found in the layout root",
						"error",
					);
					return;
				}
			}
			trimResponse = next;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(
				`Panel C: ${trimResponse ? "response only" : "full transcript"}`,
				"info",
			);
		},
	});

	pi.registerCommand("split-save", {
		description: "Save current panel layout as the startup defaults",
		handler: async (_args, ctx) => {
			// SV-11: serialize the EFFECTIVE files state — a regular-mode files
			// overlay of the CURRENT generation counts as files-on; an overlay left
			// over from a stale generation must not save a phantom panel.
			const filesEffective =
				filesOn || (REG.active !== null && REG.activeGen === MY_GEN);
			// SV-13: report the real outcome — success only after a durable write.
			const saved = saveUiPanelsConfig({
				split: thinkingOn || toolsOn,
				thinking: thinkingOn,
				tools: toolsOn,
				files: filesEffective,
				toolMode,
				trimResponse,
				bandHeight,
				toolsWidthPct,
			});
			ctx.ui.notify(
				saved
					? "Panel layout saved as startup defaults for new windows"
					: "Could not save panel layout (config write failed)",
				saved ? "success" : "error",
			);
		},
	});
}
