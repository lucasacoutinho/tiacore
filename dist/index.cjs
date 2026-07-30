const { pathToFileURL: __tiaPathToFileURL } = require('node:url');
const __tiaImportMetaUrl = __tiaPathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => tia,
  tia: () => tia
});
module.exports = __toCommonJS(index_exports);

// src/vitest/plugin.ts
var import_node_fs13 = require("node:fs");
var import_node_path19 = require("node:path");
var import_node_url = require("node:url");
var import_istanbul_lib_instrument2 = require("istanbul-lib-instrument");
var import_picomatch7 = __toESM(require("picomatch"), 1);

// src/shared/constants.ts
var GRAPH_SCHEMA_VERSION = 3;
var PLUGIN_VERSION = "0.1.0";
var TIA_META_KEY = "__tiajs__";
var TIA_REPLAY_META_KEY = "__tiajs_replay__";
var TIA_SELECTION_KEY = "__tiajs_selection__";
var TIA_TEST_META_KEY = "__tiajs_test__";
var DEFAULT_INCLUDE = ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"];
var DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.tia/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.{test,spec}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
  "**/__tests__/**",
  "**/__mocks__/**"
];
var TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/;
var STRUCTURAL_FILE_PATTERN = /^(?:package\.json|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json|(?:vite|vitest)(?:\.[^.]+)?\.config\.[cm]?[jt]s)$/;

// src/graph/merge.ts
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function mergeRecord(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (current !== void 0 && !same(current, value)) {
      return false;
    }
    target[key] = structuredClone(value);
  }
  return true;
}
function mergePartitionedGraphs(fragments) {
  if (fragments.length === 0) {
    return null;
  }
  const first = fragments[0];
  if (first === void 0 || first.partition === void 0) {
    return null;
  }
  const total = first.partition.total;
  const group = first.partition.group;
  const baseline = JSON.stringify(first.baseline);
  const fingerprint = first.fingerprint;
  const partitions = /* @__PURE__ */ new Map();
  for (const fragment of fragments) {
    const partition = fragment.partition;
    if (partition === void 0 || partition.total !== total || partition.group !== group || fragment.complete || fragment.fingerprint !== fingerprint || JSON.stringify(fragment.baseline) !== baseline) {
      continue;
    }
    const existing = partitions.get(partition.index);
    if (existing !== void 0 && !same(existing, fragment)) {
      return null;
    }
    partitions.set(partition.index, fragment);
  }
  if (partitions.size !== total || [...Array.from({ length: total }, (_, index) => index + 1)].some(
    (index) => !partitions.has(index)
  )) {
    return null;
  }
  const merged = {
    baseline: structuredClone(first.baseline),
    collectionCoverage: {},
    complete: true,
    coverageComplete: true,
    edges: {},
    fingerprint,
    results: {},
    schema: first.schema,
    testCoverage: {},
    testEdges: {},
    updatedAt: ""
  };
  for (const fragment of [...partitions.values()].sort(
    (left, right) => left.partition.index - right.partition.index
  )) {
    if (!mergeRecord(merged.edges, fragment.edges) || !mergeRecord(merged.results, fragment.results) || !mergeRecord(merged.testEdges, fragment.testEdges) || !mergeRecord(
      merged.collectionCoverage,
      fragment.collectionCoverage
    ) || !mergeRecord(merged.testCoverage, fragment.testCoverage)) {
      return null;
    }
    merged.coverageComplete &&= fragment.coverageComplete;
    if (fragment.updatedAt > merged.updatedAt) {
      merged.updatedAt = fragment.updatedAt;
    }
  }
  return merged;
}

