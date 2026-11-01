import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeployStep } from "../../eval/lib/enums.js";
import {
  ELEVATED_VERIFY_MESSAGE,
  ELEVATION_NOTICE,
  UAC_REFUSED_MESSAGE,
  TASK_NAME,
  createTaskArgs,
  deploySteps,
  elevatedCreateCommand,
  ensureTask,
  installedLine,
  isAccessDenied,
  needsCreateTask,
  parseDeployArgs,
  parseTaskAction,
  startScriptText,
  stopOutcome,
  isOurService,
  stopService,
  taskAction,
  taskScriptText,
  waitForPort,
} from "../deploy.js";
import type { StopIo, TaskIo } from "../deploy.js";
import { ScriptError } from "../lib/shell.js";

describe("installedLine", () => {
  const home = join("C:", "Users", "someone");

  it("names the package and the version, with no path of the home", () => {
    const json = JSON.stringify({
      name: "npm-global",
      path: join(home, "npm"),
      dependencies: { wikifact: { version: "0.1.20", resolved: `file:${join(home, "wikifact-0.1.20.tgz")}` } },
    });
    const line = installedLine(json);
    expect(line).toContain("wikifact@0.1.20");
    expect(line).not.toContain(home);
  });

  it("throws when wikifact is not listed", () => {
    expect(() => installedLine(JSON.stringify({ path: join(home, "npm") }))).toThrow(ScriptError);
    expect(() => installedLine("not json")).toThrow(ScriptError);
  });
});

