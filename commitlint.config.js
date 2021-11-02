module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [message => /^chore\(release\): \d+\.\d+\.\d+ \[skip ci\]/.test(message)],
};
