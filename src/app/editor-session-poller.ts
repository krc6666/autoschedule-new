import type { CloudBackend, EditorLoginRequest } from "./cloud-contract";

/** One request at a time; stopped/older responses cannot change the next session. */
export class EditorSessionPoller {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backend: CloudBackend,
    private readonly sessionId: string,
    private readonly onChange: (request: EditorLoginRequest | null) => void,
    private readonly onError: (error: unknown) => void
  ) {}

  start(requestId: string | null): void {
    this.stop();
    const generation = this.generation;
    const poll = async () => {
      try {
        const request = await this.backend.pollSessionRequest(
          this.sessionId,
          requestId
        );
        if (generation !== this.generation) return;
        this.onChange(request);
      } catch (error) {
        if (generation !== this.generation) return;
        this.onError(error);
      }
      if (generation === this.generation)
        this.timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
  }

  stop(): void {
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
