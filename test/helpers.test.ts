import { test } from "node:test";
import assert from "node:assert/strict";
import {
	appendStreamTail,
	bandToolsColsFor,
	capDisplayLine,
	capToolText,
	dockColsFor,
	formatDuration,
	lastImageBlock,
	outputPreview,
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

test("normalizeConfig: thinkingScope is a strict turn|session read", () => {
	assert.equal(normalizeConfig({}).thinkingScope, "turn");
	assert.equal(normalizeConfig({ thinkingScope: "session" }).thinkingScope, "session");
	assert.equal(normalizeConfig({ thinkingScope: "turn" }).thinkingScope, "turn");
	// Anything that is not the literal "session" must fall back to the default.
	assert.equal(normalizeConfig({ thinkingScope: "all" as never }).thinkingScope, "turn");
	assert.equal(normalizeConfig({ thinkingScope: true as never }).thinkingScope, "turn");
	assert.equal(normalizeConfig(null as never).thinkingScope, "turn");
});

test("lastImageBlock returns the last well-formed image block", () => {
	// String content (plain-text results) has no image.
	assert.equal(lastImageBlock("plain text"), undefined);
	assert.equal(lastImageBlock(undefined), undefined);
	assert.equal(lastImageBlock({}), undefined);
	// Text-only block list.
	assert.equal(lastImageBlock([{ type: "text", text: "hi" }]), undefined);
	// A read-on-image result: text note + image block.
	const readResult = [
		{ type: "text", text: "Read image file [image/png]" },
		{ type: "image", data: "aGk=", mimeType: "image/png" },
	];
	assert.deepEqual(lastImageBlock(readResult), {
		data: "aGk=",
		mimeType: "image/png",
	});
	// Malformed blocks (missing/non-string data or mimeType) are skipped.
	assert.equal(
		lastImageBlock([
			{ type: "image", data: "aGk=" },
			{ type: "image", mimeType: "image/png" },
		]),
		undefined,
	);
	// The LAST image block wins when several are present.
	const multi = [
		{ type: "image", data: "MQ==", mimeType: "image/png" },
		{ type: "image", data: "Mg==", mimeType: "image/jpeg" },
	];
	assert.deepEqual(lastImageBlock(multi), { data: "Mg==", mimeType: "image/jpeg" });
});

test("outputPreview shows the first `cap` lines and counts the hidden rest", () => {
	assert.deepEqual(outputPreview([], 2), { shown: [], hidden: 0 });
	assert.deepEqual(outputPreview(["a", "b"], 2), { shown: ["a", "b"], hidden: 0 });
	assert.deepEqual(outputPreview(["a", "b", "c"], 2), {
		shown: ["a", "b"],
		hidden: 1,
	});
	// cap 0 (compact mode) shows nothing but still counts the hidden lines.
	assert.deepEqual(outputPreview(["a", "b"], 0), { shown: [], hidden: 2 });
	// A cap larger than the list hides nothing.
	assert.deepEqual(outputPreview(["a"], 20), { shown: ["a"], hidden: 0 });
});
