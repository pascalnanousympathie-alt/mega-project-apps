# 🚀 MEGA PROJECT: DOMINOMADA, LOTOMADA, AND RAMIMADA MONOREPO

## 1. ARCHITECTURE OVERVIEW (SHARED CORE ENGINE)
The core backend acts as a Centralized Wallet and Authentication Ledger. Each game spins up on a dedicated microservice layer via WebSockets.

Use code with caution.+------------------------+|  Central Wallet Server | <--- REST API (Auth, Balance, Ledger)+------------------------+^| (Internal Communication / IPC)v+------------------------------+| Central Multiplayer Gateway  |+------------------------------+/            |             /             |              v              v               v+--------------+  +--------------+  +--------------+|  DominoMada  |  |   LotoMada   |  |   RamiMada   ||  (Port 3001) |  |  (Port 3002) |  |  (Port 3003) |+--------------+  +--------------+  +--------------+
## 2. DETAILED GAME ARCHITECTURE

### 🎮 GAME 1: DOMINOMADA (HYBRID ONLINE/OFFLINE)
*   **Operational Modes:** Online matchmaking vs Offline session against local AI Bots. Local ledger is locked using cryptographic hashes to prevent score-tampering.

### 🎰 GAME 2: LOTOMADA (MALAGASY LOTO STYLE)
*   **Card Architecture (UI/UX Grid):** Enforces a strict 3x9 matrix for each card (9 columns, 3 rows). Each row contains exactly 5 numbers and 4 blank spaces (Standard 90-ball layout).
*   **Card Management Logic:** Implement a "Mélanger" (Shuffle) endpoint to dynamically re-generate randomized yet valid 3x9 matrix tickets before purchase.
*   **Prize Pool Monitoring:** Live broadcast of the total MGA Prize Pool (Cagnotte) and connected player avatars to all room clients using Socket.io.
*   **Winning Handshake:** Immediate calculation of "Quine" (1 full row) and "Carton Plein" (all 15 numbers marked) with secure automated wallet updates.

### 🃏 GAME 3: RAMIMADA (ONLINE MULTIPLAYER RAMI MALAGASY)
*   **Deck & Validation Rules:** Standard 52 cards + 2 Jokers. Algorithms check valid groups for:
    *   *Brelan (Tree):* 3 cards of the same rank, distinct suits.
    *   *Carré:* 4 cards of the same rank, distinct suits.
    *   *Escalier (Run):* Consecutive card ranks within the same suit.
