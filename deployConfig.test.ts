import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The hard rule: a server needs nothing but docker-compose.yml (and .env for
 * what differs): the Caddyfile is part of the caddy service in it, written
 * out when the container starts (0.800.0). These checks keep that Caddyfile,
 * the compose file and .env.example saying the same thing: the choice of
 * certificate (TLS_MODUS), where the files are read from, and the ports.
 */

const compose = readFileSync('docker-compose.yml', 'utf8');

/** The script of the caddy service as a shell gets it: the indent gone and `$$` unescaped. */
function caddyScript(): string {
  const block = compose.match(/command:\n\s+- sh\n\s+- -c\n\s+- \|\n((?:        .*\n|\n)+)/);
  if (!block) throw new Error('geen start-check in docker-compose.yml');
  return block[1]
    .split('\n')
    .map((line) => line.slice(8))
    .join('\n')
    .replace(/\$\$/g, '$');
}

/** The Caddyfile the caddy service writes before it starts Caddy. */
function caddyfileUitCompose(): string {
  const m = caddyScript().match(/cat > \/tmp\/Caddyfile <<'CADDYFILE'\n([\s\S]*?)\nCADDYFILE\n/);
  if (!m) throw new Error('geen Caddyfile in docker-compose.yml');
  return m[1];
}

const caddyfile = caddyfileUitCompose();

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

describe('one file is the installation (0.800.0)', () => {
  it('the compose file mounts no Caddyfile and no file of the repository but its folders', () => {
    const mounts = [...compose.matchAll(/^\s+- (\.[^\s:]*|\$\{DATA_DIR[^}]*\}):/gm)].map((m) => m[1]);
    expect([...mounts].sort()).toEqual(['./certs', '${DATA_DIR:-./data}'].sort());
    expect(compose).not.toMatch(/Caddyfile:\/etc\/caddy/);
  });

  it('listens on 443 unless APP_PORT says otherwise: published, handed to caddy, and in the site address', () => {
    expect(compose).toContain('- "${APP_PORT:-443}:${APP_PORT:-443}"');
    expect(compose).toContain('APP_PORT: "${APP_PORT:-443}"');
    expect(caddyfile).toContain('https://:{$APP_PORT:443} {');
    expect(caddyfile).toContain('redir https://{host}:{$APP_PORT:443}{uri} 308');
    expect(compose).not.toContain('8010}');
  });

  it('.env.example gives a NAS that uses 443 itself the way out', () => {
    expect(envExample).toMatch(/^# APP_PORT=8010$/m);
  });

  // The real thing, when a Caddy binary is at hand (CADDY_BIN, or caddy on the PATH): the file it writes is one Caddy accepts.
  const caddy = process.env.CADDY_BIN || 'caddy';
  const heeftCaddy = spawnSync(caddy, ['version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!heeftCaddy)('the Caddyfile in the compose file is valid for Caddy, with and without the own certificate', () => {
    const map = mkdtempSync(join(tmpdir(), 'caddyfile-'));
    const bestand = join(map, 'Caddyfile');
    writeFileSync(bestand, caddyfile);
    const sleutels = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=rooster.test', '-keyout', join(map, 'rooster.key'), '-out', join(map, 'rooster.pem')], { encoding: 'utf8' });
    expect(sleutels.status).toBe(0);
    for (const tlsModus of ['intern', 'bestand']) {
      const r = spawnSync(caddy, ['validate', '--config', bestand, '--adapter', 'caddyfile'], {
        encoding: 'utf8',
        env: { ...process.env, TLS_MODUS: tlsModus, APP_PORT: '443', BASE_PATH: '/achterwacht', XDG_DATA_HOME: map, XDG_CONFIG_HOME: map },
      });
      // The certificate is read from /certs, which a test machine does not have: only that may be what fails.
      const fout = `${r.stdout}${r.stderr}`;
      if (tlsModus === 'intern') expect(r.status, fout).toBe(0);
      else if (r.status !== 0) expect(fout).toContain('/certs/rooster');
    }
  });
});

describe('port 80 (HTTP_PORT)', () => {
  it('is published on every interface on port 80 without any .env, and HTTP_PORT moves it', () => {
    expect(compose).toContain('- "${HTTP_PORT:-80}:80"');
    expect(compose).not.toContain('127.0.0.1:}');
  });

  it('.env.example documents HTTP_PORT as the way out for a NAS that has port 80 taken', () => {
    expect(envExample).toMatch(/^# HTTP_PORT=8080$/m);
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
  return caddyScript()
    .replace(/cat > \/tmp\/Caddyfile <<'CADDYFILE'\n[\s\S]*?\nCADDYFILE\n/, '')
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
  it('the Dockerfile puts the compose file and the IT guide in /app/installatie', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toContain('COPY docker-compose.yml docs/installatie-it.md /app/installatie/');
  });

  it('those files exist and the build context does not leave them out', () => {
    const dockerignore = readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim());
    for (const file of ['docker-compose.yml', 'docs/installatie-it.md']) {
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

describe('the web server', () => {
  it('does not announce itself with an X-Powered-By header', () => {
    expect(readFileSync('next.config.js', 'utf8')).toMatch(/poweredByHeader:\s*false/);
  });
});

describe('the build context and the start', () => {
  const dockerignore = readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim());

  it('keeps every secret pattern of .gitignore out of the image, as well', () => {
    // A build from the source (docker compose up --build) copies the folder: a private key or a
    // certificate that git ignores would travel into the image.
    for (const patroon of ['*.pem', '*.key', '*.crt']) {
      expect(readFileSync('.gitignore', 'utf8')).toContain(patroon);
      expect(dockerignore, patroon).toContain(patroon);
      expect(dockerignore, `**/${patroon}`).toContain(`**/${patroon}`);
    }
    expect(dockerignore).toContain('certs');
  });

  it('starts Next itself, so that SIGTERM reaches it', () => {
    const entrypoint = readFileSync('docker-entrypoint.sh', 'utf8');
    const laatste = entrypoint.trim().split('\n').filter((l) => !l.trim().startsWith('#')).pop()!;
    // npm stays between as a parent that passes no signal on; reproduced: the server was left running.
    expect(laatste).not.toMatch(/\bnpm\b/);
    expect(laatste).toMatch(/^exec .*next start/);
  });

  it('re-owns the data folder without following links', () => {
    expect(readFileSync('docker-entrypoint.sh', 'utf8')).toMatch(/chown -R -h node:node \/data/);
  });
});
