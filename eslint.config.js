// Lint enforces the `[lint]` rules of docs/code-standard.md. Each rule that a preset does not hold has a comment that names its section.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";
import noMagicNumbers from "./eslint-rules/no-magic-numbers.js";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

// The block sits before the `export` keyword, so jsdoc attaches it to the export node, not to the function inside.
const NO_SIDE_EFFECTS = "JsdocBlock:not(:has(JsdocTag[tag='sideEffects']))";
const SIDE_EFFECTS_CONTEXTS = [
  "ExportNamedDeclaration:has(> FunctionDeclaration)",
  "ExportDefaultDeclaration:has(> FunctionDeclaration)",
  "ExportNamedDeclaration:has(> VariableDeclaration > VariableDeclarator > ArrowFunctionExpression)",
  "ExportNamedDeclaration:has(> VariableDeclaration > VariableDeclarator > FunctionExpression)",
].map((context) => ({
  context,
  comment: NO_SIDE_EFFECTS,
  message: "docs/code-standard.md: every exported function's JSDoc block has a @sideEffects tag (`none` if pure).",
}));

// The `no-restricted-syntax` selectors. The rule replaces its options in each config block, so a block builds its list from these.
// Section 1: no type is a union of string literals (a union with 2 string literal members is a set of names). The keys
// that `Pick`, `Omit` and `Record` take are a selection of properties, not a set of names, so they pass.
const STRING_UNION = {
  selector:
    "TSUnionType:not(TSTypeReference[typeName.name=/^(Pick|Omit|Record)$/] > TSTypeParameterInstantiation > TSUnionType):has(> TSLiteralType[literal.raw=/^[\"']/] ~ TSLiteralType[literal.raw=/^[\"']/])",
  message:
    "docs/code-standard.md, section 1: a fixed set of names is an enum in src/domain/enums.ts (or eval/lib/enums.ts), not a union of string literals.",
};
// Section 1: only the 2 enums files declare an enum.
const ENUM_DECLARATION = {
  selector: "TSEnumDeclaration",
  message:
    "docs/code-standard.md, section 1: an enum is declared in src/domain/enums.ts (src/), eval/lib/enums.ts (eval/, scripts/) only.",
};
// Section 1: a zod schema takes the enum itself, with no literal strings.
const ZOD_ENUM_ARRAY = {
  selector: "CallExpression[callee.object.name='z'][callee.property.name='enum'] > ArrayExpression > Literal",
  message:
    "docs/code-standard.md, section 1: a zod schema takes an enum (`z.nativeEnum(Outcome)`), not an array of literal strings.",
};
// Section 2: an index file holds only imports and exports.
const INDEX_LOGIC = {
  selector:
    "Program > :not(:matches(ImportDeclaration, ExportAllDeclaration, ExportNamedDeclaration)), Program > ExportNamedDeclaration[declaration]",
  message:
    "docs/code-standard.md, section 2: an index file holds only imports and exports, no logic and no declaration.",
};
const COMMON_SYNTAX = [STRING_UNION, ENUM_DECLARATION, ZOD_ENUM_ARRAY];

// Section 2: only src/store/ runs SQL, so only it imports the SQLite driver.
const SQLITE_PATHS = ["better-sqlite3", "sqlite-vec"].map((name) => ({
  name,
  message: "docs/code-standard.md, section 2: only src/store/ imports the SQLite driver; go through the store API.",
}));
// Section 2: src/ never imports from eval/, fakes/ or a __tests__/ folder.
const SRC_LAYERING = {
  group: [
    "**/eval",
    "**/eval/**",
    "**/fakes",
    "**/fakes/**",
    "**/__tests__",
    "**/__tests__/**",
    "**/plugin",
    "**/plugin/**",
  ],
  message: "docs/code-standard.md: src/ never imports from eval/, fakes/, plugin/ or __tests__/.",
};
// Section 2: plugin/src/ is self-contained: it imports nothing from outside its own folder (src/, eval/, scripts/).
const PLUGIN_ISOLATION = {
  group: ["../**"],
  message: "docs/code-standard.md, section 2: plugin/src/ imports nothing from src/, eval/ or scripts/.",
};
// Section 2: eval/ imports from src/ through the module index files or the top-level files, never a deep path.
const EVAL_DEEP_IMPORT = {
  regex: "(^|/)src/[^/]+/(?!index\\.js$).+",
  message:
    "docs/code-standard.md, section 2: eval/ imports from src/ through a module index file (src/store/index.js) or a top-level file, never a deep path.",
};

