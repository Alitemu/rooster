import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

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
