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

// src/node.ts
var node_exports = {};
__export(node_exports, {
  tia: () => tia
});
module.exports = __toCommonJS(node_exports);

// src/runners/node.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs7 = require("node:fs");
var import_node_os3 = require("node:os");
var import_node_path9 = require("node:path");
var import_node_url = require("node:url");
var import_tinyglobby = require("tinyglobby");

// src/runners/core.ts
var import_node_path8 = require("node:path");

// src/shared/constants.ts
var GRAPH_SCHEMA_VERSION = 3;
var PLUGIN_VERSION = "0.1.0";
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
var wait = (milliseconds) => new Promise((resolve7) => setTimeout(resolve7, milliseconds));
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
function repositoryPaths(root, args) {
  const repositoryRoot = gitText(root, ["rev-parse", "--show-toplevel"]);
  if (repositoryRoot === null) {
    return null;
  }
  const paths = gitPaths(repositoryRoot, args);
  return paths?.map(
    (file) => slash((0, import_node_path5.relative)(root, (0, import_node_path5.resolve)(repositoryRoot, file)))
  ) ?? null;
}
function currentSha(root) {
  return gitText(root, ["rev-parse", "--verify", "HEAD"]);
}
function isAncestor(root, ancestor, descendant) {
  return runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}
function untrackedFiles(root) {
  return repositoryPaths(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard"
  ]);
}
function filesDifferentFrom(root, revision) {
  return repositoryPaths(root, [
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

// src/graph/update.ts
var import_node_fs6 = require("node:fs");
var import_node_path7 = require("node:path");
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
    if (!(0, import_node_fs6.existsSync)((0, import_node_path7.resolve)(input.root, testFile))) {
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

// src/runners/core.ts
function normalizedOptions2(root, options) {
  return {
    artifactProviders: artifactProviders(options.artifacts),
    cacheDir: resolveCacheDir(root, options.cacheDir ?? ".tia"),
    coverage: false,
    enabled: true,
    exclude: [...DEFAULT_EXCLUDE, ...options.exclude ?? []],
    fresh: options.fresh ?? false,
    frameworkAdapters: [],
    frameworkFingerprint: "",
    ignoreChanges: options.ignoreChanges ?? [],
    include: options.include ?? DEFAULT_INCLUDE,
    log: options.log ?? true,
    onUnknownChange: options.onUnknownChange ?? "full",
    replayAdapters: options.replayAdapters === void 0 ? [] : Array.isArray(options.replayAdapters) ? options.replayAdapters : [options.replayAdapters],
    replayReporters: []
  };
}
var TiaCore = class {
  cacheDir;
  options;
  root;
  baselineAtStart = null;
  fingerprintAtStart = "";
  graphDigestAtStart = null;
  planValue = null;
  runner;
  runnerFiles;
  constructor(options) {
    this.root = (0, import_node_path8.resolve)(options.root ?? process.cwd());
    this.options = normalizedOptions2(this.root, options);
    this.cacheDir = (0, import_node_path8.resolve)(this.options.cacheDir, options.runner);
    this.runner = options.runner;
    this.runnerFiles = [...options.files].sort();
    this.baselineAtStart = null;
  }
  get plan() {
    if (this.planValue === null) {
      throw new Error("TIA core has not been prepared");
    }
    return this.planValue;
  }
  async prepare() {
    const cachePrefix = projectRelative(this.root, this.options.cacheDir) ?? "";
    this.fingerprintAtStart = this.fingerprint();
    if (this.options.fresh) {
      purgeGraph(this.cacheDir);
    } else if (this.options.artifactProviders.length > 0) {
      await restoreGraphFromArtifacts({
        cacheDir: this.cacheDir,
        fingerprint: this.fingerprintAtStart,
        log: this.options.log,
        providers: this.options.artifactProviders,
        root: this.root,
        runner: this.runner
      });
    }
    const graph = readGraph(this.cacheDir);
    this.graphDigestAtStart = graphDigest(graph);
    this.baselineAtStart = captureBaseline(
      this.root,
      cachePrefix === "" ? [] : [cachePrefix]
    );
    this.planValue = createRunPlan({
      cachePrefix,
      fingerprint: this.fingerprintAtStart,
      graph,
      ignoredPrefixes: cachePrefix === "" ? [] : [cachePrefix],
      options: this.options,
      root: this.root
    });
    await notifyReplayAdapters(
      this.options.replayAdapters,
      "onRunStart",
      replayRunEvent(this.planValue),
      console.warn
    );
    for (const result of this.replayedResults()) {
      await notifyReplayAdapters(
        this.options.replayAdapters,
        "onTestReplayed",
        { result: structuredClone(result) },
        console.warn
      );
    }
    return this.planValue;
  }
  async commit(observations, wholeTestFiles) {
    const plan = this.plan;
    const cachePrefix = projectRelative(this.root, this.options.cacheDir) ?? "";
    const baseline = captureBaseline(
      this.root,
      cachePrefix === "" ? [] : [cachePrefix]
    );
    if (baseline === null || this.baselineAtStart === null || JSON.stringify(baseline) !== JSON.stringify(this.baselineAtStart) || this.fingerprint() !== this.fingerprintAtStart) {
      return null;
    }
    const results = /* @__PURE__ */ new Map();
    const testEdges = /* @__PURE__ */ new Map();
    for (const observation of observations) {
      results.set(observation.id, {
        ...observation.duration === void 0 ? {} : { duration: observation.duration },
        file: observation.file,
        fullName: observation.fullName,
        id: observation.id,
        state: observation.state
      });
      testEdges.set(observation.id, {
        file: observation.file,
        files: [
          .../* @__PURE__ */ new Set([observation.file, ...observation.files])
        ].sort()
      });
    }
    const touchedFiles = /* @__PURE__ */ new Set([
      ...wholeTestFiles,
      ...observations.map((observation) => observation.file)
    ]);
    const graph = updateGraph({
      executedFiles: touchedFiles,
      fullyExecutedFiles: wholeTestFiles,
      previous: plan.mode === "record" || plan.graph === null ? null : plan.graph,
      results,
      root: this.root,
      testEdges
    });
    graph.baseline = baseline;
    graph.complete = true;
    graph.coverageComplete = false;
    graph.fingerprint = this.fingerprintAtStart;
    graph.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const committed = await commitGraph(this.cacheDir, {
      expected: plan.graph,
      expectedDigest: this.graphDigestAtStart,
      graph
    });
    if (committed.status === "conflict" || committed.graph === null) {
      return null;
    }
    await notifyReplayAdapters(
      this.options.replayAdapters,
      "onRunComplete",
      {
        ...replayRunEvent(plan),
        coverageReportDirectory: null,
        executedTestFiles: [...touchedFiles].sort()
      },
      console.warn
    );
    return committed.graph;
  }
  replayedResults() {
    return replayedResults(this.plan);
  }
  fingerprint() {
    return hashBytes(
      JSON.stringify({
        core: projectFingerprint(this.root, this.options),
        files: this.runnerFiles,
        runner: this.runner
      })
    );
  }
};

// src/runners/parallel.ts
var import_node_os2 = require("node:os");
function normalizedConcurrency(value) {
  if (value === void 0) {
    return Math.max(1, Math.min(4, (0, import_node_os2.availableParallelism)()));
  }
  return Math.max(1, Math.floor(value));
}
function groupBy(values, key) {
  const groups = /* @__PURE__ */ new Map();
  for (const value of values) {
    const group = key(value);
    const items = groups.get(group) ?? [];
    items.push(value);
    groups.set(group, items);
  }
  return groups;
}
async function parallelMap(values, concurrency, worker) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (next < values.length) {
          const index = next;
          next += 1;
          results[index] = await worker(values[index], index);
        }
      }
    )
  );
  return results;
}

