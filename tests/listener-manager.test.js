#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  ListenerManager,
  parseBooleanFlag,
  resolveTailscaleIPv4,
} = require("../scripts/listener-manager");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.host = null;
    this.port = null;
  }

  listen(port, host, callback) {
    this.port = port;
    this.host = host;
    setImmediate(callback);
  }

  close(callback) {
    this.closed = true;
    setImmediate(() => callback?.());
  }
}

function createHarness(options = {}) {
  const servers = [];
  const logs = [];
  const timeouts = [];
  const intervals = [];
  const createServer = () => {
    const server = new FakeServer();
    servers.push(server);
    return server;
  };
  const manager = new ListenerManager({
    createServer,
    requestHandler: () => {},
    port: 6419,
    primaryHost: "127.0.0.1",
    tailscaleListen: true,
    resolveTailscaleIPv4: () => "100.92.198.57",
    log: (level, message) => logs.push({ level, message }),
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { timer.cleared = true; },
    ...options,
  });
  return { manager, servers, logs, timeouts, intervals };
}

test("parseBooleanFlag accepts only true and false", () => {
  assert.equal(parseBooleanFlag(undefined, false), false);
  assert.equal(parseBooleanFlag("true", false), true);
  assert.equal(parseBooleanFlag("false", true), false);
  assert.equal(parseBooleanFlag("TRUE", false), false);
});

test("resolveTailscaleIPv4 selects a non-internal CGNAT IPv4 deterministically", () => {
  const interfaces = {
    utun9: [
      { address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false },
      { address: "100.127.255.255", family: "IPv4", internal: false },
    ],
    utun3: [
      { address: "100.92.198.57", family: 4, internal: false },
      { address: "fd7a:115c:a1e0::f136:c639", family: 6, internal: false },
      { address: "100.128.0.1", family: "IPv4", internal: false },
    ],
    en7: [{ address: "100.65.0.2", family: "IPv4", internal: false }],
    lo0: [{ address: "100.64.0.1", family: "IPv4", internal: true }],
  };

  assert.equal(resolveTailscaleIPv4(interfaces), "100.92.198.57");
  assert.equal(resolveTailscaleIPv4({ en0: [{ address: "192.168.1.2", family: "IPv4", internal: false }] }), null);
});

test("resolveTailscaleIPv4 rejects CGNAT addresses without Tailscale ULA on the same interface", () => {
  assert.equal(resolveTailscaleIPv4({
    en7: [
      { address: "100.65.0.2", family: "IPv4", internal: false },
      { address: "fd00::1", family: "IPv6", internal: false },
    ],
    utun8: [{ address: "100.100.10.20", family: "IPv4", internal: false }],
  }), null);
});

test("starts primary and Tailscale listeners on the same port", async () => {
  const { manager, servers, intervals } = createHarness();
  manager.start();
  await nextTurn();
  await nextTurn();

  assert.deepEqual(servers.map(({ host, port }) => ({ host, port })), [
    { host: "127.0.0.1", port: 6419 },
    { host: "100.92.198.57", port: 6419 },
  ]);
  assert.equal(intervals[0].delay, 30_000);
});

test("keeps primary active and retries only the secondary listener", async () => {
  let tailscaleIp = null;
  const { manager, servers, timeouts } = createHarness({
    resolveTailscaleIPv4: () => tailscaleIp,
  });
  manager.start();
  await nextTurn();

  assert.equal(servers.length, 1);
  assert.equal(servers[0].closed, false);
  assert.equal(timeouts[0].delay, 1_000);

  tailscaleIp = "100.92.198.57";
  timeouts[0].callback();
  await nextTurn();
  await nextTurn();
  assert.equal(servers[1].host, tailscaleIp);
});

test("caps secondary retry backoff at 60 seconds", async () => {
  const { manager, servers, timeouts } = createHarness({ resolveTailscaleIPv4: () => null });
  manager.start();
  await nextTurn();

  for (let index = 0; index < 7; index += 1) timeouts[index].callback();
  assert.deepEqual(timeouts.map(({ delay }) => delay), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(servers[0].closed, false);
});

test("logs a secondary bind failure and schedules a retry without closing primary", async () => {
  const created = [];
  const createServer = () => {
    const server = new FakeServer();
    if (created.length === 1) {
      server.listen = function listen(port, host) {
        this.port = port;
        this.host = host;
        const error = new Error("address unavailable");
        error.code = "EADDRNOTAVAIL";
        setImmediate(() => this.emit("error", error));
      };
    }
    created.push(server);
    return server;
  };
  const { manager, logs, timeouts } = createHarness({ createServer });
  manager.start();
  await nextTurn();
  await nextTurn();

  assert.equal(created[0].closed, false);
  assert.equal(timeouts[0].delay, 1_000);
  assert.match(logs.map(({ message }) => message).join("\n"), /EADDRNOTAVAIL/);
});

test("binds a changed Tailscale IP before closing the old listener", async () => {
  let tailscaleIp = "100.92.198.57";
  const { manager, servers } = createHarness({ resolveTailscaleIPv4: () => tailscaleIp });
  manager.start();
  await nextTurn();
  await nextTurn();

  tailscaleIp = "100.92.198.58";
  manager.reconcileTailscale();
  assert.equal(servers[1].closed, false);
  await nextTurn();
  assert.equal(servers[2].host, tailscaleIp);
  assert.equal(servers[1].closed, true);
});

test("does not add a duplicate listener for wildcard or matching primary hosts", async () => {
  for (const primaryHost of ["0.0.0.0", "::", "100.92.198.57"]) {
    const { manager, servers } = createHarness({ primaryHost });
    manager.start();
    await nextTurn();
    await nextTurn();
    assert.equal(servers.length, 1, primaryHost);
    await new Promise((resolve) => manager.closeAll(resolve));
  }
});

test("does not monitor Tailscale when the flag is disabled", async () => {
  const { manager, servers, timeouts, intervals } = createHarness({ tailscaleListen: false });
  manager.start();
  await nextTurn();

  assert.equal(servers.length, 1);
  assert.equal(timeouts.length, 0);
  assert.equal(intervals.length, 0);
});

test("closeAll closes every listener and clears monitoring timers", async () => {
  const { manager, servers, intervals } = createHarness();
  manager.start();
  await nextTurn();
  await nextTurn();

  await new Promise((resolve) => manager.closeAll(resolve));
  assert.equal(servers.every((server) => server.closed), true);
  assert.equal(intervals[0].cleared, true);
});
