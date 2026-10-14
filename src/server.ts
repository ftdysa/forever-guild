import { loadConfig, type Config } from "./config.js";
import { buildApp } from "./app.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = buildApp(config);

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  app.close().then(() => process.exit(0));
});
process.on("SIGINT", () => {
  app.close().then(() => process.exit(0));
});
