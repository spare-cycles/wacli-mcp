// @ts-check
import tseslint from "typescript-eslint";
import { baseConfig } from "../../eslint.base.js";

// Global Constraint 1, mechanically. Absence from `package.json` is the primary defence, but pnpm's
// layout is not a guarantee against every hoisting arrangement and `node:sqlite` is a builtin no
// manifest can withhold at all, so both are also a lint failure rather than a review catch.
export default tseslint.config(...baseConfig(import.meta.dirname), {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "baileys", message: "packages/mcp must never import Baileys — see Global Constraint 1." },
          { name: "node:sqlite", message: "packages/mcp holds no store — reads go through the SDK client." },
        ],
      },
    ],
  },
});