// src/graph/state.ts
var import_node_fs = require("node:fs");
var import_node_crypto = require("node:crypto");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function graphPath(cacheDir) {
  return (0, import_node_path.join)(cacheDir, "graph.json");
}
function graphDigest(graph) {
  return graph === null ? null : (0, import_node_crypto.createHash)("sha256").update(JSON.stringify(graph)).digest("hex");
}
function readGraph(cacheDir) {
  try {
    return parseGraph((0, import_node_fs.readFileSync)(graphPath(cacheDir), "utf8"));
  } catch {
    return null;
  }
}
function parseGraph(source) {
  try {
    const value = typeof source === "string" ? JSON.parse(source) : source;
    if (!isGraph(value)) {
      return null;
    }
    if (value.schema === 1 || value.schema === 2) {
      return {
        ...value,
        collectionCoverage: {},
        coverageComplete: false,
        schema: GRAPH_SCHEMA_VERSION,
        testCoverage: {},
        testEdges: value.schema === 1 ? {} : value.testEdges
      };
    }
    return value;
  } catch {
    return null;
  }
}
function writeGraph(cacheDir, graph) {
  const target = graphPath(cacheDir);
  const temporary = `${target}.${process.pid}.${(0, import_node_crypto.randomUUID)()}.tmp`;
  (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(target), { recursive: true });
  try {
    (0, import_node_fs.writeFileSync)(
      temporary,
      `${JSON.stringify(graph, null, 2)}
`,
      "utf8"
    );
    (0, import_node_fs.renameSync)(temporary, target);
  } finally {
    (0, import_node_fs.rmSync)(temporary, { force: true });
  }
}
var wait = (milliseconds) => new Promise((resolve14) => setTimeout(resolve14, milliseconds));
function lockPath(cacheDir) {
  return (0, import_node_path.join)(cacheDir, "graph.lock");
}
function lockOwner(path) {
  try {
    const value = JSON.parse(
      (0, import_node_fs.readFileSync)((0, import_node_path.join)(path, "owner.json"), "utf8")
    );
    return typeof value.createdAt === "number" && typeof value.hostname === "string" && typeof value.pid === "number" && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
function staleLock(path, staleAfter) {
  try {
    const owner = lockOwner(path);
    const age = Date.now() - (owner?.createdAt ?? (0, import_node_fs.statSync)(path).mtimeMs);
    if (owner?.hostname === (0, import_node_os.hostname)() && !processAlive(owner.pid)) {
      return true;
    }
    return age >= staleAfter;
  } catch {
    return false;
  }
}
async function acquireLock(cacheDir, timeout, staleAfter) {
  const path = lockPath(cacheDir);
  const started = Date.now();
  (0, import_node_fs.mkdirSync)(cacheDir, { recursive: true });
  while (Date.now() - started < timeout) {
    const owner = {
      createdAt: Date.now(),
      hostname: (0, import_node_os.hostname)(),
      pid: process.pid,
      token: (0, import_node_crypto.randomUUID)()
    };
    try {
      (0, import_node_fs.mkdirSync)(path);
      (0, import_node_fs.writeFileSync)(
        (0, import_node_path.join)(path, "owner.json"),
        `${JSON.stringify(owner)}
`,
        "utf8"
      );
      return owner;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    if (staleLock(path, staleAfter)) {
      (0, import_node_fs.rmSync)(path, { force: true, recursive: true });
      continue;
    }
    await wait(20 + Math.floor(Math.random() * 30));
  }
  return null;
}
function releaseLock(cacheDir, owner) {
  const path = lockPath(cacheDir);
  if (lockOwner(path)?.token === owner.token) {
    (0, import_node_fs.rmSync)(path, { force: true, recursive: true });
  }
}
function cleanAbandonedWrites(cacheDir) {
  try {
    for (const entry of (0, import_node_fs.readdirSync)(cacheDir)) {
      if (/^graph\.json\.\d+\.[\da-f-]{36}\.tmp$/i.test(entry)) {
        (0, import_node_fs.rmSync)((0, import_node_path.join)(cacheDir, entry), { force: true });
      }
    }
  } catch {
  }
}
function same2(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameResult(left, right) {
  if (!isRecord(left) || !isRecord(right)) {
    return same2(left, right);
  }
  const { duration: _leftDuration, ...leftValue } = left;
  const { duration: _rightDuration, ...rightValue } = right;
  return same2(leftValue, rightValue);
}
function mergeChangedRecord(expected, current, proposed, equivalent = same2) {
  const keys = /* @__PURE__ */ new Set([
    ...Object.keys(expected),
    ...Object.keys(current),
    ...Object.keys(proposed)
  ]);
  for (const key of keys) {
    const before = expected[key];
    const ours = proposed[key];
    const theirs = current[key];
    const oursChanged = !equivalent(ours, before);
    if (!oursChanged) {
      continue;
    }
    const theirsChanged = !equivalent(theirs, before);
    if (theirsChanged && !equivalent(ours, theirs)) {
      return false;
    }
    if (ours === void 0) {
      delete current[key];
    } else {
      current[key] = structuredClone(ours);
    }
  }
  return true;
}
function compatibleCommit(left, right) {
  return left.schema === right.schema && left.fingerprint === right.fingerprint && left.complete === right.complete && left.coverageComplete === right.coverageComplete && same2(left.baseline, right.baseline) && same2(left.partition, right.partition);
}
function mergeConcurrentGraphs(expected, current, proposed) {
  if (!compatibleCommit(current, proposed)) {
    return null;
  }
  const before = expected ?? {
    collectionCoverage: {},
    edges: {},
    results: {},
    testCoverage: {},
    testEdges: {}
  };
  const merged = structuredClone(current);
  const records = [
    ["collectionCoverage", same2],
    ["edges", same2],
    ["results", sameResult],
    ["testCoverage", same2],
    ["testEdges", same2]
  ];
  for (const [key, equivalent] of records) {
    if (!mergeChangedRecord(
      before[key],
      merged[key],
      proposed[key],
      equivalent
    )) {
      return null;
    }
  }
  merged.updatedAt = proposed.updatedAt > current.updatedAt ? proposed.updatedAt : current.updatedAt;
  return merged;
}
async function commitGraph(cacheDir, options) {
  if (graphDigest(options.expected) !== options.expectedDigest) {
    return { graph: readGraph(cacheDir), status: "conflict" };
  }
  const owner = await acquireLock(
    cacheDir,
    options.lockTimeoutMs ?? 1e4,
    options.staleLockMs ?? 12e4
  );
  if (owner === null) {
    return { graph: readGraph(cacheDir), status: "conflict" };
  }
  try {
    cleanAbandonedWrites(cacheDir);
    const current = readGraph(cacheDir);
    if (graphDigest(current) === options.expectedDigest) {
      writeGraph(cacheDir, options.graph);
      return {
        graph: structuredClone(options.graph),
        status: "committed"
      };
    }
    if (current === null) {
      return { graph: null, status: "conflict" };
    }
    const merged = mergeConcurrentGraphs(
      options.expected,
      current,
      options.graph
    );
    if (merged === null) {
      return { graph: current, status: "conflict" };
    }
    writeGraph(cacheDir, merged);
    return { graph: merged, status: "merged" };
  } finally {
    releaseLock(cacheDir, owner);
  }
}
function purgeGraph(cacheDir) {
  (0, import_node_fs.rmSync)(graphPath(cacheDir), { force: true });
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isGraph(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (value.schema !== 1 && value.schema !== 2 && value.schema !== GRAPH_SCHEMA_VERSION || typeof value.complete !== "boolean" || typeof value.fingerprint !== "string" || !isRecord(value.baseline) || typeof value.baseline.sha !== "string" || value.baseline.source !== void 0 && value.baseline.source !== "filesystem" && value.baseline.source !== "git" || !isRecord(value.baseline.workingTree) || !isRecord(value.edges) || !isRecord(value.results) || typeof value.updatedAt !== "string") {
    return false;
  }
  const workingTree = value.baseline.workingTree;
  const edges = value.edges;
  const results = value.results;
  const testEdges = value.testEdges;
  const collectionCoverage = value.collectionCoverage;
  const testCoverage = value.testCoverage;
  const partition = value.partition;
  return Object.values(workingTree).every((hash) => typeof hash === "string") && Object.values(edges).every(
    (files) => Array.isArray(files) && files.every((file) => typeof file === "string")
  ) && Object.values(results).every(
    (result) => isRecord(result) && typeof result.id === "string" && typeof result.file === "string" && typeof result.fullName === "string" && (result.state === "passed" || result.state === "failed" || result.state === "skipped") && (result.duration === void 0 || typeof result.duration === "number")
  ) && (value.schema === 1 || isRecord(testEdges) && Object.values(testEdges).every(
    (edge) => isRecord(edge) && typeof edge.file === "string" && Array.isArray(edge.files) && edge.files.every((file) => typeof file === "string")
  )) && (value.schema !== GRAPH_SCHEMA_VERSION || typeof value.coverageComplete === "boolean" && isRecord(collectionCoverage) && Object.values(collectionCoverage).every(isRecord) && isRecord(testCoverage) && Object.values(testCoverage).every(isRecord)) && (partition === void 0 || isRecord(partition) && (partition.group === void 0 || typeof partition.group === "string") && Number.isInteger(partition.index) && Number.isInteger(partition.total) && partition.index >= 1 && partition.total >= partition.index);
}

// src/artifacts/github-actions.ts
var import_fflate = require("fflate");
var import_picomatch = __toESM(require("picomatch"), 1);
var MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
var MAX_GRAPH_BYTES = 20 * 1024 * 1024;
function normalizedOptions(options) {
  return {
    apiUrl: options.apiUrl ?? "https://api.github.com",
    artifactName: options.artifactName ?? "tiajs",
    branch: options.branch ?? null,
    maxArtifacts: Math.max(
      1,
      Math.min(100, options.maxArtifacts ?? 20)
    ),
    repository: options.repository ?? process.env.GITHUB_REPOSITORY ?? null,
    runId: options.runId === void 0 ? null : String(options.runId),
    tokenEnv: options.tokenEnv ?? "GITHUB_TOKEN"
  };
}
function repositoryParts(repository) {
  if (repository === null) {
    return null;
  }
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository);
  return match === null ? null : [match[1], match[2]];
}
function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    ...token === void 0 || token === "" ? {} : { Authorization: `Bearer ${token}` },
    "X-GitHub-Api-Version": "2022-11-28"
  };
}
function archiveGraph(archive, runner) {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    return null;
  }
  const paths = [
    ...runner === void 0 ? ["graph.json", ".tia/graph.json"] : [
      `${runner}/graph.json`,
      `.tia/${runner}/graph.json`
    ]
  ];
  const allowedPaths = new Set(paths);
  let entries;
  try {
    entries = (0, import_fflate.unzipSync)(archive, {
      filter: (entry) => allowedPaths.has(entry.name) && entry.originalSize <= MAX_GRAPH_BYTES
    });
  } catch {
    return null;
  }
  for (const path of paths) {
    const bytes = entries[path];
    if (bytes === void 0 || bytes.byteLength > MAX_GRAPH_BYTES) {
      continue;
    }
    const graph = parseGraph((0, import_fflate.strFromU8)(bytes));
    if (graph !== null) {
      return graph;
    }
  }
  return null;
}
async function readBoundedResponse(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === void 0) {
    return null;
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function artifactList(value) {
  if (typeof value !== "object" || value === null || !("artifacts" in value) || !Array.isArray(value.artifacts)) {
    return [];
  }
  return value.artifacts.filter(
    (artifact) => typeof artifact === "object" && artifact !== null && typeof artifact.id === "number" && typeof artifact.name === "string" && typeof artifact.expired === "boolean" && typeof artifact.archive_download_url === "string" && typeof artifact.created_at === "string" && typeof artifact.size_in_bytes === "number"
  );
}
async function loadGitHubActionsArtifact(context, options, request) {
  const repository = repositoryParts(options.repository);
  if (repository === null) {
    return null;
  }
  const [owner, name] = repository;
  const token = process.env[options.tokenEnv];
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const encodedName = encodeURIComponent(options.artifactName);
  const patternedName = import_picomatch.default.scan(options.artifactName).isGlob;
  const listUrl = options.runId === null ? `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/artifacts?${patternedName ? "" : `name=${encodedName}&`}per_page=100` : `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${encodeURIComponent(options.runId)}/artifacts?${patternedName ? "" : `name=${encodedName}&`}per_page=100&direction=desc`;
  const response = await request(listUrl, {
    headers: headers(token),
    redirect: "follow"
  });
  if (!response.ok) {
    return null;
  }
  const currentRun = process.env.GITHUB_RUN_ID;
  const matchesArtifact = (0, import_picomatch.default)(options.artifactName);
  const artifacts = artifactList(await response.json()).filter(
    (artifact) => matchesArtifact(artifact.name) && !artifact.expired && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES && (options.branch === null || artifact.workflow_run?.head_branch === options.branch) && (currentRun === void 0 || String(artifact.workflow_run?.id ?? "") !== currentRun)
  ).sort(
    (left, right) => right.created_at.localeCompare(left.created_at)
  ).slice(0, options.maxArtifacts);
  const candidates = [];
  for (const artifact of artifacts) {
    const download = await request(artifact.archive_download_url, {
      headers: headers(token),
      redirect: "follow"
    });
    if (!download.ok) {
      continue;
    }
    const archive = await readBoundedResponse(
      download,
      MAX_ARCHIVE_BYTES
    );
    if (archive === null) {
      continue;
    }
    const graph = archiveGraph(
      archive,
      context.runner
    );
    if (graph === null || graph.fingerprint !== context.fingerprint) {
      continue;
    }
    candidates.push({
      graph,
      ...artifact.workflow_run?.id === void 0 ? {} : { group: artifact.workflow_run.id },
      id: artifact.id
    });
  }
  return candidates.length === 0 ? null : candidates;
}
function createGitHubActionsArtifactProvider(source, request = globalThis.fetch) {
  const options = normalizedOptions(source);
  return {
    name: "GitHub Actions",
    load: (context) => loadGitHubActionsArtifact(context, options, request)
  };
}

// src/artifacts/filesystem.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var DEFAULT_PATHS = [".tia-artifacts"];
var MAX_GRAPH_BYTES2 = 20 * 1024 * 1024;
var MAX_FILES = 1e3;
function graphFiles(path, files) {
  if (files.length >= MAX_FILES) {
    return;
  }
  let stat;
  try {
    stat = (0, import_node_fs2.lstatSync)(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isFile()) {
    if (path.endsWith("graph.json") && stat.size <= MAX_GRAPH_BYTES2) {
      files.push(path);
    }
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const entry of (0, import_node_fs2.readdirSync)(path).sort()) {
    graphFiles((0, import_node_path2.resolve)(path, entry), files);
    if (files.length >= MAX_FILES) {
      return;
    }
  }
}
function createFilesystemArtifactProvider(options = {}) {
  return {
    name: "filesystem artifacts",
    async load(context) {
      const root = context.root ?? process.cwd();
      const files = [];
      for (const path of options.paths ?? DEFAULT_PATHS) {
        graphFiles((0, import_node_path2.resolve)(root, path), files);
      }
      return files.flatMap((path) => {
        try {
          const graph = JSON.parse((0, import_node_fs2.readFileSync)(path, "utf8"));
          const group = typeof graph.partition?.group === "string" ? graph.partition.group : options.group;
          return [{
            graph,
            ...group === void 0 ? {} : { group },
            id: path
          }];
        } catch {
          return [];
        }
      });
    }
  };
}

// src/artifacts/restore.ts
function isProvider(source) {
  return "load" in source && typeof source.load === "function";
}
function usableGraph(graph, fingerprint, coverageRequested) {
  return graph !== null && graph.fingerprint === fingerprint && graph.complete && (!coverageRequested || graph.coverageComplete);
}
function artifactProviders(sources) {
  if (sources === void 0) {
    return [];
  }
  return (Array.isArray(sources) ? sources : [sources]).map(
    (source) => isProvider(source) ? source : source.provider === "filesystem" ? createFilesystemArtifactProvider(source) : createGitHubActionsArtifactProvider(source)
  );
}
async function restoreGraphFromArtifacts(input) {
  const local = readGraph(input.cacheDir);
  const coverageRequested = input.coverageRequested ?? false;
  if (usableGraph(local, input.fingerprint, coverageRequested)) {
    return { reason: "compatible local graph exists", restored: false };
  }
  for (const provider of input.providers) {
    try {
      const candidate = await provider.load({
        fingerprint: input.fingerprint,
        ...input.root === void 0 ? {} : { root: input.root },
        ...input.runner === void 0 ? {} : { runner: input.runner }
      });
      if (candidate === null) {
        continue;
      }
      const candidates = Array.isArray(candidate) ? candidate : [candidate];
      const parsed = candidates.map((item) => ({
        graph: parseGraph(item.graph),
        group: item.group,
        id: item.id
      })).filter(
        (item) => item.graph !== null && item.graph.fingerprint === input.fingerprint
      );
      const complete = parsed.find(
        (item) => usableGraph(
          item.graph,
          input.fingerprint,
          coverageRequested
        )
      );
      let graph = complete?.graph ?? null;
      let partitionIds = [];
      if (graph === null) {
        const groups = /* @__PURE__ */ new Map();
        for (const item of parsed) {
          if (item.graph.partition === void 0) {
            continue;
          }
          const group = groups.get(item.group) ?? [];
          group.push(item);
          groups.set(item.group, group);
        }
        for (const group of groups.values()) {
          graph = mergePartitionedGraphs(
            group.map((item) => item.graph)
          );
          if (graph !== null) {
            partitionIds = group.map((item) => item.id);
            break;
          }
        }
      }
      if (!usableGraph(
        graph,
        input.fingerprint,
        coverageRequested
      )) {
        continue;
      }
      const ids = complete === void 0 ? partitionIds : complete.id;
      const committed = await commitGraph(input.cacheDir, {
        expected: local,
        expectedDigest: graphDigest(local),
        graph
      });
      if (committed.status === "conflict") {
        return {
          reason: usableGraph(
            committed.graph,
            input.fingerprint,
            coverageRequested
          ) ? "compatible local graph won artifact restore race" : "concurrent graph update prevented artifact restore",
          restored: false
        };
      }
      if (input.log) {
        console.log(
          `TIA restored artifact ${Array.isArray(ids) ? ids.map(String).join(", ") : String(ids)} from ${provider.name}.`
        );
      }
      return {
        artifactId: ids,
        provider: provider.name,
        reason: "compatible artifact restored",
        restored: true
      };
    } catch {
    }
  }
  return {
    reason: "no provider returned a compatible artifact",
    restored: false
  };
}

// src/graph/fingerprint.ts
var import_node_crypto2 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var DELETED_HASH = "<deleted>";
function hashBytes(value) {
  return (0, import_node_crypto2.createHash)("sha256").update(value).digest("hex");
}
function hashFile(path) {
  if (!(0, import_node_fs3.existsSync)(path)) {
    return DELETED_HASH;
  }
  return hashBytes((0, import_node_fs3.readFileSync)(path));
}
function projectFingerprint(root, options, extraFiles = []) {
  const names = new Set(
    (0, import_node_fs3.readdirSync)(root, { withFileTypes: true }).filter((entry) => entry.isFile() && STRUCTURAL_FILE_PATTERN.test(entry.name)).map((entry) => entry.name)
  );
  for (const file of extraFiles) {
    if (file !== "") {
      names.add(file);
    }
  }
  const structural = [...names].sort().map((name) => [name, hashFile((0, import_node_path3.join)(root, name))]);
  return hashBytes(
    JSON.stringify({
      arch: process.arch,
      exclude: options.exclude,
      frameworks: options.frameworkFingerprint,
      ignoreChanges: options.ignoreChanges,
      include: options.include,
      node: process.versions.node.split(".")[0],
      onUnknownChange: options.onUnknownChange,
      platform: process.platform,
      plugin: PLUGIN_VERSION,
      structural
    })
  );
}

// src/graph/baseline.ts
var import_node_child_process = require("node:child_process");
var import_node_fs4 = require("node:fs");
var import_node_path5 = require("node:path");
var import_picomatch2 = __toESM(require("picomatch"), 1);

// src/shared/paths.ts
var import_node_path4 = require("node:path");
function windowsPath(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}
function pathApi(...values) {
  if (values.some(windowsPath)) {
    return import_node_path4.win32;
  }
  if (values.some((value) => value.startsWith("/"))) {
    return import_node_path4.posix;
  }
  return process.platform === "win32" ? import_node_path4.win32 : import_node_path4.posix;
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
function resolveCacheDir(root, cacheDir) {
  const api = pathApi(root, cacheDir);
  return api.isAbsolute(cacheDir) ? api.normalize(cacheDir) : api.resolve(root, cacheDir);
}
function isInside(parent, child) {
  const api = pathApi(parent, child);
  const rel = api.relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

// src/graph/baseline.ts
var ALWAYS_IGNORED_DIRECTORIES = /* @__PURE__ */ new Set([
  ".git",
  ".tia",
  "node_modules"
]);
var ROOT_OUTPUT_DIRECTORIES = /* @__PURE__ */ new Set([
  ".cache",
  ".turbo",
  "build",
  "coverage",
  "dist"
]);
var VITE_TEMPORARY_CONFIG = /\.config\.[cm]?[jt]s\.timestamp-\d+-[a-z\d]+\.mjs$/i;
function runGit(root, args) {
  try {
    return (0, import_node_child_process.execFileSync)("git", ["-c", "core.quotepath=false", ...args], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function gitText(root, args) {
  const value = runGit(root, args);
  return value === null ? null : value.toString("utf8").trim();
}
function gitPaths(root, args) {
  const value = runGit(root, args);
  if (value === null) {
    return null;
  }
  return value.toString("utf8").split("\0").filter(Boolean).map(slash);
}
function currentSha(root) {
  return gitText(root, ["rev-parse", "--verify", "HEAD"]);
}
function isAncestor(root, ancestor, descendant) {
  return runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}
function untrackedFiles(root) {
  return gitPaths(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
}
function filesDifferentFrom(root, revision) {
  return gitPaths(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=ACDMRTUXB",
    "-z",
    revision,
    "--"
  ]);
}
function unique(paths) {
  return [...new Set(paths)].sort();
}
function isIgnored(file, prefixes) {
  return (Array.isArray(prefixes) ? prefixes : [prefixes]).some(
    (prefix) => prefix !== "" && (file === prefix || file.startsWith(`${prefix}/`))
  );
}
function ignoreRules(root) {
  try {
    return (0, import_node_fs4.readFileSync)((0, import_node_path5.resolve)(root, ".gitignore"), "utf8").split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        return [];
      }
      const ignored = !trimmed.startsWith("!");
      const original = ignored ? trimmed : trimmed.slice(1);
      const anchored = original.startsWith("/");
      const directory = original.endsWith("/");
      const pattern = original.replace(/^\/+/, "").replace(/\/+$/, "");
      if (pattern === "") {
        return [];
      }
      const variants = anchored || pattern.includes("/") ? [pattern] : [pattern, `**/${pattern}`];
      if (directory) {
        variants.push(
          `${pattern}/**`,
          ...anchored || pattern.includes("/") ? [] : [`**/${pattern}/**`]
        );
      }
      return [{
        ignored,
        matcher: (0, import_picomatch2.default)(variants, { dot: true })
      }];
    });
  } catch {
    return [];
  }
}
function ignoredByRules(file, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.matcher(file)) {
      ignored = rule.ignored;
    }
  }
  return ignored;
}
function walkProjectFiles(root, ignoredPrefixes) {
  const files = [];
  const rules = ignoreRules(root);
  function visit(directory, prefix) {
    for (const entry of (0, import_node_fs4.readdirSync)(directory, { withFileTypes: true })) {
      const file = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isIgnored(file, ignoredPrefixes)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRECTORIES.has(entry.name) || prefix === "" && ROOT_OUTPUT_DIRECTORIES.has(entry.name) || ignoredByRules(file, rules)) {
          continue;
        }
        visit((0, import_node_path5.resolve)(directory, entry.name), file);
      } else if (entry.isFile() && !ignoredByRules(file, rules)) {
        files.push(slash(file));
      }
    }
  }
  try {
    visit(root, "");
    return unique(files);
  } catch {
    return null;
  }
}
function projectFiles(root, ignoredPrefixes) {
  const listed = gitPaths(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard"
  ]);
  return listed === null ? walkProjectFiles(root, ignoredPrefixes)?.filter(
    (file) => !VITE_TEMPORARY_CONFIG.test(file)
  ) ?? null : unique(listed).filter(
    (file) => !isIgnored(file, ignoredPrefixes) && !VITE_TEMPORARY_CONFIG.test(file)
  );
}
function filesystemChanges(root, baseline, ignoredPrefixes) {
  const current = projectFiles(root, ignoredPrefixes);
  if (current === null) {
    return null;
  }
  const candidates = unique([
    ...Object.keys(baseline.workingTree),
    ...current
  ]);
  const currentFiles = new Set(current);
  return candidates.filter((file) => {
    const hash = currentFiles.has(file) ? hashFile((0, import_node_path5.resolve)(root, file)) : null;
    return baseline.workingTree[file] !== hash;
  });
}
function changedFilesSince(root, baseline, ignoredPrefixes) {
  if (baseline.source === "filesystem") {
    return filesystemChanges(root, baseline, ignoredPrefixes);
  }
  const head = currentSha(root);
  if (head === null || !isAncestor(root, baseline.sha, head)) {
    return null;
  }
  const tracked = filesDifferentFrom(root, baseline.sha);
  const untracked = untrackedFiles(root);
  if (tracked === null || untracked === null) {
    return null;
  }
  return unique([...tracked, ...untracked]).filter((file) => !isIgnored(file, ignoredPrefixes)).filter((file) => !VITE_TEMPORARY_CONFIG.test(file)).filter((file) => baseline.workingTree[file] !== hashFile((0, import_node_path5.resolve)(root, file)));
}
function captureBaseline(root, ignoredPrefixes) {
  const sha = currentSha(root);
  if (sha === null) {
    const files = projectFiles(root, ignoredPrefixes);
    if (files === null) {
      return null;
    }
    return {
      sha: "",
      source: "filesystem",
      workingTree: Object.fromEntries(
        files.map((file) => [
          file,
          hashFile((0, import_node_path5.resolve)(root, file))
        ])
      )
    };
  }
  const tracked = filesDifferentFrom(root, sha);
  const untracked = untrackedFiles(root);
  if (tracked === null || untracked === null) {
    return null;
  }
  const workingTree = {};
  for (const file of unique([...tracked, ...untracked])) {
    if (isIgnored(file, ignoredPrefixes)) {
      continue;
    }
    const absolute = (0, import_node_path5.resolve)(root, file);
    if ((0, import_node_fs4.existsSync)(absolute) || tracked.includes(file)) {
      workingTree[file] = hashFile(absolute);
    }
  }
  return { sha, source: "git", workingTree };
}

