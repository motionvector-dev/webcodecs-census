// Fail fast, and fail legibly, before a release does any real work.
//
// npm answers a publish to a scope you cannot write with 404 rather than 403,
// so it never leaks whether the scope exists. Unauthenticated and
// not-a-member-of-the-org therefore produce the same message — one that reads
// like the package name is wrong when it usually is not. Check both up front,
// while the terminal still has room for an explanation.

import { execFileSync } from 'node:child_process';

const SCOPE = 'motionvector';

const run = (args) =>
  execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const die = (lines) => {
  console.error(`\n  Cannot publish.\n\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
  process.exit(1);
};

let who;
try {
  who = run(['whoami']);
} catch {
  die([
    'You are not logged in to npm.',
    '',
    'There is an _authToken for registry.npmjs.org in ~/.npmrc, but the registry',
    'rejects it — it has expired or been revoked. A publish in this state fails',
    'with a 404 that looks like the package scope does not exist.',
    '',
    'Fix:  npm login',
    'Then: npm run release',
  ]);
}

let members = '';
try {
  members = run(['org', 'ls', SCOPE]);
} catch {
  die([
    `Logged in as ${who}, but the @${SCOPE} org is not readable by this account.`,
    '',
    `Either the org has a different name, or ${who} is not a member of it.`,
    'npm reports both as the same 404 at publish time.',
    '',
    `Check:  npm org ls ${SCOPE}`,
    `        npm profile get`,
  ]);
}

if (!members.includes(who)) {
  die([
    `Logged in as ${who}, who is not listed in the @${SCOPE} org.`,
    'Publishing will fail with a 404. Ask an owner to add this account.',
    '',
    members,
  ]);
}

console.log(`preflight: ${who} can publish to @${SCOPE}`);
