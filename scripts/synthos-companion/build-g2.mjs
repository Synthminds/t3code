import { build } from "esbuild";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const sdkLicense = NodeFS.readFileSync(
  new URL("../LICENSE", import.meta.resolve("@evenrealities/even_hub_sdk")),
  "utf8",
);

await build({
  entryPoints: [NodeURL.fileURLToPath(new URL("./g2/sdk-entry.js", import.meta.url))],
  outfile: NodeURL.fileURLToPath(new URL("./dist/even-sdk.js", import.meta.url)),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  legalComments: "inline",
  minify: true,
  banner: {
    js: `/*! @evenrealities/even_hub_sdk 0.0.16\n${sdkLicense.replaceAll("*/", "* /")} */`,
  },
});
process.stdout.write("Built local Even Hub SDK bundle. Hardware connection is unverified.\n");
