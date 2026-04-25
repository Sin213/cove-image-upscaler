// Types are defined in electron/types.ts (the source of truth) and re-exported
// here so renderer code can import from `./types`. The `declare global`
// augmentation for `window.cove` lives in electron/types.ts and applies to the
// renderer because tsconfig.json includes that file.
export type * from "../electron/types";
