# codebuddy-gateway

Node 22 based container image with:
- OpenSSH server
- CodeBuddy Code CLI (`codebuddy` / `cbc`)
- **OpenAI-compatible REST API** (powered by CodeBuddy Agent SDK)

It allows another user/container to SSH in and run CodeBuddy from stdin/stdout, **or** call it via a standard OpenAI-compatible HTTP API.

The image creates a default `codebuddy` user at build time and uses `/home/codebuddy` as a persistent volume.

## Why this exists

This project is a small gateway for using [CodeBuddy Code](https://www.codebuddy.cn/docs/cli/overview) from agent systems, workflow automation, and tools such as n8n. The idea is similar in spirit to [EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth): expose a local/contained coding assistant through an API shape that existing OpenAI-compatible clients already understand.

CodeBuddy Code is Tencent Cloud's AI coding assistant. Its CLI is terminal-native, supports interactive use, direct prompts, stdin/stdout workflows, built-in development tools, and MCP-based extension. The [CodeBuddy Agent SDK](https://www.codebuddy.cn/docs/cli/sdk) provides programmatic control from TypeScript/JavaScript and Python, with support for streaming messages, sessions, permission control, hooks, custom agents, and MCP integration. This gateway uses the TypeScript SDK package (`@tencent-ai/agent-sdk`) to bridge OpenAI-style chat requests into CodeBuddy SDK calls.

The main goal is convenience: keep CodeBuddy authentication and runtime state inside a persistent container volume, then let external agents call a familiar `/v1/chat/completions` endpoint or connect over SSH.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   codebuddy-gateway container            │
│                                                          │
│  ┌─────────────┐    ┌──────────────────────────────────┐ │
│  │  SSH Daemon  │    │  codebuddy-gateway (REST API)   │ │
│  │  (port 22)   │    │       (port 10532)              │ │
│  │              │    │                                  │ │
│  │  codebuddy   │    │  POST /v1/chat/completions      │ │
│  │  codebuddy-  │    │  GET  /v1/models                │ │
│  │  stdin       │    │  GET  /health                   │ │
│  └──────┬───────┘    └────────────┬─────────────────────┘ │
│         │                         │                       │
│         └────────┬────────────────┘                       │
│                  │                                        │
│          ┌───────▼────────┐                              │
│          │  CodeBuddy      │                              │
│          │  Agent SDK      │                              │
│          │  (@tencent-ai/  │                              │
│          │   agent-sdk)    │                              │
│          └────────────────┘                              │
│                  │                                        │
│          ┌───────▼────────┐                              │
│          │  .codebuddy/    │                              │
│          │  (credentials/    │                              │
│          │   sessions)       │                              │
│          └────────────────┘                              │
└──────────────────────────────────────────────────────────┘
```

## Build

```bash
docker build -t codebuddy-gateway:latest .
```

GitHub Actions publishes tagged images to:

```text
ghcr.io/windoc/codebuddy-gateway
```

## Run

```bash
docker run -d --name codebuddy-gateway \
  -p 2222:22 \
  -p 10532:10532 \
  -e SSH_PASSWORD=codebuddy \
  -v codebuddy-home:/home/codebuddy \
  ghcr.io/windoc/codebuddy-gateway:latest
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SSH_PASSWORD` | `codebuddy` | SSH password for the `codebuddy` user |
| `SSH_PUBLIC_KEY` | — | SSH public key for key-based auth |
| `CODEBUDDY_API_KEY` | — | CodeBuddy API key, saved to `~/.codebuddy/env.sh` |
| `CODEBUDDY_GATEWAY_ENABLED` | `true` | Enable the OpenAI-compatible REST API |
| `CODEBUDDY_GATEWAY_HOST` | `0.0.0.0` | Gateway listen address |
| `CODEBUDDY_GATEWAY_PORT` | `10532` | Gateway listen port |
| `CODEBUDDY_GATEWAY_TOOLS` | — | Built-in CodeBuddy tools to expose (comma-separated). Empty by default so API callers can use their own OpenAI-style tools |
| `CODEBUDDY_GATEWAY_DISALLOWED_TOOLS` | `Bash(git commit),Bash(git push),Bash(rm),Bash(sudo)` | Disallowed tools |
| `CODEBUDDY_GATEWAY_MODEL` | — | Model override |
| `CODEBUDDY_GATEWAY_MAX_TURNS` | `30` | Max conversation turns |
| `CODEBUDDY_GATEWAY_TIMEOUT` | `300000` | Request timeout in ms |
| `CODEBUDDY_GATEWAY_MODELS_TIMEOUT` | `5000` | `/v1/models` SDK discovery timeout in ms before returning fallback models |
| `CODEBUDDY_GATEWAY_MAX_BODY_BYTES` | `10485760` | Maximum JSON request body size in bytes |

These env vars are auto-loaded on SSH login via `.bashrc`, `.profile`, and `.bash_profile`.
If the home volume already has files, startup keeps existing files and only creates missing ones.

---

## Authenticate CodeBuddy inside Docker

The REST API uses the CodeBuddy CLI through the Agent SDK, so the container must be authenticated before `/v1/chat/completions` can work. Keep `/home/codebuddy` on a Docker volume so the CodeBuddy credentials and sessions survive container restarts.

After starting the container, run the CodeBuddy login flow inside it:

```bash
docker exec -it --user codebuddy codebuddy-gateway codebuddy login
```

Follow the login instructions printed by the CLI. After login, verify that the CLI works from the same container user:

```bash
docker exec -it --user codebuddy codebuddy-gateway \
  codebuddy -p "Reply with OK if authentication works." -y
```

If you use Docker Compose, the service name can be used instead of the container name:

```bash
docker compose exec --user codebuddy codebuddy-gateway codebuddy login
```

You can also pass `CODEBUDDY_API_KEY` when starting the container, but interactive `codebuddy login` is usually easier for local use. Without a valid CodeBuddy login or API key, the REST API will return an authentication error.

---

## Usage — SSH (CLI)

### Interactive CLI

```bash
ssh -p 2222 codebuddy@127.0.0.1
codebuddy
```

First login may require authentication. Credentials/sessions are stored under `/home/codebuddy/.codebuddy`.

### Non-interactive prompt

```bash
ssh -p 2222 codebuddy@127.0.0.1 'codebuddy -p "Explain TCP in one sentence." -y'
```

### Pipe stdin directly (recommended for automation)

```bash
echo "Summarize SSH port forwarding in 3 bullets." | \
  ssh -p 2222 codebuddy@127.0.0.1 'codebuddy-stdin'
```

The `codebuddy-stdin` wrapper script:
- If stdin is a TTY → runs `codebuddy` interactively
- If stdin is a pipe → reads it as the prompt and runs `codebuddy -p "<prompt>" -y`

### JSON output (for scripting)

```bash
echo "List the main functions in this project" | \
  ssh -p 2222 codebuddy@127.0.0.1 'codebuddy-stdin --output-format json'
```

### Stream JSON input (multi-turn)

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Explain this code"}]}}' | \
  ssh -p 2222 codebuddy@127.0.0.1 \
  'codebuddy -p --input-format stream-json --output-format stream-json -y'
```

---

## Usage — REST API (OpenAI-compatible)

The gateway exposes an OpenAI-compatible HTTP API on port `10532`. CodeBuddy must be authenticated inside the container first; see [Authenticate CodeBuddy inside Docker](#authenticate-codebuddy-inside-docker).

### Chat Completions (non-streaming)

```bash
curl -s http://127.0.0.1:10532/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codebuddy",
    "messages": [
      {"role": "user", "content": "Explain what Docker is in one paragraph"}
    ]
  }'
```

### Chat Completions (streaming)

```bash
curl -s http://127.0.0.1:10532/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codebuddy",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Write a Python function to reverse a linked list"}
    ]
  }'
```

### Custom tools / function calling

The REST API accepts OpenAI-style `tools` and exposes them to CodeBuddy as request-scoped SDK MCP tools. When the model chooses a tool, the gateway returns an OpenAI-compatible `tool_calls` response. The external client is responsible for executing the tool and sending the result back as a `role: "tool"` message.

```bash
curl -s http://127.0.0.1:10532/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codebuddy",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "Calculator",
          "description": "Evaluate a math expression",
          "parameters": {
            "type": "object",
            "properties": {
              "input": { "type": "string", "description": "Math expression to evaluate" }
            },
            "required": ["input"],
            "additionalProperties": false
          }
        }
      }
    ],
    "messages": [
      { "role": "user", "content": "What is 12 * 37?" }
    ]
  }'
```

Example tool-call response:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_...",
            "type": "function",
            "function": {
              "name": "Calculator",
              "arguments": "{\"input\":\"12 * 37\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

Then call the API again with the original assistant `tool_calls` message and the external tool result:

```json
{
  "role": "tool",
  "tool_call_id": "call_...",
  "name": "Calculator",
  "content": "444"
}
```

### List Models

```bash
curl -s http://127.0.0.1:10532/v1/models
```

The endpoint first asks the SDK for model metadata. If discovery does not respond within `CODEBUDDY_GATEWAY_MODELS_TIMEOUT`, it returns the gateway fallback model list instead of leaving the HTTP request hanging.

### Health Check

```bash
curl -s http://127.0.0.1:10532/health
```

### Using with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:10532/v1",
    api_key="not-needed"  # authentication is handled at the container level
)

response = client.chat.completions.create(
    model="codebuddy",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### LiteLLM compatibility

Configure LiteLLM's OpenAI-compatible upstream `api_base` to end in `/v1`.
For streaming requests, the gateway emits JSON chat-completion chunks followed
by the unquoted OpenAI SSE terminator `data: [DONE]`.

### Using with Vercel AI SDK

```typescript
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const codebuddy = createOpenAI({
  baseURL: "http://127.0.0.1:10532/v1",
  apiKey: "not-needed",
});

const { text } = await generateText({
  model: codebuddy("codebuddy"),
  prompt: "Explain monads in simple terms",
});
```

---

## Optional: SSH public key auth

Pass `SSH_PUBLIC_KEY` on container start:

```bash
docker run -d --name codebuddy-gateway \
  -p 2222:22 \
  -p 10532:10532 \
  -e SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  -v codebuddy-home:/home/codebuddy \
  ghcr.io/windoc/codebuddy-gateway:latest
```

## Docker Compose

Use [docker-compose.yml](docker-compose.yml):

```bash
docker compose up -d
```

## Kubernetes

Use [k8s-codebuddy-gateway.yaml](k8s-codebuddy-gateway.yaml):

```bash
kubectl apply -f k8s-codebuddy-gateway.yaml
```

For external access:
- **SSH**: `kubectl port-forward svc/codebuddy-gateway 2222:22`
- **API**: `kubectl port-forward svc/codebuddy-gateway 10532:10532`
- Or change the Service type to `NodePort` / `LoadBalancer`

---

## Gateway Design

The `codebuddy-gateway` (at `/opt/codebuddy-gateway/server.mjs`) is a lightweight Node.js HTTP server that:

1. Receives OpenAI-format `/v1/chat/completions` requests
2. Converts them to prompts for the **CodeBuddy Agent SDK** (`@tencent-ai/agent-sdk`)
3. Streams or collects the response back in OpenAI format
4. Supports both streaming and non-streaming modes
5. Converts request-scoped OpenAI `tools` into SDK MCP tools and returns `tool_calls` for the client to execute

The gateway uses the **Agent SDK** as the bridge layer. The SDK manages the CLI process, authentication, built-in tool plumbing, request-scoped MCP tools, and message streaming. OpenAI-style custom tools passed to the REST API are external client tools: the gateway exposes their schemas to the model and returns `tool_calls`, but it does not execute those tools.

### Safety

The gateway disables built-in CodeBuddy tools by default for REST API calls. API callers can still pass OpenAI-style `tools`; those tools are treated as external client tools and are not executed by the gateway.

Set `CODEBUDDY_GATEWAY_TOOLS` only if you intentionally want to expose built-in CodeBuddy tools such as `Read`, `Grep`, `WebSearch`, or `Bash`. `CODEBUDDY_GATEWAY_DISALLOWED_TOOLS` remains available as an extra deny list.
