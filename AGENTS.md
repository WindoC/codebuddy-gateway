# Project Notes for Codex

## Editing

- Prefer `apply_patch` for source edits.
- Keep changes scoped to the gateway, Docker packaging, and docs unless the task explicitly asks otherwise.
- Do not commit `gateway/node_modules/`; it is intentionally ignored for local development.

## Gateway

- Main server: `gateway/server.mjs`
- Unit tests: `gateway/test/server.test.mjs`
- Package manager: npm, using `gateway/package-lock.json`
- Run tests from `gateway/`:

```bash
npm test
```

- Syntax check from repo root:

```bash
node --check gateway/server.mjs
```

## CodeBuddy SDK Notes

- The gateway uses `@tencent-ai/agent-sdk`.
- In Docker, `CODEBUDDY_CODE_PATH` must point at the real npm package bin:

```text
/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy
```

- Do not point SDK startup at `/usr/local/bin/codebuddy`; the SDK resolves `dist/codebuddy-headless.js` relative to the provided path and the symlink path resolves incorrectly.
- Treat request model `codebuddy` as a gateway alias. Do not pass it through to the CodeBuddy CLI as a model id.
- REST API built-in CodeBuddy tools are disabled by default. External OpenAI-style `tools` are exposed as request-scoped SDK MCP tools and returned to clients as OpenAI-compatible `tool_calls`.

## Docker Verification

Build:

```bash
docker build -t codebuddy-gateway:custom-tool-supported .
```

Run a disposable test container using the existing authenticated volume:

```bash
docker rm -f codebuddy-gateway-custom-tool-test 2>/dev/null || true
docker run -d --name codebuddy-gateway-custom-tool-test \
  -p 11532:10532 \
  -e SSH_PASSWORD=codebuddy \
  -e CODEBUDDY_GATEWAY_TOOLS= \
  -v codebuddy-home:/home/codebuddy \
  codebuddy-gateway:custom-tool-supported
```

Verify:

```bash
curl -s http://127.0.0.1:11532/health
```

Then test `/v1/chat/completions` with `model: "codebuddy"` and a simple exact-response prompt. For custom tools, verify the first response returns `finish_reason: "tool_calls"` and an OpenAI-compatible `message.tool_calls` array, then send the external tool result back as a `role: "tool"` message.

Clean up only the disposable container, not the auth volume:

```bash
docker rm -f codebuddy-gateway-custom-tool-test
```
