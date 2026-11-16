/** An error with the HTTP status the admin API or control channel should answer with. Input problems are 4xx; a peer that cannot be reached is 502. */
export class PeerError extends Error {
  constructor(readonly status: number, message: string, readonly code = "peer-error") {
    super(message);
  }
}
