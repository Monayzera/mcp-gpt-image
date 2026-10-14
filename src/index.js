#!/usr/bin/env node
const command = process.argv[2];

const USAGE = [
  "Usage:",
  "  npx -y github:Monayzera/mcp-gpt-image setup       install the skill and register the MCP server in Claude Code",
  "  npx -y github:Monayzera/mcp-gpt-image uninstall   remove both",
  "  npx -y github:Monayzera/mcp-gpt-image             run the MCP server (stdio), as Claude Code does",
].join("\n");

if (command === undefined) {
  await import("./server.js");
} else if (command === "setup" || command === "uninstall") {
  const { setup, uninstall } = await import("./setup.js");
  try {
    process.exitCode = await (command === "setup" ? setup() : uninstall());
  } catch (err) {
    console.error(`mcp-gpt-image ${command} failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
} else {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}
