// Metro config tuned for our pnpm monorepo layout.
//
// Without this, Metro can resolve two copies of React when the bundle pulls in
// dependencies via `@teamclaw/app` (whose radix-ui transitive deps want a
// newer React than `apps/expo` declares). Two Reacts in the same bundle break
// hooks at runtime ("Cannot read property 'useMemo' of null"). The fix is to
// force a single resolution rooted in `apps/expo/node_modules` and explicitly
// alias react/react-native to the symlinks pnpm planted there.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

config.resolver.disableHierarchicalLookup = true;

config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
};

module.exports = config;
