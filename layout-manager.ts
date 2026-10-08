/**
 * layout-manager.ts — shared owner of pi's single fullscreen layout-root slot.
 *
 * Both split-view and explored-files wrap the layout root. If each captured
 * `tui.layoutRoot` and restored it independently, closing one panel would
 * discard the other's wrap (they'd fight over one slot). This manager owns the
 * slot: it captures the true base root once, keeps an ordered set of active
 * "layers" (each a wrap builder), and on any toggle rebuilds the composition
 * `baseRoot → layer1 → layer2 → …` and re-applies it. Closing one layer leaves
 * the others intact.
 *
 * Survives /reload via globalThis: a fresh module unwraps any stale composition
 * back to the base root before re-applying its own layers.
 *
 * Single-TUI-context assumption (SV-20): this manager stores exactly one
 * tuiRef / baseRoot / layer map per process. pi does not guarantee one
 * interactive TUI context per process upstream; simultaneous contexts are
 * unverified and unsupported (see split-view.ts's header).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REG_KEY = Symbol.for("pi.layout-manager");

/** A layer is a wrap builder: receives the inner root, returns the wrapped root. */
type LayerBuild = (inner: Component) => Component;

interface Manager {
	gen: number;
	tuiRef: any;
	baseRoot: Component | null;
	layers: Map<string, LayerBuild>;
}

const G = globalThis as Record<symbol, Manager>;
const M: Manager = G[REG_KEY] ?? {
	gen: 0,
	tuiRef: null,
	baseRoot: null,
	layers: new Map(),
};
G[REG_KEY] = M;

/**
 * Register the live TUI and (re)establish the base root. Call from a widget
 * factory or session_start. If a stale composition from a previous module
 * generation is present, unwrap it back to the base root first.
 */
export function initLayoutManager(tui: any): void {
	M.tuiRef = tui;
	if (M.baseRoot && tui.layoutRoot !== M.baseRoot) {
		// Stale composition left by a /reload'd module — restore the base root.
		try {
			tui.setLayoutRoot(M.baseRoot);
			tui.requestRender?.(true);
		} catch {
			/* not a viewport TUI */
		}
		M.layers.clear();
	}
	if (!M.baseRoot) {
		M.baseRoot = tui.layoutRoot as Component | null;
	}
}

/**
 * Add (or remove, with null) a layout layer. Rebuilds the composed root.
 * `build` receives the inner root and returns the wrapped root.
 */
export function setLayoutLayer(
	id: string,
	build: ((inner: Component) => Component) | null,
): void {
	if (build === null) {
		M.layers.delete(id);
	} else {
		M.layers.set(id, build);
	}
	applyLayout();
}

export function isLayoutLayerActive(id: string): boolean {
	return M.layers.has(id);
}

/** The captured base root (pi's own fullscreen layout root), or null. */
export function getBaseRoot(): Component | null {
	return M.baseRoot;
}

function applyLayout(): void {
	if (!M.tuiRef || !M.baseRoot) return;
	let root = M.baseRoot;
	for (const build of M.layers.values()) {
		root = build(root);
	}
	try {
		M.tuiRef.setLayoutRoot(root);
	} catch {
		/* ignore */
	}
	try {
		// Force a FULL repaint, not a diff frame: the first frame of the new
		// composition must never be diffed against the previous composition's
		// screen buffer (tui.setLayoutRoot only schedules a throttled render
		// without resetting diff state — stale diffs paint blank regions that
		// persist until the next keystroke forces a clean frame).
		M.tuiRef.requestRender?.(true);
	} catch {
		/* ignore */
	}
}

/**
 * Self-heal: pi resets the layout root on a TUI-mode switch (regular↔fullscreen)
 * with no event. Call this on each render; if the live root no longer matches
 * our composition, re-apply the layers.
 */
export function selfHealLayout(): void {
	if (!M.tuiRef || !M.baseRoot || M.layers.size === 0) return;
	let composed: Component | null = null;
	try {
		composed = M.tuiRef.layoutRoot as Component | null;
	} catch {
		return;
	}
	// If the live root is our base root (layers were dropped), re-apply them.
	if (composed === M.baseRoot) {
		applyLayout();
	}
}

/** Restore the base root and clear all layers (on session shutdown). */
export function resetLayoutManager(): void {
	if (M.tuiRef && M.baseRoot) {
		try {
			M.tuiRef.setLayoutRoot(M.baseRoot);
			M.tuiRef.requestRender?.(true);
		} catch {
			/* ignore */
		}
	}
	M.layers.clear();
}

/**
 * This module is a shared utility imported by split-view.ts and explored-files.ts.
 * pi auto-discovers every *.ts file in this directory as an extension and
 * requires a default factory export, so expose a no-op one here. The named
 * exports above are what the other extensions actually use.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: this is a shared layout module, not a real extension */
}
