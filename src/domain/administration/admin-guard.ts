import type { GameConfiguration } from "../../config/game.js";

export class AdminAuthorizationError extends Error {
  constructor() {
    super("You are not authorized to use admin commands.");
  }
}

export function createAdminGuard(admin: GameConfiguration["admin"]) {
  const users = new Set(admin.user_ids);
  return (userId: string): void => {
    if (!users.has(userId)) throw new AdminAuthorizationError();
  };
}
