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
 *   /split              full toggle pair: OFF = all panels off (bare pi
 *                       layout), ON = the panel flags saved as startup defaults
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
 * thinking blocks and extension custom entries. pi's startup header and
 * loaded-resources listing stay mounted above those messages (SV-26). The
 * editor dock
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
 * Mouse (fullscreen): header [↗]/[×] buttons zoom / hide a panel; drag the
 * band bottom border (height), the tools panel's left edge (split) and the
 * files dock's left edge (width). Drags mutate the composed stack entries in
 * place (applyGeometry) so panel scroll positions survive.
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
	Image,
	ScrollView,
	Spacer,
	VStack,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	type Component,
	type OverlayHandle,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	wrapTextWithAnsi,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	loadUiPanelsConfig,
	saveUiPanelsConfig,
	normalizeConfig,
	type ToolMode as ToolModeCfg,
	type ThinkingScope,
} from "./ui-panels-config.ts";
import {
	getBaseRoot,
	initLayoutManager,
	setLayoutLayer,
	isLayoutLayerActive,
	selfHealLayout,
} from "./layout-manager.ts";
import {
	appendStreamTail,
	bandToolsColsFor as bandToolsColsForPct,
	capDisplayLine,
	capToolText,
	dockColsFor as dockColsForManual,
	formatDuration,
	lastImageBlock,
	outputPreview,
	truncateInline,
	type ImageBlock,
} from "./helpers.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
// Display window (logical lines) for the thinking panel. The full transcript
// keeps everything; the band is a recent-history view. Must stay small: the
// per-flush render cost is dominated by wrapping the visible window.
const MAX_LINES = 400;
// A newline-free streaming tail grows char by char and re-wraps on every
// flush. Bounded by dropping its older HALF on overflow (appendStreamTail),
// so the visible paragraph re-flows once per ~8K chars, not on every flush.
const MAX_TAIL_CHARS = 16000;
const MAX_FILES = 500;
const MAX_WIDGET_NAMES = 3;
const MIN_TERM_WIDTH = 90;
const MAX_TOOL_OUTPUT_LINES = 20;
/** Lines of an edit's unified diff kept per tool entry (zoomed tools view). */
const MAX_TOOL_DIFF_LINES = 150;
// OracleSpec body window: hard cap on FINAL VISUAL rows rendered by band
// panels (logical lines can wrap into many). Wrapped rows are memoized per
// line, so only changed lines (the streaming tail) re-wrap on a flush.
const MAX_BODY_ROWS = 400;
// Hard cap on raw chars per logical line (giant-line guard). ≥ MAX_TAIL_CHARS
// so the streaming tail is never cut by a sliding (re-flowing) window.
const MAX_LINE_CHARS = MAX_TAIL_CHARS;
/** Rows the transcript + editor need below the band; shorter terminals hide
 * the band (B2) instead of squeezing the transcript. */
const MIN_ROWS_BELOW_BAND = 12;

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
/** SV-27: "turn" = the thinking panel carries the current turn only (the
 * buffer is cleared on each new user message); "session" = accumulate every
 * turn. Session-local; /split-thinking-scope, persisted by /split-save. */
let thinkingScope: ThinkingScope = "turn";
let toolsOn = true;
let filesOn = false;
/** Files panel edit-diff subpanel (session-local; /split-diff, persisted by
 * /split-save). Off keeps the file list but drops the bottom diff section. */
let showDiff = true;
/** Response-only divider between successive assistant messages: "rule" (dim
 * dashed line) or "space" (plain blank line). Session-local; /split-divider,
 * persisted by /split-save. */
let answerDividerMode: "rule" | "space" = "rule";
let toolMode: ToolModeCfg = "compact";
/** Panel C: response-only view instead of pi's transcript (persisted). */
let trimResponse = false;
/** Top band height in rows (6–40, persisted; /split-height). */
let bandHeight = 14;
/** F: tools panel's share of the band width in percent (20–60, default 35,
 * persisted as toolsWidthPct; session-local, only /split-save writes it). */
let toolsWidthPct = 35;
/** Files dock width in cols set by dragging its edge (null = auto 25%,
 * 34–48). Session-local; persisted by /split-save as filesWidth. */
let filesWidth: number | null = null;
/** Panel expanded to the whole area above the editor (header ↗ button).
 * Transient: never persisted. */
type PanelId = "thinking" | "tools" | "files";
let zoomed: PanelId | null = null;

const bandToolsColsFor = (total: number) => bandToolsColsForPct(total, toolsWidthPct);
const dockColsFor = (cols: number) => dockColsForManual(cols, filesWidth);

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
const THINK_RAF_MS = 50;
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
		// Split complete lines first, then cap the tail (half-drop on overflow).
		const before = this.current.lines.length;
		this.current.tail = appendStreamTail(
			this.current.lines,
			this.current.tail,
			delta,
			MAX_TAIL_CHARS,
		);
		if (this.current.lines.length !== before) this.trim();
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

/** Live theme proxy captured from ctx.ui.theme / the widget factory; it
 * resolves the current global theme on every access, so answer dividers never
 * go stale after a theme change (the doc is rebuilt on change anyway). */
let docTheme: Theme | null = null;

/** One dim rule separating consecutive assistant messages in the response-only
 *  doc. Dashed (and dim) so it reads fainter than the panel borders. */
class AnswerDivider implements Component {
	render(width: number): string[] {
		const rule = "┄".repeat(Math.max(0, width));
		return [docTheme ? docTheme.fg("dim", rule) : rule];
	}
	invalidate(): void {}
	dispose(): void {}
}

/** Role of the last message actually added to the response doc. */
let lastResponseRole: "user" | "assistant" | null = null;

/**
 * Begin a response-doc entry: always a blank spacer between turns, plus the
 * divider ONLY between two successive assistant messages (never around a user
 * message). `answerDivider` = "space" drops the rule, leaving plain
 * blank-line spacing.
 */
