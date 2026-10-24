// @ts-check
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");
const securityPlugin = require("eslint-plugin-security");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security: securityPlugin,
    },
    rules: {
      ...tsPlugin.configs["recommended"].rules,
      ...securityPlugin.configs.recommended.rules,
      "no-console": "warn",
      // Rest-sibling destructuring (`{ dropped: _x, ...rest }`) is how fields get omitted.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      // `declare global { namespace Express { ... } }` is the only way to augment Express's types.
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "@typescript-eslint/explicit-function-return-type": "warn",
    },
  },
];
