import path from 'node:path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { ReolinkClient } from 'reolink-nvr-api';
import { ReolinkHttpError } from 'reolink-nvr-api/types';
import { createApp } from './app.js';
import { loadPinnedCertificate, createPinnedFetch, createPinnedHttpsAgent, HOW_TO_SAVE_CERT, type PinnedCertificate } from './nvr-tls.js';

dotenv.config();

const nvrHost        = process.env['REOLINK_NVR_HOST'];
const nvrUser        = process.env['REOLINK_NVR_USER'];
const nvrPass        = process.env['REOLINK_NVR_PASS'];
const viewerPassword = process.env['VIEWER_PASSWORD'];
const adminPassword  = process.env['ADMIN_PASSWORD'];
const sessionSecret  = process.env['SESSION_SECRET'];

if (!nvrHost || !nvrUser || !nvrPass || !viewerPassword || !adminPassword || !sessionSecret) {
  console.error(
    'Missing required environment variables: ' +
    'REOLINK_NVR_HOST, REOLINK_NVR_USER, REOLINK_NVR_PASS, ' +
    'VIEWER_PASSWORD, ADMIN_PASSWORD, SESSION_SECRET'
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The hub's self-signed certificate, saved once and trusted from then on.
// See src/nvr-tls.ts for how it is enforced.
const nvrCertPath = path.join(__dirname, '..', 'nvr-cert.pem');
let nvrCert: PinnedCertificate;
try {
  nvrCert = loadPinnedCertificate(nvrCertPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// insecure: false stops the library from switching certificate checks off;
// the pinned fetch supplies the checks instead.
const client = new ReolinkClient({
  host: nvrHost,
  username: nvrUser,
  password: nvrPass,
  mode: 'long',
  insecure: false,
  fetch: createPinnedFetch(nvrCert),
  debug: false,
});

const ffmpegBin = process.env['FFMPEG_PATH'] ?? path.join(__dirname, '..', 'bin', 'ffmpeg');
const publicDir = path.join(__dirname, '..', 'public');

const app = createApp(client, {
  sessionSecret,
  viewerPassword,
  adminPassword,
  nvrHost,
  nvrUser,
  nvrPass,
  ffmpegBin,
  publicDir,
  nvrHttpsAgent: createPinnedHttpsAgent(nvrCert),
});

try {
  await client.login();
  console.log(`Authenticated to Reolink Hub at ${nvrHost}`);
} catch (error) {
  if (error instanceof ReolinkHttpError) {
    console.error(`Authentication failed (rspCode ${error.rspCode}): ${error.detail}`);
  } else if (error instanceof Error) {
    // fetch reports TLS failures, including a certificate mismatch, as
    // "fetch failed" with the real reason in error.cause.
    const reason = error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
    console.error(`Could not reach Reolink Hub at ${nvrHost}: ${reason}`);

    // OpenSSL's code when the hub presents a self-signed certificate other than
    // the pinned one, which is what a reset or replaced hub does.
    const causeCode = (error.cause as { code?: string } | undefined)?.code;
    if (causeCode === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      console.error(
        `The hub presented a certificate other than the one in nvr-cert.pem. ` +
        `If the hub was reset or replaced, save its new certificate. ${HOW_TO_SAVE_CERT}`
      );
    }
  } else {
    console.error('Unknown error during authentication:', error);
  }
  process.exit(1);
}

app.listen(3000, () => {
  console.log('Reolink Viewer running at http://localhost:3000');
});
