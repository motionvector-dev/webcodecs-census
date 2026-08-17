/**
 * An MCP server for the census, so an agent can find a WebCodecs leak without a
 * browser UI in the loop.
 *
 * The tools are deliberately few and their output is deliberately small: an
 * agent reading a full census would spend most of its context on stack strings.
 * `webcodecs_census` returns a digest; `webcodecs_leak_sites` returns the
 * attribution; `webcodecs_timeline` returns the correlation a static count
 * cannot give.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { attach, launchChrome, type CensusSession } from '@motionvector/webcodecs-census-cdp';
import { checkLeaks, summarize, type TrackedType } from '@motionvector/webcodecs-census';

let session: CensusSession | null = null;
let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const TOOLS = [
  {
    name: 'webcodecs_attach',
    description:
      'Instrument a page and every one of its Web Workers with the WebCodecs census. ' +
      'Either attach to a Chrome already started with --remote-debugging-port (pass browserURL), ' +
      'or launch a throwaway one (pass executablePath). Call this before any other tool.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page to open and instrument.' },
        browserURL: {
          type: 'string',
          description: 'DevTools endpoint of a running Chrome, e.g. http://127.0.0.1:9222.',
        },
        executablePath: {
          type: 'string',
          description: 'Chrome binary to launch instead, with a throwaway profile.',
        },
        headless: { type: 'boolean', description: 'Launch headless. Default true.' },
        sampleIntervalMs: {
          type: 'number',
          description: 'Timeline sampling interval. Default 250.',
        },
      },
    },
  },
  {
    name: 'webcodecs_census',
    description:
      'A digest of what every instrumented context holds open right now: live objects by type, ' +
      'media element readiness, and whether anything was garbage collected without close(). ' +
      'Small by design — use webcodecs_leak_sites for allocation stacks.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'number', description: 'Settle for this long first. Default 0.' },
      },
    },
  },
  {
    name: 'webcodecs_leak_sites',
    description:
      'Where the live objects were allocated, grouped by site and ordered worst first. ' +
      'This is the tool that answers "which line is leaking".',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Restrict to one type, e.g. VideoFrame.',
        },
        limit: { type: 'number', description: 'Max sites. Default 10.' },
        minAgeMs: {
          type: 'number',
          description: 'Ignore objects younger than this; they may still be in flight.',
        },
      },
    },
  },
  {
    name: 'webcodecs_timeline',
    description:
      'The rolling sample history: live counts, decode/encode throughput, codec queue depth and ' +
      'media element readyState over time. Use this when something stalls intermittently — a ' +
      'single snapshot cannot distinguish a busy pipeline from a wedged one.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Restrict to one context name.' },
        lastN: { type: 'number', description: 'Most recent N samples. Default 40.' },
      },
    },
  },
  {
    name: 'webcodecs_evaluate',
    description:
      'Run an expression in the page to drive the app — click something, start playback — so the ' +
      'census has activity to observe.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
  {
    name: 'webcodecs_detach',
    description: 'Stop instrumenting and close any browser this server launched.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server(
  { name: 'webcodecs-census', version: '0.3.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function requireSession(): CensusSession {
  if (!session) throw new Error('Not attached. Call webcodecs_attach first.');
  return session;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params as any;

  switch (name) {
    case 'webcodecs_attach': {
      if (session) return text('Already attached. Call webcodecs_detach first.');
      let browserURL = args.browserURL;
      if (!browserURL) {
        if (!args.executablePath) {
          throw new Error('Pass browserURL for a running Chrome, or executablePath to launch one.');
        }
        chrome = await launchChrome({
          executablePath: args.executablePath,
          headless: args.headless !== false,
        });
        browserURL = chrome.browserURL;
      }
      const seen: string[] = [];
      session = await attach({
        browserURL,
        install: { sampleIntervalMs: args.sampleIntervalMs ?? 250, keepSamples: 400 },
        onContext: (c) => seen.push(`${c.type} ${c.url}`),
      });
      if (args.url) {
        await session.navigate(args.url);
        await new Promise((r) => setTimeout(r, 1500));
      }
      return text(
        `Attached.\nInstrumented ${session.contexts().length} context(s):\n` +
          session.contexts().map((c) => `  ${c.type} ${c.url}`).join('\n') +
          '\n\nWorkers are instrumented before their first line, so allocations at worker startup are counted.',
      );
    }

    case 'webcodecs_census': {
      const s = requireSession();
      if (args.waitMs) await new Promise((r) => setTimeout(r, args.waitMs));
      const censuses = await s.census();
      if (!censuses.length) return text('No instrumented context answered.');
      const problems = censuses.flatMap((c: any) =>
        c.problems.map((p: string) => `${c.context}: ${p}`),
      );
      return text(
        summarize(censuses) +
          (problems.length ? `\n\nNot instrumented:\n  ${problems.join('\n  ')}` : ''),
      );
    }

    case 'webcodecs_leak_sites': {
      const s = requireSession();
      const censuses = await s.census();
      // Attribution, not a verdict: never hide a type the caller did not ask
      // about, or "which line is leaking" answers nothing for a codec leak.
      const report = checkLeaks(censuses, {
        types: args.type ? [args.type as TrackedType] : 'all',
        minAgeMs: args.minAgeMs,
      });
      const sites = report.sites.slice(0, args.limit ?? 10);
      if (!sites.length) return text('No live tracked objects to attribute.');
      return text(
        sites
          .map(
            (site) =>
              `${site.count}x ${site.type} — ${site.origin}, oldest ${site.oldestAgeMs}ms, in ${site.context}\n` +
              site.stack.split('\n').map((l) => `    ${l.trim()}`).join('\n'),
          )
          .join('\n\n'),
      );
    }

    case 'webcodecs_timeline': {
      const s = requireSession();
      const censuses = await s.census();
      const chosen = args.context
        ? censuses.filter((c: any) => c.context === args.context)
        : censuses;
      const lines: string[] = [];
      for (const c of chosen) {
        const samples = c.timeline.slice(-(args.lastN ?? 40));
        if (!samples.length) continue;
        lines.push(`### ${c.context} (${samples.length} samples)`);
        lines.push('  t(ms)  live          dec/out  queued  media(stalled)');
        for (const sm of samples) {
          const live = Object.entries(sm.live)
            .filter(([, n]) => n)
            .map(([t, n]) => `${t[0]}${t.includes('Frame') ? 'F' : ''}=${n}`)
            .join(',') || '-';
          lines.push(
            `  ${String(sm.t).padStart(6)}  ${live.padEnd(13)} ` +
              `${sm.activity.decodeCalls}/${sm.activity.outputs}`.padEnd(8) +
              ` ${String(sm.activity.queued).padEnd(7)} ` +
              `${sm.mediaElements.total}(${sm.mediaElements.stalled})`,
          );
        }
      }
      return text(lines.length ? lines.join('\n') : 'No samples recorded yet.');
    }

    case 'webcodecs_evaluate': {
      const s = requireSession();
      const value = await s.evaluate(args.expression);
      return text(JSON.stringify(value, null, 2) ?? 'undefined');
    }

    case 'webcodecs_detach': {
      session?.detach();
      session = null;
      await chrome?.kill();
      chrome = null;
      return text('Detached.');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const shutdown = async () => {
  session?.detach();
  await chrome?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
