import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import { impersonateAccount, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { MockEndpointV2, MockHtsNft, TicketBooth, TicketIssuer } from "../../typechain-types";

export const HEDERA_EID = 40285;
export const BASE_EID = 40245;
export const HTS_ADDRESS = "0x0000000000000000000000000000000000000167";

/** Message kinds, as in `TicketMessages`. */
export const KIND = { SALE_OPENED: 1, MINT_ORDER: 2, SALE_SETTLED: 3 } as const;

/** Gas budgets that comfortably cover the mocks. */
export const GAS = { mintBase: 300_000n, mintPerTicket: 250_000n, settle: 150_000n };

export const PRICE = ethers.parseEther("0.01");
export const ALLOCATION = 10;
export const MAX_PER_ORDER = 4;
export const MAX_SUPPLY = 50;
export const CREATION_FEE = ethers.parseEther("20");
export const METADATA = ethers.toUtf8Bytes("ipfs://bafkreihopstile/launch-night.json");

export const toPeer = (address: string) => ethers.zeroPadValue(address, 32);

export function collection(royaltyCollector: string) {
  return {
    name: "Hopstile Launch Night",
    symbol: "HOP",
    memo: "test collection",
    maxSupply: MAX_SUPPLY,
    metadata: METADATA,
    royaltyBps: 500,
    royaltyFallback: 100_000_000n,
    royaltyCollector,
  };
}

/** Two simulated chains: the issuer behind one mock endpoint, the booth behind the other, wired as peers. */
export async function deployFixture() {
  const [owner, buyer, alice, bob, stranger] = await ethers.getSigners();

  const tokenServiceArtifact = await artifacts.readArtifact("MockHederaTokenService");
  await network.provider.send("hardhat_setCode", [HTS_ADDRESS, tokenServiceArtifact.deployedBytecode]);
  const tokenService = await ethers.getContractAt("MockHederaTokenService", HTS_ADDRESS);

  const hederaEndpoint = await ethers.deployContract("MockEndpointV2", [HEDERA_EID]);
  const baseEndpoint = await ethers.deployContract("MockEndpointV2", [BASE_EID]);
  await hederaEndpoint.setRemote(BASE_EID, await baseEndpoint.getAddress());
  await baseEndpoint.setRemote(HEDERA_EID, await hederaEndpoint.getAddress());

  const issuer = await ethers.deployContract("TicketIssuer", [await hederaEndpoint.getAddress(), owner.address]);
  const booth = await ethers.deployContract("TicketBooth", [
    await baseEndpoint.getAddress(),
    owner.address,
    HEDERA_EID,
    GAS,
  ]);
  await issuer.setPeer(BASE_EID, toPeer(await booth.getAddress()));
  await booth.setPeer(HEDERA_EID, toPeer(await issuer.getAddress()));

  return { owner, buyer, alice, bob, stranger, tokenService, hederaEndpoint, baseEndpoint, issuer, booth };
}

/** `deployFixture` plus the ticket collection. */
export async function collectionFixture() {
  const base = await deployFixture();
  await base.issuer.createCollection(collection(base.owner.address), { value: CREATION_FEE });
  const ticket = await ethers.getContractAt("MockHtsNft", await base.issuer.ticketToken());
  return { ...base, ticket };
}

/** `collectionFixture` plus sale 1, open at the booth for an hour. */
export async function saleFixture() {
  const base = await collectionFixture();
  const closesAt = (await time.latest()) + 3600;
  await base.issuer.openSale(BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, {
    value: await base.issuer.quoteOpenSale(BASE_EID),
  });
  return { ...base, closesAt };
}

/** Buys at the booth with exactly the quoted payment. */
export async function buy(booth: TicketBooth, buyer: HardhatEthersSigner, recipient: string, quantity: number) {
  const { total } = await booth.quoteBuy(quantity);
  return booth.connect(buyer).buy(recipient, quantity, { value: total });
}

/** Closes the booth's sale by time and settles it. */
export async function closeAndSettle(booth: TicketBooth, closesAt: number) {
  await time.increaseTo(closesAt);
  return booth.settleSale({ value: await booth.quoteSettle() });
}

/** A signer for a contract address, used to call `lzReceive` as the endpoint with a hand-made message. */
export async function impersonate(address: string) {
  await impersonateAccount(address);
  await setBalance(address, ethers.parseEther("10"));
  return ethers.getSigner(address);
}

const coder = ethers.AbiCoder.defaultAbiCoder();

export function encodeSaleOpened(terms: {
  saleId: bigint | number;
  price: bigint;
  allocation: number;
  closesAt: number;
  maxPerOrder: number;
}) {
  return coder.encode(
    ["uint8", "tuple(uint64 saleId, uint128 price, uint32 allocation, uint64 closesAt, uint8 maxPerOrder)"],
    [KIND.SALE_OPENED, terms],
  );
}

export function encodeMintOrder(order: { saleId: number; orderId: number; recipient: string; quantity: number }) {
  return coder.encode(
    ["uint8", "tuple(uint64 saleId, uint64 orderId, address recipient, uint8 quantity)"],
    [KIND.MINT_ORDER, order],
  );
}

export function encodeSaleSettled(settlement: { saleId: number; sold: number }) {
  return coder.encode(["uint8", "tuple(uint64 saleId, uint32 sold)"], [KIND.SALE_SETTLED, settlement]);
}

/**
 * What must hold after every action:
 * - every unit of supply is minted, reserved by a sale, or available
 * - the HTS token's supply is what the issuer says it minted
 * - the booth holds exactly the proceeds it has not paid out
 */
export async function expectConsistent(contracts: { issuer: TicketIssuer; booth: TicketBooth; ticket: MockHtsNft }) {
  const { issuer, booth, ticket } = contracts;
  const [maxSupply, minted, reserved, available] = await Promise.all([
    issuer.maxSupply(),
    issuer.totalMinted(),
    issuer.reservedSupply(),
    issuer.availableSupply(),
  ]);

  expect(minted + reserved + available, "supply accounting").to.equal(maxSupply);
  expect(await ticket.totalSupply(), "HTS supply").to.equal(minted);
  expect(await ethers.provider.getBalance(await booth.getAddress()), "booth balance").to.equal(await booth.proceeds());
}

/** Index of the newest message waiting at, or delivered by, an endpoint. */
export async function lastPacket(endpoint: MockEndpointV2) {
  return (await endpoint.inboxLength()) - 1n;
}
