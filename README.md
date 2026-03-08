# Optimized Claw

<p align="center">
    <img src="docs/assets/optimized-claw-banner.png" alt="Optimized Claw" width="800">
</p>

<p align="center">
  <strong>Production-hardened OpenClaw for multi-agent teams</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node ≥22">
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/Fork%20of-OpenClaw-FF4500?style=for-the-badge" alt="Fork of OpenClaw"></a>
</p>

---

## What is Optimized Claw?

**Optimized Claw** is a production-hardened fork of [OpenClaw](https://github.com/openclaw/openclaw) — the open-source personal AI assistant. It tracks upstream closely but ships battle-tested fixes, multi-agent isolation, security hardening, and infrastructure improvements needed to run OpenClaw reliably in production with multiple agents.

Everything from upstream works as-is. Optimized Claw adds the layer on top: per-agent browser isolation, consciousness loops, content security scanning, Docker reliability fixes, and tooling that makes multi-agent deployments actually stable.

If you want a single-agent personal assistant, upstream OpenClaw is great. If you want to run a **team of agents** on a server, keeping them isolated, secure, and self-aware — this fork is for you.

The public brand is **Optimized Claw**, but the runtime, CLI, package layout, and config paths stay `openclaw` for upstream compatibility.

---

## Best Fit

Optimized Claw is a better fit than stock upstream if you are:

- running multiple long-lived agents on one gateway
- deploying primarily with Docker or server-hosted infrastructure
- relying on per-agent browser isolation and scoped credentials
- using upstream channels like Matrix/Element, Telegram, Discord, Slack, or WhatsApp but wanting a more production-oriented baseline
- keeping a fork in sync with upstream while preserving a known patch set

---

## What's Different from Upstream OpenClaw?

### 🔒 Security

| Feature               | Description                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Content Scanner       | Two-stage scanning (regex + optional frontier model) with risk scoring on all external content |
| Data Classification   | Three-tier classification (Confidential/Internal/Public) with PII detection                    |
| Event Logger          | Structured JSONL event logging with PII redaction, log rotation, and queryable history         |
| Scan-and-Log Pipeline | DRY wrapper used across browser, web-fetch, and cron — all external content is scanned         |

### 🤖 Multi-Agent Isolation

| Feature                      | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Per-Agent Browser Containers | Each agent gets a dedicated browser sandbox via Docker, not a shared browser                |
| Per-Agent OAuth              | Removed credential inheritance — agents use only their own OAuth tokens                     |
| Browser-Only Sandbox Mode    | New `browser-only` sandbox mode for agents that need browser access without full containers |
| Agent Browser Routing Fix    | `createBrowserTool()` now passes `agentId` so agents route to their own containers          |
| Per-Agent CLI Onboarding     | `--agent` and `--sync-all` flags for scoped credential setup                                |

### 🧠 Consciousness & Memory

| Feature                      | Description                                                                |
| ---------------------------- | -------------------------------------------------------------------------- |
| 3-Tier Reflection System     | Self-review (6h), consciousness loop (2h dynamic), deep-review (48h)       |
| NEXT_WAKE Dynamic Scheduling | Agents control their own cron frequency via `NEXT_WAKE:` directives        |
| Session Context Carryover    | Rolling `memory/session-context.md` persists context across session resets |
| Knowledge Base Indexer       | Auto-scans `memory/knowledge/*.md` and builds a queryable `_index.md`      |
| Memory File Templates        | Structured 10-section `MEMORY.md` template seeded on workspace creation    |
| Nightly Innovation Job       | 5-phase autonomous building cron with backlog integration                  |
| Morning Briefing             | Personalized daily summary with backlog surfacing                          |
| Weekly Self-Audit            | 21-question strategic audit feeding improvement backlog                    |

### 🐳 Docker & Deployment

| Feature                   | Description                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CDP Host Header Fix       | `http.request()` workaround for Node.js `fetch()` silently dropping `Host` headers — without this, Docker hostnames fail |
| CDP Host Proxy            | Python reverse proxy as belt-and-suspenders for Host header rewriting in containers                                      |
| Honcho Plugin Pre-Bake    | Plugin baked during image build with `root` ownership to pass the plugin scanner                                         |
| Browser Startup Sweep     | Auto-updates stale browser containers on gateway boot                                                                    |
| Managed Platform Guards   | `OPENCLAW_MANAGED_PLATFORM` gating prevents self-update in hosted deployments                                            |
| Pre-Installed CLI Tooling | `ffmpeg`, `imagemagick`, `pandoc`, `yt-dlp`, `sqlite3`, `ripgrep`, and 15+ more tools baked into Docker image            |
| Diagnostics Toolkit       | System health checks: PID file, port reachability, error rate, disk space                                                |

### 🌐 Browser Control

| Feature                  | Description                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Parallel Profile Listing | `Promise.all` replaces serial `for` loop — prevents timeout cascades with multiple remote profiles |
| Stealth Evasion Scripts  | 8 Playwright stealth injections — `navigator.webdriver`, plugins, WebGL, `chrome.runtime`, etc.    |
| Auto-Download Capture    | Browser downloads automatically route to per-agent workspace directories                           |
| Profile Timeout Tuning   | Bumped from 3s to 5s for reliability with 5+ remote profiles                                       |
| Sandbox Browser API      | HTTP/WebSocket proxy with noVNC for browser container access from the dashboard                    |

### ⚡ Performance & Resilience

| Feature                | Description                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Async Control UI       | Replaced synchronous `fs.readFileSync` with async streaming for the gateway Control UI |
| Telegram Media Timeout | 15s timeout on media downloads prevents hung downloads from blocking groups            |
| Typing TTL Callback    | "⏳ Still thinking" feedback when LLM runs exceed the typing indicator TTL             |
| Heartbeat Tuning       | Default interval changed from 30m to 1h to reduce unnecessary wakeups                  |

### 🛠️ Tooling

| Feature         | Description                                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| SQL Tools       | `sql_query` (read-only memory index) + `sql_execute` (read-write workspace databases) |
| Sansa Provider  | Additional model provider integration                                                 |
| SOUL.md Rewrite | Actionable framework with 3-tier reflection, not philosophical essay                  |
| OPERATIONS.md   | System update procedures, heartbeat docs, reflection system description               |

---

## Deployment Paths

Optimized Claw supports the same runtime surfaces as upstream OpenClaw, but the recommended fork install paths are:

- **Git checkout** for direct control and easy upstream syncs
- **GHCR images** for Docker and hosted deployments
- **OCS** for one-click managed deployments

If your deployment tooling pulls container images directly, point it at:

- `ghcr.io/ashneil12/optimized-claw:main`
- `ghcr.io/ashneil12/optimized-claw-browser:main`

If your workflow depends on Matrix/Element or other upstream channels, the existing upstream channel docs and setup flow still apply unless this fork explicitly documents an override.

---

## Fresh Install

### OCS

Use **Open Cloud Servers (OCS)** if you want the managed, one-click path.

### Self-Hosted: macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/ashneil12/optimized-claw/main/scripts/install.sh | bash
```

This installer now defaults to a **git checkout of this fork**, not a package-manager install.

### Self-Hosted: Windows

```powershell
iwr -useb https://raw.githubusercontent.com/ashneil12/optimized-claw/main/scripts/install.ps1 | iex
```

### Manual Source Install

Runtime: **Node ≥22**.

```bash
git clone https://github.com/ashneil12/optimized-claw.git
cd optimized-claw

pnpm install
pnpm build

pnpm openclaw onboard --install-daemon
pnpm openclaw gateway --port 18789 --verbose
```

Install note: the public brand is **Optimized Claw**, but the command stays `openclaw`. For this fork, prefer **git** or **Docker** installs. A plain `npm install -g openclaw` targets the upstream package unless you publish a separate forked npm package.

### Docker

```bash
docker compose up -d
```

Published images:

- `ghcr.io/ashneil12/optimized-claw:main`
- `ghcr.io/ashneil12/optimized-claw-browser:main`

---

## Upgrading from an Existing OpenClaw Setup

If your current OpenClaw setup is already stable and doing everything you need, you probably **do not** need to move.

Switch to Optimized Claw if you specifically want the fork-only behavior: multi-agent isolation, browser-container hardening, consciousness loops, hosted deployment guards, or the other production patches listed above.

### Existing Source Checkout

Safest path:

1. Back up `~/.openclaw`
2. Stop the currently running gateway/service
3. Clone this fork into a new directory
4. Build it and run onboarding/install-daemon from the new checkout
5. Run `openclaw doctor`
6. Restart the gateway from the new install

The runtime and config paths stay `openclaw` / `~/.openclaw`, so your existing configuration can carry over. That also means you should keep a backup before switching.

### Existing Docker Deployment

Update your image references to:

- `ghcr.io/ashneil12/optimized-claw:main`
- `ghcr.io/ashneil12/optimized-claw-browser:main`

Then pull and restart:

```bash
docker compose pull
docker compose up -d
```

### Existing npm Install

There is no direct fork-owned npm upgrade path yet. If you installed with `npm install -g openclaw`, you are still on the official package stream.

To move to this fork, reinstall via:

- the git-based installer above
- a manual source checkout
- Docker / GHCR images

---

## One-Click Deploy

For managed hosting, **Open Cloud Servers (OCS)** provides one-click deploy of Optimized Claw instances. Connect your channels, and it just works.

---

## Staying in Sync with Upstream

Optimized Claw tracks `openclaw/openclaw` main branch. Custom patches are documented in:

- **[LOCAL_PATCHES.md](LOCAL_PATCHES.md)** — Critical patches with per-file verification commands
- **[OPENCLAW_CONTEXT.md](OPENCLAW_CONTEXT.md)** — Complete modification inventory with post-sync checklist

After every upstream sync:

```bash
# Quick verification that all patches survived
grep -c 'httpRequestWithHostOverride' src/browser/cdp.helpers.ts  # expect ≥ 1
grep -c 'Promise.all' src/browser/server-context.ts               # expect ≥ 1
grep -c 'agentId.*resolveSessionAgentId' src/agents/openclaw-tools.ts  # expect ≥ 1
```

---

## Configuration

Optimized Claw uses the same configuration as upstream OpenClaw. See:

- [Full configuration reference](https://docs.openclaw.ai/gateway/configuration)
- [Getting started guide](https://docs.openclaw.ai/start/getting-started)
- [Channel setup](https://docs.openclaw.ai/channels)

Fork-specific additions are documented in `OPENCLAW_CONTEXT.md`.

---

## Credits

Optimized Claw is built on top of [OpenClaw](https://github.com/openclaw/openclaw) by Peter Steinberger and the OpenClaw community. All upstream contributors are recognized.

- [OpenClaw](https://github.com/openclaw/openclaw) — upstream project
- [OpenClaw Docs](https://docs.openclaw.ai) — documentation (applies to this fork)

## License

[MIT](LICENSE) — same as upstream OpenClaw.