function beginResponseEntry(role: "user" | "assistant"): void {
	if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
	if (
		role === "assistant" &&
		lastResponseRole === "assistant" &&
		answerDividerMode === "rule"
	)
		responseDoc.addChild(new AnswerDivider());
	lastResponseRole = role;
}

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
			beginResponseEntry("user");
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
			beginResponseEntry("assistant");
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
	lastResponseRole = null;
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
			beginResponseEntry("assistant");
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
	/** Last image block of the result (e.g. `read` on an image file), so the
	 * panel can render it inline like pi's transcript does. */
	image?: ImageBlock;
	/** Raw unified diff of an `edit` result (details.diff), shown in the
	 * zoomed tools view; capped to MAX_TOOL_DIFF_LINES. */
	diff?: string;
	/** Wall-clock start/end (ms) of LIVE calls; absent for resumed history. */
	startedAt?: number;
	endedAt?: number;
}
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

/** B1: 1 Hz ticker that refreshes running-tool elapsed counters; runs only
 * while a timed tool is active and stops itself afterwards. */
let toolTicker: ReturnType<typeof setInterval> | null = null;
function stopToolTicker(): void {
	if (toolTicker) {
		clearInterval(toolTicker);
		toolTicker = null;
	}
}
function ensureToolTicker(): void {
	if (toolTicker) return;
	toolTicker = setInterval(() => {
		let running = false;
		for (const e of toolsBy.values())
			if (e.active && e.startedAt !== undefined) running = true;
		if (!running) return stopToolTicker();
		toolsVersionCounter++;
		if (toolsOn) requestRender();
	}, 1000);
	toolTicker.unref?.();
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
function ingestToolCall(id: string, name: string, args: any, startedAt?: number): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name,
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
		startedAt,
	});
	if (startedAt !== undefined) ensureToolTicker();
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift()!;
		toolsBy.delete(evict);
	}
}

/** SV-17: ingest one tool result, correlated to its call by id (live event
 * or resumed branch entry). A result whose call is not in the bounded buffer
 * (evicted or unknown) is ignored. */
function ingestToolResult(id: string, result: any, isError: boolean, endedAt?: number): void {
	const e = toolsBy.get(id);
	if (!e) return;
	if (endedAt !== undefined && e.startedAt !== undefined) e.endedAt = endedAt;
	const text = resultText(result);
	if (text) setToolOutput(e, text);
	// Keep the last image block so the tools panel can render it inline on
	// terminals with image support (pi's transcript does the same via pi-tui's
	// Image component; resultText drops non-text blocks).
	const img = lastImageBlock(result?.content);
	if (img) e.image = img;
	const diff = result?.details?.diff;
	if (typeof diff === "string" && diff) {
		const lines = capToolText(diff).split(/\r?\n/);
		e.diff = lines.slice(0, MAX_TOOL_DIFF_LINES).join("\n");
		if (lines.length > MAX_TOOL_DIFF_LINES)
			e.diff += `\n… +${lines.length - MAX_TOOL_DIFF_LINES} more diff lines`;
	}
	e.active = false;
	e.isError = isError;
	cancelPendingToolsFlush();
	toolsVersionCounter++;
}

/** One row-source item of a band panel body: a styled text line, or an
 * inline image block. Image items render RAW via pi-tui's Image component
 * (never wrapped, capped or padded) — the same line structure pi's own
 * transcript feeds its ScrollView, which the TUI engine handles (image-aware
 * scrollbar, scroll cropping, placement cleanup on full repaints). */
type BodyItem = string | { image: ImageBlock; maxRows?: number };

/** Band (non-zoomed) tools panel: inline images are thumbnails capped at
 * this many rows so they don't crowd the small panel. Zoomed: pi's default. */
const BAND_IMAGE_ROWS = 6;

/** Zoomed tools panel: show full detail for every tool — its whole stored
 * output (≤ MAX_TOOL_OUTPUT_LINES) instead of the 2-line band preview. */
const toolOutputCap = (zoomedTools: boolean) =>
	zoomedTools ? MAX_TOOL_OUTPUT_LINES : 2;