export default defineConfig(
  {
    ignores: [
      "dist/",
      "plugin/dist/",
      "node_modules/",
      ".cache/",
      ".claude/worktrees/",
      "eval/**/results/",
      "eval/**/*-results/",
      "**/*.json",
    ],
  },

  eslint.configs.recommended,

  {
    files: ["**/*.ts"],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      jsdoc.configs["flat/recommended-typescript-error"],
    ],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts", "vitest.ui.config.ts"] },
        tsconfigRootDir,
      },
    },
    plugins: { local: { rules: { "no-magic-numbers": noMagicNumbers } } },
    rules: {
      // Section 4: no `any`, no `!`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // Section 1: a switch over an enum has no `default`, so the compiler reports a missing case.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { allowDefaultCaseForExhaustiveSwitch: false, requireDefaultForNonUnion: false },
      ],
      // Section 4: at most 4 positional parameters.
      "max-params": ["error", 4],
      // Section 5: a magic number has a named constant with a comment on the unit (a local rule: arithmetic in a `const` is the naming).
      "local/no-magic-numbers": "error",
      // Section 4: a return type on every exported function.
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Section 1: names for fixed sets.
      "no-restricted-syntax": ["error", ...COMMON_SYNTAX],
      // Section 5: only src/env.ts reads process.env.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "docs/code-standard.md, section 2: only src/env.ts reads process.env.",
        },
      ],
      // Section 2: only src/store/ imports the SQLite driver.
      "no-restricted-imports": ["error", { paths: SQLITE_PATHS }],
      // Section 3: documentation.
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
          contexts: ["TSEnumDeclaration", "TSTypeAliasDeclaration", "TSInterfaceDeclaration"],
        },
      ],
      "jsdoc/check-tag-names": ["error", { definedTags: ["sideEffects"] }],
      // The standard's example has one blank line between the description and the first tag.
      "jsdoc/require-description": "error",
      "jsdoc/tag-lines": ["error", "never", { startLines: 1 }],
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns-type": "off",
      // Section 3: `@throws` for every `throw`.
      "jsdoc/require-throws": "error",
      "jsdoc/no-restricted-syntax": ["error", { contexts: SIDE_EFFECTS_CONTEXTS }],
    },
  },

  // A library module does not call console, and never imports eval, fakes or tests.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-imports": ["error", { paths: SQLITE_PATHS, patterns: [SRC_LAYERING] }],
    },
  },

  // The enums of src/ sit in a leaf module that imports nothing, so that no import cycle can form.
  {
    files: ["src/domain/enums.ts"],
    rules: {
      "no-restricted-syntax": ["error", STRING_UNION, ZOD_ENUM_ARRAY],
      "no-restricted-imports": [
        "error",
        {
          patterns: [{ regex: ".", message: "docs/code-standard.md, section 1: src/domain/enums.ts imports nothing." }],
        },
      ],
    },
  },

  // The enums that only eval/ and scripts/ use.
  {
    files: ["eval/lib/enums.ts"],
    rules: { "no-restricted-syntax": ["error", STRING_UNION, ZOD_ENUM_ARRAY] },
  },

  // The enums of the plugin sit in their own file; the plugin does not import src/domain/enums.ts.
  {
    files: ["plugin/src/enums.ts"],
    rules: { "no-restricted-syntax": ["error", STRING_UNION, ZOD_ENUM_ARRAY] },
  },

  // The plugin runs in the session of the consumer, apart from the service: it imports nothing from the repo.
  {
    files: ["plugin/src/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { paths: SQLITE_PATHS, patterns: [PLUGIN_ISOLATION] }] },
  },

  // The one reader of the environment in the plugin.
  {
    files: ["plugin/src/env.ts"],
    rules: { "no-restricted-properties": "off" },
  },

  // eval/ goes through the index files of src/.
  {
    files: ["eval/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { paths: SQLITE_PATHS, patterns: [EVAL_DEEP_IMPORT] }] },
  },

  // The one reader of the environment.
  {
    files: ["src/env.ts"],
    rules: { "no-restricted-properties": "off" },
  },

  // An index file exports the public surface of its folder and holds no logic.
  {
    files: ["**/index.ts"],
    rules: { "no-restricted-syntax": ["error", ...COMMON_SYNTAX, INDEX_LOGIC] },
  },

  // The browser script has its own tsconfig (dom lib, no Node types); the project service only knows tsconfig.json.
  {
    files: ["src/console/client/**/*.ts"],
    languageOptions: { parserOptions: { projectService: false, project: "./tsconfig.client.json", tsconfigRootDir } },
  },

  // Tests: the same rules, except documentation, console and the layering of imports.
  {
    files: ["**/__tests__/**/*.ts"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/no-restricted-syntax": "off",
      "local/no-magic-numbers": "off",
      "no-console": "off",
      // A test sets and restores the environment of the child processes it spawns.
      "no-restricted-properties": "off",
      "no-restricted-imports": ["error", { paths: SQLITE_PATHS }],
    },
  },

  // Only src/store/ imports the SQLite driver: its code and its tests.
  {
    files: ["src/store/**/*.ts"],
    ignores: ["**/__tests__/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [SRC_LAYERING] }] },
  },
  {
    files: ["src/store/**/__tests__/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  // Plain JS (this file) has no type information.
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    // No globals package: the .mjs files are Node scripts, so no-undef would flag console and process.
    rules: { "no-undef": "off" },
  },

  prettier,
);
