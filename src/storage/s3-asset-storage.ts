import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Environment } from "../config/env.js";
import { type AssetStorage, AssetStorageError } from "./asset-storage.js";

type StorageEnvironment = Pick<
  Environment,
  | "S3_ENDPOINT"
  | "S3_REGION"
  | "S3_FORCE_PATH_STYLE"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_BUCKET"
>;

export class S3AssetStorage implements AssetStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  /** Receives the existing startup-validated environment; never reloads it. */
  constructor(environment: StorageEnvironment) {
    this.bucket = environment.S3_BUCKET;
    this.client = new S3Client({
      endpoint: environment.S3_ENDPOINT,
      region: environment.S3_REGION,
      forcePathStyle: environment.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: environment.S3_ACCESS_KEY_ID,
        secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async put(
    assetKey: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: assetKey,
          Body: bytes,
          ContentType: contentType,
        }),
      );
    } catch (cause) {
      throw new AssetStorageError("put", assetKey, cause);
    }
  }

  async get(assetKey: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: assetKey }),
      );
      if (!response.Body) {
        throw new Error("Object storage returned no response body.");
      }
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (cause) {
      throw new AssetStorageError("get", assetKey, cause);
    }
  }

  async delete(assetKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: assetKey }),
      );
    } catch (cause) {
      throw new AssetStorageError("delete", assetKey, cause);
    }
  }

  /** Release the owned client's connections when the application shuts down. */
  destroy(): void {
    this.client.destroy();
  }
}