function toolItems(theme: Theme, width: number): BodyItem[] {
	const th = theme;
	const out: BodyItem[] = [];
	// Zooming the tools panel expands it over the whole area above the editor,
	// so it always renders full detail regardless of the compact/full toggle.
	const zoomedTools = zoomed === "tools";
	const full = toolMode === "full" || zoomedTools;
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
		// B1: duration (done) or live elapsed counter (running, from 1s on).
		let dur = "";
		if (e.startedAt !== undefined) {
			if (e.endedAt !== undefined)
				dur = th.fg("dim", ` ${formatDuration(e.endedAt - e.startedAt)}`);
			else if (e.active && Date.now() - e.startedAt >= 1000)
				dur = th.fg("warning", ` ${formatDuration(Date.now() - e.startedAt, true)}`);
		}
		const prefix = `${mark} ${name}${badge}${dur}`;
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
			const { shown, hidden } = outputPreview(content, toolOutputCap(zoomedTools));
			for (const l of shown)
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (hidden > 0) out.push(th.fg("dim", `  · +${hidden} more`));
		}
		// Zoomed: an edit's diff, rendered like pi's transcript (renderDiff
		// colours +/- lines); long lines wrap in the body.
		if (zoomedTools && e.diff) {
			out.push("");
			for (const l of renderDiff(e.diff).split(/\r?\n/)) out.push(`    ${l}`);
		}
		// Inline image result (e.g. read on an image file), like pi's
		// transcript: a separator row, then the image as a raw item. Without
		// image support it's a one-line text fallback styled as an output row.
		if (e.image) {
			if (getCapabilities().images) out.push("");
			out.push({
				image: e.image,
				maxRows: zoomedTools ? undefined : BAND_IMAGE_ROWS,
			});
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
// SV-01 (revised): /split is a full toggle pair over every panel flag
// (thinking/tools/files/trim), so its "on" state is the flag disjunction.
// The old bandActive() derived state from the band alone, which made a
// files-only or trim-only layout report "off" for a not-bare view and left
// those panels running after a /split off. Layout-layer checks remain in use
// only for layout ownership (anyPanelActive/filesActive).
const panelsActive = () =>
	thinkingOn || toolsOn || filesOn || trimResponse;
const filesActive = () => isLayoutLayerActive("files") || !!REG.active;

// ─── mouse: drag-resize, header buttons, wheel routing ───────────────────────

/** Mouse wiring of one panel (thinking / tools band panel, or files dock). */
interface PanelCtl {
	id: PanelId;
	/** Panel lives in the band (its bottom border drags the band height). */
	inBand: boolean;
	/** The panel's left edge column is a width-drag handle. */
	resizeLeft: boolean;
	/** Body ScrollView — wheel over the frame scrolls it (B3). */
	scroll?: ScrollView;
}

/** Live layout entries that drags and resizes mutate in place — no tree
 * rebuild, so panel scroll positions survive. Reset on every compose. */
const geo: {
	bandStack?: VStack;
	band?: Component;
	panelStack?: HStack;
	thinkPanel?: Component;
	toolsPanel?: Component;
	dockStack?: HStack;
	dockPanel?: Component;
} = {};

/** Terminal width the current geometry was computed for (resize hook). */
let composedTermCols = -1;

/** Late-bound UI access for mouse actions (set by the widget factory). */
let themeGetter: (() => Theme) | null = null;
let notifyFn: ((msg: string, level: "info" | "warning") => void) | null = null;

function stackEntry(stack: unknown, component: Component | undefined): any {
	if (!component) return undefined;
	const entries = (stack as { entries?: any[] } | undefined)?.entries;
	return entries?.find((e) => e.component === component);
}

/** Band width available next to the files dock. */
function bandBase(cols: number): number {
	const dockVisible = filesOn && cols >= MIN_TERM_WIDTH;
	return cols - (dockVisible ? dockColsFor(cols) : 0);
}

/** Recompute dock width, band height and the thinking|tools split from the
 * current state and mutate the composed entries in place. */
function applyGeometry(): void {
	const cols = tuiRef?.terminal?.columns ?? 120;
	composedTermCols = cols;
	const dockEntry = stackEntry(geo.dockStack, geo.dockPanel);
	if (dockEntry) {
		const w = dockColsFor(cols);
		dockEntry.basis = w;
		dockEntry.minSize = w;
	}
	const bandEntry = stackEntry(geo.bandStack, geo.band);
	if (bandEntry) {
		bandEntry.basis = bandHeight;
		bandEntry.minSize = Math.min(6, bandHeight);
	}
	const t = stackEntry(geo.panelStack, geo.thinkPanel);
	const u = stackEntry(geo.panelStack, geo.toolsPanel);
	if (t && u) {
		const base = bandBase(cols);
		const toolsW = bandToolsColsFor(base);
		t.basis = base - toolsW;
		u.basis = toolsW;
	}
	requestRender();
}

type DragKind = "height" | "tools" | "dock";
let drag: { kind: DragKind; x: number; y: number; start: number } | null = null;

function beginDrag(kind: DragKind, ev: TuiMouseEvent): TuiMouseEventResult {
	const cols = tuiRef?.terminal?.columns ?? 120;
	const start =
		kind === "height"
			? bandHeight
			: kind === "dock"
				? dockColsFor(cols)
				: bandToolsColsFor(bandBase(cols));
	drag = { kind, x: ev.screenX, y: ev.screenY, start };
	return { capture: true };
}

function continueDrag(ev: TuiMouseEvent): TuiMouseEventResult {
	const d = drag;
	if (!d || ev.type === "release") {
		drag = null;
		return { handled: true };
	}
	if (ev.type !== "drag") return { handled: true };
	const cols = tuiRef?.terminal?.columns ?? 120;
	if (d.kind === "height") {
		// Never drag the band into its own auto-hide threshold (B2).
		const rows = tuiRef?.terminal?.rows ?? 40;
		const max = Math.max(6, Math.min(40, rows - 1 - MIN_ROWS_BELOW_BAND));
		bandHeight = Math.max(6, Math.min(max, d.start + (ev.screenY - d.y)));
	} else if (d.kind === "tools") {
		const base = Math.max(1, bandBase(cols));
		const w = d.start - (ev.screenX - d.x);
		toolsWidthPct = Math.max(20, Math.min(60, Math.round((w * 100) / base)));
	} else {
		filesWidth = dockColsForManual(cols, d.start - (ev.screenX - d.x));
	}
	applyGeometry();
	return { handled: true };
}

/** Header buttons occupy the 6 columns before the right corner, when the
 * header has room (≥ 16 content columns). */
const HEADER_BUTTONS_MIN = 16;
function headerButtons(theme: Theme, id: PanelId): string {
	return (
		theme.fg("muted", `[${zoomed === id ? "↙" : "↗"}]`) + theme.fg("muted", "[×]")
	);
}
function buttonAt(ev: TuiMouseEvent): "zoom" | "close" | null {
	if (ev.y !== 0 || ev.width - 2 < HEADER_BUTTONS_MIN) return null;
	const z = ev.width - 7;
	if (ev.x >= z && ev.x < z + 3) return "zoom";
	if (ev.x >= z + 3 && ev.x < z + 6) return "close";
	return null;
}

function recompose(): void {
	if (themeGetter) reconcileLayout(themeGetter());
}

function toggleZoom(id: PanelId): void {
	zoomed = zoomed === id ? null : id;
	recompose();
}

const PANEL_LABELS: Record<PanelId, [string, string]> = {
	thinking: ["Thinking", "/split-thinking"],
	tools: ["Tools", "/split-tools"],
	files: ["Files", "/files"],
};

function hidePanel(id: PanelId): void {
	if (id === "thinking") thinkingOn = false;
	else if (id === "tools") toolsOn = false;
	else filesOn = false;
	if (zoomed === id) zoomed = null;
	recompose();
	const [label, cmd] = PANEL_LABELS[id];
	notifyFn?.(`${label} hidden · ${cmd} to show`, "info");
}

/** Shared mouse handling for panel chrome: header buttons (top), band-height
 * drag (band bottom border), width drag (left edge), wheel routing. */
function panelMouse(
	ev: TuiMouseEvent,
	ctl: PanelCtl | undefined,
	where: "top" | "bottom" | "body",
): TuiMouseEventResult | undefined {
	if (drag && (ev.type === "drag" || ev.type === "release")) return continueDrag(ev);
	if (!ctl) return undefined;
	if (ev.type === "wheel") {
		// Body wheel uses native routing (contained in the panel's ScrollView).
		if (where === "body" || !ctl.scroll) return undefined;
		ctl.scroll.scrollBy(ev.wheelDelta ?? 0);
		return { handled: true };
	}
	if (ev.button !== "left") return undefined;
	if (ev.type === "press") {
		if (where === "top" && buttonAt(ev)) return { capture: true };
		if (ctl.resizeLeft && ev.x === 0)
			return beginDrag(ctl.id === "files" ? "dock" : "tools", ev);
		if (where === "bottom" && ctl.inBand) return beginDrag("height", ev);
		return undefined;
	}
	if (ev.type === "click" && where === "top") {
		const b = buttonAt(ev);
		if (b === "zoom") toggleZoom(ctl.id);
		else if (b === "close") hidePanel(ctl.id);
		if (b) return { handled: true };
	}
	return undefined;
}

// ─── framed panel components ─────────────────────────────────────────────────

class BorderTop implements Component {
	constructor(
		private theme: Theme,
		private title: string,
		private color: "accent" | "muted",
		private streaming: () => boolean,
		private ctl?: PanelCtl,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const contentWidth = Math.max(1, width - 2);
		const buttons =
			this.ctl && contentWidth >= HEADER_BUTTONS_MIN ? headerButtons(th, this.ctl.id) : "";
		const room = contentWidth - visibleWidth(buttons);
		const title = th.fg(this.color, ` ${this.title} `);
		const dot = this.streaming() ? th.fg("warning", "●") : "";
		const label = truncateToWidth(title + dot, room);
		const fill = th.fg("border", "─".repeat(Math.max(0, room - visibleWidth(label))));
		return [th.fg("border", "╭") + label + fill + buttons + th.fg("border", "╮")];
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, "top");
	}
	invalidate(): void {}
	dispose(): void {}
}