// src/runners/observations.ts
function moduleFailureObservation(file) {
  return {
    file,
    files: [file],
    fullName: `${file} (module failure)`,
    id: `module:${file}`,
    state: "failed"
  };
}
function fullyExecutedFiles(plan, observations, initial) {
  const files = new Set(initial);
  for (const observation of observations) {
    if (observation.id === `module:${observation.file}`) {
      files.add(observation.file);
    }
  }
  if (plan.mode === "replay" && plan.graph !== null) {
    for (const id of plan.affectedTestIds) {
      if (id.startsWith("module:")) {
        const result = plan.graph.results[id];
        if (result !== void 0) {
          files.add(result.file);
        }
      }
    }
  }
  return [...files].sort();
}

// src/runners/node.ts
function runnerAsset(name) {
  const moduleAsset = (0, import_node_url.fileURLToPath)(new URL(`./${name}`, __tiaImportMetaUrl));
  if ((0, import_node_fs7.existsSync)(moduleAsset)) {
    return moduleAsset;
  }
  return (0, import_node_url.fileURLToPath)(new URL(`./runners/${name}`, __tiaImportMetaUrl));
}
var DEFAULT_NODE_TESTS = [
  "test/**/*.test.{js,cjs,mjs,ts,cts,mts}",
  "test-*.{js,cjs,mjs,ts,cts,mts}",
  "**/*.test.{js,cjs,mjs,ts,cts,mts}"
];
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function nodeVersionSupported() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || major === 22 && minor >= 10;
}
function nodeDiscoveryHooksSupported() {
  if (process.env.TIAJS_NODE_DISCOVERY_HOOKS === "0") {
    return false;
  }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || major === 22 && minor >= 15;
}
function testId(file, line, column, name) {
  return `${file}:${line}:${column}:${name}`;
}
var NodeTiaRunner = class {
  core;
  concurrency;
  files;
  log;
  root;
  discoveryRegister = runnerAsset(
    "node-discovery-register.js"
  );
  executionChild = runnerAsset("node-execution-child.js");
  constructor(options) {
    this.root = (0, import_node_path9.resolve)(options.root ?? process.cwd());
    this.concurrency = normalizedConcurrency(options.concurrency);
    this.files = this.resolveFiles(options.files ?? DEFAULT_NODE_TESTS);
    this.log = options.log ?? true;
    this.core = new TiaCore({
      ...options,
      files: options.files ?? DEFAULT_NODE_TESTS,
      root: this.root,
      runner: "node"
    });
  }
  async run() {
    if (!nodeVersionSupported()) {
      throw new Error(
        "tiajs/node requires Node.js 22.10 or newer for programmatic test coverage"
      );
    }
    const plan = await this.core.prepare();
    this.print(
      plan.mode === "record" ? `TIA node recording full-suite baseline (${plan.reason}).` : `TIA node replay: ${plan.reason}; ${plan.replayedTests} cached test result${plan.replayedTests === 1 ? "" : "s"}.`
    );
    const observations = [];
    const wholeFiles = plan.mode === "record" ? this.files.map((file) => slash((0, import_node_path9.relative)(this.root, file))) : plan.wholeTestFiles;
    if (plan.mode === "record") {
      observations.push(...await this.observeFiles(this.files));
    } else {
      observations.push(
        ...await this.observeFiles(
          plan.wholeTestFiles.map((file) => (0, import_node_path9.resolve)(this.root, file))
        )
      );
      const cached = plan.affectedTestIds.flatMap((id) => {
        const result = plan.graph?.results[id];
        return result === void 0 ? [] : [result];
      });
      observations.push(...await this.observeCachedCases(cached));
    }
    const graph = await this.core.commit(
      observations,
      fullyExecutedFiles(plan, observations, wholeFiles)
    );
    const success = observations.every(
      (observation) => observation.state !== "failed"
    );
    this.print(
      `TIA node complete: ${observations.length} executed, ${plan.replayedTests} replayed.`
    );
    return {
      executedTests: observations,
      graphSaved: graph !== null,
      plan,
      replayedTests: plan.replayedTests,
      success
    };
  }
  async observeFiles(files) {
    if (files.length === 0) {
      return [];
    }
    const discovery = await this.discover(files);
    const observations = [];
    if (discovery.aggregate) {
      return discovery.cases.map(
        (testCase) => this.observation(testCase, [
          testCase.file,
          ...discovery.coverageFiles
        ])
      );
    }
    const groups = groupBy(
      discovery.cases,
      (candidate) => candidate.file
    );
    observations.push(
      ...(await parallelMap(
        [...groups.values()],
        this.concurrency,
        async (candidates) => {
          const fileObservations = [];
          for (const candidate of candidates) {
            if (candidate.state === "skipped") {
              fileObservations.push(
                this.observation(candidate, [candidate.file])
              );
              continue;
            }
            const execution = await this.execute(
              [(0, import_node_path9.resolve)(this.root, candidate.file)],
              new RegExp(`^${escapeRegExp(candidate.fullName)}$`),
              true
            );
            const executed = execution.cases.find(
              (item) => item.id === candidate.id || item.fullName === candidate.fullName || item.fullName === candidate.name || candidate.fullName.endsWith(` ${item.fullName}`)
            );
            const result = executed === void 0 ? {
              ...candidate,
              state: "failed"
            } : {
              ...executed,
              column: candidate.column,
              file: candidate.file,
              fullName: candidate.fullName,
              id: candidate.id,
              line: candidate.line
            };
            fileObservations.push(
              this.observation(result, [
                candidate.file,
                ...execution.coverageFiles
              ])
            );
          }
          return fileObservations;
        }
      )).flat()
    );
    const observedFiles = new Set(observations.map((item) => item.file));
    for (const file of discovery.moduleFailures) {
      if (!observedFiles.has(file)) {
        observations.push(moduleFailureObservation(file));
      }
    }
    return observations;
  }
  async observeCachedCases(cached) {
    const groups = groupBy(cached, (result) => result.file);
    return (await parallelMap(
      [...groups.values()],
      this.concurrency,
      async (results) => {
        const observations = [];
        for (const result of results) {
          observations.push(...await this.observeCachedCase(result));
        }
        return observations;
      }
    )).flat();
  }
  async observeCachedCase(cached) {
    const moduleFailure = cached.id === `module:${cached.file}`;
    const execution = await this.execute(
      [(0, import_node_path9.resolve)(this.root, cached.file)],
      moduleFailure ? void 0 : new RegExp(`^${escapeRegExp(cached.fullName)}$`),
      true
    );
    if (moduleFailure && execution.cases.length > 0) {
      return execution.cases.map(
        (testCase) => this.observation(testCase, [
          cached.file,
          ...execution.coverageFiles
        ])
      );
    }
    const executed = execution.cases.find(
      (item) => item.id === cached.id || item.fullName === cached.fullName || cached.fullName.endsWith(` ${item.fullName}`)
    );
    const result = executed === void 0 ? void 0 : {
      ...executed,
      fullName: cached.fullName,
      id: cached.id
    };
    if (result !== void 0) {
      return [
        this.observation(result, [
          cached.file,
          ...execution.coverageFiles
        ])
      ];
    }
    if (execution.moduleFailures.length > 0) {
      return execution.moduleFailures.map(moduleFailureObservation);
    }
    return [];
  }
  observation(testCase, files) {
    return {
      ...testCase.duration === void 0 ? {} : { duration: testCase.duration },
      file: testCase.file,
      files: [...new Set(files)].sort(),
      fullName: testCase.fullName,
      id: testCase.id,
      state: testCase.state
    };
  }
  async discover(files) {
    if (!nodeDiscoveryHooksSupported()) {
      const aggregate = await this.execute(files, void 0, true);
      return { ...aggregate, aggregate: true };
    }
    const temporary = (0, import_node_fs7.mkdtempSync)((0, import_node_path9.join)((0, import_node_os3.tmpdir)(), "tiajs-node-discovery-"));
    const output = (0, import_node_path9.join)(temporary, "cases.jsonl");
    (0, import_node_fs7.writeFileSync)(output, "");
    try {
      const moduleFailures = (await parallelMap(
        files,
        this.concurrency,
        async (file) => await this.discoverFile(file, output)
      )).filter((file) => file !== null);
      const cases = (0, import_node_fs7.readFileSync)(output, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try {
          const record = JSON.parse(line);
          const absoluteFile = (0, import_node_path9.resolve)(record.file);
          if (!isInside(this.root, absoluteFile)) {
            return [];
          }
          const file = slash((0, import_node_path9.relative)(this.root, absoluteFile));
          return [
            {
              column: record.column,
              file,
              fullName: record.fullName,
              id: testId(
                file,
                record.line,
                record.column,
                record.fullName
              ),
              line: record.line,
              state: record.skipped ? "skipped" : "passed",
              name: record.name
            }
          ];
        } catch {
          return [];
        }
      });
      if (cases.length === 0 && moduleFailures.length === 0) {
        const aggregate = await this.execute(files, void 0, true);
        return { ...aggregate, aggregate: true };
      }
      return {
        aggregate: false,
        cases,
        coverageFiles: [],
        moduleFailures,
        success: moduleFailures.length === 0
      };
    } finally {
      (0, import_node_fs7.rmSync)(temporary, { force: true, recursive: true });
    }
  }
  async discoverFile(file, output) {
    const environment = {
      ...process.env,
      TIAJS_NODE_DISCOVERY_FILE: output
    };
    delete environment.NODE_TEST_CONTEXT;
    const status = await new Promise((resolveStatus) => {
      const child = (0, import_node_child_process2.spawn)(
        process.execPath,
        ["--import", this.discoveryRegister, file],
        {
          cwd: this.root,
          env: environment,
          stdio: "ignore"
        }
      );
      child.on("error", () => {
        resolveStatus(null);
      });
      child.on("close", resolveStatus);
    });
    return status === 0 ? null : slash((0, import_node_path9.relative)(this.root, file));
  }
  async execute(files, pattern, coverage) {
    const temporary = (0, import_node_fs7.mkdtempSync)((0, import_node_path9.join)((0, import_node_os3.tmpdir)(), "tiajs-node-execution-"));
    const request = (0, import_node_path9.join)(temporary, "request.json");
    const output = (0, import_node_path9.join)(temporary, "result.json");
    (0, import_node_fs7.writeFileSync)(
      request,
      JSON.stringify({
        coverage,
        files,
        ...pattern === void 0 ? {} : {
          pattern: {
            flags: pattern.flags,
            source: pattern.source
          }
        },
        root: this.root
      })
    );
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    try {
      await new Promise((resolveChild, rejectChild) => {
        const child = (0, import_node_child_process2.spawn)(
          process.execPath,
          [this.executionChild, request, output],
          {
            cwd: this.root,
            env: environment,
            stdio: "ignore",
            timeout: 3e4
          }
        );
        child.on("error", rejectChild);
        child.on("close", () => {
          resolveChild();
        });
      });
      return JSON.parse((0, import_node_fs7.readFileSync)(output, "utf8"));
    } catch {
      return {
        cases: [],
        coverageFiles: [],
        moduleFailures: files.map(
          (file) => slash((0, import_node_path9.relative)(this.root, file))
        ),
        success: false
      };
    } finally {
      (0, import_node_fs7.rmSync)(temporary, { force: true, recursive: true });
    }
  }
  resolveFiles(patterns) {
    return [
      ...new Set(
        patterns.flatMap(
          (pattern) => (0, import_tinyglobby.globSync)(pattern, {
            cwd: this.root,
            ignore: ["**/node_modules/**", "**/.tia/**"]
          }).map((file) => (0, import_node_path9.resolve)(this.root, file))
        )
      )
    ].sort();
  }
  print(message) {
    if (this.log) {
      console.log(message);
    }
  }
};
function tia(options = {}) {
  return new NodeTiaRunner(options);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  tia
});
//# sourceMappingURL=node.cjs.map
