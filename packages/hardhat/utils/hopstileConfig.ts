import * as fs from "fs";
import * as path from "path";
import { parseEther, parseUnits, toUtf8Bytes, zeroPadValue } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Every tunable of the template lives in this file: which contract goes on which network, the LayerZero
 * endpoints, the ticket collection, the terms of the first sale and the gas budgets.
 */

/** Address of the Hedera Token Service system contract. */
export const HTS_ADDRESS = "0x0000000000000000000000000000000000000167";

/**
 * What a network is used for.
 * - `issuer`: Hedera. `TicketIssuer` is deployed here and mints the tickets.
 * - `booth`: any other EVM chain. `TicketBooth` is deployed here and takes payment.
 * - `local`: one Hardhat chain that plays both sides, with mock LayerZero endpoints and a mock token service.
 */
export type Role = "issuer" | "booth" | "local";

export type NetworkConfig = {
  role: Role;
  /** LayerZero endpoint id of this network. */
  eid: number;
  /** LayerZero EndpointV2 on this network. Absent on local networks, where a mock is deployed. */
  endpoint?: string;
  /** Hardhat network name of the other side. Absent on local networks. */
  counterpart?: string;
  /** Whether `msg.value` is in tinybars inside the EVM, which is the case on Hedera. */
  tinybarValue: boolean;
  /** Explorer URL prefix for a transaction hash. */
  txExplorer?: string;
  /** LayerZero Scan URL prefix for a transaction hash. */
  lzScan?: string;
};

/** Endpoint ids the local chain uses for its two mock endpoints. They match Hedera testnet and Base Sepolia. */
export const LOCAL_EIDS = { issuer: 40285, booth: 40245 } as const;

/**
 * Supported networks. To sell on another chain, add its entry here with role `booth`, add the network to
 * `hardhat.config.ts`, and deploy. Endpoint addresses and ids are listed at
 * https://docs.layerzero.network/v2/deployments/deployed-contracts
 */
export const NETWORKS: Record<string, NetworkConfig> = {
  hardhat: { role: "local", eid: LOCAL_EIDS.issuer, tinybarValue: false },
  localhost: { role: "local", eid: LOCAL_EIDS.issuer, tinybarValue: false },
  hederaTestnet: {
    role: "issuer",
    eid: 40285,
    endpoint: "0xbD672D1562Dd32C23B563C989d8140122483631d",
    counterpart: "baseSepolia",
    tinybarValue: true,
    txExplorer: "https://hashscan.io/testnet/transaction/",
    lzScan: "https://testnet.layerzeroscan.com/tx/",
  },
  baseSepolia: {
    role: "booth",
    eid: 40245,
    endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    counterpart: "hederaTestnet",
    tinybarValue: false,
    txExplorer: "https://sepolia.basescan.org/tx/",
    lzScan: "https://testnet.layerzeroscan.com/tx/",
  },
};

/** The ticket collection, created once on Hedera as an HTS non-fungible token. */
export const COLLECTION = {
  name: "Hopstile Launch Night",
  symbol: "HOP",
  memo: "Tickets sold on any chain, minted on Hedera",
  maxSupply: 500,
  /** Stored on every ticket, at most 100 bytes. Points at a HIP-412 metadata file. */
  metadata: "https://raw.githubusercontent.com/sanmipaul/Hopstile/main/packages/nextjs/public/ticket.json",
  /** Share of every resale that HTS pays to the royalty collector: 500 is 5%. Zero creates no royalty. */
  royaltyBps: 500,
  /** HBAR the receiver pays when a ticket changes hands for no payment. Zero for none. */
  royaltyFallbackHbar: "1",
  /** HBAR sent with `createCollection` to pay the HTS creation fee. */
  creationFeeHbar: "20",
} as const;

/** Terms of the sale that the deploy script opens at the booth. */
export const SALE = {
  /** Price of one ticket in the booth chain's native currency. */
  price: parseEther("0.0001"),
  allocation: 100,
  durationSeconds: 7 * 24 * 60 * 60,
  maxPerOrder: 4,
} as const;

/**
 * Gas each side gives the other's `lzReceive`. The sender pays for it as part of the LayerZero fee.
 *
 * HTS charges its fees as gas. They are set in US dollars, so the gas a mint needs rises when HBAR falls: at
 * 0.10 USD per HBAR and 87 tinybars per gas, minting one serial costs about 270,000 gas and transferring it
 * about 14,000. The per-ticket budget leaves room for the HBAR price to drop by a third.
 */
