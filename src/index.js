#!/usr/bin/env node
const command = process.argv[2];

if (command === "setup" || command === "uninstall") {
  const { setup, uninstall } = await import("./setup.js");
  try {
    process.exitCode = await (command === "setup" ? setup() : uninstall());
  } catch (err) {
    console.error(`mcp-gpt-image ${command} failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
} else {
  await import("./server.js");
}
