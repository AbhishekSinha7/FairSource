import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isServable } from './rights.js';

const chunk = { servable: true, optOut: false, uses: ['rag'] as const, territories: ['IN'] as const };
const buyerIN = { country: 'IN', status: 'active' as const };

test('licensed chunk is served', () => {
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['IN'] }, buyerIN, 'rag'), true);
});

test('opted-out, unservable (withdrawn, duplicate, unsafe) chunks are never served', () => {
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['IN'], optOut: true }, buyerIN, 'rag'), false);
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['IN'], servable: false }, buyerIN, 'rag'), false);
});

test('use must be licensed', () => {
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['IN'] }, buyerIN, 'training'), false);
});

test('territory must match, GLOBAL covers everyone', () => {
  const us = { country: 'US', status: 'active' as const };
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['IN'] }, us, 'rag'), false);
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['IN', 'GLOBAL'] }, us, 'rag'), true);
});

test('suspended buyer gets nothing', () => {
  assert.equal(isServable({ ...chunk, uses: ['rag'], territories: ['GLOBAL'] }, { country: 'IN', status: 'suspended' }, 'rag'), false);
});
