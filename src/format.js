function pad(n) {
  return String(n).padStart(2, "0");
}

export function localDateTime(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

export function relativeDuration(ms) {
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  return parts.join(" ") || "1m";
}

export function windowLabel(mins) {
  if (!mins) return "window";
  if (mins === 10080) return "weekly";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

export function formatWindow(win, now = Date.now()) {
  if (!win || typeof win.usedPercent !== "number") return null;
  const used = Math.max(0, Math.min(100, win.usedPercent));
  let text = `${windowLabel(win.windowDurationMins)}: ${100 - used}% left (${used}% used)`;
  if (win.resetsAt) {
    const remaining = win.resetsAt * 1000 - now;
    text +=
      remaining > 0
        ? `, resets in ${relativeDuration(remaining)} at ${localDateTime(win.resetsAt)}`
        : `, reset was due at ${localDateTime(win.resetsAt)}`;
  }
  return text;
}

export function formatRateLimits(snapshots, now = Date.now()) {
  const lines = [];
  const list = (snapshots ?? []).filter(Boolean);
  for (const snap of list) {
    const name = snap.limitName ?? (list.length > 1 ? snap.limitId : null);
    const prefix = name ? `${name} ` : "";
    for (const win of [snap.primary, snap.secondary]) {
      const text = formatWindow(win, now);
      if (text) lines.push(`${prefix}${text}`);
    }
    if (snap.rateLimitReachedType) lines.push(`${prefix}limit reached: ${snap.rateLimitReachedType}`);
    if (snap.credits?.hasCredits) {
      lines.push(`${prefix}credits: ${snap.credits.unlimited ? "unlimited" : snap.credits.balance}`);
    }
  }
  return lines;
}
