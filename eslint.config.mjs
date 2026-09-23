import nextConfig from 'eslint-config-next';

const config = [
  ...nextConfig,
  {
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@next/next/no-html-link-for-pages': 'off',
      'no-unused-vars': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Command-line tools (seed, checks, maintenance): printing progress to
    // the terminal is their whole output, not a leftover debug statement.
    files: ['scripts/**', 'solver/**', 'tests/**'],
    rules: {
      'no-console': 'off',
    },
  },
];

export default config;
