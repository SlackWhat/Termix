import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../../..");
const temporary: string[] = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

function load() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "termix-settings-"));
  temporary.push(directory);
  const module = { exports: {} as Record<string, (...args: never[]) => any> };
  vm.runInNewContext(
    readFileSync(path.join(root, "electron/desktop-settings.cjs"), "utf8"),
    {
      module,
      process,
      require: (id: string) =>
        id === "electron"
          ? { app: { getPath: () => directory } }
          : id === "fs"
            ? fs
            : path,
    },
  );
  return module.exports;
}

describe("desktop settings", () => {
  it("closes to the tray by default", () => {
    const settings = load();
    expect(settings.getDesktopSettings()).toMatchObject({
      closeToTray: true,
      trayNoticeShown: false,
    });
  });

  it("only lets the page change its own settings", () => {
    const { rendererSettings } = load();
    expect(
      rendererSettings({
        closeToTray: false,
        defaultConnectionOrigin: "remote",
        trayNoticeShown: true,
        updateMode: "never",
        macTrayIcon: "hidden",
        other: "x",
      } as never),
    ).toEqual({ closeToTray: false, defaultConnectionOrigin: "remote" });
  });

  it("drops values of the wrong type", () => {
    const { rendererSettings } = load();
    expect(
      rendererSettings({
        closeToTray: "no",
        defaultConnectionOrigin: "elsewhere",
      } as never),
    ).toEqual({});
    expect(rendererSettings(null as never)).toEqual({});
  });

  it("keeps saved settings when one is changed", () => {
    const settings = load();
    settings.saveDesktopSettings({ updateMode: "never" } as never);
    settings.saveDesktopSettings({ closeToTray: false } as never);
    expect(settings.getDesktopSettings()).toMatchObject({
      updateMode: "never",
      closeToTray: false,
    });
  });
});

describe("kept embedded logins", () => {
  it("is off by default and only takes a boolean from the page", () => {
    const { getDesktopSettings, rendererSettings } = load();
    expect(getDesktopSettings().keepEmbeddedLogins).toBe(false);
    expect(rendererSettings({ keepEmbeddedLogins: true } as never)).toEqual({
      keepEmbeddedLogins: true,
    });
    for (const value of ["true", 1, null, {}]) {
      expect(rendererSettings({ keepEmbeddedLogins: value } as never)).toEqual(
        {},
      );
    }
  });

  it("keeps the login key in a file of its own, readable by this user only", () => {
    const settings = load();
    const key = "c".repeat(64);
    expect(settings.readEmbeddedLoginKey()).toBeNull();
    settings.saveEmbeddedLoginKey(key as never);
    expect(settings.readEmbeddedLoginKey()).toBe(key);
    expect(JSON.stringify(settings.getDesktopSettings())).not.toContain(key);
    const file = path.join(temporary[0], "embedded-logins.json");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    settings.deleteEmbeddedLoginKey();
    expect(fs.existsSync(file)).toBe(false);
    // Deleting a missing key is not a failure.
    expect(() => settings.deleteEmbeddedLoginKey()).not.toThrow();
  });

  it("reads a malformed key as no key, and throws when the file can't be read", () => {
    const settings = load();
    const file = path.join(temporary[0], "embedded-logins.json");
    for (const text of ["{", '{"key":"short"}', '{"key":1}', "null"]) {
      fs.writeFileSync(file, text);
      expect(settings.readEmbeddedLoginKey()).toBeNull();
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(() => settings.readEmbeddedLoginKey()).toThrow();
  });
});
