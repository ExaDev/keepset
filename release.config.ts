import type { Options } from 'semantic-release';

type ReleaseLevel = 'major' | 'minor' | 'patch' | false;

interface CommitType {
  readonly type: string;
  readonly release: ReleaseLevel;
}

/**
 * Single source of truth for the conventional-commit types this project uses. commitlint's allowed type-enum (commitlint.config.ts imports this) and commit-analyzer's releaseRules below both derive from it, so a type cannot trigger a release without also being accepted by commit-msg validation, or the reverse.
 */
export const commitTypes: readonly CommitType[] = [
  { type: 'feat', release: 'minor' },
  { type: 'fix', release: 'patch' },
  { type: 'perf', release: 'patch' },
  { type: 'revert', release: 'patch' },
  { type: 'refactor', release: 'patch' },
  { type: 'docs', release: 'patch' },
  { type: 'style', release: 'patch' },
  { type: 'test', release: 'patch' },
  { type: 'build', release: 'patch' },
  { type: 'ci', release: 'patch' },
  { type: 'chore', release: 'patch' },
];

/**
 * Runs on `main`. Analyses commits since the last tag, bumps the version, publishes to npmjs.org through trusted OIDC publishing (no stored token, see .github/workflows/ci.yml), creates a versioned tag and GitHub Release with generated notes, and commits CHANGELOG.md and package.json back to main. The repository URL is the one in package.json, over https with the workflow's GITHUB_TOKEN: main has no ruleset, so that token can push the release commit. A ruleset on main would reject that push and need a bypass identity (json-compose's deploy key is the worked example).
 */
const config: Options = {
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        releaseRules: [{ breaking: true, release: 'major' }, ...commitTypes.map((t) => ({ type: t.type, release: t.release }))],
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        // Deliberately angular, not conventionalcommits: conventional-changelog-writer's bundled commit partial does not match the conventionalcommits preset's function-based partial signature, producing a changelog with a version header and nothing under it.
        preset: 'angular',
      },
    ],
    '@semantic-release/changelog',
    ['@semantic-release/npm', { npmPublish: true }],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]',
      },
    ],
  ],
};

export default config;
