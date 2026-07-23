import http from 'node:http';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createSdkMcpServer, query, tool } from '@tencent-ai/agent-sdk';
import { z } from 'zod';

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------------------------------------------------------------------------
// Configuration (env vars, with sensible defaults)
// ---------------------------------------------------------------------------
const HOST = process.env.CODEBUDDY_GATEWAY_HOST || '0.0.0.0';
const PORT = parseInt(process.env.CODEBUDDY_GATEWAY_PORT || '10532', 10);
const BUILTIN_TOOLS = parseCsv(process.env.CODEBUDDY_GATEWAY_TOOLS || '');
const DISALLOWED_TOOLS = parseCsv(process.env.CODEBUDDY_GATEWAY_DISALLOWED_TOOLS || 'Bash(git commit),Bash(git push),Bash(rm),Bash(sudo)');
const MODEL = process.env.CODEBUDDY_GATEWAY_MODEL || undefined;
const MAX_TURNS = parseInt(process.env.CODEBUDDY_GATEWAY_MAX_TURNS || '30', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.CODEBUDDY_GATEWAY_TIMEOUT || '300000', 10);
const MODELS_REFRESH_TIMEOUT_MS = parseInt(process.env.CODEBUDDY_GATEWAY_MODELS_TIMEOUT || '5000', 10);
const MAX_REQUEST_BODY_BYTES = parseInt(process.env.CODEBUDDY_GATEWAY_MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
const EXTERNAL_TOOL_SERVER_NAME = 'openai_client_tools';

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
  const globalCodebuddyBin = '/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy';
  SDK_ENV.CODEBUDDY_CODE_PATH = existsSync(globalCodebuddyBin) ? globalCodebuddyBin : '/usr/local/bin/codebuddy';
}

