import { test } from "node:test";
import assert from "node:assert/strict";
import {
	appendStreamTail,
	bandToolsColsFor,
	capDisplayLine,
	capToolText,
	dockColsFor,
	formatDuration,
	truncateInline,
} from "../helpers.ts";
import { normalizeConfig } from "../ui-panels-config.ts";

test("truncateInline collapses whitespace and never splits a surrogate pair", () => {
	assert.equal(truncateInline("  a\n  b\tc  "), "a b c");
	assert.equal(truncateInline("abcdefghij", 5), "abcd…");
	// "abc😀…": the cut would land between the emoji's surrogates → drop it.
	const out = truncateInline("abc😀defgh", 5);
	assert.equal(out, "abc…");
});

test("capToolText keeps the newest suffix with a marker, within the cap", () => {
	assert.equal(capToolText("short", 100), "short");
	const s = "x".repeat(500) + "TAIL";
	const out = capToolText(s, 100);
	assert.ok(out.length <= 100);
	assert.ok(out.startsWith("[truncated: newest 100 of 504 chars]\n"));
	assert.ok(out.endsWith("TAIL"));
	// Never starts the kept suffix on a lone low surrogate.
	const emoji = "😀".repeat(200);
	const e = capToolText(emoji, 101).split("\n")[1];
	assert.ok(e.length % 2 === 0 && e.startsWith("😀"));
});

test("bandToolsColsFor applies the ratio and minimum clamps", () => {
	assert.equal(bandToolsColsFor(200, 35), 70);
	assert.equal(bandToolsColsFor(60, 20), 20); // tools min 20
	assert.equal(bandToolsColsFor(50, 60), 26); // think min 24
	assert.equal(bandToolsColsFor(30, 50), 15); // both mins impossible → raw
});

test("dockColsFor: auto 25% clamped 34–48, manual clamped to the terminal", () => {
	assert.equal(dockColsFor(100), 34);
	assert.equal(dockColsFor(160), 40);
	assert.equal(dockColsFor(400), 48);
	assert.equal(dockColsFor(160, 70), 70);
	assert.equal(dockColsFor(160, 10), 24);
	assert.equal(dockColsFor(160, 150), 110); // keeps 50 cols for the left side
});

test("formatDuration", () => {
	assert.equal(formatDuration(420), "0.4s");
	assert.equal(formatDuration(2345), "2.3s");
	assert.equal(formatDuration(42_900), "42s");
	assert.equal(formatDuration(185_000), "3m05s");
	assert.equal(formatDuration(3_720_000), "1h02m");
	assert.equal(formatDuration(2345, true), "2s");
	assert.equal(formatDuration(-5), "0.0s");
});

test("appendStreamTail splits lines before capping (no lost lines)", () => {
	const lines: string[] = [];
	let tail = appendStreamTail(lines, "", "ab", 10);
	tail = appendStreamTail(lines, tail, "c\r\nline2\n" + "y".repeat(30) + "\nend", 10);
	assert.deepEqual(lines, ["abc", "line2", "y".repeat(30)]);
	assert.equal(tail, "end");
});

test("appendStreamTail drops the older half on overflow, not a sliding window", () => {
	const lines: string[] = [];
	let tail = "";
	const seen = new Set<number>();
	for (let i = 0; i < 100; i++) {
		tail = appendStreamTail(lines, tail, "abcdefghij", 40);
		seen.add(tail.length);
		assert.ok(tail.length <= 40);
	}
	assert.equal(lines.length, 0);
	// Start index changes only when the tail overflows (halves), so lengths
	// cycle 20..40 instead of pinning at 40 (which would slide every delta).
	assert.ok(seen.has(30) && seen.has(40));
});

test("capDisplayLine keeps the newest chars with an ellipsis", () => {
	assert.equal(capDisplayLine("short", 10), "short");
	assert.equal(capDisplayLine("0123456789abc", 8), "… 789abc"); // 8 units total
});

test("normalizeConfig: filesWidth is a validated optional number", () => {
	assert.equal(normalizeConfig({}).filesWidth, null);
	assert.equal(normalizeConfig({ filesWidth: 60 }).filesWidth, 60);
	assert.equal(normalizeConfig({ filesWidth: 10 }).filesWidth, null);
	assert.equal(normalizeConfig({ filesWidth: "60" as never }).filesWidth, null);
	assert.equal(normalizeConfig({ filesWidth: 999 }).filesWidth, 200);
	assert.equal(normalizeConfig(null as never).bandHeight, 20);
});
