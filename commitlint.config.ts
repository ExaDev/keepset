/**
 * The conventional-commit types this project accepts. json-compose derives this list from its release.config.ts (commit-analyzer's releaseRules and commitlint share one source there); keepset defers its release configuration entirely (see issue #15), so the list stands here alone until release.config.ts lands and becomes the single source again. It is byte-for-byte the same list, so nothing is accepted or rejected differently in the meantime.
 */
const commitTypes: readonly string[] = [
  'feat',
  'fix',
  'perf',
  'revert',
  'refactor',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'chore',
];

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', commitTypes],
  },
};
