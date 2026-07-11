#!/usr/bin/env node
"use strict";

const os = require("os");

const TAILSCALE_CGNAT_FIRST = (100 * 256 * 256 * 256) + (64 * 256 * 256);
const TAILSCALE_CGNAT_LAST = (100 * 256 * 256 * 256) + (127 * 256 * 256) + (255 * 256) + 255;

function parseBooleanFlag(value, fallback = false) {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function ipv4Number(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value;
}

function resolveTailscaleIPv4(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    const hasTailscaleUla = (addresses || []).some((entry) => {
      const family = entry.family === 6 ? "IPv6" : entry.family;
      return family === "IPv6" && !entry.internal && String(entry.address).toLowerCase().startsWith("fd7a:115c:a1e0:");
    });
    if (!hasTailscaleUla) continue;
    for (const entry of addresses || []) {
      const family = entry.family === 4 ? "IPv4" : entry.family;
      const numeric = family === "IPv4" && !entry.internal ? ipv4Number(entry.address) : null;
      if (numeric === null || numeric < TAILSCALE_CGNAT_FIRST || numeric > TAILSCALE_CGNAT_LAST) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
  return candidates[0]?.address || null;
}

function primaryCoversHost(primaryHost, secondaryHost) {
  return primaryHost === "0.0.0.0" || primaryHost === "::" || primaryHost === secondaryHost;
}

class ListenerManager {
  constructor(options) {
    this.createServer = options.createServer;
    this.requestHandler = options.requestHandler;
    this.port = options.port;
    this.primaryHost = options.primaryHost;
    this.tailscaleListen = options.tailscaleListen;
    this.resolveTailscaleIPv4 = options.resolveTailscaleIPv4 || resolveTailscaleIPv4;
    this.log = options.log;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.retryInitialMs = options.retryInitialMs || 1_000;
    this.retryMaxMs = options.retryMaxMs || 60_000;
    this.reconcileIntervalMs = options.reconcileIntervalMs || 30_000;

    this.primaryServer = null;
    this.secondary = null;
    this.pendingSecondary = null;
    this.retryTimer = null;
    this.pollTimer = null;
    this.retryMs = this.retryInitialMs;
    this.closed = false;
  }

  start(onPrimaryListening) {
    this.primaryServer = this.createServer(this.requestHandler);
    this.primaryServer.listen(this.port, this.primaryHost, () => {
      this.log("INFO", `backlog hub listening on ${this.primaryHost}:${this.port}`);
      onPrimaryListening?.();
      if (!this.tailscaleListen || this.closed) return;
      this.pollTimer = this.setIntervalFn(() => this.reconcileTailscale(), this.reconcileIntervalMs);
      this.reconcileTailscale();
    });
  }

  reconcileTailscale() {
    if (this.closed || !this.tailscaleListen || this.pendingSecondary) return;

    if (this.primaryHost === "0.0.0.0" || this.primaryHost === "::") {
      this.clearRetry();
      return;
    }

    let tailscaleIp;
    try {
      tailscaleIp = this.resolveTailscaleIPv4();
    } catch (error) {
      this.log("WARN", `failed to resolve Tailscale IPv4: ${error.message}`);
      this.scheduleRetry();
      return;
    }

    if (!tailscaleIp) {
      if (this.secondary) {
        const previous = this.secondary;
        this.secondary = null;
        this.closeServer(previous.server);
        this.log("WARN", `Tailscale IPv4 disappeared; closed listener on ${previous.host}:${this.port}`);
      }
      this.scheduleRetry();
      return;
    }

    if (primaryCoversHost(this.primaryHost, tailscaleIp)) {
      this.clearRetry();
      if (this.secondary) {
        const previous = this.secondary;
        this.secondary = null;
        this.closeServer(previous.server);
      }
      return;
    }

    if (this.secondary?.host === tailscaleIp) {
      this.retryMs = this.retryInitialMs;
      this.clearRetry();
      return;
    }

    this.startSecondary(tailscaleIp);
  }

  startSecondary(host) {
    const previous = this.secondary;
    const candidate = this.createServer(this.requestHandler);
    this.pendingSecondary = { server: candidate, host };
    let listening = false;

    candidate.on("error", (error) => {
      if (this.closed) return;
      if (listening) {
        if (this.secondary?.server === candidate) this.secondary = null;
        this.log("WARN", `Tailscale listener stopped on ${host}:${this.port}: ${error.code || error.message}`);
        this.closeServer(candidate);
        this.scheduleRetry();
        return;
      }
      if (this.pendingSecondary?.server === candidate) this.pendingSecondary = null;
      this.log("WARN", `failed to listen on Tailscale ${host}:${this.port}: ${error.code || error.message}`);
      this.closeServer(candidate);
      this.scheduleRetry();
    });

    candidate.listen(this.port, host, () => {
      listening = true;
      if (this.closed || this.pendingSecondary?.server !== candidate) {
        this.closeServer(candidate);
        return;
      }
      this.pendingSecondary = null;
      this.secondary = { server: candidate, host };
      this.retryMs = this.retryInitialMs;
      this.clearRetry();
      this.log("INFO", `backlog hub Tailscale listener active on ${host}:${this.port}`);
      if (previous && previous.server !== candidate) {
        this.closeServer(previous.server);
        this.log("INFO", `Tailscale IPv4 changed: ${previous.host} -> ${host}`);
      }
    });
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const delay = this.retryMs;
    this.log("WARN", `Tailscale listener retry in ${delay}ms`);
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      this.reconcileTailscale();
    }, delay);
    this.retryMs = Math.min(delay * 2, this.retryMaxMs);
  }

  clearRetry() {
    if (!this.retryTimer) return;
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = null;
  }

  closeServer(server, callback) {
    if (!server) {
      callback?.();
      return;
    }
    try {
      server.close(callback);
    } catch (error) {
      if (error.code !== "ERR_SERVER_NOT_RUNNING") {
        this.log("WARN", `failed to close listener: ${error.code || error.message}`);
      }
      callback?.();
    }
  }

  closeAll(callback) {
    if (this.closed) {
      callback?.();
      return;
    }
    this.closed = true;
    this.clearRetry();
    if (this.pollTimer) {
      this.clearIntervalFn(this.pollTimer);
      this.pollTimer = null;
    }

    const servers = [
      this.pendingSecondary?.server,
      this.secondary?.server,
      this.primaryServer,
    ].filter((server, index, all) => server && all.indexOf(server) === index);
    this.pendingSecondary = null;
    this.secondary = null;
    this.primaryServer = null;
    if (servers.length === 0) {
      callback?.();
      return;
    }

    let remaining = servers.length;
    const onClosed = () => {
      remaining -= 1;
      if (remaining === 0) callback?.();
    };
    for (const server of servers) this.closeServer(server, onClosed);
  }
}

module.exports = {
  ListenerManager,
  parseBooleanFlag,
  primaryCoversHost,
  resolveTailscaleIPv4,
};
