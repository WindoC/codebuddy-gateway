import http from 'node:http';
import { query } from '@tencent-ai/agent-sdk';

// ---------------------------------------------------------------------------
// Configuration (env vars, with sensible defaults)
// ---------------------------------------------------------------------------
const HOST = process.env.CODEBUDDY_GATEWAY_HOST || '0.0.0.0';
const PORT = parseInt(process.env.CODEBUDDY_GATEWAY_PORT || '10532', 10);
const ALLOWED_TOOLS = (process.env.CODEBUDDY_GATEWAY_TOOLS || 'Read,Grep,WebSearch,Bash').split(',');
const DISALLOWED_TOOLS = (process.env.CODEBUDDY_GATEWAY_DISALLOWED_TOOLS || 'Bash(git commit),Bash(git push),Bash(rm),Bash(sudo)').split(',');
const MODEL = process.env.CODEBUDDY_GATEWAY_MODEL || undefined;
const MAX_TURNS = parseInt(process.env.CODEBUDDY_GATEWAY_MAX_TURNS || '30', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.CODEBUDDY_GATEWAY_TIMEOUT || '300000', 10);

// Build the env object to pass through to the SDK.
// The SDK will spawn a CLI subprocess; these env vars control its behaviour.
const SDK_ENV = {};

// Pass through any auth-related env vars that are explicitly set.
// Only CODEBUDDY_API_KEY is needed as an override; the CLI handles
// everything else (auth file, endpoint) automatically.
for (const key of ['CODEBUDDY_API_KEY', 'CODEBUDDY_CODE_PATH']) {
  if (process.env[key]) {
    SDK_ENV[key] = process.env[key];
  }
}

// Use the system-installed CLI (v2.x) instead of the older CLI bundled with
// the SDK.  The bundled CLI targets a different API endpoint and cannot use
// auth files created by the system-installed CLI.
if (!SDK_ENV.CODEBUDDY_CODE_PATH) {
  SDK_ENV.CODEBUDDY_CODE_PATH = '/usr/local/bin/codebuddy';
}

console.log(`[auth] SDK_ENV keys: ${Object.keys(SDK_ENV).join(', ') || '(none)'}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Convert OpenAI ChatCompletion request → plain-text prompt for CodeBuddy SDK */
function messagesToPrompt(messages) {
  return messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${text}`;
    })
    .join('\n\n');
}

