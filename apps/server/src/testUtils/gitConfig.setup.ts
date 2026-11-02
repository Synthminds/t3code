// Override inherited autocrlf, signing and init-branch settings through env so every git child gets stable fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

// Inherited url.<base>.insteadOf rewrites change the remote URLs git reports back for fixtures.
// Sandboxed shells inject them through env, and git has no setting that cancels one, so drop them.
const isUrlRewrite = (key: string) => /^url\..+\.(?:push)?insteadof$/i.test(key);
const inherited = Array.from(
  { length: Number(process.env.GIT_CONFIG_COUNT ?? "0") },
  (_, index) => {
    const entry = [
      process.env[`GIT_CONFIG_KEY_${index}`] ?? "",
      process.env[`GIT_CONFIG_VALUE_${index}`] ?? "",
    ] as const;
    delete process.env[`GIT_CONFIG_KEY_${index}`];
    delete process.env[`GIT_CONFIG_VALUE_${index}`];
    return entry;
  },
);

const config = [...inherited.filter(([key]) => !isUrlRewrite(key)), ...entries];
process.env.GIT_CONFIG_COUNT = String(config.length);
config.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
});
