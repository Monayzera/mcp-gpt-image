import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRateLimits, formatWindow, localDateTime, relativeDuration, windowLabel } from "../src/format.js";

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;
const LOCAL_STAMP = "\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\(UTC[+-]\\d{2}:\\d{2}\\)";

function withTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe("windowLabel", () => {
  it("labels 300 minutes as 5h", () => {
    assert.equal(windowLabel(300), "5h");
  });

  it("labels 10080 minutes as weekly", () => {
    assert.equal(windowLabel(10080), "weekly");
  });

  it("labels whole days as Nd", () => {
    assert.equal(windowLabel(1440), "1d");
    assert.equal(windowLabel(2880), "2d");
    assert.equal(windowLabel(20160), "14d");
  });

  it("labels whole hours as Nh", () => {
    assert.equal(windowLabel(60), "1h");
    assert.equal(windowLabel(120), "2h");
  });

  it("labels anything else in minutes", () => {
    assert.equal(windowLabel(90), "90m");
    assert.equal(windowLabel(1), "1m");
  });

  it("falls back to window when the duration is unknown", () => {
    assert.equal(windowLabel(0), "window");
    assert.equal(windowLabel(undefined), "window");
    assert.equal(windowLabel(null), "window");
  });
});

describe("relativeDuration", () => {
  it("returns now for zero or negative durations", () => {
    assert.equal(relativeDuration(0), "now");
    assert.equal(relativeDuration(-5000), "now");
  });

  it("rounds sub-minute durations up to 1m", () => {
    assert.equal(relativeDuration(1), "1m");
    assert.equal(relativeDuration(30_000), "1m");
    assert.equal(relativeDuration(60_000), "1m");
  });

  it("rounds partial minutes up", () => {
    assert.equal(relativeDuration(60_001), "2m");
    assert.equal(relativeDuration(59 * 60_000 + 1), "1h");
  });

  it("formats minutes, hours and days", () => {
    assert.equal(relativeDuration(45 * 60_000), "45m");
    assert.equal(relativeDuration(3_600_000), "1h");
    assert.equal(relativeDuration(90 * 60_000), "1h 30m");
    assert.equal(relativeDuration(26 * 3_600_000), "1d 2h");
    assert.equal(relativeDuration(24 * 3_600_000), "1d");
  });

  it("drops minutes once days are shown", () => {
    assert.equal(relativeDuration((1440 + 30) * 60_000), "1d");
    assert.equal(relativeDuration((2 * 1440 + 60 + 5) * 60_000), "2d 1h");
  });
});

describe("localDateTime", () => {
  it("formats as YYYY-MM-DD HH:MM (UTC+hh:mm)", () => {
    assert.match(localDateTime(NOW_SECONDS), new RegExp(`^${LOCAL_STAMP}$`));
  });

  it("renders UTC", () => {
    assert.equal(withTimezone("UTC", () => localDateTime(NOW_SECONDS)), "2023-11-14 22:13 (UTC+00:00)");
  });

  it("renders a half-hour positive offset", () => {
    assert.equal(withTimezone("Asia/Kolkata", () => localDateTime(NOW_SECONDS)), "2023-11-15 03:43 (UTC+05:30)");
  });

  it("renders a negative whole-hour offset", () => {
    assert.equal(withTimezone("America/Sao_Paulo", () => localDateTime(NOW_SECONDS)), "2023-11-14 19:13 (UTC-03:00)");
  });

  it("renders a negative half-hour offset", () => {
    assert.equal(withTimezone("America/St_Johns", () => localDateTime(NOW_SECONDS)), "2023-11-14 18:43 (UTC-03:30)");
  });
});

