import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { renderUnit, serviceConfiguration } from "./run.mjs";

NodeTest.test(
  "source service isolates inherited T3 configuration while retaining provider login environment",
  () => {
    const config = serviceConfiguration(
      {
        T3CODE_HOME: "/operator/.t3",
        T3CODE_HOST: "0.0.0.0",
        T3CODE_BOOTSTRAP_FD: "3",
        T3CODE_TAILSCALE_SERVE: "true",
        T3_BOOT_SERVICE_UNIT: "t3code.service",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        OPENAI_API_KEY: "fixture-only",
      },
      "/operator",
    );
    NodeAssert.equal(config.baseDir, "/operator/.synthos");
    NodeAssert.equal(config.env.T3CODE_HOME, "/operator/.synthos");
    NodeAssert.equal(config.env.T3CODE_TAILSCALE_SERVE, "false");
    NodeAssert.equal(config.env.T3CODE_BOOTSTRAP_FD, undefined);
    NodeAssert.equal(config.env.VITE_DEV_SERVER_URL, undefined);
    NodeAssert.equal(config.env.T3_BOOT_SERVICE_UNIT, undefined);
    NodeAssert.equal(config.env.OPENAI_API_KEY, "fixture-only");
    NodeAssert.equal(config.args[config.args.indexOf("--host") + 1], "127.0.0.1");
    NodeAssert.ok(config.args[0].endsWith("/apps/server/dist/bin.mjs"));
  },
);

NodeTest.test(
  "unit rendering keeps spaces, percent specifiers, and dollar signs literal",
  async () => {
    const config = serviceConfiguration({
      SYNTHOS_HOME: '/opt/Synth OS/100%/"data"',
      SYNTHOS_PORT: "4321",
    });
    const unit = await renderUnit(config, {
      checkout: "/opt/100%/Synth OS",
      node: "/opt/$NODE/bin/node",
      helper: "/opt/100%/Synth OS/run.mjs",
    });
    NodeAssert.ok(unit.includes("WorkingDirectory=/opt/100%%/Synth OS\n"));
    NodeAssert.ok(
      unit.includes('ExecStart="/opt/$$NODE/bin/node" "/opt/100%%/Synth OS/run.mjs" --run'),
    );
    NodeAssert.ok(unit.includes('Environment="SYNTHOS_HOME=/opt/Synth OS/100%%/\\"data\\""'));
    NodeAssert.ok(unit.includes('Environment="SYNTHOS_PORT=4321"'));
    NodeAssert.ok(!unit.includes("fixture-only"));
    await NodeAssert.rejects(
      renderUnit(config, { helper: "/safe\nExecStart=/bad" }),
      /control characters/,
    );
  },
);

NodeTest.test("invalid home and port overrides cannot produce a unit or launch a server", () => {
  for (const home of ["relative", "/data\nExecStart=/bad"]) {
    NodeAssert.throws(() => serviceConfiguration({ SYNTHOS_HOME: home }), /SYNTHOS_HOME/);
  }
  for (const port of ["0", "65536", "3.5", "4321 --host 0.0.0.0"]) {
    NodeAssert.throws(() => serviceConfiguration({ SYNTHOS_PORT: port }), /SYNTHOS_PORT/);
  }
});
