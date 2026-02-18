# Granite Bank Run Simulator

Full-stack real-time classroom simulation for liquidity risk learning, built from the PRD.

## What is implemented

- QR-first onboarding screen (`#/hub`) with expiring join token and join URL copy.
- Guest join flow (`#/join`) with random role assignment (Depositor / Wholesale).
- Durable session resume using `resumeToken` in local storage, so refresh does not lose player progress even after QR expiry.
- Player mobile UI (`#/player`) with phase-specific interfaces for all 4 phases and final results.
- Projector dashboard (`#/projector`) with:
  - Live LCR/NSFR
  - Survival horizon
  - Gap table and cumulative logic
  - Scenario matrix
  - Funding vs market liquidity crisis panels
  - Event feed and leaderboard
- Game Master console (`#/gm`) with:
  - Manual phase transitions
  - Sensitivity event triggers
  - BBC leak trigger
  - BoE rescue/collapse decision
  - Broadcast notifications
  - Session reset
- Real-time state sync via 2-second polling.
- Persistent backend state stored in `data/state.json`.

## Run locally

```bash
cd "/Users/raksithkumar/Documents/New project"
npm start
```

Open in browser:

- Hub: [http://localhost:8787/#/hub](http://localhost:8787/#/hub)
- Join: [http://localhost:8787/#/join](http://localhost:8787/#/join)
- Player: [http://localhost:8787/#/player](http://localhost:8787/#/player)
- Projector: [http://localhost:8787/#/projector](http://localhost:8787/#/projector)
- Game Master: [http://localhost:8787/#/gm](http://localhost:8787/#/gm)

## Notes

- The QR image currently uses a public QR image service endpoint for fast setup.
- The simulation engine is deterministic but tunable; coefficients can be refined for your classroom dynamics.
- Session persistence survives page refresh and server restarts because state is written to disk.
