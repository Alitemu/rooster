import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The hard rule: a server with the organisation's own certificate needs
 * nothing but the three files and .env. These checks keep the Caddyfile, the
 * compose file and .env.example saying the same thing: the choice of
 * certificate (TLS_MODUS), where the files are read from, and the http port.
 */

const caddyfile = readFileSync('Caddyfile', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');

describe('certificate choice (TLS_MODUS)', () => {
  it('the Caddyfile imports the snippet TLS_MODUS names and falls back to intern', () => {
    expect(caddyfile).toMatch(/import tls_\{\$TLS_MODUS:intern\}/);
    expect(caddyfile).toMatch(/\(tls_intern\) \{[^}]*tls internal/);
  });

  it('the bestand snippet reads the files the compose file mounts', () => {
    expect(caddyfile).toMatch(/\(tls_bestand\) \{\s*tls \/certs\/rooster\.pem \/certs\/rooster\.key\s*\}/);
    expect(compose).toContain('./certs:/certs:ro');
  });

  it('the compose file hands TLS_MODUS on to caddy, intern when left out', () => {
    expect(compose).toContain('TLS_MODUS: "${TLS_MODUS:-intern}"');
  });

  it('.env.example documents TLS_MODUS with the certificate file names', () => {
    expect(envExample).toMatch(/^TLS_MODUS=bestand$/m);
    expect(envExample).toContain('certs/rooster.pem');
    expect(envExample).toContain('certs/rooster.key');
  });
});

describe('port 80 (HTTP_PORT)', () => {
  it('is published on every interface only when HTTP_PORT is set, on the loopback otherwise', () => {
    expect(compose).toContain('"${HTTP_PORT:+0.0.0.0:}${HTTP_PORT:-127.0.0.1:}:80"');
  });

  it('.env.example documents HTTP_PORT', () => {
    expect(envExample).toMatch(/^HTTP_PORT=80$/m);
  });
});

/**
 * The caddy service starts through a small shell check that names, in Dutch,
 * a wrong TLS_MODUS or missing certificate files, and then hands over to
 * Caddy. Run here as the compose file has it: `$$` unescaped, and the final
 * `exec caddy` swapped for a marker, so a green test also proves the
 * check never keeps Caddy from starting.
 */
function startCheck(): string {
  const block = compose.match(/command:\n\s+- sh\n\s+- -c\n\s+- \|\n((?:        .*\n|\n)+)/);
  if (!block) throw new Error('geen start-check in docker-compose.yml');
  return block[1]
    .split('\n')
    .map((line) => line.slice(8))
    .join('\n')
    .replace(/\$\$/g, '$')
    .replace(/exec caddy run .*/, 'echo CADDY-GESTART');
}

function runCheck(env: Record<string, string>): { stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', startCheck()], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('start check of caddy', () => {
  const map = mkdtempSync(join(tmpdir(), 'certs-'));
  writeFileSync(join(map, 'rooster.pem'), 'x');
  writeFileSync(join(map, 'rooster.key'), 'x');
  const legeMap = mkdtempSync(join(tmpdir(), 'certs-leeg-'));

  it('says nothing and starts Caddy with the own CA', () => {
    const r = runCheck({ TLS_MODUS: 'intern', CERTS_DIR: legeMap });
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('CADDY-GESTART');
  });

  it('says nothing when both certificate files are there', () => {
    const r = runCheck({ TLS_MODUS: 'bestand', CERTS_DIR: map });
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('CADDY-GESTART');
  });

  it('names the missing certificate file, and still hands over to Caddy', () => {
    const r = runCheck({ TLS_MODUS: 'bestand', CERTS_DIR: legeMap });
    expect(r.stderr).toContain('certs/rooster.pem ontbreekt');
    expect(r.stderr).toContain('certs/rooster.key ontbreekt');
    expect(r.stdout).toContain('CADDY-GESTART');
  });

  it.each(['Bestand', 'file', 'intren'])('names a TLS_MODUS that does not exist (%s)', (waarde) => {
    const r = runCheck({ TLS_MODUS: waarde, CERTS_DIR: map });
    expect(r.stderr).toContain(`TLS_MODUS="${waarde}" bestaat niet`);
    expect(r.stderr).toContain('bestand of intern');
    expect(r.stdout).toContain('CADDY-GESTART');
  });
});

describe('the installation files in the image', () => {
  it('the Dockerfile puts compose file, Caddyfile and the IT guide in /app/installatie', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toContain('COPY docker-compose.yml Caddyfile docs/installatie-it.md /app/installatie/');
  });

  it('those files exist and the build context does not leave them out', () => {
    const dockerignore = readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim());
    for (const file of ['docker-compose.yml', 'Caddyfile', 'docs/installatie-it.md']) {
      expect(existsSync(file)).toBe(true);
      expect(dockerignore).not.toContain(file);
      expect(dockerignore).not.toContain(file.split('/')[0]);
    }
  });

  it('the guide tells how to take them out of the image', () => {
    const gids = readFileSync('docs/installatie-it.md', 'utf8');
    expect(gids).toContain('--entrypoint tar $IMAGE -cf - -C /app/installatie .');
  });
});

/**
 * The workflows (0.111.0): a release checks everything before `stable` moves, and the jobs that run the packages of
 * the lockfiles hold no write rights and no stored git credentials.
 */
describe('the workflows', () => {
  const release = readFileSync('.github/workflows/release.yml', 'utf8');
  const images = readFileSync('.github/workflows/images.yml', 'utf8');

  it('the release checks the images and the tag before it moves stable', () => {
    const controle = release.indexOf('name: Check the images and the tag');
    const stable = release.indexOf('name: Point stable at this version');
    expect(controle).toBeGreaterThan(-1);
    expect(stable).toBeGreaterThan(controle);
    // The AIOS's solver is one of the images that must exist, from 0.74.0 on.
    expect(release.slice(controle, stable)).toMatch(/images="\$images aios-solver"/);
    expect(release.slice(controle, stable)).toContain('Tag $tag bestaat niet');
  });

  it('only a job that pushes an image may write packages; the workflow itself writes nothing', () => {
    const werk = images.slice(images.indexOf('\npermissions:'), images.indexOf('\nconcurrency:'));
    expect(werk).toContain('contents: read');
    expect(werk).not.toContain('write');
    const jobs = images.slice(images.indexOf('\njobs:'));
    const delen = jobs.split(/\n  (?=[a-z-]+:\n)/).slice(1);
    const packagesWrite = delen.filter((d) => /packages: write/.test(d)).map((d) => d.split(':')[0]);
    expect(packagesWrite).toEqual(['build']);
  });

  it('every checkout keeps no git credentials', () => {
    for (const bron of [images, release]) {
      const checkouts = bron.match(/uses: actions\/checkout@[^\n]*\n(\s+with:\n(\s+[a-z-]+: [^\n]*\n)+)?/g) ?? [];
      expect(checkouts.length).toBeGreaterThan(0);
      for (const c of checkouts) expect(c).toContain('persist-credentials: false');
    }
  });
});
