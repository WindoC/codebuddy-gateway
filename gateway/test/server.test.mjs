import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  attachRequestAbort,
  captureToolUseBlocks,
  createToolCallCollector,
  jsonSchemaObjectToZodShape,
  messagesToPrompt,
  normalizeOpenAiTools,
  parseCsv,
  readBody,
  RequestBodyTooLargeError,
  resolveEffectiveModel,
  streamingToolCalls,
} from '../server.mjs';

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


test('readBody rejects oversized request bodies', async () => {
  const req = new PassThrough();
  const bodyPromise = readBody(req, 4);

  req.write(Buffer.from('123'));
  req.write(Buffer.from('45'));

  await assert.rejects(bodyPromise, RequestBodyTooLargeError);
  assert.equal(req.destroyed, true);
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
