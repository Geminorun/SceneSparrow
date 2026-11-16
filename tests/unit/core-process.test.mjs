import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  coreIsRunning,
  stopCoreProcess,
} from "../../apps/desktop/src/core-process.ts";
test("a signalled already-exited core cannot strand stop, health or activation rollback", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  assert.equal(coreIsRunning(child), true);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(coreIsRunning(child), false);
  await stopCoreProcess(child);
  assert.equal(child.listenerCount("exit"), 0);
  const live = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  await once(live, "spawn");
  await stopCoreProcess(live);
  assert.equal(coreIsRunning(live), false);
});

test("a failed executable spawn is terminal without an exit event", async () => {
  const child = spawn("/nonexistent-scenesparrow-core-fixture", [], {
    stdio: "ignore",
  });
  const error = await new Promise((resolve) => child.once("error", resolve));
  assert.equal(error.code, "ENOENT");
  assert.equal(child.pid, undefined);
  assert.equal(coreIsRunning(child), false);
  await stopCoreProcess(child);
  assert.equal(child.listenerCount("exit"), 0);
});