export const GAS = {
  /** Booth to issuer: a mint order, before the per-ticket part. */
  mintBase: 300_000n,
  /** Booth to issuer: extra gas per ticket in the order. */
  mintPerTicket: 450_000n,
  /** Booth to issuer: a settlement message. */
  settle: 150_000n,
} as const;

/** Tinybars (8 decimals) per weibar (18 decimals) scale factor. */
const WEIBARS_PER_TINYBAR = 10n ** 10n;

export function isLocalNetwork(networkName: string): boolean {
  return networkName === "hardhat" || networkName === "localhost";
}

export function getNetworkConfig(hre: HardhatRuntimeEnvironment): NetworkConfig {
  const config = NETWORKS[hre.network.name];
  if (!config) {
    throw new Error(
      `Network "${hre.network.name}" is not configured for Hopstile. Add it to NETWORKS in utils/hopstileConfig.ts.`,
    );
  }
  return config;
}

/**
 * Converts an amount as the EVM sees it into the `value` to put on a transaction.
 *
 * On Hedera the EVM counts HBAR in tinybars (8 decimals), but the JSON-RPC relay expects `value` in weibars
 * (18 decimals) and divides by 10^10 on the way in. So a fee quoted by a contract on Hedera must be multiplied
 * by 10^10 before it is sent. On every other network the two units are the same.
 */
export function toRpcValue(config: NetworkConfig, evmAmount: bigint): bigint {
  return config.tinybarValue ? evmAmount * WEIBARS_PER_TINYBAR : evmAmount;
}

/** An HBAR amount as the EVM sees it on this network: tinybars on Hedera, 18 decimals on a local chain. */
export function hbarToEvmAmount(config: NetworkConfig, hbar: string): bigint {
  return parseUnits(hbar, config.tinybarValue ? 8 : 18);
}

/** The argument `TicketIssuer.createCollection` takes, built from `COLLECTION`. */
export function collectionArgs(royaltyCollector: string) {
  return {
    name: COLLECTION.name,
    symbol: COLLECTION.symbol,
    memo: COLLECTION.memo,
    maxSupply: COLLECTION.maxSupply,
    metadata: toUtf8Bytes(COLLECTION.metadata),
    royaltyBps: COLLECTION.royaltyBps,
    // The royalty fallback is always in tinybars, because HTS reads it, not the EVM.
    royaltyFallback: parseUnits(COLLECTION.royaltyFallbackHbar, 8),
    royaltyCollector,
  };
}

/**
 * Overrides for a transaction sent by a deploy script.
 * - `value` is given as the EVM sees it and converted for the network.
 * - On Hedera the gas limit is set by hand: HTS and LayerZero calls are hard to estimate through the relay, and
 *   Hedera charges for at least 80% of the limit, so each call names a limit close to what it uses.
 */
export async function txOverrides(
  hre: HardhatRuntimeEnvironment,
  config: NetworkConfig,
  options: { hederaGasLimit: bigint; value?: bigint },
) {
  const feeData = await hre.ethers.provider.getFeeData();
  return {
    ...(feeData.gasPrice != null ? { gasPrice: feeData.gasPrice } : {}),
    ...(config.tinybarValue ? { gasLimit: options.hederaGasLimit } : {}),
    ...(options.value !== undefined ? { value: toRpcValue(config, options.value) } : {}),
  };
}

/** A contract address as the 32-byte value LayerZero uses for peers. */
export function toPeer(address: string): string {
  return zeroPadValue(address, 32);
}

/**
 * Address of a contract deployed on another network, read from that network's deployment files.
 * Returns undefined when it has not been deployed from this checkout yet.
 */
export function readDeployedAddress(
  hre: HardhatRuntimeEnvironment,
  networkName: string,
  contractName: string,
): string | undefined {
  const file = path.join(hre.config.paths.deployments, networkName, `${contractName}.json`);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")).address as string;
}

/** Explorer and LayerZero Scan links for a transaction, for the networks that have them. */
export function txLinks(config: NetworkConfig, txHash: string): string {
  const links = [];
  if (config.txExplorer) links.push(`explorer: ${config.txExplorer}${txHash}`);
  if (config.lzScan) links.push(`LayerZero Scan: ${config.lzScan}${txHash}`);
  return links.join("\n   ");
}
