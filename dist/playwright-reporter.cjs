const { pathToFileURL: __tiaPathToFileURL } = require('node:url');
const __tiaImportMetaUrl = __tiaPathToFileURL(__filename).href;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/playwright/reporter.ts
var reporter_exports = {};
__export(reporter_exports, {
  default: () => TiaPlaywrightReporter
});
module.exports = __toCommonJS(reporter_exports);
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");

// src/shared/paths.ts
var import_node_path = require("node:path");
function windowsPath(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}
function pathApi(...values) {
  if (values.some(windowsPath)) {
    return import_node_path.win32;
  }
  if (values.some((value) => value.startsWith("/"))) {
    return import_node_path.posix;
  }
  return process.platform === "win32" ? import_node_path.win32 : import_node_path.posix;
}
function slash(path) {
  return path.replaceAll("\\", "/");
}
function projectRelative(root, path) {
  const api = pathApi(root, path);
  const candidate = slash(api.relative(root, path));
  if (candidate === "" || candidate === ".") {
    return "";
  }
  if (candidate === ".." || candidate.startsWith("../") || api.isAbsolute(candidate)) {
    return null;
  }
  return candidate;
}

// src/playwright/protocol.ts
var PLAYWRIGHT_DEPENDENCIES_ATTACHMENT = "tiajs.dependencies.json";
var PLAYWRIGHT_SESSION_ENV = "TIA_PLAYWRIGHT_SESSION";
var PLAYWRIGHT_ROOT_ENV = "TIA_PLAYWRIGHT_ROOT";

// src/playwright/reporter.ts
function attachmentDependencies(result) {
  const attachment = result.attachments.find(
    (candidate) => candidate.name === PLAYWRIGHT_DEPENDENCIES_ATTACHMENT
  );
  if (attachment === void 0) {
    return null;
  }
  try {
    const source = attachment.body?.toString("utf8") ?? (attachment.path === void 0 ? null : (0, import_node_fs.readFileSync)(attachment.path, "utf8"));
    if (source === null) {
      return null;
    }
    const value = JSON.parse(source);
    return Array.isArray(value) && value.every((file) => typeof file === "string") ? value : null;
  } catch {
    return null;
  }
}
function observationState(test, result) {
  if (result.status === "skipped") {
    return "skipped";
  }
  return test.ok() ? "passed" : "failed";
}
var TiaPlaywrightReporter = class {
  configuredTestIds = [];
  observations = /* @__PURE__ */ new Map();
  onBegin(_config, suite) {
    this.configuredTestIds = suite.allTests().map((test) => test.id).sort();
  }
  onTestEnd(test, result) {
    const root = process.env[PLAYWRIGHT_ROOT_ENV];
    if (root === void 0) {
      return;
    }
    const file = projectRelative(root, test.location.file);
    if (file === null || file === "") {
      return;
    }
    const dependencies = attachmentDependencies(result);
    this.observations.set(test.id, {
      dependenciesComplete: dependencies !== null || result.status === "skipped",
      duration: result.duration,
      file,
      files: dependencies ?? [],
      fullName: test.titlePath().filter(Boolean).join(" \u203A "),
      id: `playwright:${test.id}`,
      state: observationState(test, result)
    });
  }
  onEnd(result) {
    const target = process.env[PLAYWRIGHT_SESSION_ENV];
    if (target === void 0) {
      return;
    }
    const report = {
      configuredTestIds: this.configuredTestIds,
      observations: [...this.observations.values()],
      status: result.status
    };
    const temporary = `${target}.${process.pid}.tmp`;
    (0, import_node_fs.mkdirSync)((0, import_node_path2.dirname)(target), { recursive: true });
    (0, import_node_fs.writeFileSync)(temporary, `${JSON.stringify(report)}
`, "utf8");
    (0, import_node_fs.renameSync)(temporary, target);
  }
  printsToStdio() {
    return false;
  }
};
//# sourceMappingURL=playwright-reporter.cjs.map
