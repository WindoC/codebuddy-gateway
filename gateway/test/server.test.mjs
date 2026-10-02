import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  attachRequestAbort,
  captureToolUseBlocks,
  createToolCallCollector,
  installProcessGuards,
  isSdkTeardownFault,
  isSensitiveContentRefusal,
  jsonSchemaObjectToZodShape,
  logProcessFault,
  messagesToPrompt,
  normalizeModelEntries,
  normalizeOpenAiTools,
  parseCsv,
  readBody,
  RequestBodyTooLargeError,
  resolveEffectiveModel,
  sseDone,
  sseEvent,
  streamingToolCalls,
} from '../server.mjs';

test('SSE uses JSON for chunks and a raw OpenAI done sentinel', () => {
  assert.equal(sseEvent(null, { choices: [] }), 'data: {"choices":[]}\n\n');
  assert.equal(sseDone(), 'data: [DONE]\n\n');
  assert.notEqual(sseDone(), sseEvent(null, '[DONE]'));
});
test('parseCsv trims values and drops blanks', () => {
  assert.deepEqual(parseCsv(' Read, ,Grep, Bash(git push) '), [
    'Read',
    'Grep',
    'Bash(git push)',
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('messagesToPrompt preserves assistant tool calls and tool results', () => {
  const prompt = messagesToPrompt([
    { role: 'system', content: 'Use tools when needed.' },
    { role: 'user', content: 'What is 12 * 37?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'Calculator', arguments: '{"input":"12 * 37"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'Calculator', content: '444' },
  ]);

  assert.match(prompt, /^\[System\]: Use tools when needed\./);
  assert.match(prompt, /\[User\]: What is 12 \* 37\?/);
  assert.match(prompt, /Tool calls made by Assistant:/);
  assert.match(prompt, /"name":"Calculator"/);
  assert.match(prompt, /\[Tool Result: Calculator\]: 444/);
});

test('normalizeOpenAiTools keeps only valid function tools', () => {
  const tools = normalizeOpenAiTools([
    {
      type: 'function',
      function: {
        name: 'Calculator',
        description: 'Evaluate math',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      },
    },
    { type: 'web_search_preview' },
    { type: 'function', function: { description: 'missing name' } },
  ]);

  assert.deepEqual(tools, [
    {
      name: 'Calculator',
      description: 'Evaluate math',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
    },
  ]);
});

test('normalizeModelEntries maps CLI model entries to OpenAI model objects', () => {
  assert.deepEqual(normalizeModelEntries([
    { modelId: 'hy4-preview-f', name: 'Hy4 preview', description: 'flagship' },
    { modelId: 'glm-5.3', name: 'GLM-5.3' },
  ]), [
    { id: 'hy4-preview-f', object: 'model', owned_by: 'codebuddy', display_name: 'Hy4 preview' },
    { id: 'glm-5.3', object: 'model', owned_by: 'codebuddy', display_name: 'GLM-5.3' },
  ]);

  // Raw language models carry the id on `id` instead of `modelId`.
  assert.deepEqual(normalizeModelEntries([{ id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' }]), [
    { id: 'kimi-k2.7', object: 'model', owned_by: 'codebuddy', display_name: 'Kimi-K2.7-Code' },
  ]);

  // Legacy ModelInfo entries use `value` / `displayName`.
  assert.deepEqual(normalizeModelEntries([{ value: 'hy3', displayName: 'Hy3' }]), [
    { id: 'hy3', object: 'model', owned_by: 'codebuddy', display_name: 'Hy3' },
  ]);

  // Plain strings fall back to using the id as its own display name.
  assert.deepEqual(normalizeModelEntries([' minimax-m3 ', 'space-bunny ']), [
    { id: 'minimax-m3', object: 'model', owned_by: 'codebuddy', display_name: 'minimax-m3' },
    { id: 'space-bunny', object: 'model', owned_by: 'codebuddy', display_name: 'space-bunny' },
  ]);
});

test('normalizeModelEntries deduplicates and ignores unusable entries', () => {
  assert.deepEqual(normalizeModelEntries([
    { modelId: 'glm-5.2', name: 'GLM-5.2' },
    { modelId: 'glm-5.2', name: 'GLM-5.2 (duplicate)' },
    { modelId: '', name: 'no id' },
    { name: 'missing id entirely' },
    null,
    undefined,
    42,
  ]), [
    { id: 'glm-5.2', object: 'model', owned_by: 'codebuddy', display_name: 'GLM-5.2' },
  ]);

  assert.deepEqual(normalizeModelEntries(null), []);
  assert.deepEqual(normalizeModelEntries([]), []);
});

test('jsonSchemaObjectToZodShape converts required and optional properties', () => {
  const shape = jsonSchemaObjectToZodShape({
    type: 'object',
    properties: {
      input: { type: 'string' },
      count: { type: 'integer' },
      mode: { enum: ['fast', 'safe'] },
      tags: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
    },
    required: ['input', 'count'],
  });
  const schema = z.object(shape);

  assert.deepEqual(schema.parse({
    input: '12 * 37',
    count: 2,
    mode: 'fast',
    tags: ['math'],
    enabled: true,
  }), {
    input: '12 * 37',
    count: 2,
    mode: 'fast',
    tags: ['math'],
    enabled: true,
  });
  assert.equal(schema.safeParse({ count: 2 }).success, false);
  assert.equal(schema.safeParse({ input: 'x', count: 2 }).success, true);
  assert.equal(schema.safeParse({ input: 'x', count: 1.5 }).success, false);
  assert.equal(schema.safeParse({ input: 'x', count: 2, mode: 'slow' }).success, false);
});

test('tool call collector deduplicates and serializes OpenAI function calls', () => {
  const collector = createToolCallCollector();

  collector.add('openai_client_tools__Calculator', { input: '12 * 37' }, 'toolu_1');
  collector.add('openai_client_tools__Calculator', { input: '12 * 37' }, 'toolu_1');

  assert.equal(collector.hasCalls(), true);
  assert.deepEqual(collector.list(), [
    {
      id: 'toolu_1',
      type: 'function',
      function: {
        name: 'Calculator',
        arguments: '{"input":"12 * 37"}',
      },
    },
  ]);
});

test('captureToolUseBlocks captures only external tool use blocks', () => {
  const collector = createToolCallCollector();
  const externalToolNames = new Set(['Calculator']);

  captureToolUseBlocks({
    message: {
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 'toolu_1', name: 'Calculator', input: { input: '12 * 37' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'README.md' } },
      ],
    },
  }, collector, externalToolNames);

  assert.deepEqual(collector.list(), [
    {
      id: 'toolu_1',
      type: 'function',
      function: {
        name: 'Calculator',
        arguments: '{"input":"12 * 37"}',
      },
    },
  ]);
});

test('streamingToolCalls adds OpenAI streaming indexes', () => {
  assert.deepEqual(streamingToolCalls([
    { id: 'call_1', type: 'function', function: { name: 'Calculator', arguments: '{}' } },
  ]), [
    { index: 0, id: 'call_1', type: 'function', function: { name: 'Calculator', arguments: '{}' } },
  ]);
});

test('resolveEffectiveModel treats codebuddy as gateway default alias', () => {
  assert.equal(resolveEffectiveModel('codebuddy', undefined), undefined);
  assert.equal(resolveEffectiveModel('codebuddy', 'glm-5.2'), 'glm-5.2');
  assert.equal(resolveEffectiveModel('minimax-m3', 'glm-5.2'), 'minimax-m3');
  assert.equal(resolveEffectiveModel(undefined, 'glm-5.2'), 'glm-5.2');
});

test('isSensitiveContentRefusal detects CodeBuddy policy refusal text', () => {
  assert.equal(isSensitiveContentRefusal(
    '抱歉，系统检测到您当前输入的信息存在敏感内容，我无法响应您的请求，请检查后重新输入。This topic is currently outside the scope of my capabilities, so I\'m unable to discuss it further.',
  ), true);
  assert.equal(isSensitiveContentRefusal('This is a normal assistant response.'), false);
  assert.equal(isSensitiveContentRefusal('系统检测到您当前输入的信息存在敏感内容'), false);
});

test('readBody rejects oversized request bodies', async () => {
  const req = new PassThrough();
  const bodyPromise = readBody(req, 4);

  req.write(Buffer.from('123'));
  req.write(Buffer.from('45'));

  await assert.rejects(bodyPromise, RequestBodyTooLargeError);
  assert.equal(req.destroyed, true);
});

test('isSdkTeardownFault recognises transport teardown noise', () => {
  assert.equal(isSdkTeardownFault(new Error('Transport not started')), true);
  assert.equal(isSdkTeardownFault(new Error('SDK MCP server not found: openai_client_tools')), true);
  assert.equal(isSdkTeardownFault({ message: 'transport closed' }), true);
  // Genuine application errors must still be treated as faults.
  assert.equal(isSdkTeardownFault(new Error('Cannot read properties of undefined')), false);
  assert.equal(isSdkTeardownFault(undefined), false);
});

test('logProcessFault never throws, whatever it is handed', () => {
  // This is the whole point: a guard that itself crashes is useless.
  const originals = { warn: console.warn, error: console.error };
  const lines = [];
  console.warn = (...args) => lines.push(['warn', ...args]);
  console.error = (...args) => lines.push(['error', ...args]);

  try {
    assert.doesNotThrow(() => logProcessFault('unhandledRejection', new Error('Transport not started')));
    assert.doesNotThrow(() => logProcessFault('uncaughtException', new Error('boom')));
    assert.doesNotThrow(() => logProcessFault('unhandledRejection', undefined));
    assert.doesNotThrow(() => logProcessFault('unhandledRejection', 'plain string'));
  } finally {
    console.warn = originals.warn;
    console.error = originals.error;
  }

  // Known teardown noise is downgraded to a warning; everything else is an error.
  const levels = lines.map(([level]) => level);
  assert.equal(levels[0], 'warn');
  assert.equal(levels[1], 'error');
});

test('attachRequestAbort aborts on client disconnect and detaches listeners', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;
  const abortController = new AbortController();

  const detach = attachRequestAbort(req, res, abortController, 0);

  res.emit('close');
  assert.equal(abortController.signal.aborted, true);
  assert.match(abortController.signal.reason.message, /response closed/);

  detach();
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});
