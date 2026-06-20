import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import LZString from 'lz-string';
import {
  buildShareableUrl,
  extractMermaidFromUrl,
  resolveMermaidFromUrl,
} from './core.js';

test('round-trip preserves Mermaid source', () => {
  const src = 'flowchart TD\n    A["Start"] --> B["End"]';
  const result = buildShareableUrl(src, 'https://diagent.dev/');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const decoded = extractMermaidFromUrl(result.url);
  assert.equal(decoded, src);
});

test('round-trips non-flowchart diagram types (type-agnostic)', () => {
  // The CLI stores raw Mermaid text, so every diagram type — including the
  // newly GUI-editable Class A/B types — must round-trip byte-for-byte.
  const samples = [
    'sequenceDiagram\n    A->>B: Hello\n    B-->>A: Hi',
    'pie title Pets\n    "Dogs" : 3\n    "Cats" : 2',
    'erDiagram\n    CUSTOMER ||--o{ ORDER : places',
    'mindmap\n  root((center))\n    A\n    B',
    'gitGraph\n    commit\n    branch dev',
    'gantt\n    title T\n    dateFormat YYYY-MM-DD\n    section S\n        a :2024-01-01, 3d',
  ];
  for (const src of samples) {
    const result = buildShareableUrl(src, 'https://diagent.dev/');
    assert.equal(result.ok, true, `build failed for: ${src.split('\n')[0]}`);
    if (!result.ok) continue;
    assert.equal(extractMermaidFromUrl(result.url), src);
  }
});

test('rejects empty input', () => {
  assert.equal(buildShareableUrl('  ').ok, false);
});

test('rejects non-URL strings', () => {
  assert.equal(extractMermaidFromUrl('not a url'), null);
});

test('rejects URLs without code param', () => {
  assert.equal(extractMermaidFromUrl('https://diagent.dev/'), null);
});

test('rejects corrupt code param', () => {
  assert.equal(extractMermaidFromUrl('https://diagent.dev/?code=XXXXX'), null);
});

test('normalizes base URL without trailing slash', () => {
  const result = buildShareableUrl('flowchart TD\n A', 'https://example.com');
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.url, /^https:\/\/example\.com\/\?code=/);
});

test('resolveMermaidFromUrl returns Mermaid for inline ?code= URL', async () => {
  const src = 'flowchart TD\n    A["Start"] --> B["End"]';
  const encoded = LZString.compressToEncodedURIComponent(src);
  const result = await resolveMermaidFromUrl(
    `https://diagent.dev/?code=${encoded}`,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mermaid, src);
});

test('resolveMermaidFromUrl errors on non-URL strings', async () => {
  const result = await resolveMermaidFromUrl('not a url');
  assert.equal(result.ok, false);
});

test('resolveMermaidFromUrl errors on URL with neither ?code= nor /d/:id', async () => {
  const result = await resolveMermaidFromUrl('https://example.com/other/path');
  assert.equal(result.ok, false);
});

test('resolveMermaidFromUrl follows /d/:id 302 and returns Mermaid', async () => {
  const src = 'flowchart TD\n    X --> Y';
  const encoded = LZString.compressToEncodedURIComponent(src);
  let port = 0;

  const server = createServer((req, res) => {
    if (req.method === 'HEAD' && /^\/d\/[a-z2-7]{10}$/.test(req.url ?? '')) {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${port}/?code=${encoded}`,
      });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  try {
    const result = await resolveMermaidFromUrl(
      `http://127.0.0.1:${port}/d/abcdefghij`,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mermaid, src);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
