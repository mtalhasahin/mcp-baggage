import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { estimate } from '../src/tokens.ts';
import { qualify, serialize, weighTool } from '../src/weigh.ts';

describe('estimate', () => {
  test('empty text is free', () => {
    assert.equal(estimate(''), 0);
  });

  test('a short word is one token', () => {
    assert.equal(estimate('file'), 1);
    assert.equal(estimate('path'), 1);
  });

  test('a space before a word is absorbed into it', () => {
    assert.equal(estimate('open file path'), 3);
  });

  test('long identifiers cost more than short ones', () => {
    assert.ok(estimate('additionalProperties') > estimate('type'));
  });

  test('digits are grouped in threes', () => {
    assert.equal(estimate('1'), 1);
    assert.equal(estimate('123456'), 2);
  });

  test('punctuation pairs up rather than costing one each', () => {
    assert.ok(estimate('{"a":1}') < 7);
  });

  test('a newline costs a token, a lone space does not', () => {
    assert.equal(estimate('a b'), 2);
    assert.equal(estimate('a\nb'), 3);
  });

  test('a real schema lands in the right order of magnitude', () => {
    // 350-odd characters of ordinary JSON schema. A tokenizer puts this near
    // 90; anything from 70 to 120 means the heuristic is still honest.
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read' },
        limit: { type: 'number', description: 'How many lines to read' },
        offset: { type: 'number', description: 'Line number to start from' },
      },
      required: ['path'],
    });
    const n = estimate(schema);
    assert.ok(n > 60 && n < 130, `estimate was ${n}`);
  });
});

describe('serialize', () => {
  test('a tool reaches the model under its qualified name', () => {
    assert.equal(qualify('github', 'create_issue'), 'mcp__github__create_issue');
  });

  test('a name a client could not use is made safe', () => {
    assert.equal(qualify('my server.v2', 'go'), 'mcp__my_server_v2__go');
  });

  test('the serialized form uses the API field names', () => {
    const text = serialize({ name: 'go', description: 'd', inputSchema: { type: 'object' } }, 'mcp__x__go');
    assert.match(text, /"input_schema"/);
    assert.doesNotMatch(text, /"inputSchema"/);
  });

  test('a tool with no schema still costs something', () => {
    assert.ok(weighTool({ name: 'go' }, 'x', null).tokens > 0);
  });

  test('a fat description costs more than a thin one', () => {
    const thin = weighTool({ name: 'go', description: 'Go.' }, 'x', null);
    const fat = weighTool({ name: 'go', description: 'Go, but explained at length over several clauses.' }, 'x', null);
    assert.ok(fat.tokens > thin.tokens);
  });
});
