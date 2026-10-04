# Hardhat package

Contracts, deploy scripts and tests for Hopstile. The project [README](../../README.md) explains what the contracts do; this page is the working reference for this package.

Run the `hardhat:*` scripts from the repository root. Inside `packages/hardhat` the same scripts exist without the prefix.

## Local development

```bash
# Terminal 1: a plain local chain on http://127.0.0.1:8545
yarn hardhat:chain

# Terminal 2
yarn hardhat:deploy --network localhost
yarn hardhat:buy --network localhost
yarn hardhat:status --network localhost
```

On a local network the deploy scripts do everything in one run:

| Script | What it does locally |
| --- | --- |
| `00_deploy_local_mocks.ts` | Installs `MockHederaTokenService` at `0x167` and deploys two linked `MockEndpointV2` contracts |
| `01_deploy_ticket_issuer.ts` | Deploys `TicketIssuer` behind the first endpoint |
| `02_deploy_ticket_booth.ts` | Deploys `TicketBooth` behind the second endpoint |
| `03_wire_peers.ts` | Sets each contract as the other's LayerZero peer |
| `04_create_collection.ts` | Creates the ticket collection through the token service |
| `05_open_sale.ts` | Opens the first sale, which the mock endpoint delivers to the booth at once |

Always pass `--network localhost`. Without it, `yarn hardhat:deploy` runs against a throwaway in-memory chain that is gone when the command ends.

`yarn hardhat:fork` starts a chain that forks Hedera testnet instead, for work that needs real testnet state. Set `HEDERA_FORK_WORKER_PORT` if port 10001 is taken.

## Tests

```bash
yarn hardhat:test
```

The tests run offline in a few seconds. Each one starts from a fixture in `test/helpers/fixtures.ts` that sets up the two simulated chains.

| File | What it covers |
| --- | --- |
| `TicketIssuer.test.ts` | Collection creation and its HTS parameters, opening sales, check-in, owner functions |
| `TicketBooth.test.ts` | Buying, payment and refunds, the allocation limit, settlement, proceeds, gas budgets |
| `Delivery.test.ts` | Held tickets and claiming, messages out of order, failed deliveries and retries, and which messages each contract accepts |
| `Codec.test.ts` | The LayerZero option bytes and the round trip of every message |
| `DeployScripts.test.ts` | The deploy scripts end to end, and that running them twice changes nothing |

## Deploy to Hedera testnet and Base Sepolia

One account deploys to both networks, so it needs testnet HBAR from the [Hedera Portal faucet](https://portal.hedera.com/faucet) and a little Base Sepolia ETH.

```bash
yarn hardhat:account:import        # or yarn hardhat:account:generate
yarn hardhat:account               # address, and balance on every network

yarn hardhat:deploy --network hederaTestnet   # issuer and HTS collection
yarn hardhat:deploy --network baseSepolia     # booth, wired to the issuer
yarn hardhat:deploy --network hederaTestnet   # issuer wired to the booth, sale opened
```

The key is stored encrypted in `packages/hardhat/.env`, and each command asks for its password. Every step checks what is already done, so a command that stops halfway can be run again.

Each side reads the other's address from `deployments/<network>/`, which is why the Hedera deploy runs twice: the first run has no booth to wire to yet.

```bash
yarn hardhat:buy --network baseSepolia
yarn hardhat:status --network hederaTestnet
yarn hardhat:settle --network baseSepolia     # once the sale has closed or sold out
```

## Configuration

`utils/hopstileConfig.ts` holds the networks and their LayerZero endpoints, the collection, the terms of the first sale and the gas budgets. `hardhat.config.ts` holds RPC URLs and chain ids. `HEDERA_RPC_URL` and `BASE_SEPOLIA_RPC_URL` in `.env` override the public RPC endpoints.

## Layout

- `contracts/`: `TicketIssuer.sol`, `TicketBooth.sol`, `interfaces/`, `libraries/`, `mocks/`
- `deploy/`: the `hardhat-deploy` scripts described above, plus `90_buy_ticket.ts` and `91_settle_sale.ts`
- `scripts/`: account management, `status.ts`, frontend binding generation
- `test/`: the test files and `helpers/fixtures.ts`
- `utils/`: `hopstileConfig.ts`, `getDeployGasPrice.ts`
