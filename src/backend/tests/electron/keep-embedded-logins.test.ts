import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The keepEmbeddedLogins setting through main's real settings handlers, and
// what a new process makes of the files a failing one left behind.

const require = createRequire(import.meta.url);
const {
  createEmbeddedViews,
} = require("../../../../electron/embedded-view.cjs");
const root = path.resolve(import.meta.dirname, "../../../..");
const source = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

type Settings = {
  getDesktopSettings: () => Record<string, unknown>;
  saveDesktopSettings: (value: Record<string, unknown>) => unknown;
  rendererSettings: (value: unknown) => Record<string, unknown>;
  readEmbeddedLoginKey: () => string | null;
  saveEmbeddedLoginKey: (key: string) => void;
  deleteEmbeddedLoginKey: () => void;
};
type Handler = (event: unknown, ...args: unknown[]) => unknown;

const FALLBACK_TEXT = "Keeping them is now off";
const BOTH_FAILED_TEXT = "they may still work after Termix restarts";
const fail = () => {
  throw new Error("EACCES");
};

class FakeView {
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: () => false,
    close: vi.fn(),
  });
  setBounds = vi.fn();
  setVisible = vi.fn();
  constructor(public options: { webPreferences: Record<string, unknown> }) {}
}

let userData: string;
let partitions: string;
let opened: string[];
let grants: number;

function fakeSession() {
  return Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    clearAuthCache: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    webRequest: { onBeforeRequest: vi.fn() },
  });
}

function loadSettings(): Settings {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "electron/desktop-settings.cjs"), "utf8"),
    {
      module,
      process,
      require: (id: string) =>
        id === "electron"
          ? { app: { getPath: () => userData } }
          : id === "fs"
            ? fs
            : path,
    },
  );
  return module.exports as Settings;
}

/**
 * One app process: the real settings module, a manager swept at start, and
 * main's real get/save settings handlers around them. `broken` replaces
 * settings functions to make disk writes fail.
 */
function startProcess(broken: Partial<Settings> = {}) {
  const desktopSettings = { ...loadSettings(), ...broken };
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const dialog = { showMessageBox: vi.fn().mockResolvedValue({}) };
  const log = vi.fn();
  const embeddedViews = createEmbeddedViews({
    WebContentsView: FakeView,
    session: {
      fromPartition: (name: string) => {
        opened.push(name);
        if (!sessions.has(name)) sessions.set(name, fakeSession());
        return sessions.get(name);
      },
    },
    getMainWindow: () => ({
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
    }),
    log,
    desktopSettings,
    encryptionAvailable: () => true,
    dialog,
  });
  embeddedViews.sweepOldLogins(partitions);

  const handlers = new Map<string, Handler>();
  vm.runInNewContext(
    source.slice(
      source.indexOf('ipc.handle("get-desktop-settings"'),
      source.indexOf("// Text for the first close to tray notice"),
    ),
    {
      ipc: { handle: (name: string, fn: Handler) => handlers.set(name, fn) },
      desktopSettings,
      embeddedViews,
      Object,
    },
  );
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(name)!({}, ...args) as Record<string, unknown>;

  function openPage(url = "https://pi.example/"): string {
    const grant = (++grants).toString(16).padStart(48, "0");
    embeddedViews.addGrant({
      grant,
      pluginId: "web-endpoint",
      url,
      userId: "user-1",
      expiresAt: Date.now() + 60_000,
    });
    embeddedViews.open({ id: "page", grant, pluginId: "web-endpoint" });
    const name = opened[opened.length - 1];
    // Stands in for the folder Electron makes for a persist: partition.
    if (name.startsWith("persist:")) {
      fs.mkdirSync(path.join(partitions, name.slice(8)), { recursive: true });
    }
    return name;
  }

  return {
    embeddedViews,
    dialog,
    log,
    openPage,
    save: (settings: Record<string, unknown>) =>
      call("save-desktop-settings", settings),
    get: () => call("get-desktop-settings"),
  };
}

const tagOf = (name: string) =>
  /^persist:embedded-login-([0-9a-f]{8})-[0-9a-f]{64}$/.exec(name)?.[1];
const keyFile = () => path.join(userData, "embedded-logins.json");
const onDisk = () =>
  JSON.parse(
    fs.readFileSync(path.join(userData, "desktop-settings.json"), "utf8"),
  ).keepEmbeddedLogins;
const folders = () =>
  fs.existsSync(partitions) ? fs.readdirSync(partitions).sort() : [];
const dialogText = (dialog: { showMessageBox: ReturnType<typeof vi.fn> }) =>
  dialog.showMessageBox.mock.calls.map(([options]) => options.message);

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "termix-keep-logins-"));
  partitions = path.join(userData, "Partitions");
  opened = [];
  grants = 0;
});
afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

