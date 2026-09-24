const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
// На macOS/Linux обычно есть только `python3`, на Windows — `python`.
const CANDIDATE_BINARIES = [process.env.PYTHON_BIN, "python3", "python"].filter(
  Boolean,
);
let resolvedBinary = null;

// Сбой запуска воркера, а не ошибка валидации входных данных.
class WorkerFault extends Error {
  constructor(message, { missingInterpreter = false } = {}) {
    super(message);
    this.name = "WorkerFault";
    this.isWorkerFault = true;
    this.missingInterpreter = missingInterpreter;
  }
}

function spawnWorker(binary, moduleName) {
  return spawn(binary, ["-m", moduleName], {
    cwd: ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
  });
}

function runOnce(binary, moduleName, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(binary, moduleName);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill();
          reject(
            new WorkerFault(
              `Таймаут Python worker ${moduleName} (${timeoutMs} мс).`,
            ),
          );
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT")
        reject(
          new WorkerFault(
            `Интерпретатор Python "${binary}" не найден. Укажите PYTHON_BIN.`,
            { missingInterpreter: true },
          ),
        );
      else reject(new WorkerFault(error.message));
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      let result;
      try {
        result = JSON.parse(stdout || "{}");
      } catch (_) {
        return reject(
          new WorkerFault(
            stderr.trim() || `${moduleName} вернул некорректный JSON.`,
          ),
        );
      }
      // {"errors": [...]} — ошибка валидации при любом коде выхода.
      if (Array.isArray(result.errors)) return resolve(result);
      if (code !== 0)
        return reject(
          new WorkerFault(
            stderr.trim() || `${moduleName} завершился с кодом ${code}.`,
          ),
        );
      resolve(result);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function runPythonWorker(moduleName, input, timeoutMs) {
  if (resolvedBinary)
    return runOnce(resolvedBinary, moduleName, input, timeoutMs);
  let lastError;
  for (const candidate of CANDIDATE_BINARIES) {
    try {
      const result = await runOnce(candidate, moduleName, input, timeoutMs);
      resolvedBinary = candidate;
      return result;
    } catch (error) {
      lastError = error;
      if (!error.missingInterpreter) throw error;
    }
  }
  throw (
    lastError ||
    new WorkerFault("Не удалось найти интерпретатор Python (PYTHON_BIN).")
  );
}

function planMission(input, platform) {
  return runPythonWorker(
    "src.geometry.service",
    { ...input, platform },
    15_000,
  );
}

function allocateRoutes(input) {
  return runPythonWorker("src.route_optimizer", input, 15_000);
}

function uploadMavlinkMission(input) {
  const timeoutMs = (Number(input.timeoutSeconds) || 10) * 1000 + 5_000;
  return runPythonWorker("src.mavlink_uploader", input, timeoutMs);
}

module.exports = {
  allocateRoutes,
  planMission,
  uploadMavlinkMission,
  WorkerFault,
};
