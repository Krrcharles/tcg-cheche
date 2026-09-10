import { z } from "zod";
import { ConfigurationError } from "./error.js";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_GUILD_ID: z
    .string()
    .regex(/^\d{17,20}$/, "Expected a Discord snowflake string"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: z.string().trim().min(1).default("us-east-1"),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  S3_ACCESS_KEY_ID: z.string().trim().min(1),
  S3_SECRET_ACCESS_KEY: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0),
  S3_BUCKET: z.string().trim().min(1),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    // Report field names and validation failures without echoing secrets.
    throw new ConfigurationError(
      `Invalid environment configuration: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}