describe("the keepEmbeddedLogins handlers", () => {
  it("turns storing on and off, and reports what is in effect", () => {
    const app = startProcess();
    expect(app.get()).toMatchObject({
      keepEmbeddedLogins: false,
      embeddedLoginsStored: false,
    });
    expect(app.save({ keepEmbeddedLogins: true })).toEqual({
      success: true,
      keepEmbeddedLogins: true,
      embeddedLoginsStored: true,
    });
    expect(app.get()).toMatchObject({
      keepEmbeddedLogins: true,
      embeddedLoginsStored: true,
    });
    const key = loadSettings().readEmbeddedLoginKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(app.get())).not.toContain(key);
    expect(tagOf(app.openPage())).toBeTruthy();

    expect(app.save({ keepEmbeddedLogins: false })).toEqual({
      success: true,
      keepEmbeddedLogins: false,
      embeddedLoginsStored: false,
    });
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(tagOf(app.openPage())).toBeUndefined();
  });

  it("ignores the setting in a save with other keys", () => {
    const app = startProcess();
    expect(
      app.save({ closeToTray: false, keepEmbeddedLogins: true }),
    ).toMatchObject({ success: true, keepEmbeddedLogins: false });
    expect(onDisk()).toBe(false);
    expect(fs.existsSync(keyFile())).toBe(false);
    // And the page can't set what it only reads.
    app.save({ embeddedLoginsStored: true, closeToTray: true });
    expect(app.get().embeddedLoginsStored).toBe(false);
  });

  it("keeps the setting off when the key can't be written", () => {
    const app = startProcess({ saveEmbeddedLoginKey: fail });
    expect(app.save({ keepEmbeddedLogins: true })).toMatchObject({
      success: false,
      error: "EACCES",
      keepEmbeddedLogins: false,
      embeddedLoginsStored: false,
    });
  });

  it("writes the setting off and shows an error when the key can't be deleted", () => {
    const app = startProcess({ deleteEmbeddedLoginKey: fail });
    app.save({ keepEmbeddedLogins: true });
    expect(app.save({ keepEmbeddedLogins: false })).toMatchObject({
      success: false,
      keepEmbeddedLogins: false,
      embeddedLoginsStored: false,
    });
    expect(onDisk()).toBe(false);
    expect(dialogText(app.dialog)).toEqual([
      expect.stringContaining(FALLBACK_TEXT),
    ]);
  });

  it("says what is in effect when the key delete and the setting write both fail", () => {
    const real = loadSettings();
    let broken = false;
    const app = startProcess({
      deleteEmbeddedLoginKey: fail,
      saveDesktopSettings: (value) => {
        if (broken) fail();
        return real.saveDesktopSettings(value);
      },
    });
    app.save({ keepEmbeddedLogins: true });
    broken = true;
    expect(app.save({ keepEmbeddedLogins: false })).toMatchObject({
      success: false,
      keepEmbeddedLogins: true,
      embeddedLoginsStored: false,
    });
    expect(dialogText(app.dialog)).toEqual([
      expect.stringContaining(BOTH_FAILED_TEXT),
    ]);
  });

  it("reports the setting still on when only the setting write fails, and the old key is gone", () => {
    const real = loadSettings();
    let broken = false;
    const first = startProcess({
      saveDesktopSettings: (value) => {
        if (broken) fail();
        return real.saveDesktopSettings(value);
      },
    });
    first.save({ keepEmbeddedLogins: true });
    const old = first.openPage();
    broken = true;
    expect(first.save({ keepEmbeddedLogins: false })).toMatchObject({
      success: false,
      error: "EACCES",
      keepEmbeddedLogins: true,
    });
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(first.dialog.showMessageBox).not.toHaveBeenCalled();

    // The setting is still on, but no key reaches the old folder.
    const second = startProcess();
    expect(onDisk()).toBe(true);
    expect(folders()).toEqual([]);
    const fresh = second.openPage();
    expect(tagOf(fresh)).toBeTruthy();
    expect(tagOf(fresh)).not.toBe(tagOf(old));
  });
});