// src/graph/plan.ts
var import_node_fs5 = require("node:fs");
var import_node_path6 = require("node:path");
var import_picomatch3 = __toESM(require("picomatch"), 1);
function fullRun(reason, graph) {
  return {
    affectedTestIds: [],
    affectedTests: [],
    changedFiles: [],
    graph,
    mode: "record",
    reason,
    replayedTests: 0,
    wholeTestFiles: []
  };
}
function replayedResultCount(graph, affectedIds, wholeFiles) {
  return Object.values(graph.results).filter(
    (result) => result.state !== "failed" && !affectedIds.has(result.id) && !wholeFiles.has(result.file)
  ).length;
}
function createRunPlan(input) {
  const {
    cachePrefix,
    coverageRequested = false,
    fingerprint,
    graph,
    ignoredPrefixes = [cachePrefix],
    options,
    root
  } = input;
  if (options.fresh) {
    return fullRun("fresh graph requested", graph);
  }
  if (graph === null) {
    return fullRun("no compatible graph found", null);
  }
  if (!graph.complete) {
    return fullRun("the previous graph is incomplete", graph);
  }
  if (coverageRequested && !graph.coverageComplete) {
    return fullRun("the cached coverage graph is incomplete", graph);
  }
  if (graph.fingerprint !== fingerprint) {
    return fullRun("project structure changed", graph);
  }
  const changedFiles = changedFilesSince(root, graph.baseline, ignoredPrefixes);
  if (changedFiles === null) {
    return fullRun("the recorded commit is unavailable", graph);
  }
  const affectedIds = /* @__PURE__ */ new Set();
  const affected = /* @__PURE__ */ new Set();
  const wholeFiles = /* @__PURE__ */ new Set();
  const ignoredUnknownChange = (0, import_picomatch3.default)(options.ignoreChanges, { dot: true });
  const reverseEdges = /* @__PURE__ */ new Map();
  const reverseTestEdges = /* @__PURE__ */ new Map();
  const testFileById = /* @__PURE__ */ new Map();
  for (const [testFile, sourceFiles] of Object.entries(graph.edges)) {
    for (const sourceFile of sourceFiles) {
      const tests = reverseEdges.get(sourceFile) ?? [];
      tests.push(testFile);
      reverseEdges.set(sourceFile, tests);
    }
  }
  for (const [id, edge] of Object.entries(graph.testEdges)) {
    testFileById.set(id, edge.file);
    for (const sourceFile of edge.files) {
      const tests = reverseTestEdges.get(sourceFile) ?? [];
      tests.push(id);
      reverseTestEdges.set(sourceFile, tests);
    }
  }
  const completeTestEdges = /* @__PURE__ */ new Map();
  for (const result of Object.values(graph.results)) {
    if (result.state === "skipped" || result.id.startsWith("module:")) {
      continue;
    }
    if (!graph.testEdges[result.id]) {
      completeTestEdges.set(result.file, false);
    } else if (!completeTestEdges.has(result.file)) {
      completeTestEdges.set(result.file, true);
    }
  }
  for (const result of Object.values(graph.results)) {
    if (result.state === "failed" && (0, import_node_fs5.existsSync)((0, import_node_path6.resolve)(root, result.file))) {
      affected.add(result.file);
      if (result.id.startsWith("module:") || completeTestEdges.get(result.file) === false) {
        wholeFiles.add(result.file);
      } else {
        affectedIds.add(result.id);
      }
    }
  }
  for (const file of changedFiles) {
    if (STRUCTURAL_FILE_PATTERN.test(file)) {
      return fullRun(`structural file changed: ${file}`, graph);
    }
    if (TEST_FILE_PATTERN.test(file)) {
      if ((0, import_node_fs5.existsSync)((0, import_node_path6.resolve)(root, file))) {
        affected.add(file);
        wholeFiles.add(file);
      }
      continue;
    }
    const linkedTests = reverseEdges.get(file) ?? [];
    for (const testFile of linkedTests) {
      if ((0, import_node_fs5.existsSync)((0, import_node_path6.resolve)(root, testFile))) {
        affected.add(testFile);
      }
    }
    const linkedTestIds = reverseTestEdges.get(file) ?? [];
    for (const id of linkedTestIds) {
      const testFile = testFileById.get(id);
      if (testFile !== void 0 && (0, import_node_fs5.existsSync)((0, import_node_path6.resolve)(root, testFile))) {
        affected.add(testFile);
        affectedIds.add(id);
      }
    }
    for (const testFile of linkedTests) {
      const preciseIds = linkedTestIds.filter(
        (id) => testFileById.get(id) === testFile
      );
      if (preciseIds.length === 0 || completeTestEdges.get(testFile) === false) {
        wholeFiles.add(testFile);
      }
    }
    if (linkedTests.length === 0 && !ignoredUnknownChange(file) && options.onUnknownChange === "full") {
      return fullRun(`changed file is unknown to the graph: ${file}`, graph);
    }
  }
  for (const file of wholeFiles) {
    for (const [id, testFile] of testFileById) {
      if (testFile === file) {
        affectedIds.delete(id);
      }
    }
  }
  const affectedTestIds = [...affectedIds].sort();
  const affectedTests = [...affected].sort();
  const wholeTestFiles = [...wholeFiles].sort();
  return {
    affectedTestIds,
    affectedTests,
    changedFiles,
    graph,
    mode: "replay",
    reason: affectedTests.length === 0 ? "no affected test files" : `${affectedTestIds.length} affected test case${affectedTestIds.length === 1 ? "" : "s"} in ${affectedTests.length} test file${affectedTests.length === 1 ? "" : "s"}${wholeTestFiles.length === 0 ? "" : `; ${wholeTestFiles.length} whole-file fallback${wholeTestFiles.length === 1 ? "" : "s"}`}`,
    replayedTests: replayedResultCount(graph, affectedIds, wholeFiles),
    wholeTestFiles
  };
}