describe("formatWindow", () => {
  it("shows percent left and used with the window label", () => {
    const text = formatWindow({ usedPercent: 10, windowDurationMins: 300 }, NOW);
    assert.equal(text, "5h: 90% left (10% used)");
  });

  it("contains the percent left marker", () => {
    assert.ok(formatWindow({ usedPercent: 25, windowDurationMins: 10080 }, NOW).includes("% left"));
  });

  it("appends the reset time when resetsAt is present", () => {
    const text = formatWindow({ usedPercent: 10, windowDurationMins: 300, resetsAt: NOW_SECONDS + 5400 }, NOW);
    assert.match(text, new RegExp(`^5h: 90% left \\(10% used\\), resets in 1h 30m at ${LOCAL_STAMP}$`));
  });

  it("omits the reset clause without resetsAt", () => {
    assert.ok(!formatWindow({ usedPercent: 10, windowDurationMins: 300 }, NOW).includes("resets"));
  });

  it("clamps usedPercent above 100", () => {
    assert.equal(formatWindow({ usedPercent: 150, windowDurationMins: 60 }, NOW), "1h: 0% left (100% used)");
  });

  it("clamps negative usedPercent", () => {
    assert.equal(formatWindow({ usedPercent: -20, windowDurationMins: 60 }, NOW), "1h: 100% left (0% used)");
  });

  it("handles the 0 and 100 boundaries", () => {
    assert.equal(formatWindow({ usedPercent: 0, windowDurationMins: 300 }, NOW), "5h: 100% left (0% used)");
    assert.equal(formatWindow({ usedPercent: 100, windowDurationMins: 300 }, NOW), "5h: 0% left (100% used)");
  });

  it("returns null for missing or non-numeric windows", () => {
    assert.equal(formatWindow(null, NOW), null);
    assert.equal(formatWindow(undefined, NOW), null);
    assert.equal(formatWindow({}, NOW), null);
    assert.equal(formatWindow({ usedPercent: "10" }, NOW), null);
  });

  it("uses window as the label when the duration is unknown", () => {
    assert.equal(formatWindow({ usedPercent: 40 }, NOW), "window: 60% left (40% used)");
  });

  it("does not print a reset time in the past as resets in now", () => {
    const text = formatWindow({ usedPercent: 10, windowDurationMins: 300, resetsAt: NOW_SECONDS - 60 }, NOW);
    assert.ok(!text.includes("resets in now"), text);
  });
});

describe("formatRateLimits", () => {
  const primary = { usedPercent: 10, windowDurationMins: 300, resetsAt: NOW_SECONDS + 3600 };
  const secondary = { usedPercent: 5, windowDurationMins: 10080, resetsAt: NOW_SECONDS + 3 * 86400 };

  it("returns one line per window for a snapshot with two windows", () => {
    const lines = formatRateLimits([{ limitId: "codex", primary, secondary }], NOW);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("5h: 90% left"));
    assert.ok(lines[1].startsWith("weekly: 95% left"));
    assert.ok(lines.every(l => l.includes("% left")));
  });

  it("skips a missing window", () => {
    assert.equal(formatRateLimits([{ limitId: "codex", primary, secondary: null }], NOW).length, 1);
    assert.equal(formatRateLimits([{ limitId: "codex", primary: undefined, secondary }], NOW).length, 1);
  });

  it("returns an empty list for empty, null or undefined input", () => {
    assert.deepEqual(formatRateLimits([], NOW), []);
    assert.deepEqual(formatRateLimits(null, NOW), []);
    assert.deepEqual(formatRateLimits(undefined, NOW), []);
  });

  it("filters null entries", () => {
    assert.equal(formatRateLimits([null, { limitId: "codex", primary }, undefined], NOW).length, 1);
  });

  it("prefixes lines with limitName when present", () => {
    const lines = formatRateLimits([{ limitId: "codex", limitName: "Codex", primary }], NOW);
    assert.ok(lines[0].startsWith("Codex 5h: 90% left"));
  });

  it("prefixes lines with limitId when several snapshots have no limitName", () => {
    const lines = formatRateLimits([{ limitId: "codex", primary }, { limitId: "images", primary: secondary }], NOW);
    assert.ok(lines[0].startsWith("codex 5h:"));
    assert.ok(lines[1].startsWith("images weekly:"));
  });

  it("adds no prefix for a single snapshot without limitName", () => {
    const lines = formatRateLimits([{ limitId: "codex", primary }], NOW);
    assert.ok(lines[0].startsWith("5h:"));
  });

  it("reports a reached limit", () => {
    const lines = formatRateLimits([{ limitId: "codex", primary, rateLimitReachedType: "primary" }], NOW);
    assert.equal(lines.at(-1), "limit reached: primary");
  });

  it("reports credits only when available", () => {
    assert.equal(formatRateLimits([{ limitId: "c", credits: { hasCredits: true, unlimited: true } }], NOW)[0], "credits: unlimited");
    assert.equal(formatRateLimits([{ limitId: "c", credits: { hasCredits: true, unlimited: false, balance: "12.50" } }], NOW)[0], "credits: 12.50");
    assert.deepEqual(formatRateLimits([{ limitId: "c", credits: { hasCredits: false, unlimited: false, balance: "0" } }], NOW), []);
  });

  it("clamps out of range percentages inside snapshots", () => {
    const lines = formatRateLimits([{ limitId: "codex", primary: { usedPercent: 250, windowDurationMins: 300 } }], NOW);
    assert.equal(lines[0], "5h: 0% left (100% used)");
  });
});
