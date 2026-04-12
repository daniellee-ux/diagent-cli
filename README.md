## @diagent/cli

Command-line tool to encode and decode Diagent shareable flowchart URLs.
Designed for agents (Claude Code, Cursor) and humans alike.

By default, `diagent encode` produces a **short URL** like
`https://diagent.dev/d/abcdefghij` (~31 chars, constant size regardless
of diagram complexity). This works by calling the Diagent backend's
`POST /api/s` endpoint, which stores the Mermaid in Cloudflare KV and
returns a content-addressed short ID.

If the backend is unreachable (dev, offline, rate-limit, Cloudflare
outage), `diagent encode` **automatically falls back** to an inline URL
of the form `https://diagent.dev/?code=<lz-compressed>`, which carries
the full Mermaid source in the `code` query parameter. The feature
never fully breaks — worst case, you get a longer URL and a stderr
notice. Pass `--inline` to skip the backend entirely and always produce
the inline format.

### Install

**From npm:**

```bash
npx -y @diagent/cli --help
# or install globally
npm install -g @diagent/cli
```

**From source (contributors):**

```bash
cd cli
npm install
npm run build
npm link     # puts `diagent` on your global PATH
```

### Usage

```
diagent encode [FILE] [--base-url URL] [--inline]
                                          Encode Mermaid from FILE or stdin -> URL on stdout
                                          (tries backend short URL, falls back to inline)
diagent decode <URL>                      Decode inline ?code= URL -> Mermaid source on stdout
diagent decode -                          Decode URL read from stdin
diagent --help                            Show help
diagent --version                         Show version
```

**Encode from stdin (produces a short URL):**

```bash
cat flow.mmd | diagent encode
# https://diagent.dev/d/kwtsgx5o24
```

**Encode from a file:**

```bash
diagent encode flow.mmd
```

**Force inline format (skip backend):**

```bash
diagent encode flow.mmd --inline
# https://diagent.dev/?code=GYGw9g7gxg...
```

**Encode against a local dev server:**

```bash
diagent encode flow.mmd --base-url http://localhost:5173/
```

**Decode a short URL or inline URL (both work):**

```bash
# Short URL — diagent follows the 302 internally
diagent decode "https://diagent.dev/d/kwtsgx5o24"
# flowchart TD
#     A["Hello"]
#     B["World"]
#     A --> B

# Inline URL
diagent decode "https://diagent.dev/?code=GYGw9g7gxgFghgJwC4AIAqARAUC3KCCA..."

# From stdin — avoids shell-quoting pain for long URLs
echo "$URL" | diagent decode -
```

`diagent decode` transparently handles both URL formats. For `/d/:id`
short URLs it sends a HEAD request (3s timeout), reads the `Location`
header, and extracts `?code=` from the redirect target. The CLI user
never has to know which format they have.

### Agent workflow

Once `diagent` is on your agent's `$PATH`, no per-agent configuration is
required. The agent invokes it via its shell/Bash tool:

```bash
# Agent shares a diagram it authored — short URL by default
echo 'flowchart TD
    A[Start] --> B[End]' | diagent encode
# -> https://diagent.dev/d/abcdefghij

# Agent reads a URL the user pasted — works for both short and inline
diagent decode "https://diagent.dev/d/abcdefghij"
diagent decode "https://diagent.dev/?code=..."
```

Short URLs are legible in chat, dramatically shorter than the inline
format, and unbounded in diagram complexity. The agent never sees or
handles the `lz-string` format — the backend takes care of it.

No MCP server, no SDK, no per-user `.mcp.json` — just a CLI on PATH.
For stateless operations like these, a CLI is strictly simpler than an
MCP server and works in any environment with shell access.

### Claude Code Skill (auto-discovery)

Without priming, Claude Code doesn't know about `diagent` — it's a new
tool that isn't in training data. To teach every Claude Code session
across every project about this CLI, install the bundled Skill:

```bash
npx -y @diagent/cli install-skill
```

This copies the bundled SKILL.md to `~/.claude/skills/diagent/`. The skill
uses `npx -y @diagent/cli` internally, so the CLI auto-downloads on first
use — no `npm link` or build step required.

Or, if you have the repo cloned and want auto-updating via symlink:

```bash
mkdir -p ~/.claude/skills
ln -sfn /path/to/Diagent/.claude/skills/diagent ~/.claude/skills/diagent
```

Once installed, a fresh Claude Code session in any project will
recognize phrases like "draw me a flowchart" or "diagram the login
flow" and invoke the CLI without needing to be told it exists. Test it:

```text
You: Can you draw me a flowchart of how this login handler works?

Claude: [reads the handler, runs `npx -y @diagent/cli encode` on a generated Mermaid]
        Here's the diagram: https://diagent.dev/d/...
```

If Claude still says "I don't have a diagent CLI available," verify
the skill file: `ls -la ~/.claude/skills/diagent/SKILL.md`. A full Claude
Code restart may be needed to pick up newly-installed skills.

### Environment

| Variable | Default | Description |
|---|---|---|
| `DIAGENT_BASE_URL` | `https://diagent.dev/` | Base URL for both `POST /api/s` and inline URL construction. Override with `--base-url` flag for per-invocation. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (includes fallback-to-inline path) |
| 1 | Runtime error (empty input, invalid URL, corrupt code param, too large, file not found) |
| 2 | Usage error (unknown subcommand, missing required argument) |

When encode falls back from short URL to inline URL due to backend
unavailability, it still returns exit 0 — the operation succeeded,
just in a degraded form. The stderr notice `backend unreachable,
using inline URL` is the signal.

### Format parity with the web app

The CLI and the browser's **Copy Link** button produce byte-identical
output for the same Mermaid source and base URL — both short URLs
(from the Worker) and inline fallback URLs (from `lz-string`). The CLI
uses the same compression, the same `?code=` query-param convention,
and the same `/d/:id` shape as the browser.

This means you can:
- Generate a short URL via CLI, open it in the browser — the diagram loads.
- Click **Copy Link** in the browser, `diagent decode` the inline form
  (after following the redirect) — the source comes back exactly as the
  browser serialized it.

### Local dev workflow

To test the CLI against a local Worker instead of production, run one
dev server that hosts both the SPA and the Worker:

```bash
# Terminal 1 — Vite dev server runs the Worker via @cloudflare/vite-plugin
npm run dev                              # http://localhost:5173

# Terminal 2 (or wherever you invoke diagent)
echo 'flowchart TD\n    A --> B' | diagent encode --base-url http://localhost:5173/
# -> http://localhost:5173/d/abcdefghij
```

The `@cloudflare/vite-plugin` makes Vite's dev server execute the Worker
script natively, so `/api/*` and `/d/*` requests are handled on port 5173
without a separate `wrangler dev` process or proxy. Production
`wrangler deploy` is unaffected.

### License

AGPL-3.0 — see [LICENSE](../LICENSE)
