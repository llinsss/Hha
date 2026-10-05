import { defineRailway, fn, github, postgres, preserve, project, redis, service } from "railway/iac";

/**
 * Houzz Hills on Railway (Infrastructure as Code, `railway config plan|apply`).
 *
 *   web  ── public domain; serves the UI and forwards /api/v1/* to the API privately
 *   api  ── private only; owns PostgreSQL and Redis, migrates before each deploy
 *   expire-payment-holds / reconcile-payments ── cron jobs from the API image
 *
 * The browser and the payment provider only ever reach the web service, so the
 * refresh cookie is first-party and the API has no public surface.
 *
 * Secrets marked preserve() are never written here: set them once per
 * environment (see README "Deploying to Railway").
 */
const REPOSITORY = "llinsss/Hha";

export default defineRailway(() => {
  const db = postgres("postgres");
  const cache = redis("redis");

  const webOrigin = "https://${{web.RAILWAY_PUBLIC_DOMAIN}}";
  // Shared by the API and its cron jobs: same image, same validated configuration.
  const runtime = {
    NODE_ENV: "production",
    DATABASE_URL: db.env.DATABASE_URL,
    REDIS_URL: cache.env.REDIS_URL,
    PUBLIC_WEB_URL: webOrigin,
    CORS_ORIGINS: webOrigin,
  };

  const api = service("api", {
    source: github(REPOSITORY, { branch: "main", rootDirectory: "api" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/api/**"] },
    deploy: {
      preDeployCommand: ["node dist/scripts/migrate.js up"],
      healthcheckPath: "/health/ready",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
      drainingSeconds: 15,
    },
    env: {
      ...runtime,
      PORT: "4000",
      HOST: "::",
      // One hop: requests arrive through the web service's proxy.
      TRUST_PROXY_HOPS: "1",
      DOCS_ENABLED: "false",
      JWT_ACCESS_SECRET: preserve(),
      SETTINGS_ENCRYPTION_KEY: preserve(),
      SETUP_SECRET: preserve(),
      METRICS_TOKEN: preserve(),
    },
  });

  const web = service("web", {
    source: github(REPOSITORY, { branch: "main", rootDirectory: "web" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/web/**"] },
    deploy: {
      healthcheckPath: "/management",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
    },
    env: {
      PORT: "3000",
      // Build arguments: baked into the standalone server and client bundle.
      API_INTERNAL_URL: "http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4000",
      NEXT_PUBLIC_WEBSITE_URL: "https://houzzhills.com",
    },
  });

  const job = (name: string, command: string, schedule: string) =>
    fn(name, {
      source: github(REPOSITORY, { branch: "main", rootDirectory: "api" }),
      build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/api/**"] },
      deploy: { startCommand: `node dist/scripts/run-job.js ${command}`, cronSchedule: schedule, restartPolicyType: "NEVER" },
      env: {
        ...runtime,
        JWT_ACCESS_SECRET: api.env.JWT_ACCESS_SECRET,
        SETTINGS_ENCRYPTION_KEY: api.env.SETTINGS_ENCRYPTION_KEY,
      },
    });

  return project("houzzhills", {
    resources: [
      db,
      cache,
      api,
      web,
      // Releases rooms held by unpaid checkouts (PRD §7: every few minutes).
      job("expire-payment-holds", "expire-payment-holds", "*/5 * * * *"),
      // Applies provider settlements a webhook missed and queues stale transfers.
      job("reconcile-payments", "reconcile-payments", "17 * * * *"),
    ],
  });
});
