# ssh-codebuddy

Node 22 based container image with:
- OpenSSH server
- CodeBuddy Code CLI (`codebuddy` / `cbc`)

It allows another user/container to SSH in and run CodeBuddy from stdin/stdout.
The image creates a default `codebuddy` user at build time and uses `/home/codebuddy` as a persistent volume.

## Build

```bash
docker build -t ssh-codebuddy:latest .
```

GitLab CI/CD publishes image to:

```text
registry.windo.me/tools/ssh-codebuddy
```

## Run

```bash
docker run -d --name ssh-codebuddy \
  -p 2222:22 \
  -e SSH_PASSWORD=codebuddy \
  -v codebuddy-home:/home/codebuddy \
  registry.windo.me/tools/ssh-codebuddy:latest
```

Optional environment variables:

| Variable | Description |
|---|---|
| `CODEBUDDY_API_KEY` | CodeBuddy API key, saved to `~/.codebuddy/env.sh` |
| `CODEBUDDY_BASE_URL` | Custom API endpoint, saved to `~/.codebuddy/env.sh` |

These env vars are auto-loaded on SSH login via `.bashrc`, `.profile`, and `.bash_profile`.
If the home volume already has files, startup keeps existing files and only creates missing ones.

## SSH and use CodeBuddy

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

## Optional: SSH public key auth

Pass `SSH_PUBLIC_KEY` on container start:

```bash
docker run -d --name ssh-codebuddy \
  -p 2222:22 \
  -e SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  -v codebuddy-home:/home/codebuddy \
  registry.windo.me/tools/ssh-codebuddy:latest
```

## Docker Compose

Use [docker-compose.yml](docker-compose.yml):

```bash
docker compose up -d
```

## Kubernetes

Use [k8s-ssh-codebuddy.yaml](k8s-ssh-codebuddy.yaml):

```bash
kubectl apply -f k8s-ssh-codebuddy.yaml
```

For external SSH access, either:
- use `kubectl port-forward svc/ssh-codebuddy 2222:22`
- or change the Service type to `NodePort` / `LoadBalancer` based on your cluster setup

## Differences from ssh-gemini

| Aspect | ssh-gemini | ssh-codebuddy |
|---|---|---|
| CLI tool | `@google/gemini-cli` | `@tencent-ai/codebuddy-code` |
| User | `gemini` | `codebuddy` |
| Home | `/home/gemini` | `/home/codebuddy` |
| Env file | `.gemini/env.sh` | `.codebuddy/env.sh` |
| Stdin wrapper | `gemini-stdin` | `codebuddy-stdin` |
| Non-interactive flag | `-p` | `-p -y` (headless + skip permissions) |
| Default port | 2222 | 2222 |
