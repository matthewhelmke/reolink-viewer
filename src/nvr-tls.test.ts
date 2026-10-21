import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { loadPinnedCertificate, createPinnedHttpsAgent, createPinnedFetch } from './nvr-tls.js';

// These tests make real TLS connections to a local HTTPS server. The server's
// certificate imitates the hub's: self-signed, with a CN ("CERTIFICATE") that
// does not match the address the client connects to.

let tempDir: string;
let serverCertPath: string;   // the certificate the test server presents
let otherCertPath: string;    // an unrelated certificate, standing in for an impostor
let caCertPath: string;       // a self-signed certificate that has signed another one
let leafServer: https.Server; // presents a certificate signed by caCertPath's key
let leafServerUrl: string;
let server: https.Server;
let serverUrl: string;

/** Create a self-signed certificate and key with openssl; return the paths. */
function makeSelfSignedCert(name: string): { certPath: string; keyPath: string } {
  const certPath = path.join(tempDir, `${name}.pem`);
  const keyPath  = path.join(tempDir, `${name}-key.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=CERTIFICATE', '-days', '1',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return { certPath, keyPath };
}

/** Ask openssl, independently of Node, for a certificate's SHA-256 fingerprint. */
function opensslFingerprint(certPath: string): string {
  const output = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' });
  // Output looks like: "sha256 Fingerprint=D0:F5:93:..."
  return output.trim().split('=')[1] ?? '';
}

/** Collect the messages of an error and its causes, outermost first. */
function errorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' <- ');
}

/** GET a URL through an https.Agent; resolve with the body or reject with the error. */
function getWithAgent(url: string, agent: https.Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-tls-test-'));
  const serverCert = makeSelfSignedCert('server');
  otherCertPath = makeSelfSignedCert('other').certPath;
  serverCertPath = serverCert.certPath;

  // A certificate signed by caCertPath's key passes chain validation when
  // caCertPath is pinned; only the fingerprint comparison refuses it.
  const ca = makeSelfSignedCert('ca');
  caCertPath = ca.certPath;
  const leafKeyPath = path.join(tempDir, 'leaf-key.pem');
  const leafCsrPath = path.join(tempDir, 'leaf.csr');
  const leafCertPath = path.join(tempDir, 'leaf.pem');
  execFileSync('openssl', [
    'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=leaf',
    '-keyout', leafKeyPath, '-out', leafCsrPath,
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'x509', '-req', '-in', leafCsrPath, '-CA', ca.certPath, '-CAkey', ca.keyPath,
    '-days', '1', '-out', leafCertPath,
  ], { stdio: 'ignore' });

  leafServer = https.createServer(
    { cert: fs.readFileSync(leafCertPath), key: fs.readFileSync(leafKeyPath) },
    (_req, res) => { res.end('hello from an impostor'); },
  );
  await new Promise<void>((resolve) => leafServer.listen(0, '127.0.0.1', resolve));
  leafServerUrl = `https://127.0.0.1:${(leafServer.address() as AddressInfo).port}/`;

  server = https.createServer(
    { cert: fs.readFileSync(serverCert.certPath), key: fs.readFileSync(serverCert.keyPath) },
    (_req, res) => { res.end('hello from the hub'); },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  serverUrl = `https://127.0.0.1:${port}/`;
});

afterAll(() => {
  server.close();
  leafServer.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('loadPinnedCertificate', () => {
  it('reads the PEM and computes the same fingerprint openssl does', () => {
    const pinned = loadPinnedCertificate(serverCertPath);
    expect(pinned.pem).toContain('BEGIN CERTIFICATE');
    expect(pinned.fingerprint256).toBe(opensslFingerprint(serverCertPath));
  });

  it('explains how to fetch the certificate when the file is missing', () => {
    const missing = path.join(tempDir, 'no-such-file.pem');
    expect(() => loadPinnedCertificate(missing)).toThrow(missing);
    expect(() => loadPinnedCertificate(missing)).toThrow('openssl s_client');
  });

  it('rejects a file that does not hold a certificate', () => {
    const notACert = path.join(tempDir, 'not-a-cert.pem');
    fs.writeFileSync(notACert, 'this is not a certificate\n');
    expect(() => loadPinnedCertificate(notACert)).toThrow(notACert);
  });
});

describe('createPinnedHttpsAgent', () => {
  it('connects when the server presents the pinned certificate', async () => {
    const agent = createPinnedHttpsAgent(loadPinnedCertificate(serverCertPath));
    await expect(getWithAgent(serverUrl, agent)).resolves.toBe('hello from the hub');
  });

  it('refuses a server that presents a different certificate', async () => {
    const agent = createPinnedHttpsAgent(loadPinnedCertificate(otherCertPath));
    await expect(getWithAgent(serverUrl, agent)).rejects.toThrow();
  });

  it('refuses a certificate the pinned key signed, by fingerprint', async () => {
    const agent = createPinnedHttpsAgent(loadPinnedCertificate(caCertPath));
    const error = await getWithAgent(leafServerUrl, agent).catch((e: unknown) => e);
    expect(errorMessages(error)).toContain('does not match the pinned certificate');
  });
});

describe('createPinnedFetch', () => {
  it('connects when the server presents the pinned certificate', async () => {
    const pinnedFetch = createPinnedFetch(loadPinnedCertificate(serverCertPath));
    const response = await pinnedFetch(serverUrl);
    expect(await response.text()).toBe('hello from the hub');
  });

  it('refuses a server that presents a different certificate', async () => {
    const pinnedFetch = createPinnedFetch(loadPinnedCertificate(otherCertPath));
    await expect(pinnedFetch(serverUrl)).rejects.toThrow();
  });

  it('refuses a certificate the pinned key signed, by fingerprint', async () => {
    const pinnedFetch = createPinnedFetch(loadPinnedCertificate(caCertPath));
    const error = await pinnedFetch(leafServerUrl).catch((e: unknown) => e);
    expect(errorMessages(error)).toContain('does not match the pinned certificate');
  });
});
