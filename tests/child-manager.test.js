#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const SERVER = path.join(__dirname, "..", "scripts", "backlog-hub-server.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test("retries a repo browser after the CLI fails to spawn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-hub-child-test-"));
  const repo = path.join(root, "repo");
  const backlogDir = path.join(repo, "backlog");
  fs.mkdirSync(backlogDir, { recursive: true });
  const browserPort = await getFreePort();
  const hubPort = await getFreePort();
  fs.writeFileSync(path.join(backlogDir, "config.yml"), `default_port: ${browserPort}\n`);
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ sources: [{ type: "repo", path: repo }] }));

  let output = "";
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BACKLOG_HUB_CONFIG: configPath,
      BACKLOG_HUB_PORT: String(hubPort),
      BACKLOG_HUB_HOST: "127.0.0.1",
      BACKLOG_HUB_MANAGE_BROWSERS: "1",
      BACKLOG_HUB_TAILSCALE_LISTEN: "false",
      BACKLOG_HUB_CLI_PATH: path.join(root, "missing-backlog"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  });

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const failures = output.match(/spawn .* ENOENT/g) || [];
    if (failures.length >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(`expected a second spawn attempt after ENOENT; output:\n${output}`);
});
