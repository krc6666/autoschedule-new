import type { AppState, FlightIdentity } from "../model";
import { flightIdentityChangeFingerprint } from "../domain/flights/flight-identity-change";

export interface FlightIdentityEditingView {
  identities: FlightIdentity[];
  fingerprint: string;
  dirty: boolean;
}

/** One transient editor shared by navigation, cloud save and exit protection. */
export class FlightIdentityEditingSession {
  private draft?: FlightIdentityEditingView;
  private baseline = "";

  view(model: AppState): FlightIdentityEditingView {
    return (
      this.draft ?? {
        identities: model.shared.flightIdentities ?? [],
        fingerprint: flightIdentityChangeFingerprint(model),
        dirty: false,
      }
    );
  }

  edit(model: AppState, identities: FlightIdentity[]): void {
    const current = this.view(model);
    if (!this.draft) this.baseline = JSON.stringify(current.identities);
    this.draft = {
      identities: structuredClone(identities),
      fingerprint: current.fingerprint,
      dirty: JSON.stringify(identities) !== this.baseline,
    };
    if (!this.draft.dirty) this.discard();
  }

  discard(): void {
    this.draft = undefined;
    this.baseline = "";
  }
}
