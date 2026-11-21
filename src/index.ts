#!/usr/bin/env node
import { loadConfig } from './config.js';
import { SecretBox } from './crypto.js';
import { createApp, VERSION } from './server.js';
import { Store } from './store.js';

const config = loadConfig();
const store = Store.open(config.dataDir);
const box = SecretBox.load(config.dataDir, config.encryptionKey);
const app = createApp({ config, store, box });

const purge = () => {
  for (const grant of store.purgeExpired(Math.floor(Date.now() / 1000))) {
    console.log(
      `sign-in of ${grant.email} expired; its Immich API key "${config.apiKeyName}" (${grant.apiKeyId}) ` +
        'is no longer used and can be deleted under Account Settings → API Keys',
    );
  }
};
purge();
const timer = setInterval(purge, 3600 * 1000);
timer.unref();

const server = app.listen(config.port, config.host, () => {
  console.log(
    `immich-mcp ${VERSION} listening on ${config.host}:${config.port}, serving ${config.publicUrl.href}`,
  );
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
