import fp from "fastify-plugin";
import { createDataSource } from "../db/data-source.js";

export default fp(
  async (app) => {
    const dataSource = createDataSource(app.config, app.log.child({ module: "typeorm" }));
    await dataSource.initialize();
    app.decorate("db", dataSource);
    app.addHook("onClose", async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
    });
  },
  { name: "database" },
);
