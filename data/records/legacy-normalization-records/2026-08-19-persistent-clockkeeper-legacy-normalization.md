---
title: "Persistent clockkeeper carrier admission"
type: corpus-normalization-record
date: 2026-08-19
status: complete
---


The Koios persistent carrier contained a ten-file
`@emsenn/clockkeeper-service` state not covered by the existing four-file
`2026-07-19-linux-clock-service` witness. It adds README and agent context, a
test, cold-red-gate systemd service/timer units, and an operational
rectification record; its package, contract, and source also differ.

The complete carrier state is retained without overwriting the other state at
`lib/legacy/2026-07-19-persistent-clockkeeper-service`. `npm run check` passes.
This coverage allowed the mixed Koios/clockkeeper tar carrier to leave the
top-level legacy intake after both payload families were verified.
