// Tiny shim — re-exports F:\Brigade's existing version constant under the
// names the lifted code expects (`./version.js` from `core/`). Avoids
// duplicating the version literal; single source of truth stays at
// `src/version.ts`.
import { VERSION } from "../version.js";

export { VERSION };
// Alias the lifted callers use (Downloads/Brigade calls it BRIGADE_CLI_VERSION).
export const BRIGADE_CLI_VERSION = VERSION;