// src/graph/partitions.ts
var import_node_path7 = require("node:path");
function partitionGroup(baseline, fingerprint, total, requested) {
  if (requested !== void 0 && requested.trim() !== "") {
    return requested.trim();
  }
  return `local-${hashBytes(
    JSON.stringify({ baseline, fingerprint, total })
  ).slice(0, 20)}`;
}
function partitionCacheDir(cacheDir, partition) {
  const group = partition.group ?? "ungrouped";
  return (0, import_node_path7.join)(
    cacheDir,
    "fragments",
    hashBytes(group).slice(0, 24),
    `${partition.index}-of-${partition.total}`
  );
}
async function aggregateLocalPartitions(cacheDir, partition) {
  const fragments = [];
  for (let index = 1; index <= partition.total; index += 1) {
    const graph = readGraph(
      partitionCacheDir(cacheDir, { ...partition, index })
    );
    if (graph === null) {
      return null;
    }
    fragments.push(graph);
  }
  const merged = mergePartitionedGraphs(fragments);
  if (merged === null) {
    return null;
  }
  const expected = readGraph(cacheDir);
  const committed = await commitGraph(cacheDir, {
    expected,
    expectedDigest: graphDigest(expected),
    graph: merged
  });
  return committed.status === "conflict" ? null : committed.graph;
}

// src/frameworks/database.ts
var import_node_fs7 = require("node:fs");
var import_node_path9 = require("node:path");

// src/frameworks/files.ts
var import_node_fs6 = require("node:fs");
var import_node_path8 = require("node:path");
var import_picomatch4 = __toESM(require("picomatch"), 1);
var EXCLUDED_DIRECTORIES = /* @__PURE__ */ new Set([
  ".git",
  ".tia",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);
function matchingFiles(root, patterns) {
  const matches2 = (0, import_picomatch4.default)(patterns, { dot: true });
  const files = [];
  function walk(directory) {
    for (const entry of (0, import_node_fs6.readdirSync)(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = (0, import_node_path8.join)(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const file = slash((0, import_node_path8.relative)(root, absolute));
        if (matches2(file)) {
          files.push(file);
        }
      }
    }
  }
  walk(root);
  return files.sort();
}

// src/frameworks/database.ts
var DEFAULT_MIGRATIONS = [
  "migrations/**/*.{sql,js,cjs,mjs,ts,cts,mts}",
  "prisma/migrations/**/*.{sql,js,cjs,mjs,ts,cts,mts}",
  "drizzle/**/*.{sql,js,cjs,mjs,ts,cts,mts}"
];
var DEFAULT_SCHEMAS = [
  "prisma/schema.prisma",
  "src/db/schema.{js,jsx,ts,tsx}",
  "src/database/schema.{js,jsx,ts,tsx}"
];
var META_TABLES = /* @__PURE__ */ new Set([
  "information_schema",
  "migrations",
  "sqlite_master",
  "sqlite_sequence"
]);
function tablesFromSql(source) {
  const tables = /* @__PURE__ */ new Set();
  const patterns = [
    /\b(?:from|into|join|update|table)\s+(?:if\s+(?:not\s+)?exists\s+)?["'`\[]?([a-z_][\w$.-]*)/gi,
    /\b(?:sqliteTable|pgTable|mysqlTable|table)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:from|table)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:prisma|tx)\.([a-z_]\w*)\.(?:find|create|update|upsert|delete|count|aggregate|groupBy)/gi
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1]?.toLowerCase();
      if (raw === void 0 || META_TABLES.has(raw) || raw.startsWith("pg_")) {
        continue;
      }
      tables.add(raw);
      if (!raw.endsWith("s")) {
        tables.add(`${raw}s`);
      }
    }
  }
  return [...tables].sort();
}
function databaseEdges(configured) {
  const options = configured === true ? {} : configured;
  const migrationPatterns = options.migrations ?? DEFAULT_MIGRATIONS;
  const schemaPatterns = options.schemas ?? DEFAULT_SCHEMAS;
  const cache = /* @__PURE__ */ new Map();
  return {
    fingerprint: JSON.stringify({
      migrations: migrationPatterns,
      schemas: schemaPatterns,
      version: 1
    }),
    name: "database",
    resolve(context) {
      let project = cache.get(context.root);
      if (project === void 0) {
        project = {
          migrations: matchingFiles(
            context.root,
            migrationPatterns
          ).map((file) => ({
            file,
            tables: new Set(
              tablesFromSql((0, import_node_fs7.readFileSync)((0, import_node_path9.resolve)(context.root, file), "utf8"))
            )
          })),
          schemas: matchingFiles(context.root, schemaPatterns)
        };
        cache.set(context.root, project);
      }
      const usedTables = /* @__PURE__ */ new Set();
      for (const file of context.files) {
        try {
          for (const table of tablesFromSql(
            (0, import_node_fs7.readFileSync)((0, import_node_path9.resolve)(context.root, file), "utf8")
          )) {
            usedTables.add(table);
          }
        } catch {
        }
      }
      if (usedTables.size === 0) {
        return [];
      }
      return [
        ...project.schemas,
        ...project.migrations.filter(
          (migration) => [...migration.tables].some((table) => usedTables.has(table))
        ).map((migration) => migration.file)
      ];
    }
  };
}

// src/frameworks/views.ts
var import_node_fs8 = require("node:fs");
var import_node_path10 = require("node:path");
var DEFAULT_EXTENSIONS = [
  ".ejs",
  ".eta",
  ".hbs",
  ".handlebars",
  ".html",
  ".liquid",
  ".njk",
  ".nunjucks",
  ".pug"
];
var DEFAULT_ROOTS = ["views", "templates", "src/views", "src/templates"];
function escapedExtensions(extensions) {
  return extensions.map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}
function viewEdges(configured) {
  const options = configured === true ? {} : configured;
  const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map(
    (extension) => extension.startsWith(".") ? extension : `.${extension}`
  );
  const roots = options.roots ?? DEFAULT_ROOTS;
  const literalPattern = new RegExp(
    `["'\`]([^"'\\n]+(?:${escapedExtensions(extensions)}))["'\`]`,
    "g"
  );
  const callPattern = /\b(?:render|renderFile|compileFile|template)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  return {
    fingerprint: JSON.stringify({ extensions, roots, version: 1 }),
    name: "views",
    resolve(context) {
      const found = /* @__PURE__ */ new Set();
      for (const dependency of context.files) {
        let source;
        try {
          source = (0, import_node_fs8.readFileSync)((0, import_node_path10.resolve)(context.root, dependency), "utf8");
        } catch {
          continue;
        }
        const names = /* @__PURE__ */ new Set();
        for (const match of source.matchAll(literalPattern)) {
          if (match[1] !== void 0) {
            names.add(match[1]);
          }
        }
        for (const match of source.matchAll(callPattern)) {
          if (match[1] !== void 0) {
            names.add(match[1]);
          }
        }
        for (const name of names) {
          const candidates = /* @__PURE__ */ new Set();
          const suffixes = (0, import_node_path10.extname)(name) === "" ? extensions : [""];
          for (const suffix of suffixes) {
            candidates.add((0, import_node_path10.resolve)(context.root, (0, import_node_path10.dirname)(dependency), `${name}${suffix}`));
            for (const root of roots) {
              candidates.add((0, import_node_path10.resolve)(context.root, root, `${name}${suffix}`));
            }
          }
          for (const candidate of candidates) {
            if ((0, import_node_fs8.existsSync)(candidate)) {
              found.add(slash((0, import_node_path10.relative)(context.root, candidate)));
            }
          }
        }
      }
      return [...found].sort();
    }
  };
}

// src/frameworks/index.ts
function frameworkAdapters(options) {
  if (options === void 0) {
    return [];
  }
  const adapters = [];
  if (options.views) {
    adapters.push(viewEdges(options.views));
  }
  if (options.database) {
    adapters.push(databaseEdges(options.database));
  }
  if (options.adapters !== void 0) {
    adapters.push(
      ...Array.isArray(options.adapters) ? options.adapters : [options.adapters]
    );
  }
  return adapters;
}
function frameworkFingerprint(adapters) {
  return JSON.stringify(
    adapters.map((adapter) => ({
      fingerprint: adapter.fingerprint ?? "",
      name: adapter.name
    }))
  );
}

// src/vitest/reporter.ts
var import_node_fs12 = require("node:fs");
var import_node_path18 = require("node:path");

// src/coverage/report.ts
var import_node_fs10 = require("node:fs");
var import_node_path13 = require("node:path");
var import_istanbul_lib_coverage3 = __toESM(require("istanbul-lib-coverage"), 1);
var import_istanbul_lib_report = __toESM(require("istanbul-lib-report"), 1);
var import_istanbul_reports = __toESM(require("istanbul-reports"), 1);

// src/coverage/thresholds.ts
var import_node_path11 = require("node:path");
var import_istanbul_lib_coverage = __toESM(require("istanbul-lib-coverage"), 1);
var import_picomatch5 = __toESM(require("picomatch"), 1);
var METRICS = [
  "lines",
  "functions",
  "statements",
  "branches"
];
var RESERVED_KEYS = /* @__PURE__ */ new Set([
  "100",
  "autoUpdate",
  "perFile",
  ...METRICS
]);
function metricValues(value) {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const configured = value;
  if (configured[100] === true) {
    return {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    };
  }
  return Object.fromEntries(
    METRICS.flatMap((metric) => {
      const threshold = configured[metric];
      return typeof threshold === "number" && Number.isFinite(threshold) ? [[metric, threshold]] : [];
    })
  );
}
function thresholdSets(coverageMap, root, thresholds) {
  const sets = [
    {
      coverageMap,
      name: "global",
      values: metricValues(thresholds)
    }
  ];
  const files = coverageMap.files();
  for (const [pattern, configured] of Object.entries(thresholds)) {
    if (RESERVED_KEYS.has(pattern)) {
      continue;
    }
    const values = metricValues(configured);
    if (Object.keys(values).length === 0) {
      continue;
    }
    const matcher2 = (0, import_picomatch5.default)(pattern);
    const matching = import_istanbul_lib_coverage.default.createCoverageMap();
    for (const file of files) {
      if (matcher2(slash((0, import_node_path11.relative)(root, file)))) {
        matching.addFileCoverage(coverageMap.fileCoverageFor(file));
      }
    }
    sets.push({
      coverageMap: matching,
      name: `"${pattern}"`,
      values
    });
  }
  return sets;
}
function summaries(coverageMap, perFile) {
  if (!perFile) {
    return [{ file: null, summary: coverageMap.getCoverageSummary() }];
  }
  return coverageMap.files().map((file) => ({
    file,
    summary: coverageMap.fileCoverageFor(file).toSummary()
  }));
}
function coverageThresholdFailures(coverageMap, root, thresholds) {
  if (thresholds === null) {
    return [];
  }
  const failures = [];
  const perFile = thresholds.perFile === true;
  for (const set of thresholdSets(coverageMap, root, thresholds)) {
    for (const { file, summary } of summaries(set.coverageMap, perFile)) {
      for (const metric of METRICS) {
        const threshold = set.values[metric];
        if (threshold === void 0) {
          continue;
        }
        const total = summary.data[metric];
        const fileSuffix = perFile && file !== null ? ` for ${slash((0, import_node_path11.relative)(root, file))}` : "";
        if (threshold >= 0) {
          if (typeof total.pct === "number" && total.pct < threshold) {
            failures.push({
              message: `ERROR: Coverage for ${metric} (${total.pct}%) does not meet ${set.name} threshold (${threshold}%)${fileSuffix}`
            });
          }
          continue;
        }
        const uncovered = total.total - total.covered;
        const maximum = threshold * -1;
        if (uncovered > maximum) {
          failures.push({
            message: `ERROR: Uncovered ${metric} (${uncovered}) exceed ${set.name} threshold (${maximum})${fileSuffix}`
          });
        }
      }
    }
  }
  return failures;
}

