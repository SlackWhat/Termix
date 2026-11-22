import { afterEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";

// Every request answers with this, instead of reaching the network.
const reply = { status: 200, data: {} as Record<string, unknown> };
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const response = { ...reply, statusText: "", headers: {}, config };
  if (reply.status >= 400) {
    throw new AxiosError("failed", String(reply.status), config, null, {
      ...response,
    } as never);
  }
  return response;
};

const { isLoginRequestUrl, getUserInfo, logoutUser } =
  await import("@/main-axios");

describe("isLoginRequestUrl", () => {
  it("knows every sign in request", () => {
    expect(isLoginRequestUrl("/users/login")).toBe(true);
    expect(isLoginRequestUrl("/users/totp/verify-login")).toBe(true);
    expect(isLoginRequestUrl("/users/auth/ldap/verify")).toBe(true);
    expect(isLoginRequestUrl("/users/auth/second-factor/totp/verify")).toBe(
      true,
    );
  });

  it("leaves other requests alone", () => {
    expect(isLoginRequestUrl("/host/db/host")).toBe(false);
    expect(isLoginRequestUrl("/users/auth/ldap/start")).toBe(false);
    expect(isLoginRequestUrl(undefined)).toBe(false);
  });
});

// Signing out of Termix, by hand or when the server ends the session, has to
// reach the desktop bridge that also clears logins kept in embedded pages.
describe("desktop sign-out", () => {
  const win = window as unknown as {
    electronAPI?: { clearSessionCookies: ReturnType<typeof vi.fn> };
  };
  function desktop() {
    const clearSessionCookies = vi.fn().mockResolvedValue(undefined);
    win.electronAPI = { clearSessionCookies };
    return clearSessionCookies;
  }
  afterEach(() => {
    delete win.electronAPI;
    reply.status = 200;
    reply.data = {};
  });

  it("clears the desktop session when the server says it expired", async () => {
    const clearSessionCookies = desktop();
    reply.status = 401;
    reply.data = { code: "SESSION_EXPIRED", error: "Session expired" };
    await expect(getUserInfo()).rejects.toBeTruthy();
    expect(clearSessionCookies).toHaveBeenCalledTimes(1);
  });

  it("clears the desktop session at logout", async () => {
    const clearSessionCookies = desktop();
    await logoutUser();
    expect(clearSessionCookies).toHaveBeenCalledTimes(1);
  });
});
