#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import {
  resolveMermaidFromUrl,
  shortenOrInline,
  DEFAULT_BASE_URL,
} from './core.js';

const HELP = `diagent — encode and decode Diagent shareable diagram URLs

Usage:
  diagent encode [FILE] [--base-url URL] [--inline] [--open]
                                           Encode Mermaid from FILE or stdin → URL on stdout
                                           (tries backend short URL, falls back to inline on failure)
  diagent decode <URL>                      Decode short /d/:id OR inline ?code= URL → Mermaid on stdout
  diagent decode -                          Decode URL read from stdin
  diagent install-skill                      Install Claude Code skill to ~/.claude/skills/diagent/
  diagent --help                            Show this help
  diagent --version                         Show version

Options:
  --inline        Skip the backend and always produce an inline ?code= URL
  --open          Open the generated URL in the default browser
  --base-url URL  Diagent origin for both backend calls and URL construction
                  (default: ${DEFAULT_BASE_URL})

Examples:
  cat flow.mmd | diagent encode
  diagent encode flow.mmd
  diagent encode flow.mmd --base-url http://localhost:5173/
  diagent encode flow.mmd --inline
  diagent decode "https://diagent.dev/d/abcdefghij"
  diagent decode "https://diagent.dev/?code=GYGw9g7gxg..."

Environment:
  DIAGENT_BASE_URL   Default base URL for encode (default: ${DEFAULT_BASE_URL})
`;

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function runEncode(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      'base-url': { type: 'string' },
      inline: { type: 'boolean' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const file = positionals[0];
  const mermaid = file ? await readFile(file, 'utf8') : await readStdin();
  const baseUrl = values['base-url'] ?? DEFAULT_BASE_URL;
  const preferInline = values.inline === true;

  const { result, usedFallback } = await shortenOrInline(
    mermaid,
    baseUrl,
    preferInline,
  );
  if (!result.ok) {
    process.stderr.write(`diagent: ${result.error}\n`);
    return 1;
  }
  if (usedFallback && !preferInline) {
    process.stderr.write(
      'diagent: backend unreachable, using inline URL\n',
    );
  }
  process.stdout.write(result.url + '\n');
  if (values.open) {
    const cmd =
      process.platform === 'darwin' ? 'open' :
      process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} ${JSON.stringify(result.url)}`);
  }
  return 0;
}

async function runDecode(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let url = positionals[0];
  if (!url) {
    process.stderr.write(
      'diagent decode: missing URL argument (pass URL or "-" for stdin)\n',
    );
    return 2;
  }
  if (url === '-') url = (await readStdin()).trim();

  const result = await resolveMermaidFromUrl(url);
  if (!result.ok) {
    process.stderr.write(`diagent: could not decode URL — ${result.error}\n`);
    return 1;
  }
  const mermaid = result.mermaid;
  process.stdout.write(mermaid + (mermaid.endsWith('\n') ? '' : '\n'));
  return 0;
}

async function runInstallSkill(): Promise<number> {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    process.stderr.write('diagent: cannot determine home directory\n');
    return 1;
  }
  const destDir = `${home}/.claude/skills/diagent`;
  const src = new URL('../SKILL.md', import.meta.url);
  const dest = `${destDir}/SKILL.md`;
  await mkdir(destDir, { recursive: true });
  await copyFile(src, dest);
  process.stdout.write(`Installed skill to ${dest}\n`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    const pkg = await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    process.stdout.write(JSON.parse(pkg).version + '\n');
    return 0;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'encode':
      return runEncode(rest);
    case 'decode':
      return runDecode(rest);
    case 'install-skill':
      return runInstallSkill();
    default:
      process.stderr.write(
        `diagent: unknown subcommand "${sub}"\n${HELP}`,
      );
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `diagent: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  });
