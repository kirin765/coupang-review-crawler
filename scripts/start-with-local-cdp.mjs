import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const DEFAULT_CDP_PORT = "9222";
const DEFAULT_CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_USER_DATA_DIR = "/tmp/chrome-cdp-profile";
const DEFAULT_APP_PORT = "8080";
const DEFAULT_XVFB_DISPLAY = ":99";
const DEFAULT_XVFB_SCREEN = "1280x720x24";

function isTruthyEnv(value) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

async function waitForCdpReady(endpoint) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // CDP가 준비될 때까지 재시도
    }

    await sleep(200);
  }

  throw new Error(`CDP endpoint did not become ready: ${endpoint}`);
}

function shouldUseHeadlessLocalCdp() {
  const configured = process.env.LOCAL_CDP_HEADLESS?.trim();
  if (configured) {
    return isTruthyEnv(configured);
  }

  return false;
}

function createCdpArgs(headless) {
  const port = process.env.CDP_PORT?.trim() || DEFAULT_CDP_PORT;
  const userDataDir = process.env.CDP_USER_DATA_DIR?.trim() || DEFAULT_CDP_USER_DATA_DIR;
  const args = [
    `--remote-debugging-address=${DEFAULT_CDP_HOST}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,720",
  ];

  if (headless) {
    args.push("--headless=new");
  }

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  return args;
}

function spawnManagedProcess(command, args, env) {
  return spawn(command, args, {
    stdio: "inherit",
    env,
  });
}

function shouldLaunchLocalCdp() {
  const startLocalCdp = process.env.START_LOCAL_CDP?.trim();
  if (startLocalCdp) {
    return isTruthyEnv(startLocalCdp);
  }

  return !process.env.CHROME_CDP_URL?.trim();
}

function shouldLaunchXvfb(headless) {
  if (headless) {
    return false;
  }

  return !process.env.DISPLAY?.trim();
}

async function main() {
  const cdpPort = process.env.CDP_PORT?.trim() || DEFAULT_CDP_PORT;
  const cdpUrl = process.env.CHROME_CDP_URL?.trim() || `http://${DEFAULT_CDP_HOST}:${cdpPort}`;
  const launchLocalCdp = shouldLaunchLocalCdp();
  const useHeadlessLocalCdp = shouldUseHeadlessLocalCdp();
  let chromeProcess = null;
  let nextProcess = null;
  let xvfbProcess = null;
  let display = process.env.DISPLAY?.trim() || "";

  const shutdown = (signal = "SIGTERM") => {
    if (nextProcess && nextProcess.exitCode === null) {
      nextProcess.kill(signal);
    }

    if (chromeProcess && chromeProcess.exitCode === null) {
      chromeProcess.kill(signal);
    }

    if (xvfbProcess && xvfbProcess.exitCode === null) {
      xvfbProcess.kill(signal);
    }
  };

  if (launchLocalCdp) {
    if (shouldLaunchXvfb(useHeadlessLocalCdp)) {
      display = process.env.XVFB_DISPLAY?.trim() || DEFAULT_XVFB_DISPLAY;
      const screen = process.env.XVFB_SCREEN?.trim() || DEFAULT_XVFB_SCREEN;

      console.log(`[startup] launching Xvfb on ${display} (${screen})`);
      xvfbProcess = spawnManagedProcess(
        "Xvfb",
        [display, "-screen", "0", screen, "-ac", "-nolisten", "tcp"],
        {
          ...process.env,
        }
      );

      xvfbProcess.on("exit", (code, signal) => {
        if (signal || code !== 0) {
          console.error(`[startup] Xvfb exited early (code=${code}, signal=${signal})`);
        }
      });

      await sleep(1000);
    }

    console.log(`[startup] launching local CDP browser at ${cdpUrl}`);

    chromeProcess = spawnManagedProcess(chromium.executablePath(), createCdpArgs(useHeadlessLocalCdp), {
      ...process.env,
      ...(display ? { DISPLAY: display } : {}),
    });
    chromeProcess.on("exit", (code, signal) => {
      if (signal || code !== 0) {
        console.error(`[startup] local CDP browser exited early (code=${code}, signal=${signal})`);
      }
    });

    try {
      await waitForCdpReady(cdpUrl);
    } catch (error) {
      shutdown("SIGTERM");
      throw error;
    }

    console.log(`[startup] local CDP browser is ready: ${cdpUrl}`);
  }

  const nextPort = process.env.PORT?.trim() || DEFAULT_APP_PORT;
  const nextEnv = {
    ...process.env,
    CHROME_CDP_URL: cdpUrl,
    PORT: nextPort,
    HOSTNAME: process.env.HOSTNAME?.trim() || "0.0.0.0",
    ...(display ? { DISPLAY: display } : {}),
  };

  nextProcess = spawnManagedProcess(
    "npm",
    ["run", "start:next", "--", "--hostname", nextEnv.HOSTNAME, "--port", nextPort],
    nextEnv
  );

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  nextProcess.on("exit", (code, signal) => {
    if (chromeProcess && chromeProcess.exitCode === null) {
      chromeProcess.kill("SIGTERM");
    }

    process.exit(signal ? 1 : (code ?? 0));
  });
}

main().catch((error) => {
  console.error("[startup] failed to start server:", error);
  process.exit(1);
});
