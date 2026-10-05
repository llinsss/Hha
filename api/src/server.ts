import closeWithGrace from "close-with-grace";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/env.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  closeWithGrace({ delay: config.shutdownGraceMs, logger: app.log }, async ({ signal, err }) => {
    if (err) app.log.fatal({ err }, "shutting down after an unrecoverable error");
    else app.log.info({ signal }, "shutting down");
    await app.close();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.fatal({ err: error }, "failed to start");
    await app.close().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error("Fatal startup error", error);
  process.exit(1);
});
