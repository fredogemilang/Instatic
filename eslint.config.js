import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// React Compiler ESLint rule is NOT enabled — see vite.config.ts for why
// the compiler itself was rolled back. The eslint plugin is meaningless
// without the compiler running.

export default defineConfig([
  globalIgnores(['dist', '.worktrees']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // `varsIgnorePattern` includes `Schema$` because TypeBox's idiom is
      //   const FooSchema = Type.Object({ ... })
      //   export type Foo = Static<typeof FooSchema>
      // The schema MUST be a runtime value (the source of truth — `Static`
      // reads it through `typeof`). Eslint's `no-unused-vars` does not count
      // `typeof` references as a "use" of the value, so non-exported leaf
      // schemas would otherwise trip the rule. We allow that pattern by name.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '(^_|Schema$)',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // The editor store uses TypeScript declaration merging: `EditorStore` is
      // declared as an empty interface in `src/core/editor-store/types.ts` and
      // each slice file augments it via
      //   declare module '@core/editor-store/types' {
      //     interface EditorStore extends MySlice {}
      //   }
      // That requires both the original empty interface AND each per-slice
      // empty-extends form. They are not redundant — the empty body is the
      // augmentation point, removing it would break the type. Allowlist the
      // one identifier this pattern uses, project-wide.
      '@typescript-eslint/no-empty-object-type': ['error', {
        allowWithName: '^EditorStore$',
      }],
    },
  },
  {
    files: ['src/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-constant-condition': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
])
