# codebuddy-gateway

Node 22 based container image with:
- OpenSSH server
- CodeBuddy Code CLI (`codebuddy` / `cbc`)
- **OpenAI-compatible REST API** (powered by CodeBuddy Agent SDK)

It allows another user/container to SSH in and run CodeBuddy from stdin/stdout, **or** call it via a standard OpenAI-compatible HTTP API.

The image creates a default `codebuddy` user at build time and uses `/home/codebuddy` as a persistent volume.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   codebuddy-gateway 容器                 │
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
│          │  (凭证/会话)     │                              │
│          └────────────────┘                              │
└──────────────────────────────────────────────────────────┘
```

## Build

```bash
docker build -t codebuddy-gateway:latest .
```

GitLab CI/CD publishes image to:

```text
registry.windo.me/tools/codebuddy-gateway
```

## Run

```bash
docker run -d --name codebuddy-gateway \
  -p 2222:22 \
  -p 10532:10532 \
  -e SSH_PASSWORD=codebuddy \
  -v codebuddy-home:/home/codebuddy \
  registry.windo.me/tools/codebuddy-gateway:latest
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
| `CODEBUDDY_GATEWAY_TOOLS` | `Read,Grep,WebSearch,Bash` | Allowed tools (comma-separated) |
| `CODEBUDDY_GATEWAY_DISALLOWED_TOOLS` | `Bash(git commit),Bash(git push),Bash(rm),Bash(sudo)` | Disallowed tools |
| `CODEBUDDY_GATEWAY_MODEL` | — | Model override |
| `CODEBUDDY_GATEWAY_MAX_TURNS` | `30` | Max conversation turns |
| `CODEBUDDY_GATEWAY_TIMEOUT` | `300000` | Request timeout in ms |

These env vars are auto-loaded on SSH login via `.bashrc`, `.profile`, and `.bash_profile`.
If the home volume already has files, startup keeps existing files and only creates missing ones.

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
echo "列出项目中的主要函数" | \
  ssh -p 2222 codebuddy@127.0.0.1 'codebuddy-stdin --output-format json'
```

### Stream JSON input (multi-turn)

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"解释这段代码"}]}}' | \
  ssh -p 2222 codebuddy@127.0.0.1 \
  'codebuddy -p --input-format stream-json --output-format stream-json -y'
```

---

## Usage — REST API (OpenAI-compatible)

The gateway exposes an OpenAI-compatible HTTP API on port `10532`.

### Chat Completions (non-streaming)

```bash
curl -s http://127.0.0.1:10532/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codebuddy",
    "messages": [
      {"role": "user", "content": "用中文解释什么是 Docker"}
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

### List Models

```bash
curl -s http://127.0.0.1:10532/v1/models
```

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
  registry.windo.me/tools/codebuddy-gateway:latest
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

The gateway uses the **Agent SDK** as the bridge layer — the SDK manages the CLI process, authentication, tool execution, and message streaming internally.

### Safety

The gateway runs with restricted tools by default:
- Allowed: `Read`, `Grep`, `WebSearch`, `Bash`
- Disallowed: `Bash(git commit)`, `Bash(git push)`, `Bash(rm)`, `Bash(sudo)`

Adjust `CODEBUDDY_GATEWAY_TOOLS` / `CODEBUDDY_GATEWAY_DISALLOWED_TOOLS` to fit your security requirements.


