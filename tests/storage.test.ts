import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AssetStorage,
  AssetStorageError,
} from "../src/storage/asset-storage.js";
import { S3AssetStorage } from "../src/storage/s3-asset-storage.js";

const environment = {
  S3_ENDPOINT: "https://objects.example.test:9000",
  S3_REGION: "eu-west-3",
  S3_FORCE_PATH_STYLE: true,
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_BUCKET: "test-card-assets",
};
const assetKey = "cards/charles/legendary + #1.webp";
const bytes = new Uint8Array([0, 255, 128, 42]);

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const send = vi
    .spyOn(S3Client.prototype, "send")
    .mockImplementation(async () => ({}));
  const storage = new S3AssetStorage(environment);
  return { send, storage };
}

describe("S3 card asset storage", () => {
  it.each([true, false])(
    "uses the validated S3 environment with path style %s",
    async (forcePathStyle) => {
      const send = vi
        .spyOn(S3Client.prototype, "send")
        .mockImplementation(async () => ({}));
      const storage = new S3AssetStorage({
        ...environment,
        S3_FORCE_PATH_STYLE: forcePathStyle,
      });
      await storage.delete(assetKey);
      const client = send.mock.contexts[0];
      expect(client).toBeInstanceOf(S3Client);
      if (!(client instanceof S3Client))
        throw new Error("Expected an S3 client");
      expect(await client.config.endpoint?.()).toMatchObject({
        protocol: "https:",
        hostname: "objects.example.test",
        port: 9000,
      });
      expect(await client.config.region()).toBe(environment.S3_REGION);
      expect(client.config.forcePathStyle).toBe(forcePathStyle);
      expect(await client.config.credentials()).toMatchObject({
        accessKeyId: environment.S3_ACCESS_KEY_ID,
        secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
      });
      storage.destroy();
    },
  );

  it("puts and replaces bytes at the same unmodified asset key", async () => {
    const { send, storage } = fixture();
    const assets: AssetStorage = storage;
    await assets.put(assetKey, bytes, "image/webp");
    const replacement = Buffer.from([1, 2, 3]);
    await assets.put(assetKey, replacement, "image/png");
    expect(send).toHaveBeenCalledTimes(2);
    for (const [index, body, contentType] of [
      [0, bytes, "image/webp"],
      [1, replacement, "image/png"],
    ] as const) {
      const command = send.mock.calls[index]?.[0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command?.input).toEqual({
        Bucket: environment.S3_BUCKET,
        Key: assetKey,
        Body: body,
        ContentType: contentType,
      });
    }
    storage.destroy();
  });

  it.each([bytes, new Uint8Array()])(
    "downloads binary bytes, including an empty object, as a Buffer (%j)",
    async (body) => {
      const { send, storage } = fixture();
      const transformToByteArray = vi.fn().mockResolvedValue(body);
      send.mockImplementation(async () => ({ Body: { transformToByteArray } }));
      const result = await storage.get(assetKey);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(Buffer.from(body));
      expect(transformToByteArray).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command?.input).toEqual({
        Bucket: environment.S3_BUCKET,
        Key: assetKey,
      });
      storage.destroy();
    },
  );

  it("deletes by key without a preliminary read", async () => {
    const { send, storage } = fixture();
    await expect(storage.delete(assetKey)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command?.input).toEqual({
      Bucket: environment.S3_BUCKET,
      Key: assetKey,
    });
    storage.destroy();
  });

  it.each(["put", "get", "delete"] as const)(
    "wraps %s failures with context and preserves the cause",
    async (operation) => {
      const { send, storage } = fixture();
      const cause = new Error("access denied or network unavailable");
      send.mockRejectedValue(cause);
      const result =
        operation === "put"
          ? storage.put(assetKey, bytes, "image/webp")
          : storage[operation](assetKey);
      await expect(result).rejects.toMatchObject({
        name: "AssetStorageError",
        operation,
        assetKey,
        cause,
      });
      storage.destroy();
    },
  );

  it("reports a missing key as a failed read, preserving NoSuchKey", async () => {
    const { send, storage } = fixture();
    const cause = new NoSuchKey({
      message: "Missing image",
      $metadata: { httpStatusCode: 404 },
    });
    send.mockRejectedValue(cause);
    await expect(storage.get(assetKey)).rejects.toMatchObject({
      operation: "get",
      assetKey,
      cause,
    });
    storage.destroy();
  });

  it("rejects a missing response body instead of returning an empty image", async () => {
    const { storage } = fixture();
    await expect(storage.get(assetKey)).rejects.toMatchObject({
      name: "AssetStorageError",
      cause: new Error("Object storage returned no response body."),
    });
    storage.destroy();
  });

  it("wraps errors while consuming the response body", async () => {
    const { send, storage } = fixture();
    const cause = new Error("Download interrupted");
    send.mockImplementation(async () => ({
      Body: { transformToByteArray: vi.fn().mockRejectedValue(cause) },
    }));
    await expect(storage.get(assetKey)).rejects.toEqual(
      new AssetStorageError("get", assetKey, cause),
    );
    storage.destroy();
  });

  it("releases the owned S3 client on shutdown", () => {
    const { storage } = fixture();
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    storage.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
