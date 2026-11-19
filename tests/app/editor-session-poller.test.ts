import { afterEach, expect, it, vi } from "vitest";
import { EditorSessionPoller } from "../../src/app/editor-session-poller";
import type { EditorLoginRequest } from "../../src/app/cloud-contract";
import { cloudFixture } from "../helpers/cloud";

afterEach(() => vi.useRealTimers());
const request: EditorLoginRequest = {
  id: "applicant-request-123",
  status: "pending",
  expiresAt: "2026-11-18T12:00:00Z",
};

it("does not overlap slow polls or apply a response after stop", async () => {
  vi.useFakeTimers();
  const { backend } = cloudFixture();
  let finish!: (request: EditorLoginRequest) => void;
  backend.pollSessionRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const change = vi.fn();
  const poller = new EditorSessionPoller(
    backend,
    "editor-session-12345",
    change,
    vi.fn()
  );
  poller.start(request.id);
  await vi.advanceTimersByTimeAsync(30000);
  expect(backend.pollSessionRequest).toHaveBeenCalledTimes(1);
  poller.stop();
  finish(request);
  await vi.advanceTimersByTimeAsync(30000);
  expect(change).not.toHaveBeenCalled();
  expect(backend.pollSessionRequest).toHaveBeenCalledTimes(1);
});

it("drops errors and data from an older polling generation", async () => {
  vi.useFakeTimers();
  const { backend } = cloudFixture();
  let reject!: (error: unknown) => void;
  backend.pollSessionRequest.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  const change = vi.fn();
  const error = vi.fn();
  const poller = new EditorSessionPoller(
    backend,
    "editor-session-12345",
    change,
    error
  );
  poller.start(request.id);
  backend.pollSessionRequest.mockResolvedValue(null);
  poller.start(null);
  await Promise.resolve();
  reject(new Error("old connection failed"));
  await Promise.resolve();
  expect(error).not.toHaveBeenCalled();
  expect(change).toHaveBeenCalledExactlyOnceWith(null);
  poller.stop();
});

it("retries a temporary error without granting permission locally", async () => {
  vi.useFakeTimers();
  const { backend } = cloudFixture();
  backend.pollSessionRequest
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(request);
  const change = vi.fn();
  const error = vi.fn();
  const poller = new EditorSessionPoller(
    backend,
    "editor-session-12345",
    change,
    error
  );
  poller.start(request.id);
  await vi.advanceTimersByTimeAsync(3000);
  expect(error).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledExactlyOnceWith(request);
  expect(backend.acquireSession).not.toHaveBeenCalled();
  poller.stop();
});
