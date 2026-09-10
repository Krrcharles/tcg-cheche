import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_GUILD_ID: z
    .string()
    .regex(/^\d{17,20}$/, "Expected a Discord snowflake string"),
});

export function loadEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    // Report field names and validation failures without echoing secrets.
    throw new Error(
      `Invalid environment configuration: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}
