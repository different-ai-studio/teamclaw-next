import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema/teams.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
} satisfies Config;
