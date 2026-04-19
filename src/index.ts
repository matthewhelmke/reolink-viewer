import path from 'node:path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { ReolinkClient } from 'reolink-nvr-api';
import { ReolinkHttpError } from 'reolink-nvr-api/types';
import { createApp } from './app.js';

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

const client = new ReolinkClient({
  host: nvrHost,
  username: nvrUser,
  password: nvrPass,
  mode: 'long',
  insecure: true,
  debug: false,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
});

try {
  await client.login();
  console.log(`Authenticated to Reolink Hub at ${nvrHost}`);
} catch (error) {
  if (error instanceof ReolinkHttpError) {
    console.error(`Authentication failed (rspCode ${error.rspCode}): ${error.detail}`);
  } else if (error instanceof Error) {
    console.error(`Could not reach Reolink Hub at ${nvrHost}: ${error.message}`);
  } else {
    console.error('Unknown error during authentication:', error);
  }
  process.exit(1);
}

app.listen(3000, () => {
  console.log('Reolink Viewer running at http://localhost:3000');
});
