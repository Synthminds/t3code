#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptPath = NodeURL.fileURLToPath(import.meta.url);
const checkout = NodePath.resolve(NodePath.dirname(scriptPath), "../..");

export function serviceConfiguration(env = process.env, home = NodeOS.homedir()) {
  const baseDir = env.SYNTHOS_HOME?.trim() || NodePath.join(home, ".synthos");
  const port = env.SYNTHOS_PORT?.trim() || "4317";
  if (!NodePath.isAbsolute(baseDir) || /[\u0000-\u001f\u007f]/u.test(baseDir)) {
    throw new Error("SYNTHOS_HOME must be an absolute path without control characters.");
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("SYNTHOS_PORT must be an integer from 1 through 65535.");
  }
  // Do not inherit an official desktop's bootstrap, data home, or dev-server configuration.
  // Provider credentials remain available through their ordinary environment and CLI login.
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("T3CODE_") && !key.startsWith("T3_") && key !== "VITE_DEV_SERVER_URL",
    ),
  );
  Object.assign(childEnv, {
    NODE_ENV: "production",
    T3CODE_HOME: baseDir,
    T3CODE_TAILSCALE_SERVE: "false",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  });
  return {
    baseDir,
    port,
    env: childEnv,
    args: [
      NodePath.join(checkout, "apps/server/dist/bin.mjs"),
      "start",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      port,
      "--no-browser",
      "--base-dir",
      baseDir,
    ],
  };
}

function quoteUnitValue(value, command = false) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Service paths and environment values cannot contain control characters.");
  }
  const escaped = value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${command ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

export async function renderUnit(config, options = {}) {
  const template = await NodeFSP.readFile(
    NodePath.join(NodePath.dirname(scriptPath), "synthos-source.service.in"),
    "utf8",
  );
  const directory = options.checkout ?? checkout;
  if (
    !NodePath.isAbsolute(directory) ||
    /[\u0000-\u001f\u007f]/u.test(directory) ||
    directory.trim() !== directory
  ) {
    throw new Error(
      "The checkout must have an absolute path without control characters or surrounding whitespace.",
    );
  }
  const replacements = {
    // WorkingDirectory takes a literal path, unlike the shell-style ExecStart/Environment grammar.
    CHECKOUT: directory.replaceAll("%", "%%"),
    HOME: quoteUnitValue(`SYNTHOS_HOME=${config.baseDir}`),
    PORT: quoteUnitValue(`SYNTHOS_PORT=${config.port}`),
    PATH: quoteUnitValue(`PATH=${config.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`),
    NODE: quoteUnitValue(options.node ?? process.execPath, true),
    HELPER: quoteUnitValue(options.helper ?? scriptPath, true),
  };
  return template.replace(/@([A-Z]+)@/g, (_, key) => replacements[key]);
}

async function checkBuild(config) {
  try {
    await NodeFSP.access(config.args[0]);
    await NodeFSP.access(NodePath.join(checkout, "apps/server/dist/client/index.html"));
  } catch {
    throw new Error(
      "Build this checkout first: node_modules/.bin/vp run --filter t3 build. Keep the checkout, installed dependencies, and this Node executable in place while the service is installed.",
    );
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--print-unit", "--check", "--run"].includes(mode)) {
    throw new Error("Usage: node scripts/synthos-service/run.mjs --print-unit | --check | --run");
  }
  const config = serviceConfiguration();
  if (mode === "--print-unit") {
    process.stdout.write(await renderUnit(config));
    return;
  }
  await checkBuild(config);
  if (mode === "--check") {
    process.stdout.write(
      `SynthOS source service ready at http://127.0.0.1:${config.port}; data: ${config.baseDir}\n`,
    );
    return;
  }
  const child = NodeChildProcess.spawn(process.execPath, config.args, {
    cwd: checkout,
    env: config.env,
    stdio: "inherit",
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        accept(code ?? 128 + (NodeOS.constants.signals[signal] ?? 1)),
      );
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