/** Build a simple SSE frame */
function sseEvent(event, data) {
  if (event) return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Detect whether an error is auth-related (401, login required, etc.)
 * and return a user-friendly message.
 */
function isAuthError(err) {
  const msg = err?.message || String(err);
  return /401|authentication required|please.*login|sign in|unauthorized/i.test(msg);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// GET /v1/models — return models available to the authenticated user.
// The list is populated by running `codebuddy --list-models` (or equivalent)
// via the SDK.  Falls back to a default set if the query fails.
let cachedModels = null;

async function refreshModels() {
  try {
    const q = query({
      prompt: '',
      options: {
        maxTurns: 0,
        permissionMode: 'bypassPermissions',
        outputFormat: 'text',
        settingSources: ['user'],
        env: SDK_ENV,
      },
    });
    // We just need the init message which includes model info.
    for await (const msg of q) {
      if (msg.type === 'init') {
        const models = msg.models || [];
        if (models.length > 0) {
          return models.map((m) => ({ id: m, object: 'model', owned_by: 'codebuddy' }));
        }
      }
    }
  } catch {
    // fall through to defaults
  }
  return null;
}

async function handleModels(_req, res) {
  if (!cachedModels) {
    cachedModels = await refreshModels();
  }
  if (!cachedModels || cachedModels.length === 0) {
    // Fallback to commonly available models
    cachedModels = [
      'glm-5.2', 'glm-5.1', 'glm-5.0', 'deepseek-v4-pro',
      'deepseek-v4-flash', 'kimi-k2.7', 'minimax-m3',
    ].map((id) => ({ id, object: 'model', owned_by: 'codebuddy' }));
  }
  json(res, 200, { object: 'list', data: cachedModels });
}

// POST /v1/chat/completions
async function handleChatCompletions(req, res) {
  const body = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: { message: 'Invalid JSON body' } });
  }

  const { messages, stream, model } = parsed;
  if (!messages || !Array.isArray(messages)) {
    return json(res, 400, { error: { message: '"messages" array is required' } });
  }

  const prompt = messagesToPrompt(messages);

  // Shared query options
  const queryOptions = {
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    maxTurns: MAX_TURNS,
    permissionMode: 'bypassPermissions',
    outputFormat: 'text',
    // Load user-level settings so the SDK's spawned CLI can read the auth file
    // from ~/.local/share/CodeBuddyExtension/Data/Public/auth/
    settingSources: ['user'],
  };
  // Only pass model if explicitly specified; otherwise let CLI use its default.
  const effectiveModel = model || MODEL;
  if (effectiveModel) {
    queryOptions.model = effectiveModel;
  }
  // Pass auth env to SDK if available
  if (Object.keys(SDK_ENV).length > 0) {
    queryOptions.env = SDK_ENV;
  }

  if (stream) {
    // ---- SSE streaming ----
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let finishReason = 'stop';
    try {
      const q = query({ prompt, options: queryOptions });

      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                const chunk = {
                  id: msg.uuid,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model || 'codebuddy',
                  choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }],
                };
                res.write(sseEvent(null, chunk));
              }
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
            finishReason = 'error';
          }
        }
      }

      const finalChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'codebuddy',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      res.write(sseEvent(null, finalChunk));
    } catch (err) {
      if (isAuthError(err)) {
        res.write(sseEvent('error', {
          message: 'Authentication required. Set CODEBUDDY_API_KEY or run "codebuddy login" via SSH.',
          detail: err.message,
        }));
      } else {
        res.write(sseEvent('error', { message: err.message }));
      }
    }
    res.write(sseEvent(null, '[DONE]'));
    res.end();
  } else {
    // ---- Non-streaming ----
    try {
      const q = query({ prompt, options: queryOptions });

      const parts = [];
      let usage = { input_tokens: 0, output_tokens: 0 };
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                parts.push(block.text);
              }
            }
          }
          if (msg.message?.usage) {
            usage = msg.message.usage;
          }
        } else if (msg.type === 'result' && msg.subtype?.startsWith('error')) {
          return json(res, 500, { error: { message: msg.errors?.join('; ') || 'Execution error' } });
        }
      }

      json(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'codebuddy',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: parts.join('') },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: usage.input_tokens,
          completion_tokens: usage.output_tokens,
          total_tokens: usage.input_tokens + usage.output_tokens,
        },
      });
    } catch (err) {
      if (isAuthError(err)) {
        json(res, 401, {
          error: {
            message: 'Authentication required. Set CODEBUDDY_API_KEY or run "codebuddy login" via SSH.',
            detail: err.message,
          },
        });
      } else {
        json(res, 500, { error: { message: err.message } });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const ROUTES = {
  'GET /v1/models': handleModels,
  'POST /v1/chat/completions': handleChatCompletions,
  'GET /health': (_req, res) => json(res, 200, { status: 'ok' }),
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url}`;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const handler = ROUTES[key];
  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${key}] error:`, err);
      if (!res.headersSent) {
        json(res, 500, { error: { message: err.message } });
      }
    }
  } else {
    json(res, 404, { error: { message: `Not found: ${key}` } });
  }
});

server.timeout = REQUEST_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
  console.log(`codebuddy-gateway ready at http://${HOST}:${PORT}`);
  console.log(`  → POST /v1/chat/completions`);
  console.log(`  → GET  /v1/models`);
  console.log(`  → GET  /health`);
});