describe("a new process after a failed reset", () => {
  it("stays off after the fallback, sweeps every folder, and only the switch turns it on", () => {
    const first = startProcess({ deleteEmbeddedLoginKey: fail });
    first.save({ keepEmbeddedLogins: true });
    const old = first.openPage();
    void first.embeddedViews.forgetSessions();
    // Written before the reset returned, not after a clear settled.
    expect(onDisk()).toBe(false);
    expect(fs.existsSync(keyFile())).toBe(true);
    expect(dialogText(first.dialog)).toEqual([
      expect.stringContaining(FALLBACK_TEXT),
    ]);

    // The delete still fails at this start.
    const second = startProcess({ deleteEmbeddedLoginKey: fail });
    expect(folders()).toEqual([]);
    expect(tagOf(second.openPage())).toBeUndefined();
    expect(second.get().embeddedLoginsStored).toBe(false);
    // A stale page object among other keys can't turn it back on.
    second.save({ closeToTray: true, keepEmbeddedLogins: true });
    expect(onDisk()).toBe(false);
    expect(tagOf(second.openPage())).toBeUndefined();
    // The switch can, with a fresh key.
    expect(second.save({ keepEmbeddedLogins: true })).toMatchObject({
      success: true,
      embeddedLoginsStored: true,
    });
    const fresh = second.openPage();
    expect(tagOf(fresh)).toBeTruthy();
    expect(tagOf(fresh)).not.toBe(tagOf(old));
    expect(fresh).not.toBe(old);
  });

  it("reopens the old login when both the delete and the fallback failed (the accepted exception)", () => {
    const real = loadSettings();
    let broken = false;
    const first = startProcess({
      deleteEmbeddedLoginKey: fail,
      saveDesktopSettings: (value) => {
        if (broken) fail();
        return real.saveDesktopSettings(value);
      },
    });
    first.save({ keepEmbeddedLogins: true });
    const old = first.openPage();
    // A login from an earlier run this one never opened.
    const unopened = `embedded-login-${tagOf(old)}-${"0".repeat(64)}`;
    fs.mkdirSync(path.join(partitions, unopened));
    broken = true;
    void first.embeddedViews.forgetSessions();
    expect(dialogText(first.dialog)).toEqual([
      expect.stringContaining(BOTH_FAILED_TEXT),
    ]);
    expect(tagOf(first.openPage())).toBeUndefined();

    // Nothing on disk records the reset, so a normal start finds it all.
    const second = startProcess();
    expect(onDisk()).toBe(true);
    expect(folders()).toEqual([old.slice(8), unopened].sort());
    expect(second.openPage()).toBe(old);
  });

  it("never reads a key left over with the setting off, and the switch makes a new one", () => {
    const first = startProcess();
    first.save({ keepEmbeddedLogins: true });
    const old = first.openPage();
    const leftover = fs.readFileSync(keyFile(), "utf8");
    first.save({ keepEmbeddedLogins: false });
    fs.writeFileSync(keyFile(), leftover);
    fs.mkdirSync(path.join(partitions, old.slice(8)), { recursive: true });

    const readKey = vi.fn(() => {
      throw new Error("read with the setting off");
    });
    const second = startProcess({ readEmbeddedLoginKey: readKey });
    expect(readKey).not.toHaveBeenCalled();
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(folders()).toEqual([]);
    expect(tagOf(second.openPage())).toBeUndefined();

    const third = startProcess();
    fs.writeFileSync(keyFile(), leftover);
    third.save({ keepEmbeddedLogins: true });
    const fresh = third.openPage();
    expect(tagOf(fresh)).toBeTruthy();
    expect(tagOf(fresh)).not.toBe(tagOf(old));
  });
});

describe("a start whose key can't be read", () => {
  it("stays memory-only for the run and sweeps nothing", () => {
    const first = startProcess();
    first.save({ keepEmbeddedLogins: true });
    const old = first.openPage();

    const second = startProcess({
      readEmbeddedLoginKey: () => {
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
    });
    expect(second.get()).toMatchObject({
      keepEmbeddedLogins: true,
      embeddedLoginsStored: false,
    });
    expect(folders()).toEqual([old.slice(8)]);
    expect(fs.existsSync(keyFile())).toBe(true);
    expect(tagOf(second.openPage())).toBeUndefined();
    expect(second.log).toHaveBeenCalledWith(
      expect.stringContaining("login key read failed"),
    );
  });
});

describe("main's wiring", () => {
  it("gives the manager the settings, encryption check and dialog", () => {
    const create = vi.fn(() => ({}));
    const start = source.indexOf("const embeddedViews = createEmbeddedViews({");
    vm.runInNewContext(source.slice(start, source.indexOf("});", start) + 3), {
      createEmbeddedViews: create,
      WebContentsView: "WebContentsView",
      session: "session",
      logToFile: "log",
      desktopSettings: "settings",
      getSafeStorageAvailable: "encryption",
      dialog: "dialog",
      mainWindow: null,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopSettings: "settings",
        encryptionAvailable: "encryption",
        dialog: "dialog",
      }),
    );
  });

  it("sweeps old logins at start, before any window can open a view", () => {
    const ready = source.slice(source.indexOf("app.whenReady().then("));
    const sweep = ready.indexOf("embeddedViews.sweepOldLogins(");
    expect(ready.slice(sweep, sweep + 120)).toContain(
      'path.join(app.getPath("userData"), "Partitions")',
    );
    expect(sweep).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(ready.indexOf("createWindow("));
    expect(sweep).toBeLessThan(ready.indexOf("await "));
  });
});