describe("startScriptText", () => {
  it("is a batch file with CRLF line ends that starts the service with a worker", () => {
    const text = startScriptText();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("@echo off");
    expect(lines[1]).toBe('cd /d "%USERPROFILE%\\wikifact"');
    expect(lines[2]).toBe("call wikifact serve --wikis ./wikis --http 7777 --with-worker");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("taskScriptText", () => {
  it("starts start-service.cmd hidden, from the user profile", () => {
    expect(taskScriptText()).toBe(
      'Start-Process -WindowStyle Hidden -FilePath "$env:USERPROFILE\\wikifact\\start-service.cmd"\r\n',
    );
  });
});

describe("createTaskArgs", () => {
  const script = "C:\\Program Files\\wikifact\\start-service.ps1";

  it("creates a logon task that runs the .ps1 through hidden PowerShell, as one argument, and replaces an existing task", () => {
    const args = createTaskArgs(script);
    expect(args.slice(0, 4)).toEqual(["/create", "/tn", TASK_NAME, "/sc"]);
    expect(args.at(-1)).toBe("/f");
    expect(args.at(-2)).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`);
  });
});

describe("deploySteps", () => {
  it("leaves out the task steps with --no-task", () => {
    expect(deploySteps({ task: true }).at(-1)).toBe(DeployStep.RunTask);
    expect(deploySteps({ task: false })).toEqual([DeployStep.Pack, DeployStep.Install, DeployStep.PrepareFolder]);
  });
});

describe("task action", () => {
  const script = "C:\\Program Files\\wikifact\\start-service.ps1";
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2">
  <Actions Context="Author">
    <Exec>
      <Command>powershell</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;${script}&quot;</Arguments>
    </Exec>
  </Actions>
</Task>`;

  it("parses the command and arguments from the query XML", () => {
    expect(parseTaskAction(xml)).toBe(taskAction(script));
    expect(parseTaskAction("<Task></Task>")).toBeNull();
  });

  it("skips create-task when the action is unchanged and creates it when it differs or the task is absent", () => {
    expect(needsCreateTask(parseTaskAction(xml), taskAction(script))).toBe(false);
    expect(needsCreateTask('cmd /c "C:\\old.cmd"', taskAction(script))).toBe(true);
    expect(needsCreateTask(null, taskAction(script))).toBe(true);
  });

  it("recognises access denied", () => {
    expect(isAccessDenied("ERROR: Access is denied.")).toBe(true);
    expect(isAccessDenied("ERROR: The system cannot find the file specified.")).toBe(false);
  });
});

describe("elevatedCreateCommand", () => {
  it("builds one single-quoted ArgumentList with the /tr value escaped", () => {
    const script = "C:\\Program Files\\wikifact\\start-service.ps1";
    expect(elevatedCreateCommand(createTaskArgs(script))).toBe(
      "Start-Process -FilePath schtasks -ArgumentList '/create /tn WikiFact /sc onlogon /rl limited /tr " +
        '"powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"C:\\Program Files\\wikifact\\start-service.ps1\\"" /f\'' +
        " -Verb RunAs -Wait -WindowStyle Hidden",
    );
  });

  it("doubles a single quote", () => {
    expect(elevatedCreateCommand(["a'b"])).toContain("-ArgumentList 'a''b'");
  });
});

describe("ensureTask", () => {
  const script = "C:\\Program Files\\wikifact\\start-service.ps1";
  const denied = { code: 1, output: "ERROR: Access is denied." };
  function setup(over: Partial<TaskIo>) {
    const logs: string[] = [];
    const calls = { elevated: 0 };
    const io: TaskIo = {
      create: () => ({ code: 0, output: "" }),
      createElevated: () => {
        calls.elevated++;
        return true;
      },
      read: () => taskAction(script),
      log: (l) => logs.push(l),
      ...over,
    };
    return { io, logs, calls };
  }

  it("does nothing when the action is current", () => {
    const { io, calls } = setup({
      create: () => {
        throw new Error("must not create");
      },
    });
    ensureTask(script, taskAction(script), io);
    expect(calls.elevated).toBe(0);
  });

  it("does not elevate when the plain create works", () => {
    const { io, calls } = setup({});
    ensureTask(script, null, io);
    expect(calls.elevated).toBe(0);
  });

  it("elevates on access denied, also for a changed action, and verifies the action", () => {
    const { io, logs, calls } = setup({ create: () => denied });
    ensureTask(script, 'cmd /c "C:\\old.cmd"', io);
    expect(calls.elevated).toBe(1);
    expect(logs).toEqual([ELEVATION_NOTICE]);
  });

  it("stops when the UAC prompt is refused", () => {
    const { io } = setup({ create: () => denied, createElevated: () => false });
    expect(() => ensureTask(script, null, io)).toThrow(UAC_REFUSED_MESSAGE);
  });

  it("stops when the action is wrong after the elevated create", () => {
    const { io } = setup({ create: () => denied, read: () => null });
    expect(() => ensureTask(script, null, io)).toThrow(ELEVATED_VERIFY_MESSAGE);
  });

  it("stops without elevating on another failure", () => {
    const { io, calls } = setup({ create: () => ({ code: 1, output: "ERROR: other" }) });
    expect(() => ensureTask(script, null, io)).toThrow(/failed with exit code 1/);
    expect(calls.elevated).toBe(0);
  });
});

describe("stopOutcome", () => {
  it("says that nothing listened when there is no pid", () => {
    expect(stopOutcome([], true)).toEqual({ message: "no service was listening on 127.0.0.1:7777", failed: false });
  });

  it("says that the service stopped when the port was freed", () => {
    expect(stopOutcome([4242], true)).toEqual({
      message: "stopped the service on 127.0.0.1:7777 (pid 4242 and its children)",
      failed: false,
    });
  });

  it("fails with the pid when the port is not freed", () => {
    const o = stopOutcome([4242], false);
    expect(o.failed).toBe(true);
    expect(o.message).toContain("pid 4242");
  });
});

describe("stopService", () => {
  function setup(pids: number[], freed: boolean, cmd = "node C:\\npm\\node_modules\\wikifact\\dist\\cli.js serve") {
    const killed: number[] = [];
    const logs: string[] = [];
    const io: StopIo = {
      listening: () => Promise.resolve(pids),
      describe: () => Promise.resolve({ name: "node.exe", cmd }),
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      waitFree: () => Promise.resolve(freed),
      log: (l) => logs.push(l),
    };
    return { io, killed, logs };
  }

  it("kills nothing and says so when no pid listens", async () => {
    const { io, killed, logs } = setup([], true);
    await stopService(io);
    expect(killed).toEqual([]);
    expect(logs).toEqual(["no service was listening on 127.0.0.1:7777"]);
  });

  it("kills the pid and reports it once the port is free", async () => {
    const { io, killed, logs } = setup([4242], true);
    await stopService(io);
    expect(killed).toEqual([4242]);
    expect(logs).toEqual(["stopped the service on 127.0.0.1:7777 (pid 4242 and its children)"]);
  });

  it("throws when the port stays held", async () => {
    const { io } = setup([4242], false);
    await expect(stopService(io)).rejects.toThrow(/still in use by pid 4242/);
  });
});

describe("isOurService", () => {
  it("accepts a command line that names wikifact, in any case", () => {
    expect(isOurService({ name: "node.exe", cmd: "node C:\\npm\\node_modules\\wikifact\\dist\\cli.js" })).toBe(true);
    expect(isOurService({ name: "node.exe", cmd: "node C:\\WikiFact\\cli.js" })).toBe(true);
  });
});

describe("waitForPort", () => {
  it("is true for a listening port and false at the timeout for a closed one", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    expect(await waitForPort(port, 2000, 20)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await waitForPort(port, 100, 20)).toBe(false);
    expect(await waitForPort(port, 100, 20, false)).toBe(true);
  });
});

describe("parseDeployArgs", () => {
  it("turns the task steps on by default and --no-task turns them off", () => {
    expect(parseDeployArgs([])).toEqual({ task: true });
    expect(parseDeployArgs(["--no-task"])).toEqual({ task: false });
  });

  it("refuses an unknown flag", () => {
    expect(() => parseDeployArgs(["--nope"])).toThrow(/usage/);
  });
});
