import nextConfig from 'eslint-config-next';

export default [
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
];
