// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**', '.claude/**'] },
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
      // Архитектурное правило ТЗ §15.1 п.7: прямой fetch из инструментов запрещён,
      // сетевой вызов делает только bitrix/client.ts. Проверяется отдельным тестом
      // tests/security/no-direct-fetch.test.ts, здесь — подстраховка.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Используйте BitrixClient; прямой fetch запрещён (ТЗ §15.1 п.7).' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Данные Bitrix читаются по строковым ключам (obj['ID']) осознанно: это внешний формат, не наш тип.
      '@typescript-eslint/dot-notation': 'off',
      // get<T>(sql) / consume<T>(id): тип результата выбирает вызывающий — это осознанный приём.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // Единственные места, где сетевой вызов разрешён.
    files: ['src/bitrix/client.ts', 'src/bitrix/http.ts', 'tests/**/*.ts', 'src/cli/mcp-smoke.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts', 'scripts/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
