// @author yxpil
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'docs/**',
      'release/**',
      'out/**',
      '.tmp/**',
      '*.md',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.{mts,ts}'],
    rules: { '@typescript-eslint/no-require-imports': 'error' },
  },
  {
    // TS 侧由编译器负责未定义标识符，no-undef 在 TS 项目里是噪音
    files: ['**/*.{ts,tsx,mts}'],
    rules: { 'no-undef': 'off' },
  },
  {
    // 主进程与 CLI 脚本需要 stdout；渲染层仍然禁 console（走通知中心与 Toast）
    files: ['electron/**', 'scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // 纯 Node 脚本没有 TS 环境，显式声明运行时全局
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // CLI 的 CJS 引导壳：只有 require/__dirname/process，不含业务逻辑
    files: ['bin/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
