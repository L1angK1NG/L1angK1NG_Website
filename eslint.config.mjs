// ESLint 扁平配置：覆盖 Node 后端（admin/、scripts/）、浏览器脚本（src/lib、
// src/scripts）与测试（tests/）的纯 JS/MJS 文件。.astro / .ts 文件交给
// astro check / TypeScript，不在这里重复检查。
//
// 规则取向：只开「几乎不可能误报」的一档（eslint:recommended 里挑稳的），
// 零依赖可跑（npm run lint），作为回归兜底而非风格警察。
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['admin/**/*.{js,mjs}', 'scripts/**/*.mjs', 'src/lib/**/*.js', 'src/scripts/**/*.js', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // 全局对象横跨 Node 与浏览器两套环境，no-undef 误报率过高，交由类型检查兜底。
      'no-undef': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': 'off',
    },
  },
];
