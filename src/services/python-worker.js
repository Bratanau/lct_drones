const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";

function runPythonWorker(moduleName, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ["-m", moduleName], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`Таймаут Python worker ${moduleName}.`));
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      try {
        const result = JSON.parse(stdout || "{}");
        if (code === 0 && !result.errors) return resolve(result);
        reject(
          new Error(
            result.errors?.join(" ") || stderr || `${moduleName} failed.`,
          ),
        );
      } catch (_) {
        reject(new Error(stderr || `${moduleName} returned invalid JSON.`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function planMission(input, platform) {
  return runPythonWorker(
    "src.geometry.service",
    { ...input, platform },
    15_000,
  );
}

function allocateRoutes(input) {
  return runPythonWorker("src.route_optimizer", input, 8_000);
}

function uploadMavlinkMission(input) {
  const timeoutMs = (Number(input.timeoutSeconds) || 10) * 1000 + 5_000;
  return runPythonWorker("src.mavlink_uploader", input, timeoutMs);
}

module.exports = { allocateRoutes, planMission, uploadMavlinkMission };
