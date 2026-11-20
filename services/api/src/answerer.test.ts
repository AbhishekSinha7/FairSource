import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoogleGenAI } from '@google/genai';
import { loadConfig } from './config.js';
import { GeminiAnswerer } from './gcp.js';

const cfg = loadConfig({});
const sources = [{ n: 1, title: 'T', publisher: 'P', text: 'x' }] as never;

/** A stand-in client: each reply is either answer text or an error to throw. */
function fakeAi(replies: Array<string | Error>) {
  const models: string[] = [];
  const ai = {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        models.push(model);
        const r = replies.shift();
        if (r instanceof Error) throw r;
        return { text: r };
      },
    },
  } as unknown as GoogleGenAI;
  return { ai, models };
}

const apiError = (status: number, message = 'x') => Object.assign(new Error(message), { status });

test('answers with the main model when it is available', async () => {
  const { ai, models } = fakeAi(['answer']);
  assert.equal(await new GeminiAnswerer(ai, cfg).answer('q', sources, 'en'), 'answer');
  assert.deepEqual(models, [cfg.answerModel]);
});

test('an overloaded main model falls back to the lighter one', async () => {
  for (const err of [apiError(503), apiError(429), apiError(0, 'The model is overloaded. Try again later.')]) {
    const { ai, models } = fakeAi([err, 'fallback answer']);
    assert.equal(await new GeminiAnswerer(ai, cfg).answer('q', sources, 'en'), 'fallback answer');
    assert.deepEqual(models, [cfg.answerModel, cfg.answerFallbackModel]);
  }
});

test('other errors are not hidden by the fallback', async () => {
  const { ai, models } = fakeAi([apiError(400), 'never used']);
  await assert.rejects(new GeminiAnswerer(ai, cfg).answer('q', sources, 'en'));
  assert.deepEqual(models, [cfg.answerModel]);
});

test('defaults are current models', () => {
  assert.doesNotMatch(cfg.answerModel, /2\.5/);
  assert.notEqual(cfg.answerFallbackModel, cfg.answerModel);
});
