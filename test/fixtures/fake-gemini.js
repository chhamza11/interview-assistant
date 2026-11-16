#!/usr/bin/env node
'use strict';
/*
 * Stands in for the Gemini CLI in tests. Reads the prompt from stdin and
 * streams JSONL events matching `gemini --output-format stream-json`.
 */
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  emit({ type: 'init', session_id: 'test-gemini', model: 'gemini-2.5-flash' });
  if (input.includes('FAIL_LOGIN')) {
    emit({ type: 'error', severity: 'error', message: 'Manual authorization is required' });
    process.exit(1);
  }
  const reply = `gemini heard ${input.length} characters`;
  emit({ type: 'message', role: 'assistant', content: reply.slice(0, 12), delta: true });
  emit({ type: 'message', role: 'assistant', content: reply.slice(12), delta: true });
  emit({ type: 'result', status: 'success' });
});