// src/coverage/files.ts
var import_node_fs9 = require("node:fs");
var import_node_path12 = require("node:path");
var import_istanbul_lib_coverage2 = __toESM(require("istanbul-lib-coverage"), 1);
var import_istanbul_lib_instrument = require("istanbul-lib-instrument");
var import_picomatch6 = __toESM(require("picomatch"), 1);
var import_tinyglobby = require("tinyglobby");
function matcher(patterns) {
  return patterns.length === 0 ? null : (0, import_picomatch6.default)(patterns, { contains: true, dot: true });
}
function matches(file, root, value) {
  if (value === null) {
    return false;
  }
  const absolute = slash((0, import_node_path12.resolve)(file));
  const relative5 = slash(absolute.slice(slash((0, import_node_path12.resolve)(root)).length + 1));
  return value(absolute) || value(relative5);
}
function zeroCoverage(file) {
  const instrumenter = (0, import_istanbul_lib_instrument.createInstrumenter)({
    coverageVariable: "__coverage__",
    esModules: true,
    parserPlugins: ["typescript", "jsx"],
    produceSourceMap: true
  });
  instrumenter.instrumentSync((0, import_node_fs9.readFileSync)(file, "utf8"), file);
  return instrumenter.lastFileCoverage();
}
function selectedCoverage(coverage, root, options) {
  const selected = import_istanbul_lib_coverage2.default.createCoverageMap(coverage.toJSON());
  const includes = matcher(options.include ?? []);
  const excludes = matcher(options.exclude);
  const warnings = [];
  selected.filter(
    (file) => (0, import_node_fs9.existsSync)(file) && (options.include === null || matches(file, root, includes)) && !matches(file, root, excludes)
  );
  if (options.include === null) {
    return { coverage: selected, warnings };
  }
  const files = (0, import_tinyglobby.globSync)(options.include, {
    absolute: true,
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    ignore: options.exclude,
    onlyFiles: true
  });
  for (const file of files) {
    const absolute = (0, import_node_path12.resolve)(file);
    if (selected.data[absolute] !== void 0 || !matches(absolute, root, includes) || matches(absolute, root, excludes)) {
      continue;
    }
    try {
      selected.addFileCoverage(zeroCoverage(absolute));
    } catch (error) {
      warnings.push(
        `TIA coverage could not include ${slash(absolute)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { coverage: selected, warnings };
}

// src/coverage/report.ts
function portableCoverageMap(root, coverage) {
  const portable = {};
  for (const [key, value] of Object.entries(coverage)) {
    const file = projectRelative(root, value.path || key);
    if (file === null || file === "") {
      continue;
    }
    portable[file] = {
      ...structuredClone(value),
      path: file
    };
  }
  return portable;
}
function absoluteCoverageMap(root, coverage) {
  return Object.fromEntries(
    Object.entries(coverage).map(([key, value]) => {
      const path = (0, import_node_path13.resolve)(root, value.path || key);
      return [
        path,
        {
          ...structuredClone(value),
          path
        }
      ];
    })
  );
}
function mergedGraphCoverage(graph, root) {
  const merged = import_istanbul_lib_coverage3.default.createCoverageMap();
  for (const coverage of Object.values(graph.collectionCoverage)) {
    merged.merge(absoluteCoverageMap(root, coverage));
  }
  for (const coverage of Object.values(graph.testCoverage)) {
    merged.merge(absoluteCoverageMap(root, coverage));
  }
  return merged;
}
function writeCoverageReports(graph, root, options) {
  const selected = selectedCoverage(
    mergedGraphCoverage(graph, root),
    root,
    options
  );
  const coverageMap = selected.coverage;
  const context = import_istanbul_lib_report.default.createContext({
    coverageMap,
    dir: options.reportsDirectory,
    sourceFinder: (file) => (0, import_node_fs10.readFileSync)(file, "utf8"),
    watermarks: options.watermarks
  });
  for (const reporter of options.reporters) {
    import_istanbul_reports.default.create(reporter.name, {
      projectRoot: root,
      skipFull: options.skipFull,
      ...reporter.options
    }).execute(context);
  }
  return {
    files: coverageMap.files().length,
    thresholdFailures: coverageThresholdFailures(
      coverageMap,
      root,
      options.thresholds
    ),
    warnings: selected.warnings
  };
}

// src/frameworks/resolve.ts
var import_node_path14 = require("node:path");
function resolveFrameworkEdges(adapters, context) {
  const files = /* @__PURE__ */ new Set();
  for (const adapter of adapters) {
    try {
      for (const file of adapter.resolve(context)) {
        const relative5 = projectRelative(context.root, (0, import_node_path14.resolve)(context.root, file));
        if (relative5 !== null && relative5 !== "") {
          files.add(relative5);
        }
      }
    } catch {
      return { complete: false, files: [] };
    }
  }
  return { complete: true, files: [...files].sort() };
}

// src/vitest/module-graph.ts
var import_node_path15 = require("node:path");
var EXECUTABLE_SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i;
function cleanId(id) {
  return id.split("?", 1)[0] ?? id;
}
function moduleFile(node) {
  const value = node.file ?? node.id;
  return value === null ? null : cleanId(value);
}
function entryModules(graph, moduleId) {
  const cleanModuleId = cleanId(moduleId);
  const direct = graph.getModuleById(moduleId) ?? graph.getModuleById(cleanModuleId);
  const byFile = graph.getModulesByFile((0, import_node_path15.resolve)(cleanModuleId));
  return [
    .../* @__PURE__ */ new Set([
      ...direct === void 0 ? [] : [direct],
      ...byFile ?? []
    ])
  ];
}
function importedAssetFiles(graph, moduleId, root) {
  const queue = entryModules(graph, moduleId);
  const visited = /* @__PURE__ */ new Set();
  const assets = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === void 0 || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const imported of current.importedModules) {
      queue.push(imported);
      const file = moduleFile(imported);
      if (file === null || EXECUTABLE_SOURCE_PATTERN.test(file)) {
        continue;
      }
      const relative5 = projectRelative(root, file);
      if (relative5 !== null && relative5 !== "") {
        assets.add(relative5);
      }
    }
  }
  return [...assets].sort();
}
function directlyImportedAssetFiles(graph, moduleId, root) {
  const assets = /* @__PURE__ */ new Set();
  for (const entry of entryModules(graph, moduleId)) {
    for (const imported of entry.importedModules) {
      const file = moduleFile(imported);
      if (file === null || EXECUTABLE_SOURCE_PATTERN.test(file)) {
        continue;
      }
      const relative5 = projectRelative(root, file);
      if (relative5 !== null && relative5 !== "") {
        assets.add(relative5);
      }
    }
  }
  return [...assets].sort();
}

// src/graph/update.ts
var import_node_fs11 = require("node:fs");
var import_node_path16 = require("node:path");
function emptyGraph() {
  return {
    baseline: { sha: "", workingTree: {} },
    collectionCoverage: {},
    complete: false,
    coverageComplete: false,
    edges: {},
    fingerprint: "",
    results: {},
    schema: GRAPH_SCHEMA_VERSION,
    testCoverage: {},
    testEdges: {},
    updatedAt: ""
  };
}
function deleteFileRecords(graph, file) {
  const ids = /* @__PURE__ */ new Set([
    ...Object.keys(graph.results),
    ...Object.keys(graph.testEdges)
  ]);
  for (const id of ids) {
    if (graph.results[id]?.file === file || graph.testEdges[id]?.file === file) {
      delete graph.results[id];
      delete graph.testEdges[id];
      delete graph.testCoverage[id];
    }
  }
}
function updateGraph(input) {
  const graph = input.previous === null ? emptyGraph() : structuredClone(input.previous);
  const executedFiles = new Set(input.executedFiles);
  for (const file of input.fullyExecutedFiles) {
    deleteFileRecords(graph, file);
  }
  for (const [id, result] of input.results) {
    graph.results[id] = structuredClone(result);
  }
  for (const [id, edge] of input.testEdges) {
    graph.testEdges[id] = structuredClone(edge);
  }
  for (const [id, coverage] of input.testCoverage ?? []) {
    graph.testCoverage[id] = structuredClone(coverage);
  }
  for (const file of executedFiles) {
    if (input.collectionCoverage !== void 0) {
      graph.collectionCoverage[file] = structuredClone(
        input.collectionCoverage.get(file) ?? {}
      );
    }
    const dependencies = Object.values(graph.testEdges).filter((edge) => edge.file === file).flatMap((edge) => edge.files);
    graph.edges[file] = dependencies.length === 0 ? structuredClone(
      input.fallbackEdges?.get(file) ?? graph.edges[file] ?? [file]
    ) : [.../* @__PURE__ */ new Set([file, ...dependencies])].sort();
  }
  for (const testFile of Object.keys(graph.edges)) {
    if (!(0, import_node_fs11.existsSync)((0, import_node_path16.resolve)(input.root, testFile))) {
      delete graph.edges[testFile];
      delete graph.collectionCoverage[testFile];
      deleteFileRecords(graph, testFile);
    }
  }
  graph.schema = GRAPH_SCHEMA_VERSION;
  return graph;
}

// src/runtime/replay.ts
function replayedResults(plan) {
  if (plan.mode !== "replay" || plan.graph === null) {
    return [];
  }
  const affectedIds = new Set(plan.affectedTestIds);
  const wholeFiles = new Set(plan.wholeTestFiles);
  return Object.values(plan.graph.results).filter(
    (result) => result.state !== "failed" && !affectedIds.has(result.id) && !wholeFiles.has(result.file)
  ).sort((left, right) => left.id.localeCompare(right.id));
}
function replayRunEvent(plan) {
  return {
    affectedTestIds: [...plan.affectedTestIds],
    affectedTests: [...plan.affectedTests],
    changedFiles: [...plan.changedFiles],
    mode: plan.mode,
    reason: plan.reason,
    replayedTests: plan.replayedTests,
    wholeTestFiles: [...plan.wholeTestFiles]
  };
}
async function notifyReplayAdapters(adapters, method, event, warn) {
  for (const adapter of adapters) {
    const handler = adapter[method];
    if (handler === void 0) {
      continue;
    }
    try {
      await handler.call(adapter, event);
    } catch (error) {
      warn(
        `TIA replay adapter ${method} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// src/vitest/cached-test.ts
var import_node_path17 = require("node:path");
var TIA_CACHED_META_KEY = "__tiajs_cached__";
function resultFor(cached) {
  if (cached.state === "skipped") {
    return {
      errors: void 0,
      note: "replayed from the tiajs cache",
      state: "skipped"
    };
  }
  if (cached.state === "failed") {
    return {
      errors: [
        {
          message: "Cached failure",
          name: "Error"
        }
      ],
      state: "failed"
    };
  }
  return {
    errors: void 0,
    state: "passed"
  };
}
function cachedTestCase(vitest, root, cached) {
  const project = vitest.getRootProject();
  const result = resultFor(cached);
  const metadata = {
    [TIA_CACHED_META_KEY]: true,
    [TIA_REPLAY_META_KEY]: true
  };
  let testCase;
  const collection = {
    at: (index) => index === 0 || index === -1 ? testCase : void 0,
    allTests: function* () {
      yield testCase;
    },
    array: () => [testCase],
    get size() {
      return 1;
    },
    suites: function* () {
    },
    tests: function* (state) {
      if (state === void 0 || state === result.state) {
        yield testCase;
      }
    },
    *[Symbol.iterator]() {
      yield testCase;
    }
  };
  const moduleId = (0, import_node_path17.resolve)(root, cached.file);
  const module2 = {
    children: collection,
    diagnostic: () => cached.duration === void 0 ? void 0 : {
      duration: cached.duration,
      environmentSetupDuration: 0,
      prepareDuration: 0,
      setupDuration: 0
    },
    errors: () => [],
    fullName: cached.file,
    id: `tiajs:cached:${cached.file}`,
    location: void 0,
    meta: () => metadata,
    moduleId,
    name: cached.file,
    ok: () => result.state !== "failed",
    pool: "cached",
    project,
    state: () => result.state === "failed" ? "failed" : result.state === "skipped" ? "skipped" : "passed",
    type: "module"
  };
  testCase = {
    annotations: () => [],
    artifacts: () => [],
    diagnostic: () => cached.duration === void 0 ? void 0 : {
      duration: cached.duration,
      flaky: false,
      repeatCount: 0,
      retryCount: 0,
      slow: cached.duration > project.globalConfig.slowTestThreshold,
      startTime: Date.now() - cached.duration
    },
    fullName: cached.fullName,
    id: cached.id,
    location: void 0,
    meta: () => metadata,
    module: module2,
    name: cached.fullName.split(" > ").at(-1) ?? cached.fullName,
    ok: () => result.state !== "failed",
    options: {
      concurrent: false,
      fails: false,
      repeats: 0,
      retry: 0,
      shuffle: false,
      skip: cached.state === "skipped",
      tags: [],
      timeout: 0,
      todo: false
    },
    parent: module2,
    project,
    result: () => result,
    tags: [],
    toTestSpecification: () => project.createSpecification(moduleId, {
      testIds: [cached.id]
    }),
    type: "test"
  };
  return testCase;
}

// src/vitest/reporter.ts
function baselineDifferences(before, after) {
  return [
    .../* @__PURE__ */ new Set([
      ...Object.keys(before.workingTree),
      ...Object.keys(after.workingTree)
    ])
  ].filter(
    (file) => before.workingTree[file] !== after.workingTree[file]
  ).sort();
}
var TiaReporter = class {
  constructor(runtime) {
    this.runtime = runtime;
  }
  runtime;
  collectionCoverage = /* @__PURE__ */ new Map();
  edges = /* @__PURE__ */ new Map();
  executedFiles = /* @__PURE__ */ new Set();
  results = /* @__PURE__ */ new Map();
  testEdges = /* @__PURE__ */ new Map();
  testCoverage = /* @__PURE__ */ new Map();
  incomplete = false;
  vitest = null;
  onInit(vitest) {
    this.vitest = vitest;
  }
  async onTestRunStart() {
    const plan = this.runtime.plan;
    if (plan === null) {
      return;
    }
    if (this.runtime.coverage.enabled && this.runtime.coverage.clean) {
      (0, import_node_fs12.rmSync)(this.runtime.coverage.reportsDirectory, {
        force: true,
        recursive: true
      });
    }
    if (this.runtime.options.log) {
      if (plan.mode === "record") {
        this.log(`TIA recording full-suite baseline (${plan.reason}).`);
      } else {
        this.log(
          `TIA replay: ${plan.reason}; ${plan.replayedTests} cached test result${plan.replayedTests === 1 ? "" : "s"}.`
        );
      }
    }
    await notifyReplayAdapters(
      this.runtime.options.replayAdapters,
      "onRunStart",
      replayRunEvent(plan),
      (message) => this.warn(message)
    );
    for (const result of replayedResults(plan)) {
      await notifyReplayAdapters(
        this.runtime.options.replayAdapters,
        "onTestReplayed",
        { result: structuredClone(result) },
        (message) => this.warn(message)
      );
      await this.notifyReplayReporters(result);
    }
  }
  onTestModuleEnd(module2) {
    const testFile = projectRelative(this.runtime.root, module2.moduleId);
    if (testFile === null || testFile === "") {
      return;
    }
    const value = module2.meta()[TIA_META_KEY];
    if (value === void 0) {
      this.incomplete = true;
      return;
    }
    const dependencies = /* @__PURE__ */ new Set([testFile]);
    const sharedTestDependencies = /* @__PURE__ */ new Set([testFile]);
    this.collectionCoverage.set(
      testFile,
      portableCoverageMap(this.runtime.root, value.collectionCoverage)
    );
    for (const file of value.files) {
      const dependency = projectRelative(this.runtime.root, file);
      if (dependency !== null && dependency !== "") {
        dependencies.add(dependency);
      }
    }
    for (const file of value.collectionFiles) {
      const dependency = projectRelative(this.runtime.root, file);
      if (dependency !== null && dependency !== "") {
        sharedTestDependencies.add(dependency);
      }
    }
    const moduleFrameworkEdges = resolveFrameworkEdges(
      this.runtime.options.frameworkAdapters,
      {
        files: [...dependencies],
        root: this.runtime.root,
        testFile
      }
    );
    if (!moduleFrameworkEdges.complete) {
      this.incomplete = true;
    }
    for (const file of moduleFrameworkEdges.files) {
      dependencies.add(file);
      sharedTestDependencies.add(file);
    }
    if (module2.viteEnvironment !== void 0) {
      const moduleGraph = module2.viteEnvironment.moduleGraph;
      const sharedAssets = new Set(
        directlyImportedAssetFiles(
          moduleGraph,
          module2.moduleId,
          this.runtime.root
        )
      );
      for (const collectionFile of value.collectionFiles) {
        for (const asset of importedAssetFiles(
          moduleGraph,
          collectionFile,
          this.runtime.root
        )) {
          sharedAssets.add(asset);
        }
      }
      for (const asset of sharedAssets) {
        dependencies.add(asset);
        sharedTestDependencies.add(asset);
      }
      for (const [id, edge] of this.testEdges) {
        if (edge.file !== testFile) {
          continue;
        }
        const caseAssets = /* @__PURE__ */ new Set();
        for (const dependency of edge.files) {
          if (dependency === testFile) {
            continue;
          }
          for (const asset of importedAssetFiles(
            moduleGraph,
            (0, import_node_path18.resolve)(this.runtime.root, dependency),
            this.runtime.root
          )) {
            caseAssets.add(asset);
            dependencies.add(asset);
          }
        }
        this.testEdges.set(id, {
          file: edge.file,
          files: [.../* @__PURE__ */ new Set([...edge.files, ...caseAssets])].sort()
        });
      }
    }
    for (const [id, edge] of this.testEdges) {
      if (edge.file === testFile) {
        if (value.concurrent) {
          this.testEdges.delete(id);
          this.testCoverage.delete(id);
        } else {
          this.testEdges.set(id, {
            file: edge.file,
            files: [
              .../* @__PURE__ */ new Set([...edge.files, ...sharedTestDependencies])
            ].sort()
          });
        }
      }
    }
    this.executedFiles.add(testFile);
    this.edges.set(testFile, [...dependencies].sort());
  }
  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state === "pending") {
      return;
    }
    if (testCase.meta()[TIA_REPLAY_META_KEY] === true) {
      return;
    }
    const file = projectRelative(this.runtime.root, testCase.module.moduleId);
    if (file === null || file === "") {
      return;
    }
    const diagnostic = testCase.diagnostic();
    this.results.set(testCase.id, {
      ...diagnostic === void 0 ? {} : { duration: diagnostic.duration },
      file,
      fullName: testCase.fullName,
      id: testCase.id,
      state: result.state
    });
    const meta = testCase.meta()[TIA_TEST_META_KEY];
    if (meta === void 0) {
      if (result.state !== "skipped") {
        this.incomplete = true;
      }
      return;
    }
    const dependencies = /* @__PURE__ */ new Set([file]);
    for (const dependencyFile of meta.files) {
      const dependency = projectRelative(this.runtime.root, dependencyFile);
      if (dependency !== null && dependency !== "") {
        dependencies.add(dependency);
      }
    }
    const frameworkEdges = resolveFrameworkEdges(
      this.runtime.options.frameworkAdapters,
      {
        files: [...dependencies],
        root: this.runtime.root,
        testFile: file
      }
    );
    if (!frameworkEdges.complete) {
      this.incomplete = true;
    }
    for (const dependency of frameworkEdges.files) {
      dependencies.add(dependency);
    }
    this.testEdges.set(testCase.id, {
      file,
      files: [...dependencies].sort()
    });
    this.testCoverage.set(
      testCase.id,
      portableCoverageMap(this.runtime.root, meta.coverage)
    );
  }
  async onTestRunEnd(modules, unhandledErrors, reason) {
    const plan = this.runtime.plan;
    if (plan === null) {
      return;
    }
    if (reason === "interrupted") {
      this.warn("TIA graph was not updated because the run was interrupted.");
      return;
    }
    if (unhandledErrors.length > 0) {
      this.warn("TIA graph was not updated because Vitest reported an unhandled error.");
      return;
    }
    if (this.incomplete) {
      this.warn("TIA graph was not updated because dependency metadata was incomplete.");
      return;
    }
    this.recordModuleFailures(modules);
    const fingerprint = projectFingerprint(
      this.runtime.root,
      this.runtime.options,
      this.runtime.structuralFiles
    );
    if (fingerprint !== this.runtime.fingerprintAtStart) {
      this.warn("TIA graph was not updated because project structure changed during the run.");
      return;
    }
    const baseline = captureBaseline(
      this.runtime.root,
      this.runtime.ignoredPrefixes
    );
    if (baseline === null) {
      this.warn("TIA graph was not updated because the Git baseline is unavailable.");
      return;
    }
    if (this.runtime.baselineAtStart === null || JSON.stringify(baseline) !== JSON.stringify(this.runtime.baselineAtStart)) {
      const changed = this.runtime.baselineAtStart === null ? [] : baselineDifferences(
        this.runtime.baselineAtStart,
        baseline
      );
      this.warn(
        `TIA graph was not updated because project files changed during the run.${changed.length === 0 ? "" : ` Changed: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", \u2026" : ""}.`}`
      );
      return;
    }
    const recordComplete = plan.mode !== "record" || this.runtime.partition !== null || await this.recordIncludesEveryConfiguredTestFile(modules);
    const graph = updateGraph({
      collectionCoverage: this.collectionCoverage,
      executedFiles: this.executedFiles,
      fallbackEdges: this.edges,
      fullyExecutedFiles: plan.mode === "record" ? this.executedFiles : [...this.executedFiles].filter(
        (file) => plan.wholeTestFiles.includes(file)
      ),
      previous: plan.mode === "record" ? null : plan.graph,
      results: this.results,
      root: this.runtime.root,
      testCoverage: this.testCoverage,
      testEdges: this.testEdges
    });
    graph.baseline = baseline;
    graph.complete = this.runtime.partition === null && recordComplete;
    graph.coverageComplete = plan.mode === "record" ? recordComplete : graph.coverageComplete;
    graph.fingerprint = fingerprint;
    if (this.runtime.partition === null) {
      delete graph.partition;
    } else {
      graph.partition = structuredClone(this.runtime.partition);
    }
    graph.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const committed = await commitGraph(
      this.runtime.writeCacheDir,
      {
        expected: this.runtime.graphAtStart,
        expectedDigest: this.runtime.graphDigestAtStart,
        graph
      }
    );
    if (committed.status === "conflict" || committed.graph === null) {
      this.warn(
        "TIA graph was not updated because another process committed a conflicting graph."
      );
      return;
    }
    let savedGraph = committed.graph;
    if (this.runtime.partition !== null) {
      savedGraph = await aggregateLocalPartitions(
        this.runtime.options.cacheDir,
        this.runtime.partition
      ) ?? savedGraph;
    }
    if (!recordComplete) {
      this.warn(
        "TIA saved an incomplete graph because Vitest did not execute every configured test file."
      );
    }
    const coverageReady = this.runtime.partition === null || savedGraph.complete;
    const failedRun = modules.some((module2) => !module2.ok());
    const shouldReportCoverage = this.runtime.coverage.enabled && coverageReady && (!failedRun || this.runtime.coverage.reportOnFailure);
    if (shouldReportCoverage) {
      const canCheckThresholds = savedGraph.complete && savedGraph.coverageComplete;
      const report = writeCoverageReports(
        savedGraph,
        this.runtime.root,
        canCheckThresholds ? this.runtime.coverage : {
          ...this.runtime.coverage,
          thresholds: null
        }
      );
      if (this.runtime.coverage.thresholds !== null && !canCheckThresholds) {
        this.warn(
          "TIA coverage thresholds were deferred because this graph is a partial shard."
        );
      }
      if (this.runtime.coverage.thresholds?.autoUpdate) {
        this.warn(
          "TIA enforced coverage thresholds but did not rewrite the Vitest config for thresholds.autoUpdate."
        );
      }
      for (const warning of report.warnings) {
        this.warn(warning);
      }
      for (const failure of report.thresholdFailures) {
        process.exitCode = 1;
        this.error(failure.message);
      }
      if (this.runtime.options.log) {
        this.log(
          `TIA coverage reconstructed: ${report.files} source file${report.files === 1 ? "" : "s"} in ${this.runtime.coverage.reportsDirectory}.`
        );
      }
    }
    if (this.runtime.coverage.enabled && !coverageReady && this.runtime.coverage.thresholds !== null) {
      this.warn(
        "TIA coverage thresholds were deferred because this graph is a partial shard."
      );
    }
    if (this.runtime.options.log) {
      const replayed = plan.mode === "replay" ? plan.replayedTests : 0;
      this.log(
        `TIA graph saved: ${this.executedFiles.size} executed file${this.executedFiles.size === 1 ? "" : "s"}, ${replayed} replayed result${replayed === 1 ? "" : "s"}.`
      );
    }
    await notifyReplayAdapters(
      this.runtime.options.replayAdapters,
      "onRunComplete",
      {
        ...replayRunEvent(plan),
        coverageReportDirectory: shouldReportCoverage ? this.runtime.coverage.reportsDirectory : null,
        executedTestFiles: [...this.executedFiles].sort()
      },
      (message) => this.warn(message)
    );
  }
  async recordIncludesEveryConfiguredTestFile(modules) {
    if (this.vitest === null) {
      return false;
    }
    try {
      const expected = /* @__PURE__ */ new Set();
      for (const project of this.vitest.projects) {
        const files = await project.globTestFiles();
        for (const file of files.testFiles) {
          const relative5 = projectRelative(this.runtime.root, file);
          if (relative5 !== null && relative5 !== "") {
            expected.add(relative5);
          }
        }
      }
      const observed = new Set(
        modules.map(
          (module2) => projectRelative(this.runtime.root, module2.moduleId)
        ).filter(
          (file) => file !== null && file !== ""
        )
      );
      return [...expected].every((file) => observed.has(file));
    } catch {
      return false;
    }
  }
  async notifyReplayReporters(result) {
    if (this.vitest === null || this.runtime.options.replayReporters.length === 0) {
      return;
    }
    const testCase = cachedTestCase(
      this.vitest,
      this.runtime.root,
      result
    );
    for (const reporter of this.runtime.options.replayReporters) {
      for (const method of [
        "onTestCaseReady",
        "onTestCaseResult"
      ]) {
        const handler = reporter[method];
        if (handler === void 0) {
          continue;
        }
        try {
          await handler.call(reporter, testCase);
        } catch (error) {
          this.warn(
            `TIA replay reporter ${method} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  recordModuleFailures(modules) {
    for (const module2 of modules) {
      if (module2.state() !== "failed") {
        continue;
      }
      const file = projectRelative(this.runtime.root, module2.moduleId);
      if (file === null || file === "") {
        continue;
      }
      const hasFailedTestCase = [...this.results.values()].some(
        (result) => result.file === file && result.state === "failed" && !result.id.startsWith("module:")
      );
      if (hasFailedTestCase) {
        continue;
      }
      const id = `module:${file}`;
      this.results.set(id, {
        file,
        fullName: `${file} (module failure)`,
        id,
        state: "failed"
      });
    }
  }
  log(message) {
    if (this.vitest !== null) {
      this.vitest.logger.log(`
 ${message}`);
      return;
    }
    console.log(message);
  }
  error(message) {
    if (this.vitest !== null) {
      this.vitest.logger.error(message);
      return;
    }
    console.error(message);
  }
  warn(message) {
    if (this.vitest !== null) {
      this.vitest.logger.warn(message);
      return;
    }
    console.warn(message);
  }
};

// src/vitest/plugin.ts
var sharedStateKey = /* @__PURE__ */ Symbol.for(`tiajs@${PLUGIN_VERSION}/shared-state`);
var sharedStates = globalThis[sharedStateKey] ??= /* @__PURE__ */ new WeakMap();
var runtimeStateKey = /* @__PURE__ */ Symbol.for(
  `tiajs@${PLUGIN_VERSION}/browser-runtime-state`
);
var runtimeStates = globalThis[runtimeStateKey] ??= /* @__PURE__ */ new Map();
function envFlag(name) {
  return /^(?:1|true|yes|on)$/i.test(process.env[name] ?? "");
}
function defaultEnabled() {
  if (process.env.TIA !== void 0) {
    return envFlag("TIA");
  }
  return envFlag("CI") || process.argv.includes("run") || process.argv.includes("--run");
}
function hasCliFileFilter(root) {
  const optionValues = /* @__PURE__ */ new Set([
    "--config",
    "-c",
    "--dir",
    "--root"
  ]);
  const arguments_ = process.argv.slice(2);
  return arguments_.some((argument, index) => {
    if (argument.startsWith("-")) {
      return false;
    }
    const previous = arguments_[index - 1];
    if (previous !== void 0 && optionValues.has(previous)) {
      return false;
    }
    const clean = slash(argument.replace(/:\d+$/, ""));
    return TEST_FILE_PATTERN.test(clean) || clean !== "run" && clean !== "watch" && (0, import_node_fs13.existsSync)((0, import_node_path19.resolve)(root, clean)) && !clean.includes(".config.");
  });
}
function hasNativeSelection(root, config) {
  return Boolean(config.changed) || (config.cliExclude?.length ?? 0) > 0 || (config.filters?.length ?? 0) > 0 || (config.project?.length ?? 0) > 0 || (config.related?.length ?? 0) > 0 || (config.tagsFilter?.length ?? 0) > 0 || config.testNamePattern !== void 0 || hasCliFileFilter(root);
}
function normalizeOptions(options) {
  const requestedCoverage = options.coverage === true ? {} : options.coverage || null;
  const adapters = frameworkAdapters(options.frameworks);
  const shardGroup = options.shardGroup ?? (process.env.TIA_SHARD_GROUP?.trim() === "" ? void 0 : process.env.TIA_SHARD_GROUP);
  return {
    artifactProviders: artifactProviders(options.artifacts),
    cacheDir: options.cacheDir ?? ".tia",
    coverage: requestedCoverage === null ? false : {
      clean: requestedCoverage.clean ?? true,
      cleanOnRerun: requestedCoverage.cleanOnRerun ?? true,
      exclude: requestedCoverage.exclude ?? [],
      include: requestedCoverage.include ?? null,
      reportOnFailure: requestedCoverage.reportOnFailure ?? false,
      reporters: requestedCoverage.reporters ?? [
        "text",
        "html",
        "json"
      ],
      reportsDirectory: requestedCoverage.reportsDirectory ?? "coverage",
      skipFull: requestedCoverage.skipFull ?? false,
      thresholds: requestedCoverage.thresholds ?? null,
      watermarks: {
        branches: requestedCoverage.watermarks?.branches ?? [50, 80],
        functions: requestedCoverage.watermarks?.functions ?? [50, 80],
        lines: requestedCoverage.watermarks?.lines ?? [50, 80],
        statements: requestedCoverage.watermarks?.statements ?? [50, 80]
      }
    },
    enabled: options.enabled ?? defaultEnabled(),
    exclude: [...DEFAULT_EXCLUDE, ...options.exclude ?? []],
    fresh: options.fresh ?? envFlag("TIA_FRESH"),
    frameworkAdapters: adapters,
    frameworkFingerprint: frameworkFingerprint(adapters),
    ignoreChanges: options.ignoreChanges ?? [],
    include: options.include ?? DEFAULT_INCLUDE,
    log: options.log ?? true,
    onUnknownChange: options.onUnknownChange ?? "full",
    replayAdapters: options.replayAdapters === void 0 ? [] : Array.isArray(options.replayAdapters) ? options.replayAdapters : [options.replayAdapters],
    replayReporters: options.replayReporters === void 0 ? [] : [
      ...new Set(
        Array.isArray(options.replayReporters) ? options.replayReporters : [options.replayReporters]
      )
    ],
    ...shardGroup === void 0 ? {} : { shardGroup }
  };
}
var DEFAULT_COVERAGE_REPORTERS = [
  "text",
  "html",
  "json"
];
function coverageReporters(value) {
  const configured = typeof value === "string" ? [value] : Array.isArray(value) ? value : DEFAULT_COVERAGE_REPORTERS;
  const reporters = [];
  for (const item of configured) {
    if (typeof item === "string" && item !== "") {
      reporters.push({ name: item, options: {} });
      continue;
    }
    if (!Array.isArray(item) || typeof item[0] !== "string" || item[0] === "") {
      continue;
    }
    const value2 = item[1];
    reporters.push({
      name: item[0],
      options: value2 !== null && typeof value2 === "object" && !Array.isArray(value2) ? { ...value2 } : {}
    });
  }
  return reporters.length === 0 ? coverageReporters(DEFAULT_COVERAGE_REPORTERS) : reporters;
}
function coverageRuntime(root, configured, native) {
  if (configured === false && native === null) {
    return {
      clean: true,
      cleanOnRerun: true,
      enabled: false,
      exclude: [],
      include: null,
      reportOnFailure: false,
      reporters: [],
      reportsDirectory: (0, import_node_path19.resolve)(root, "coverage"),
      skipFull: false,
      thresholds: null,
      watermarks: {
        branches: [50, 80],
        functions: [50, 80],
        lines: [50, 80],
        statements: [50, 80]
      }
    };
  }
  const runtime = {
    clean: configured === false ? native?.clean ?? true : configured.clean,
    cleanOnRerun: configured === false ? native?.cleanOnRerun ?? true : configured.cleanOnRerun,
    enabled: true,
    exclude: configured === false ? native?.exclude ?? [] : configured.exclude,
    include: configured === false ? native?.include ?? null : configured.include,
    reportOnFailure: configured === false ? native?.reportOnFailure ?? false : configured.reportOnFailure,
    reporters: configured === false ? coverageReporters(native?.reporter) : coverageReporters(configured.reporters),
    reportsDirectory: (0, import_node_path19.resolve)(
      root,
      configured === false ? native?.reportsDirectory ?? "coverage" : configured.reportsDirectory
    ),
    skipFull: configured === false ? native?.skipFull ?? false : configured.skipFull,
    thresholds: configured === false ? native?.thresholds !== null && typeof native?.thresholds === "object" ? native.thresholds : null : configured.thresholds ?? (native?.thresholds !== null && typeof native?.thresholds === "object" ? native.thresholds : null),
    watermarks: configured === false ? {
      branches: native?.watermarks?.branches ?? [50, 80],
      functions: native?.watermarks?.functions ?? [50, 80],
      lines: native?.watermarks?.lines ?? [50, 80],
      statements: native?.watermarks?.statements ?? [50, 80]
    } : configured.watermarks
  };
  if (runtime.reportsDirectory === (0, import_node_path19.resolve)(root) || (0, import_node_path19.dirname)(runtime.reportsDirectory) === runtime.reportsDirectory) {
    throw new Error(
      `tiajs cannot use the project or filesystem root as coverage.reportsDirectory: ${runtime.reportsDirectory}`
    );
  }
  return runtime;
}
function normalizeSetupFiles(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  return [];
}
function impossibleTestPattern(cacheDir) {
  return slash((0, import_node_path19.resolve)(cacheDir, "__no_affected_tests__", "**", "*.{test,spec}.ts"));
}
function setupProxyPath(root, cacheDir) {
  const resolvedCache = resolveCacheDir(root, cacheDir);
  const localCache = isInside(root, resolvedCache) ? resolvedCache : (0, import_node_path19.resolve)(root, ".tia");
  return (0, import_node_path19.resolve)(localCache, "runtime", `setup-${PLUGIN_VERSION}.mjs`);
}
function pluginSetupPath() {
  const localCompiled = (0, import_node_url.fileURLToPath)(
    new URL("./setup.js", __tiaImportMetaUrl)
  );
  const compiled = [
    localCompiled,
    (0, import_node_url.fileURLToPath)(new URL("./vitest/setup.js", __tiaImportMetaUrl))
  ];
  for (const candidate of compiled) {
    if ((0, import_node_fs13.existsSync)(candidate)) {
      return candidate;
    }
  }
  const source = (0, import_node_url.fileURLToPath)(new URL("./setup.ts", __tiaImportMetaUrl));
  return (0, import_node_fs13.existsSync)(source) ? source : localCompiled;
}
function ensureSetupProxy(root, cacheDir, setupPath) {
  const proxyPath = setupProxyPath(root, cacheDir);
  const contents = `import ${JSON.stringify((0, import_node_url.pathToFileURL)(setupPath).href)}
`;
  if (!(0, import_node_fs13.existsSync)(proxyPath) || (0, import_node_fs13.readFileSync)(proxyPath, "utf8") !== contents) {
    (0, import_node_fs13.mkdirSync)((0, import_node_path19.dirname)(proxyPath), { recursive: true });
    (0, import_node_fs13.writeFileSync)(proxyPath, contents);
  }
  return proxyPath;
}
function affectedTestsForProject(affectedTests, globalRoot, projectRoot, include, exclude) {
  const includes = (0, import_picomatch7.default)(include, { dot: true });
  const excludes = (0, import_picomatch7.default)(exclude, { dot: true });
  return affectedTests.map((file) => {
    const absolute = (0, import_node_path19.resolve)(globalRoot, file);
    return {
      absolute: slash(absolute),
      projectRelative: slash((0, import_node_path19.relative)(projectRoot, absolute)),
      rootRelative: file
    };
  }).filter(
    (file) => !file.projectRelative.startsWith("../") && (includes(file.projectRelative) || includes(file.rootRelative) || includes(file.absolute)) && !(excludes(file.projectRelative) || excludes(file.rootRelative) || excludes(file.absolute))
  ).map((file) => file.projectRelative);
}
function tia(options = {}) {
  const normalized = normalizeOptions(options);
  const setupPath = pluginSetupPath();
  let runtime = {
    active: false,
    baselineAtStart: null,
    coverage: {
      clean: true,
      cleanOnRerun: true,
      enabled: false,
      exclude: [],
      include: null,
      reportOnFailure: false,
      reporters: [],
      reportsDirectory: (0, import_node_path19.resolve)(process.cwd(), "coverage"),
      skipFull: false,
      thresholds: null,
      watermarks: {
        branches: [50, 80],
        functions: [50, 80],
        lines: [50, 80],
        statements: [50, 80]
      }
    },
    fingerprintAtStart: "",
    graphAtStart: null,
    graphDigestAtStart: null,
    ignoredPrefixes: [],
    instrumenter: null,
    options: normalized,
    partition: null,
    plan: null,
    root: process.cwd(),
    structuralFiles: [],
    writeCacheDir: (0, import_node_path19.resolve)(process.cwd(), normalized.cacheDir)
  };
  let includeMatcher = null;
  let excludeMatcher = null;
  return {
    name: "tiajs",
    enforce: "post",
    config(config) {
      if (!normalized.enabled) {
        return;
      }
      const root = (0, import_node_path19.resolve)(config.root ?? process.cwd());
      const runtimeKey = `${slash(root)}\0${slash(
        resolveCacheDir(root, normalized.cacheDir)
      )}`;
      const existingRuntime = runtimeStates.get(runtimeKey);
      if (existingRuntime === void 0) {
        runtimeStates.set(runtimeKey, runtime);
      } else {
        runtime = existingRuntime;
      }
      const setupProxy = ensureSetupProxy(
        root,
        normalized.cacheDir,
        setupPath
      );
      config.test ??= {};
      const setupFiles = normalizeSetupFiles(config.test.setupFiles);
      if (!setupFiles.includes(setupProxy)) {
        config.test.setupFiles = [...setupFiles, setupProxy];
      }
    },
    async configureVitest({ project, vitest }) {
      if (!normalized.enabled) {
        return;
      }
      let shared = sharedStates.get(vitest);
      if (shared === void 0) {
        shared = {
          bypassed: false,
          excludeMatcher: null,
          includeMatcher: null,
          initialized: false,
          runtime,
          selectedProjects: /* @__PURE__ */ new Set()
        };
        sharedStates.set(vitest, shared);
      } else {
        runtime = shared.runtime;
        includeMatcher = shared.includeMatcher;
        excludeMatcher = shared.excludeMatcher;
      }
      if (shared.bypassed) {
        return;
      }
      const candidates = [.../* @__PURE__ */ new Set([...vitest.projects, project])];
      const selectAll = {
        mode: "all",
        testIds: [],
        wholeTestFiles: []
      };
      const nativeCoverageProject = candidates.find(
        (candidate) => candidate.config.coverage.enabled
      );
      if (vitest.config.watch || hasNativeSelection(
        (0, import_node_path19.resolve)(vitest.config.root ?? process.cwd()),
        vitest.config
      )) {
        for (const candidate of candidates) {
          candidate.provide(TIA_SELECTION_KEY, selectAll);
        }
        runtime.active = false;
        shared.bypassed = true;
        return;
      }
      if (!shared.initialized) {
        runtime.root = (0, import_node_path19.resolve)(vitest.config.root);
        runtime.options = {
          ...normalized,
          cacheDir: resolveCacheDir(runtime.root, normalized.cacheDir)
        };
        runtime.coverage = coverageRuntime(
          runtime.root,
          normalized.coverage,
          nativeCoverageProject?.config.coverage ?? null
        );
        if (nativeCoverageProject !== void 0) {
          vitest.disableCoverage();
        }
        const cachePrefix = projectRelative(runtime.root, runtime.options.cacheDir) ?? "";
        runtime.ignoredPrefixes = [
          cachePrefix,
          projectRelative(
            runtime.root,
            runtime.coverage.reportsDirectory
          ),
          ...candidates.map(
            (candidate) => projectRelative(
              runtime.root,
              (0, import_node_path19.resolve)(
                runtime.root,
                candidate.config.coverage.reportsDirectory
              )
            )
          ).filter((file) => file !== null)
        ].filter(
          (file) => file !== null && file !== ""
        );
        runtime.structuralFiles = [
          ...new Set(
            [...vitest.projects, project].map((candidate) => candidate.vite.config.configFile).filter((file) => typeof file === "string").map((file) => projectRelative(runtime.root, file)).filter((file) => file !== null)
          )
        ];
        runtime.fingerprintAtStart = projectFingerprint(
          runtime.root,
          runtime.options,
          runtime.structuralFiles
        );
        runtime.baselineAtStart = captureBaseline(
          runtime.root,
          runtime.ignoredPrefixes
        );
        runtime.partition = vitest.config.shard === void 0 ? null : {
          group: partitionGroup(
            runtime.baselineAtStart,
            runtime.fingerprintAtStart,
            vitest.config.shard.count,
            runtime.options.shardGroup
          ),
          index: vitest.config.shard.index,
          total: vitest.config.shard.count
        };
        runtime.writeCacheDir = runtime.partition === null ? runtime.options.cacheDir : partitionCacheDir(
          runtime.options.cacheDir,
          runtime.partition
        );
        if (runtime.partition === null) {
          if (runtime.options.fresh) {
            purgeGraph(runtime.options.cacheDir);
          } else if (runtime.options.artifactProviders.length > 0) {
            await restoreGraphFromArtifacts({
              cacheDir: runtime.options.cacheDir,
              coverageRequested: runtime.coverage.enabled,
              fingerprint: runtime.fingerprintAtStart,
              log: runtime.options.log,
              providers: runtime.options.artifactProviders,
              root: runtime.root
            });
          }
        } else if (runtime.options.fresh) {
          purgeGraph(runtime.writeCacheDir);
        }
        const graph = readGraph(runtime.writeCacheDir);
        runtime.graphAtStart = graph;
        runtime.graphDigestAtStart = graphDigest(graph);
        runtime.plan = createRunPlan({
          cachePrefix,
          coverageRequested: runtime.coverage.enabled,
          fingerprint: runtime.fingerprintAtStart,
          graph: runtime.partition === null ? graph : null,
          ignoredPrefixes: runtime.ignoredPrefixes,
          options: runtime.options,
          root: runtime.root
        });
        runtime.active = true;
        shared.initialized = true;
        vitest.config.reporters.push(new TiaReporter(runtime));
        includeMatcher = (0, import_picomatch7.default)(runtime.options.include, { dot: true });
        excludeMatcher = (0, import_picomatch7.default)(runtime.options.exclude, { dot: true });
        shared.includeMatcher = includeMatcher;
        shared.excludeMatcher = excludeMatcher;
      }
      const plan = runtime.plan;
      if (plan === null) {
        return;
      }
      if (plan.mode === "record") {
        for (const candidate of candidates) {
          candidate.provide(TIA_SELECTION_KEY, selectAll);
        }
        return;
      }
      if (plan.mode === "replay") {
        vitest.config.passWithNoTests = true;
        const selection = {
          mode: "tests",
          testIds: plan.affectedTestIds,
          wholeTestFiles: plan.wholeTestFiles.map(
            (file) => slash((0, import_node_path19.resolve)(runtime.root, file))
          )
        };
        for (const candidate of candidates) {
          if (shared.selectedProjects.has(candidate)) {
            continue;
          }
          shared.selectedProjects.add(candidate);
          candidate.provide(TIA_SELECTION_KEY, selection);
          const candidateConfig = candidate.config;
          const affectedTests = affectedTestsForProject(
            plan.affectedTests,
            runtime.root,
            (0, import_node_path19.resolve)(candidateConfig.root),
            candidateConfig.include,
            candidateConfig.exclude
          );
          candidateConfig.include = affectedTests.length === 0 ? [impossibleTestPattern(runtime.options.cacheDir)] : affectedTests;
          candidateConfig.passWithNoTests = true;
        }
      }
    },
    transform(code, id) {
      if (!runtime.active) {
        return;
      }
      includeMatcher ??= (0, import_picomatch7.default)(runtime.options.include, { dot: true });
      excludeMatcher ??= (0, import_picomatch7.default)(runtime.options.exclude, { dot: true });
      const cleanId2 = id.split("?", 1)[0];
      if (cleanId2 === void 0 || cleanId2.startsWith("\0") || !isInside(runtime.root, cleanId2)) {
        return;
      }
      const relativeId = slash((0, import_node_path19.relative)(runtime.root, cleanId2));
      if (!includeMatcher(relativeId) || excludeMatcher(relativeId)) {
        return;
      }
      runtime.instrumenter ??= (0, import_istanbul_lib_instrument2.createInstrumenter)({
        coverageVariable: "__coverage__",
        esModules: true,
        produceSourceMap: true
      });
      try {
        const inputMap = this.getCombinedSourcemap();
        const transformed = runtime.instrumenter.instrumentSync(
          code,
          cleanId2,
          inputMap.mappings === "" ? void 0 : inputMap
        );
        return {
          code: transformed,
          map: runtime.instrumenter.lastSourceMap()
        };
      } catch (error) {
        this.warn(
          `tiajs could not instrument ${relativeId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  tia
});
//# sourceMappingURL=index.cjs.map
