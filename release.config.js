module.exports = {
  repositoryUrl: 'https://github.com/PolymeshAssociation/polymesh-subquery.git',
  branches: [
    'master',
    {
      name: 'alpha',
      prerelease: true,
    },
  ],
  /*
   * The expectation is for Github plugin to create a tag that begins with `v`, which triggers a workflow for publishing a docker container
   */
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    [
      '@semantic-release/npm',
      {
        npmPublish: false,
      },
    ],
    [
      '@semantic-release/github',
      {
        assets: ['CHANGELOG.md'],
      },
    ],
  ],
};
