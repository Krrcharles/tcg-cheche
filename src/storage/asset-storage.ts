export interface AssetStorage {
  /** Upload or replace the image at the exact catalogue asset key. */
  put(assetKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Retrieve private image bytes suitable for a Discord attachment. */
  get(assetKey: string): Promise<Buffer>;
  delete(assetKey: string): Promise<void>;
}

export class AssetStorageError extends Error {
  constructor(
    readonly operation: "put" | "get" | "delete",
    readonly assetKey: string,
    cause: unknown,
  ) {
    super(`Card asset storage ${operation} failed.`, { cause });
    this.name = "AssetStorageError";
  }
}
