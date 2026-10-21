# Clockkeeper Service

This settlement carries reusable Clockkeeper service law for a colony that
offers clocked pulses to customer enterprises. A deployed colony owns its
clock, schedules, occurrence reservations, delivery attempts, and receipts. It
never owns time or the work a pulse causes.

- A customer first solicits and accepts an exact provider-authored offer.
- A schedule may address only an operation advertised by the target package.
- The provider authors the delivered ActivityStreams activity under its own
  actor and the exact customer-admitted capability.
- One occurrence receives at most one delivery attempt. Missed intervals never
  create an unbounded catch-up cascade.
- A target `Accept` or typed `Reject` is a terminal delivery receipt. The
  provider does not reinterpret the target's decision.
- Customer files, editorial choices, inference, publication, DNS, and Git are
  outside this service's authority.
- The present local stdio carrier binds actor, capability, target operation,
  and bytes exactly. It does not claim HTTP Signatures or ActivityPub
  federation; those require a later transport contract.
