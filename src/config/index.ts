import { type Environment, loadEnvironment } from "./env.js";
import { type GameConfiguration, loadGameConfiguration } from "./game.js";

export type Configuration = {
  environment: Environment;
  game: GameConfiguration;
};

export function loadConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  gamePath = "config/game.yaml",
): Configuration {
  return {
    environment: loadEnvironment(environment),
    game: loadGameConfiguration(gamePath),
  };
}