class BorderBottom implements Component {
	constructor(
		private theme: Theme,
		private ctl?: PanelCtl,
	) {}
	render(width: number): string[] {
		return [
			this.theme.fg("border", "╰") +
				this.theme.fg("border", "─".repeat(Math.max(0, width - 2))) +
				this.theme.fg("border", "╯"),
		];
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, "bottom");
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
 * ScrollView's always-on scrollbar column is the right frame edge. Pads every
 * row to EXACT width and always emits at least `minRows` rows so the left
 * edge is continuous when content is short. Output is cached on
 * (version, minRows, width); wrapped rows are memoized per source line, so a
 * streaming flush only re-wraps lines that changed (the tail).
 *
 * Row sources are BodyItems: text lines go through the wrap/edge/pad path;
 * image items render raw via a cached pi-tui Image component (atomic group,
 * no edge/pad — the escape lines must stay contiguous and unsliced, exactly
 * the structure pi's transcript feeds its ScrollView; the TUI engine is
 * image-aware: the scrollbar skips image lines, scrolling crops placements,
 * full repaints clear them).
 */
class RecentBody implements Component {
	private cacheVersion = -1;
	private cacheMinRows = -1;
	/** SV-19: bounded width cache (current width + small LRU). */
	private cacheByWidth = new Map<number, string[]>();
	private static readonly MAX_CACHED_WIDTHS = 4;
	/** Per-line wrap memo for one width; holds only the lines last shown. */
	private wrapWidth = -1;
	private wrapMemo = new Map<string, string[]>();
	/** Image components by (mimeType:data), small LRU. Cached so a re-render
	 * re-emits the SAME Kitty image ID — a fresh instance per frame would
	 * allocate a new placement every frame and leak them in the terminal. */
	private imageCache = new Map<string, Image>();
	private static readonly MAX_CACHED_IMAGES = 8;
	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		private lines: (width: number) => BodyItem[],
		private version: () => number,
		private empty: string,
		/** Rows to guarantee so the left edge has no gaps (viewport height). */
		private minRows: () => number,
		private ctl?: PanelCtl,
		/** SV-27: false = emit every row of the source instead of the newest
		 * MAX_BODY_ROWS window. See BandDef.windowed. */
		private windowed = true,
	) {}
	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		const min = Math.max(1, this.minRows());
		if (v !== this.cacheVersion || min !== this.cacheMinRows) {
			this.cacheVersion = v;
			this.cacheMinRows = min;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			// SV-19: refresh recency so eviction is genuinely LRU.
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			return cached;
		}
		if (width !== this.wrapWidth) {
			this.wrapWidth = width;
			this.wrapMemo.clear();
		}
		const memo = this.wrapMemo;
		const nextMemo = new Map<string, string[]>();
		const edge = th.fg("border", "│");
		const pad = (s: string) => " ".repeat(Math.max(0, width - 1 - visibleWidth(s)));
		// Wrap newest-first, keep only the newest MAX_BODY_ROWS visual rows.
		// SV-03/SV-04: fragments of ONE source line are wrapped as a group and
		// inserted in order; the cap counts VISUAL rows. A group that would
		// straddle the cap is skipped whole; a single group larger than the
		// whole cap keeps only its newest fragments — except an image group,
		// which is atomic (its escape lines must stay contiguous and unsliced)
		// and therefore kept whole (its height is bounded by the Image
		// component's maxHeightCells, far below MAX_BODY_ROWS in practice).
		const src = this.lines(width);
		const groups: { frags: string[]; raw: boolean }[] = [];
		let used = 0;
		for (let i = src.length - 1; i >= 0; i--) {
			const { frags, raw } = this.itemFrags(src[i], width, memo, nextMemo);
			// SV-27: a non-windowed body keeps walking past the cap; the caller
			// guarantees the source is bounded (thinking: MAX_LINES). The
			// newest-first collection order is kept either way, so the reverse
			// pass below still emits oldest-to-newest.
			if (this.windowed && used + frags.length > MAX_BODY_ROWS) {
				if (groups.length === 0 && frags.length > MAX_BODY_ROWS)
					groups.push({
						frags: raw ? frags : frags.slice(frags.length - MAX_BODY_ROWS),
						raw,
					});
				break;
			}
			groups.push({ frags, raw });
			used += frags.length;
		}
		this.wrapMemo = nextMemo;
		const rows: string[] = [];
		for (let g = groups.length - 1; g >= 0; g--)
			for (const f of groups[g].frags)
				rows.push(groups[g].raw ? f : edge + f + pad(f));
		let out: string[];
		if (rows.length === 0) {
			const empty = " " + th.fg("dim", this.empty);
			out = [edge + empty + pad(empty)];
		} else {
			// Rows already carry the edge/pad (text) or are raw (image).
			out = rows;
		}
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		while (out.length < min) out.push(filler);
		this.cacheByWidth.set(width, out);
		while (this.cacheByWidth.size > RecentBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return out;
	}
	/** Fragments for one row-source item: text lines are wrapped (memoized
	 * per line) and emit with the frame edge; image items go to imageRows.
	 * `raw` rows bypass the edge/pad pass. */
	private itemFrags(
		item: BodyItem,
		width: number,
		memo: Map<string, string[]>,
		nextMemo: Map<string, string[]>,
	): { frags: string[]; raw: boolean } {
		if (typeof item !== "string")
			return this.imageRows(item.image, width, item.maxRows);
		const memoFrags = nextMemo.get(item) ?? memo.get(item);
		const frags =
			memoFrags ??
			wrapTextWithAnsi(
				this.style(capDisplayLine(item, MAX_LINE_CHARS)),
				Math.max(1, width - 3),
			).map((w: string) => " " + w);
		nextMemo.set(item, frags);
		return { frags, raw: false };
	}
	/** Render one image item. Terminals with image support get the raw rows
	 * from a cached pi-tui Image component. Without image support, pi's text
	 * fallback (imageFallback), as a normal padded text row. */
	private imageRows(
		img: ImageBlock,
		width: number,
		maxRows?: number,
	): { frags: string[]; raw: boolean } {
		const th = this.theme;
		if (!getCapabilities().images) {
			const dims = getImageDimensions(img.data, img.mimeType) ?? undefined;
			// Aligned with the tool's output rows ("  · …").
			const fb = th.fg("toolOutput", `  · ${imageFallback(img.mimeType, dims)}`);
			return {
				frags: wrapTextWithAnsi(
					capDisplayLine(fb, MAX_LINE_CHARS),
					Math.max(1, width - 3),
				).map((w: string) => " " + w),
				raw: false,
			};
		}
		const key = `${maxRows ?? ""}:${img.mimeType}:${img.data}`;
		let component = this.imageCache.get(key);
		if (component) {
			// LRU touch.
			this.imageCache.delete(key);
			this.imageCache.set(key, component);
		} else {
			component = new Image(
				img.data,
				img.mimeType,
				{ fallbackColor: (s: string) => th.fg("toolOutput", s) },
				maxRows ? { maxHeightCells: maxRows } : {},
			);
			this.imageCache.set(key, component);
			while (this.imageCache.size > RecentBody.MAX_CACHED_IMAGES)
				this.imageCache.delete(this.imageCache.keys().next().value as string);
		}
		// Frame edge + 2-col inset before the image. Placement escapes draw at
		// the cursor column (Kitty C=1, iTerm2 cursor-up keeps the column), so
		// prefixing shifts the image right; blank reserved rows get the edge
		// and pad like any text row.
		const edge = th.fg("border", "│");
		const inset = edge + "  ";
		const blank = edge + " ".repeat(Math.max(0, width - 1));
		const rows = component
			.render(Math.max(1, width - 4))
			.map((l: string) => (l ? inset + l : blank));
		return { frags: rows, raw: true };
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, "body");
	}
	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
		this.wrapMemo.clear();
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
		/** Mouse wiring (dock / zoom only; the regular-mode overlay has none). */
		private ctl?: PanelCtl,
	) {}

	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		return panelMouse(ev, this.ctl, ev.y === 0 ? "top" : "body");
	}

	// No handleInput: the regular-mode overlay is nonCapturing, so it never
	// receives keys — Escape belongs to the editor/Pi, and /files is the
	// close/reopen path (Option C, decisions/D-overlay-lifecycle.md).

	render(width: number): string[] {
		if (REG.gen !== MY_GEN) return [];
		const height =
			this.heightProvider?.() || termHeight || recentEntries().length + 12;
		// Cache key MUST include height: a height-only terminal resize changes
		// the list/diff row split without bumping filesVersion or width.
		const key = `${filesVersion}|${editDiff.version}|${width}|${height}|${showDiff ? 1 : 0}`;
		if (key === this.cacheKey) return this.cacheLines;

		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const pad = (s: string) =>
			s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const row = (c: string) =>
			th.fg("border", "│") + pad(truncateToWidth(c, inner)) + th.fg("border", "│");

		const entries = recentEntries();
		// Reserve the bottom half for the edit diff (min 2 list rows) when the
		// diff subpanel is shown; otherwise the list owns the whole panel.
		const half = Math.max(6, Math.floor(height / 2));
		const listRows = showDiff ? Math.max(2, half - 4) : Math.max(1, height - 4);
		// SV-06: exact row accounting so the bottom border lands on the last
		// allocated row. Fixed chrome is 6 rows (top, title, list separator,
		// diff separator, diff title, bottom border) and the list always pads
		// to listRows, so the diff section gets exactly what remains. Without
		// this a short diff left an unframed hole between the panel and the
		// viewport bottom (the old diffRows budget was never padded when a diff
		// existed, only when it did not). When the diff subpanel is off the
		// chrome is 4 rows (top, title, list separator, bottom border).
		const diffRows = showDiff ? Math.max(0, height - listRows - 6) : 0;

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

		// ── edit-diff subpanel (optional: /split-diff) ──
		const diffBody: string[] = [];
		if (showDiff) {
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
		}

		const out = [
			this.ctl && inner >= HEADER_BUTTONS_MIN
				? th.fg("border", `╭${"─".repeat(inner - 6)}`) +
					headerButtons(th, this.ctl.id) +
					th.fg("border", "╮")
				: th.fg("border", `╭${"─".repeat(inner)}╮`),
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

interface BandDef {
	title: string;
	color: "accent" | "muted";
	streaming: () => boolean;
	style: (line: string) => string;
	lines: (width: number) => BodyItem[];
	version: () => number;
	empty: string;
	/** SV-27: false = the body emits its whole row source instead of the newest
	 * MAX_BODY_ROWS window. Defaults to true (windowed). */
	windowed?: boolean;
}

function bandDef(theme: Theme, id: "thinking" | "tools"): BandDef {
	return id === "thinking"
		? {
				title: "Thinking",
				color: "accent",
				streaming: () => thinking.streaming,
				style: (l) => theme.fg("thinkingText", l),
				lines: (w) => thinkingLines(theme, w),
				version: () => thinking.version,
				empty: "Thinking idle",
				// SV-27: the thinking buffer is already capped at MAX_LINES, and a
				// sliding newest-N window makes a fixed scrollTop resolve to
				// different text on every streaming flush — scroll up and the panel
				// keeps sliding under you. Emit the whole buffer instead.
				windowed: false,
			}
		: {
				title: "Tool Usage",
				color: "muted",
				streaming: () => toolOrder.some((id) => toolsBy.get(id)?.active),
				style: (l) => l,
				lines: (w) => toolItems(theme, w),
				version: toolsVersion,
				empty: "No tools called yet",
			};
}

/**
 * Panel scaffold: no separate border columns, no inner HStack — the always-on
 * scrollbar column is the right frame edge (track styled as border; the idle
 * full-height thumb is border-colored too, accent only while actively
 * scrolling), so nothing ever paints over a frame line and there is no
 * second composite layer. The MeasurementSafeVStack wrapper keeps the
 * engine's discarded measurement passes O(1).
 */
function framedPanel(theme: Theme, d: BandDef, ctl: PanelCtl): Component {
	// Filler rows track the real viewport (band or zoomed), so the left edge
	// stays continuous at any allocated height.
	const body = new RecentBody(
		theme,
		d.style,
		d.lines,
		d.version,
		d.empty,
		() => ctl.scroll?.viewportHeight || bandHeight - 2,
		ctl,
		d.windowed ?? true,
	);
	const scroll = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		// SV-25: map the IDLE thumb "┃" to the track's "│" so the right frame
		// edge is uniform at rest; the ACTIVE thumb keeps "█" in accent.
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	ctl.scroll = scroll;
	return new MeasurementSafeVStack([
		{ component: new BorderTop(theme, d.title, d.color, d.streaming, ctl), basis: 1, grow: 0, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new BorderBottom(theme, ctl), basis: 1, grow: 0, shrink: 0 },
	]);
}

/** Top border of the transcript region under the band; drags the band height. */
class BandSeparator implements Component {
	constructor(private theme: Theme) {}
	render(w: number): string[] {
		const th = this.theme;
		return [th.fg("border", "╭") + th.fg("border", "─".repeat(Math.max(0, w - 2))) + th.fg("border", "╮")];
	}
	handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (drag && (ev.type === "drag" || ev.type === "release")) return continueDrag(ev);
		if (ev.type === "press" && ev.button === "left") return beginDrag("height", ev);
		return undefined;
	}
	invalidate(): void {}
	dispose(): void {}
}

function buildBand(theme: Theme, inner: Component): Component {
	const ids: ("thinking" | "tools")[] = [];
	if (thinkingOn) ids.push("thinking");
	if (toolsOn) ids.push("tools");
	// No enabled sub-panels → no band at all.
	if (ids.length === 0) return inner;

	// F/F2: explicit tunable width split (toolsWidthPct of the band base, i.e.
	// the terminal minus a visible files dock). Single panels take the full
	// width. applyGeometry() sets the bases and re-applies them on drags and
	// resizes without rebuilding the tree.
	const splitBand = ids.length === 2;
	const panels = ids.map((id) =>
		framedPanel(theme, bandDef(theme, id), {
			id,
			inBand: true,
			// The boundary between the panels is the tools panel's left edge.
			resizeLeft: splitBand && id === "tools",
		}),
	);
	const band = splitBand
		? new HStack(panels.map((component) => ({ component, basis: 1, grow: 0, shrink: 1, minSize: 1 })))
		: panels[0]!;
	if (splitBand) {
		geo.panelStack = band as HStack;
		geo.thinkPanel = panels[0];
		geo.toolsPanel = panels[1];
	}
	// B2: on short terminals hide the band instead of squeezing the transcript.
	const fits = (v: { height: number }) => v.height - bandHeight - 1 >= MIN_ROWS_BELOW_BAND;
	const stack = new VStack([
		{ component: band, basis: bandHeight, grow: 0, shrink: 1, minSize: Math.min(6, bandHeight), visible: fits },
		{ component: new BandSeparator(theme), basis: 1, grow: 0, shrink: 0, visible: fits },
		{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	geo.bandStack = stack;
	geo.band = band;
	return stack;
}

function buildFilesDock(theme: Theme, inner: Component): Component {
	const cols = tuiRef?.terminal?.columns ?? 120;
	const panelCols = dockColsFor(cols);
	const panel = new FilesPanel(theme, () => tuiRef?.terminal?.rows ?? 0, {
		id: "files",
		inBand: false,
		resizeLeft: true,
	});
	// Wrap the left subtree in a MeasurementSafeVStack — the dock HStack's
	// discarded intrinsic-height measurement would otherwise eagerly render the
	// ENTIRE left side (band + transcript) every keystroke frame. ENTRY FORM
	// MATTERS: a bare component defaults to grow:0, and this wrapper's sentinel
	// render measures as 1 row — a shorter-than-screen left subtree would then
	// collapse to its intrinsic height instead of stretching.
	const left = new MeasurementSafeVStack([
		{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	const stack = new HStack([
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
	geo.dockStack = stack;
	geo.dockPanel = panel;
	return stack;
}

/** Whether a zoomable panel is currently enabled (and composable). */
function panelOn(id: PanelId): boolean {
	if (id === "thinking") return thinkingOn;
	if (id === "tools") return toolsOn;
	return filesOn && typeof tuiRef?.setLayoutRoot === "function";
}

/** D1: one panel over the whole area above pi's editor dock (reused verbatim,
 * like trim mode); the transcript is hidden until the zoom is restored. */
function buildZoom(theme: Theme, id: PanelId): Component | null {
	const base = getBaseRoot();
	const dock = base ? baseDockOf(base) : null;
	if (!dock) return null;
	const ctl: PanelCtl = { id, inBand: false, resizeLeft: false };
	const panel =
		id === "files"
			? new FilesPanel(
					theme,
					// The panel sizes itself: terminal rows minus the dock's height.
					() =>
						Math.max(
							8,
							(tuiRef?.terminal?.rows ?? 24) -
								dock.render(tuiRef?.terminal?.columns ?? 80).length,
						),
					ctl,
				)
			: framedPanel(theme, bandDef(theme, id), ctl);
	return new VStack([
		{ component: panel, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
}

/**
 * Panel C trim mode: replace the transcript region of the base root with a
 * ScrollView over our response doc. The editor dock (pending/status/editor/
 * widgets/footer) is reused verbatim from the base root's second entry, so
 * input is untouched and the composition stays lossless to toggle.
 */
let responseScrollView: ScrollView | null = null;

/** Container for the trimmed doc (startup containers + response doc), the
 * child of responseScrollView. Built lazily; holds live references into pi's
 * base tree, so it stays valid across theme changes and resource reloads. */
let responseDocHost: Container | null = null;

/** Extract the transcript ScrollView from pi's base root (VStack[transcript,
 * dock]): the entry with an own `child` property (baseDockOf finds the other
 * one). */
function baseTranscriptOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	for (const e of entries) {
		const c = e?.component;
		if (c && Object.hasOwn(c, "child")) return c as Component;
	}
	return null;
}

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

/**
 * SV-26: build the trimmed panel's document: pi's own startup header and
 * loaded-resources containers mounted above the response doc. Those two
 * containers are children[0..1] of the transcript's documentContainer and
 * hold the startup banner + [Context]/[Skills]/[Prompts]/[Extensions]
 * listing. Trim mode unmounts the base transcript, which erased them; the
 * response doc mirrors branch messages only and never contained them.
 * Mounting the LIVE instances here (not snapshots) keeps ctrl+o header
 * expansion, theme updates and /reload resource refreshes working, and never
 * double-mounts: while trim is on the base transcript is unmounted, and when
 * trim toggles off these containers return with it. Requires exactly the
 * expected [header, resources, chat] triple; any other shape degrades to the
 * old response-only doc (never risk mounting chatContainer here).
 */
function buildTrimDoc(base: Component): Container {
	if (!responseDocHost) {
		responseDocHost = new Container();
		try {
			const kids = (baseTranscriptOf(base) as any)?.child?.children;
			if (Array.isArray(kids) && kids.length === 3) {
				responseDocHost.addChild(kids[0]);
				responseDocHost.addChild(kids[1]);
			}
		} catch {
			/* unexpected tree shape — response doc only */
		}
		responseDocHost.addChild(responseDoc);
	}
	return responseDocHost;
}

/** Build the trimmed inner: VStack([responseScroll, dock]) like pi's viewport. */
function buildTrimInner(theme: Theme): Component | null {
	const base = getBaseRoot();
	if (!base) return null;
	const dock = baseDockOf(base);
	if (!dock) return null;
	if (!responseScrollView) {
		responseScrollView = new ScrollView(buildTrimDoc(base), {
			follow: "end",
			// A1: in trim mode pi's own transcript (primary) is not mounted;
			// without this the FIRST laid-out ScrollView — the Thinking panel —
			// became primary and received PgUp/PgDn, Ctrl+F and wheel fallback.
			primary: true,
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
	// Geometry refs belong to the tree being built; drop stale ones first.
	for (const k of Object.keys(geo) as (keyof typeof geo)[]) delete geo[k];
	composedTermCols = tuiRef?.terminal?.columns ?? 120;
	if (zoomed && panelOn(zoomed)) {
		const z = buildZoom(theme, zoomed);
		if (z) return z;
	}
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
	// Set the real bases (dock width, band height, width split) on the
	// freshly built entries.
	applyGeometry();
	return root;
}

/** Reconcile the single "ui" layout layer with the current panel flags. */
function reconcileLayout(theme: Theme): void {
	drag = null;
	if (zoomed && !panelOn(zoomed)) zoomed = null;
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
			(tui, theme) => {
				tuiRef = tui;
				docTheme = theme;
				themeGetter = () => ctx.ui.theme;
				notifyFn = (msg, level) => ctx.ui.notify(msg, level);
				initLayoutManager(tui);
				// SV-14: apply the still-pending startup composition here. The
				// factory runs synchronously during session_start (before the
				// first paint) and the fullscreen root is available right now, so
				// the saved panels land in the FIRST painted frame. The deferred
				// startupTimer remains as the fallback for a later-ready root.
				if (startupPending && REG.gen === MY_GEN) {
					startupPending = false;
					reconcileLayout(ctx.ui.theme);
				}
				return {
					render: (width: number) => {
						selfHealLayout();
						// SV-08: pi swaps the global theme object on a theme change
						// (extensions get no event) and the composition + response doc
						// capture ANSI at build time. Compare a color fingerprint and
						// recompose with the live theme ONLY on a change — ordinary
						// state changes never rebuild the tree.
						const liveTheme = ctx.ui.theme;
						const fp = themeFingerprint(liveTheme);
						if (composedThemeFp === null) composedThemeFp = fp;
						else if (fp !== composedThemeFp) {
							composedThemeFp = fp;
							if (anyPanelActive()) {
								rebuildResponseDoc(ctx);
								reconcileLayout(liveTheme);
							}
						}
						// SV-07/F2: dock width and the band's width split derive from the
						// terminal width; on any resize re-apply them to the composed
						// entries in place (no rebuild, scroll positions survive).
						if (
							typeof tuiRef?.setLayoutRoot === "function" &&
							isLayoutLayerActive("ui") &&
							(tuiRef?.terminal?.columns ?? 120) !== composedTermCols
						)
							applyGeometry();
						return widgetLines(liveTheme, width);
					},
					invalidate: () => {},
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
					// Pass the whole message (content + details), the same
					// shape as a live result.
					ingestToolResult(msg.toolCallId, msg, msg.isError);
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
		thinkingScope = cfg.thinkingScope;
		toolsOn = cfg.tools;
		toolMode = cfg.toolMode;
		bandHeight = cfg.bandHeight;
		toolsWidthPct = cfg.toolsWidthPct;
		filesWidth = cfg.filesWidth;
		zoomed = null;
		filesOn = cfg.files;
		showDiff = cfg.diff;
		answerDividerMode = cfg.answerDivider;
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
		// SV-27: a new user message starts a new turn — with thinkingScope
		// "turn" the panel drops the previous turn's reasoning here (it stays in
		// the transcript, and reconstruct() restores it on resume/branch switch).
		// Clearing on thinking_start instead would wipe the earlier blocks of the
		// SAME turn, since one assistant message can stream several of them.
		if (msg?.role === "user" && thinkingScope === "turn") {
			thinking.reset();
		}
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
		ingestToolCall(event.toolCallId, event.toolName, event.args, Date.now());
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
		ingestToolResult(event.toolCallId, (event as any).result, event.isError, Date.now());
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
				const inputPath = (event as any).input?.path;
				const p = typeof inputPath === "string" ? inputPath : editDiff.path;
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
		stopToolTicker();
		drag = null;
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
			width: dockColsFor(cols),
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
		description:
			"Toggle all panels: off = bare pi layout, on = saved startup defaults",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split requires fullscreen mode", "warning");
				return;
			}
			// Full toggle pair (revised SV-01): OFF clears every panel flag so
			// pi's native layout is fully restored (no band, no files dock, no
			// trim/response-only swap). ON restores the panel flags saved as
			// startup defaults (ui-panels.json, written by /split-save); if the
			// saved layout has no panels on (or was never saved), fall back to
			// the classic default of thinking + tools. Geometry (bandHeight,
			// toolMode, toolsWidthPct) is session-local and not reset here.
			const wasOn = panelsActive();
			if (wasOn) {
				thinkingOn = false;
				toolsOn = false;
				filesOn = false;
				trimResponse = false;
				zoomed = null;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view off (all panels) · /split-save saves defaults", "info");
			} else {
				const cfg = normalizeConfig(loadUiPanelsConfig());
				if (!cfg.thinking && !cfg.tools && !cfg.files && !cfg.trimResponse) {
					thinkingOn = true;
					toolsOn = true;
				} else {
					thinkingOn = cfg.thinking;
					toolsOn = cfg.tools;
					filesOn = cfg.files;
					showDiff = cfg.diff;
					answerDividerMode = cfg.answerDivider;
					trimResponse = cfg.trimResponse;
				}
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view on (saved layout) · /split-save saves defaults", "info");
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

	pi.registerCommand("split-thinking-scope", {
		description:
			"Thinking panel buffer: turn (current turn only) | session (all turns)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "turn") thinkingScope = "turn";
			else if (arg === "session") thinkingScope = "session";
			else thinkingScope = thinkingScope === "turn" ? "session" : "turn";
			// Switching back to "turn" takes effect now instead of at the next
			// user message, so the command's feedback matches the panel.
			if (thinkingScope === "turn") thinking.reset();
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(
				`Thinking panel: ${thinkingScope === "turn" ? "current turn only" : "all turns"}`,
				"info",
			);
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

	pi.registerCommand("split-diff", {
		description: "Toggle the files panel's edit-diff subpanel",
		handler: async (_args, ctx) => {
			showDiff = !showDiff;
			filesVersion++;
			requestRender();
			ctx.ui.notify(`Edit diff ${showDiff ? "on" : "off"}`, "info");
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

	pi.registerCommand("split-divider", {
		description:
			"Response-only divider between successive answers: rule | space",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "rule") answerDividerMode = "rule";
			else if (arg === "space") answerDividerMode = "space";
			else answerDividerMode = answerDividerMode === "rule" ? "space" : "rule";
			// Doc children were built with the old mode → rebuild from branch.
			rebuildResponseDoc(ctx);
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(`Answer divider: ${answerDividerMode}`, "info");
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
				thinkingScope,
				bandHeight,
				toolsWidthPct,
				...(filesWidth === null ? {} : { filesWidth }),
				diff: showDiff,
				answerDivider: answerDividerMode,
			});
			ctx.ui.notify(
				saved
					? "Panel layout saved as startup defaults for new windows"
					: "Could not save panel layout (config write failed)",
				saved ? "info" : "error",
			);
		},
	});
}
