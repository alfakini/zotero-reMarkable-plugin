import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const repo = "https://github.com/{{owner}}/{{repo}}/releases/download";

export default defineConfig({
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  source: ["src", "addon"],
  dist: ".scaffold/build",
  // A fixed file name keeps releases/latest/download/<name>.xpi stable.
  xpiName: "zotero-remarkable-sync",
  updateURL: `${repo}/release/${pkg.version.includes("-") ? "update-beta.json" : "update.json"}`,
  xpiDownloadLink: `${repo}/v{{version}}/{{xpiName}}.xpi`,
  build: {
    assets: ["addon/**/*.*"],
    // Replaces __key__ placeholders in addon/ files.
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
    },
    prefs: { prefix: pkg.config.prefsPrefix },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },
  release: {
    bumpp: { commit: "Release v%s" },
  },
});
