/**
 * ui-panels-config.ts — shared persistent config for the unified split-view
 * extension (thinking / tools / files panels). Stored at ~/.pi/agent/ui-panels.json.
 *
 * Defaults: thinking and tools default ON (when `split` is on); files defaults OFF.
 * `toolMode` defaults to "compact".
 *
 * IMPORTANT: the JSON on disk is a TEMPLATE of startup defaults, NOT live
 * state. Toggle commands only mutate in-process state (session-local);
 * only /split-save writes the current layout back to disk. This keeps
 * concurrent pi windows from clobbering each other's panels.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "ui-panels.json");

export type ToolMode = "compact" | "full";

export interface UiPanelsConfig {
	/** Master: is the top band (thinking | tools over chat) active. */
	split?: boolean;
	/** Thinking panel within the band. Defaults to true when absent. */
	thinking?: boolean;
	/** Tools panel within the band. Defaults to true when absent. */
	tools?: boolean;
	/** Files side panel (fullscreen dock or regular overlay). */
	files?: boolean;
	/** Tool panel detail mode. */
	toolMode?: ToolMode;
	/** Panel C shows response-only (own-rendered) instead of pi's full transcript. */
	trimResponse?: boolean;
	/** Top band height in rows (6–40, default 20). */
	bandHeight?: number;
	/** Tools panel's share of the band width in percent (20–60, default 35). */
	toolsWidthPct?: number;
}

/** SV-12: strict boolean read — only real booleans count; absent or
 * wrongly-typed values (strings, numbers, objects, null) fall back to the
 * same defaults as a missing field, so bad JSON can never become an
 * accidental truthy flag. */
function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Normalize raw config with defaults (never throws). */
export function normalizeConfig(raw: UiPanelsConfig): Required<{
	split: boolean;
	thinking: boolean;
	tools: boolean;
	files: boolean;
	toolMode: ToolMode;
	trimResponse: boolean;
	bandHeight: number;
	toolsWidthPct: number;
}> {
	// SV-12: tolerate any shape — a null root, an array or a primitive reads
	// as an empty config instead of throwing on property access.
	const root: UiPanelsConfig =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? raw
			: {};
	const split = boolOr(root.split, false);
	const tm: ToolMode = root.toolMode === "full" ? "full" : "compact";
	// SV-12: only a real finite number is usable; Number(null) === 0 would
	// otherwise clamp to 6. Non-numeric/unusable values use the default.
	const rawHeight: unknown = root.bandHeight;
	const usableHeight =
		typeof rawHeight === "number" && Number.isFinite(rawHeight)
			? Math.trunc(rawHeight)
			: 20;
	const bandHeight = Math.max(6, Math.min(40, usableHeight));
	// F: toolsWidthPct — same strict typing as bandHeight (real finite number,
	// default 35 on garbage), clamped to 20–60.
	const rawPct: unknown = root.toolsWidthPct;
	const usablePct =
		typeof rawPct === "number" && Number.isFinite(rawPct)
			? Math.trunc(rawPct)
			: 35;
	const toolsWidthPct = Math.max(20, Math.min(60, usablePct));
	return {
		split,
		thinking: split && boolOr(root.thinking, true),
		tools: split && boolOr(root.tools, true),
		files: boolOr(root.files, false),
		toolMode: tm,
		trimResponse: boolOr(root.trimResponse, false),
		bandHeight,
		toolsWidthPct,
	};
}

export function loadUiPanelsConfig(): UiPanelsConfig {
	try {
		// SV-12: validate the parsed root is a plain object before casting;
		// JSON null, arrays or primitives fall back to defaults.
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		)
			return {};
		return parsed as UiPanelsConfig;
	} catch {
		return {};
	}
}

/** Persist the config. SV-13: returns whether the write actually succeeded
 * instead of swallowing the error, so callers can report the real outcome. */
export function saveUiPanelsConfig(cfg: UiPanelsConfig): boolean {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
		return true;
	} catch {
		/* never break the extension on a config write failure */
		return false;
	}
}

/**
 * This module is a shared utility imported by split-view.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: this is a shared config module, not a real extension */
}
