// Certificate pinning for HTTPS connections to the Reolink hub.
//
// The hub presents a self-signed certificate, so ordinary verification fails.
// Instead of turning verification off, the app trusts exactly one certificate:
// the one saved in nvr-cert.pem. Every connection to the hub must present that
// certificate, byte for byte, or the connection is refused before any request
// (and so any credential or session token) is sent.
//
// Two checks enforce this:
//   1. `ca` makes the saved certificate the only trust anchor, so the normal
//      TLS chain validation stays on. A self-signed certificate passes only if
//      it is that exact certificate.
//   2. `checkServerIdentity` compares the presented certificate's SHA-256
//      fingerprint with the saved one, which also refuses any other certificate
//      signed by the saved certificate's key. It replaces the usual hostname
//      check, which can never pass: the hub's certificate names "CERTIFICATE",
//      not the hub's address.

import fs from 'node:fs';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';

export interface PinnedCertificate {
  pem:            string;
  fingerprint256: string;   // colon-separated hex, as Node and openssl print it
}

export const HOW_TO_SAVE_CERT =
  'Save the hub certificate with: ' +
  'openssl s_client -connect <hub-address>:443 </dev/null 2>/dev/null | openssl x509 -out nvr-cert.pem';

/** Read the saved hub certificate. Throws a message that explains how to fix the problem. */
export function loadPinnedCertificate(pemPath: string): PinnedCertificate {
  let pem: string;
  try {
    pem = fs.readFileSync(pemPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the hub certificate at ${pemPath} (${reason}). ${HOW_TO_SAVE_CERT}`);
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw new Error(`${pemPath} does not contain a PEM certificate. ${HOW_TO_SAVE_CERT}`);
  }

  return { pem, fingerprint256: certificate.fingerprint256 };
}

/** TLS options shared by both HTTPS clients: trust only the pinned certificate. */
function pinnedTlsOptions(pinned: PinnedCertificate) {
  return {
    ca: pinned.pem,
    checkServerIdentity: (_hostname: string, presented: PeerCertificate): Error | undefined => {
      if (presented.fingerprint256 === pinned.fingerprint256) {
        return undefined;
      }
      return new Error(
        `Hub certificate does not match the pinned certificate in nvr-cert.pem ` +
        `(presented ${presented.fingerprint256}, pinned ${pinned.fingerprint256}). ` +
        `If the hub was reset or replaced, save its new certificate. ${HOW_TO_SAVE_CERT}`
      );
    },
  };
}

/** An https.Agent for requests the app makes to the hub itself (recording playback). */
export function createPinnedHttpsAgent(pinned: PinnedCertificate): https.Agent {
  return new https.Agent(pinnedTlsOptions(pinned));
}

/** A fetch function for ReolinkClient that connects only to the pinned hub. */
export function createPinnedFetch(pinned: PinnedCertificate): typeof fetch {
  const dispatcher = new UndiciAgent({ connect: pinnedTlsOptions(pinned) });

  const pinnedFetch = (input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher });

  // undici's fetch and the global fetch are the same API, but their TypeScript
  // declarations differ in small ways, so the types need a cast.
  return pinnedFetch as unknown as typeof fetch;
}
