// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * The shared flat config, parameterised by the calling package's own directory.
 *
 * `tsconfigRootDir` is passed in rather than derived here on purpose. `projectService` resolves a
 * file's program by walking up from `tsconfigRootDir`, so a single root-anchored value would make
 * every sibling package's sources "not found by the project service" — a fatal, not a skip. Each
 * package therefore hands us its `import.meta.dirname`.
 *
 * `ignores` is relative to the config file that ESLint loaded, i.e. the package directory, so
 * `dist/` here means that package's `dist/`. `eslint.config.js` is ignored for the same reason
 * `smoke.mjs` used to be: no package tsconfig includes it, and `projectService` fatals on that.
 *
 * @param {string} tsconfigRootDir
 */
export function baseConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores: ["dist/", "node_modules/", "eslint.config.js"] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        // env defaults intentionally use `||` so empty strings fall back to a default.
        "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],
        // process.env access is via bracket notation under noPropertyAccessFromIndexSignature.
        "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],
        // we use union type aliases, so prefer `type` over `interface` consistently.
        "@typescript-eslint/consistent-type-definitions": ["error", "type"],
        // numbers in log/error template strings are intentional and safe.
        "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
        // mirror tsconfig's noUnusedParameters: a leading underscore marks an intentionally-unused arg.
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      },
    },
    prettier,
  );
}
