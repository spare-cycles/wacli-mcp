// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "smoke.mjs", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
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
