// Read-only provider interface the API consumes (no game imports here)
import type {
    SummaryDTO,
    PlayerDTO,
    PlanetDTO,
    StarDTO,
    BlackholeDTO,
    BaseDTO,
} from "./dto.js";

export interface GameStateProvider {
    getSummary(): Readonly<SummaryDTO>;
    listPlayers(): readonly Readonly<PlayerDTO>[];
    listPlanets(): readonly Readonly<PlanetDTO>[];
    listStars(): readonly Readonly<StarDTO>[];
    listBlackholes(): readonly Readonly<BlackholeDTO>[];
    listBases(): readonly Readonly<BaseDTO>[];
}