if (IS_MAIN) {
  console.log(`[auth] SDK_ENV keys: ${Object.keys(SDK_ENV).join(', ') || '(none)'}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function errorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) return error.message;

  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : fallback;
  } catch {
    return String(error) || fallback;
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'RequestBodyTooLargeError';
    this.statusCode = 413;
  }
}

function abortWith(controller, reason) {
  if (!controller.signal.aborted) {
    controller.abort(reason);
  }
}

export function attachRequestAbort(req, res, abortController, timeoutMs = REQUEST_TIMEOUT_MS) {
  const onAborted = () => abortWith(abortController, new Error('HTTP request aborted by client'));
  const onResponseClosed = () => {
    if (!res.writableEnded) {
      abortWith(abortController, new Error('HTTP response closed before completion'));
    }
  };
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => abortWith(abortController, new Error('Gateway request timed out')), timeoutMs)
    : null;

  req.once('aborted', onAborted);
  res.once('close', onResponseClosed);

  return () => {
    req.off('aborted', onAborted);
    res.off('close', onResponseClosed);
    if (timeout) clearTimeout(timeout);
  };
}

export function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (c) => {
      received += c.length;
      if (received > maxBytes) {
        reject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Convert OpenAI ChatCompletion request → plain-text prompt for CodeBuddy SDK */
export function messagesToPrompt(messages) {
  return messages
    .map((m) => {
      if (m.role === 'tool') {
        const toolName = m.name || m.tool_call_id || 'unknown';
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `[Tool Result: ${toolName}]: ${text}`;
      }

      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      const content = m.content == null ? '' : m.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      const toolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
        ? `\nTool calls made by Assistant: ${JSON.stringify(m.tool_calls)}`
        : '';
      return `[${role}]: ${text}${toolCalls}`;
    })
    .join('\n\n');
}

/** Build a simple SSE frame */
export function sseEvent(event, data) {
  if (event) return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function sseDone() {
  return 'data: [DONE]\n\n';
}

const SENSITIVE_CONTENT_REFUSAL_PATTERNS = [
  /系统检测到您当前输入的信息存在敏感内容/,
  /This topic is currently outside the scope of my capabilities/i,
];

export function isSensitiveContentRefusal(text) {
  if (typeof text !== 'string') return false;
  return SENSITIVE_CONTENT_REFUSAL_PATTERNS.every((pattern) => pattern.test(text));
}

function sensitiveContentRefusalError(detail) {
  return {
    error: {
      message: 'CodeBuddy refused the request because the input was classified as sensitive content.',
      type: 'invalid_request_error',
      code: 'sensitive_content_refusal',
      detail,
    },
  };
}

/**
 * Detect whether an error is auth-related (401, login required, etc.)
 * and return a user-friendly message.
 */
function isAuthError(err) {
  const msg = err?.message || String(err);
  return /401|authentication required|please.*login|sign in|unauthorized/i.test(msg);
}

function isAbortError(err) {
  return err?.name === 'AbortError' || /aborted|abort/i.test(err?.message || String(err));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOpenAiTools(tools) {
  if (!Array.isArray(tools)) return [];

  return tools
    .filter((item) => item?.type === 'function' && isObject(item.function) && item.function.name)
    .map((item) => ({
      name: String(item.function.name),
      description: String(item.function.description || ''),
      parameters: isObject(item.function.parameters) ? item.function.parameters : { type: 'object', properties: {} },
    }));
}

export function jsonSchemaToZod(schema, required = false) {
  if (!isObject(schema)) {
    return required ? z.any() : z.any().optional();
  }

  let result;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    result = z.enum(schema.enum.map((value) => String(value)));
  } else {
    const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type;
    switch (type) {
      case 'string':
        result = z.string();
        break;
      case 'integer':
        result = z.number().int();
        break;
      case 'number':
        result = z.number();
        break;
      case 'boolean':
        result = z.boolean();
        break;
      case 'array':
        result = z.array(jsonSchemaToZod(schema.items || {}, true));
        break;
      case 'object': {
        const shape = jsonSchemaObjectToZodShape(schema);
        result = z.object(shape);
        break;
      }
      default:
        result = z.any();
        break;
    }
  }

  if (schema.description && typeof result.describe === 'function') {
    result = result.describe(String(schema.description));
  }
  return required ? result : result.optional();
}

export function jsonSchemaObjectToZodShape(schema) {
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);

  return Object.fromEntries(
    Object.entries(properties).map(([name, propertySchema]) => [
      name,
      jsonSchemaToZod(propertySchema, required.has(name)),
    ]),
  );
}

function buildExternalToolServer(openAiTools, collector) {
  if (openAiTools.length === 0) return null;

  const sdkTools = openAiTools.map((definition) => tool(
    definition.name,
    definition.description || `External client tool: ${definition.name}`,
    jsonSchemaObjectToZodShape(definition.parameters),
    async (args) => {
      collector.add(definition.name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: 'The API gateway captured this external tool call. The client must execute the tool and return its result as a role=tool message.',
          },
        ],
      };
    },
  ));

  return createSdkMcpServer({
    name: EXTERNAL_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: sdkTools,
  });
}

export function createToolCallCollector() {
  const calls = [];
  const seen = new Set();

  return {
    add(name, args, id) {
      const safeName = String(name || '');
      const key = `${id || ''}:${safeName}:${JSON.stringify(args || {})}`;
      if (seen.has(key)) return;
      seen.add(key);
      calls.push({
        id: id || `call_${Date.now()}_${calls.length}`,
        type: 'function',
        function: {
          name: safeName.includes('__') ? safeName.split('__').at(-1) : safeName,
          arguments: JSON.stringify(args || {}),
        },
      });
    },
    list() {
      return calls;
    },
    hasCalls() {
      return calls.length > 0;
    },
  };
}

export function captureToolUseBlocks(msg, collector, externalToolNames) {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    const rawName = String(block.name || '');
    const toolName = rawName.includes('__') ? rawName.split('__').at(-1) : rawName;
    if (externalToolNames.has(rawName) || externalToolNames.has(toolName)) {
      collector.add(toolName, block.input || {}, block.id);
    }
  }
}

export function streamingToolCalls(calls) {
  return calls.map((call, index) => ({ index, ...call }));
}

export function resolveEffectiveModel(requestModel, configuredModel) {
  return requestModel && requestModel !== 'codebuddy' ? requestModel : configuredModel;
}

function streamToolCallChunk(res, id, model, collector) {
  if (res.destroyed || res.writableEnded) return;
  const toolChunk = {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { tool_calls: streamingToolCalls(collector.list()) }, finish_reason: null }],
  };
  res.write(sseEvent(null, toolChunk));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// GET /v1/models — return models available to the authenticated user.
// The list is populated by running `codebuddy --list-models` (or equivalent)
// via the SDK.  Falls back to a default set if the query fails.
let cachedModels = null;

async function refreshModels() {
  const abortController = new AbortController();
  let timeout = null;

  const discoverModels = async () => {
    try {
      const q = query({
        prompt: '',
        options: {
          abortController,
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
  };

  const discovery = discoverModels();
  const timeoutMs = Number.isFinite(MODELS_REFRESH_TIMEOUT_MS) ? MODELS_REFRESH_TIMEOUT_MS : 0;
  if (timeoutMs <= 0) return discovery;

  const fallbackOnTimeout = new Promise((resolve) => {
    timeout = setTimeout(() => {
      abortWith(abortController, new Error('Model discovery timed out'));
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([discovery, fallbackOnTimeout]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return json(res, 413, { error: { message: errorMessage(err) } });
    }
    throw err;
  }
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

  const externalTools = normalizeOpenAiTools(parsed.tools);
  const externalToolNames = new Set(externalTools.map((item) => item.name));
  const toolCallCollector = createToolCallCollector();
  const externalToolServer = buildExternalToolServer(externalTools, toolCallCollector);
  const abortController = new AbortController();
  const detachRequestAbort = attachRequestAbort(req, res, abortController);
  const prompt = messagesToPrompt(messages);

  // Shared query options
  const queryOptions = {
    abortController,
    tools: BUILTIN_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    maxTurns: MAX_TURNS,
    permissionMode: 'bypassPermissions',
    outputFormat: 'text',
    includePartialMessages: externalTools.length > 0,
    stderr: (data) => {
      console.error(`[codebuddy stderr] ${data}`);
    },
    // Load user-level settings so the SDK's spawned CLI can read the auth file
    // from ~/.local/share/CodeBuddyExtension/Data/Public/auth/
    settingSources: ['user'],
  };
  if (SDK_ENV.CODEBUDDY_CODE_PATH) {
    queryOptions.pathToCodebuddyCode = SDK_ENV.CODEBUDDY_CODE_PATH;
  }
  if (externalToolServer) {
    queryOptions.mcpServers = {
      [EXTERNAL_TOOL_SERVER_NAME]: externalToolServer,
    };
  }
  // Only pass model if explicitly specified; otherwise let CLI use its default.
  const effectiveModel = resolveEffectiveModel(model, MODEL);
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
    let toolChunkSent = false;
    try {
      const q = query({ prompt, options: queryOptions });

      for await (const msg of q) {
        if (msg.type === 'assistant') {
          captureToolUseBlocks(msg, toolCallCollector, externalToolNames);
          if (toolCallCollector.hasCalls()) {
            abortController.abort();
            streamToolCallChunk(res, msg.uuid, model || 'codebuddy', toolCallCollector);
            toolChunkSent = true;
            finishReason = 'tool_calls';
            break;
          }
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
                if (!res.destroyed && !res.writableEnded) {
                  res.write(sseEvent(null, chunk));
                }
              }
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
            finishReason = 'error';
          }
        }

        if (toolCallCollector.hasCalls()) {
          abortController.abort();
          if (!toolChunkSent) {
            streamToolCallChunk(res, msg.uuid, model || 'codebuddy', toolCallCollector);
            toolChunkSent = true;
          }
          finishReason = 'tool_calls';
          break;
        }
      }

      const finalChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'codebuddy',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      if (!res.destroyed && !res.writableEnded) {
        res.write(sseEvent(null, finalChunk));
      }
    } catch (err) {
      if (toolCallCollector.hasCalls() && isAbortError(err)) {
        finishReason = 'tool_calls';
        if (!toolChunkSent) {
          streamToolCallChunk(res, undefined, model || 'codebuddy', toolCallCollector);
          toolChunkSent = true;
        }
        const finalChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || 'codebuddy',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        };
        if (!res.destroyed && !res.writableEnded) {
          res.write(sseEvent(null, finalChunk));
        }
      } else if (isAuthError(err)) {
        if (!res.destroyed && !res.writableEnded) {
          res.write(sseEvent('error', {
            message: 'Authentication required. Set CODEBUDDY_API_KEY or run "codebuddy login" via SSH.',
            detail: errorMessage(err),
          }));
        }
      } else {
        if (!isAbortError(err) && !res.destroyed && !res.writableEnded) {
          res.write(sseEvent('error', { message: errorMessage(err) }));
        }
      }
    } finally {
      detachRequestAbort();
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write(sseDone());
      res.end();
    }
  } else {
    // ---- Non-streaming ----
    try {
      const q = query({ prompt, options: queryOptions });

      const parts = [];
      let usage = { input_tokens: 0, output_tokens: 0 };
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          captureToolUseBlocks(msg, toolCallCollector, externalToolNames);
          if (toolCallCollector.hasCalls()) {
            abortController.abort();
            break;
          }
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

        if (toolCallCollector.hasCalls()) {
          abortController.abort();
          break;
        }
      }

      if (toolCallCollector.hasCalls()) {
        return json(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model || 'codebuddy',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCallCollector.list(),
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
          },
        });
      }

      const responseText = parts.join('');
      if (isSensitiveContentRefusal(responseText)) {
        return json(res, 400, sensitiveContentRefusalError(responseText));
      }

      json(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'codebuddy',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: responseText },
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
      if (toolCallCollector.hasCalls() && isAbortError(err)) {
        return json(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model || 'codebuddy',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCallCollector.list(),
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
      }
      if (isAuthError(err)) {
        json(res, 401, {
          error: {
            message: 'Authentication required. Set CODEBUDDY_API_KEY or run "codebuddy login" via SSH.',
            detail: errorMessage(err),
          },
        });
      } else {
        json(res, 500, { error: { message: errorMessage(err) } });
      }
    } finally {
      detachRequestAbort();
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
export const server = http.createServer(async (req, res) => {
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
        json(res, 500, { error: { message: errorMessage(err) } });
      }
    }
  } else {
    json(res, 404, { error: { message: `Not found: ${key}` } });
  }
});

server.timeout = REQUEST_TIMEOUT_MS;

if (IS_MAIN) {
  server.listen(PORT, HOST, () => {
    console.log(`codebuddy-gateway ready at http://${HOST}:${PORT}`);
    console.log(`  → POST /v1/chat/completions`);
    console.log(`  → GET  /v1/models`);
    console.log(`  → GET  /health`);
  });
}
