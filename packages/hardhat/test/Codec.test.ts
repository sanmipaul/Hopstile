import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { KIND, encodeMintOrder, encodeSaleOpened, encodeSaleSettled } from "./helpers/fixtures";

describe("LzOptions and TicketMessages", function () {
  async function harnessFixture() {
    const [, alice] = await ethers.getSigners();
    return { harness: await ethers.deployContract("CodecHarness"), alice };
  }

  describe("LzOptions.lzReceive", function () {
    it("builds the bytes that the live LayerZero endpoints accept", async function () {
      const { harness } = await loadFixture(harnessFixture);

      // Both values were sent to `quote` on EndpointV2 on Base Sepolia and on Hedera testnet, which returned a fee.
      expect(await harness.lzReceiveOptions(500_000)).to.equal("0x0003010011010000000000000000000000000007a120");
      expect(await harness.lzReceiveOptions(200_000)).to.equal("0x00030100110100000000000000000000000000030d40");
    });

    it("lays out options type, worker, size, option type and gas in 22 bytes", async function () {
      const { harness } = await loadFixture(harnessFixture);
      const options = ethers.getBytes(await harness.lzReceiveOptions(2n ** 128n - 1n));

      expect(options.length).to.equal(22);
      expect(ethers.hexlify(options.slice(0, 2)), "options type 3").to.equal("0x0003");
      expect(options[2], "executor worker id").to.equal(1);
      expect(ethers.hexlify(options.slice(3, 5)), "option size").to.equal("0x0011");
      expect(options[5], "lzReceive option type").to.equal(1);
      expect(ethers.hexlify(options.slice(6)), "gas").to.equal("0x" + "ff".repeat(16));
    });
  });

  describe("TicketMessages", function () {
    it("round-trips sale terms", async function () {
      const { harness } = await loadFixture(harnessFixture);
      const terms = {
        saleId: 7n,
        price: ethers.parseEther("0.25"),
        allocation: 1200,
        closesAt: 1_800_000_000,
        maxPerOrder: 6,
      };

      const message = await harness.encodeSaleOpened(terms);
      expect(await harness.kind(message)).to.equal(KIND.SALE_OPENED);

      const decoded = await harness.decodeSaleOpened(message);
      expect(decoded.saleId).to.equal(terms.saleId);
      expect(decoded.price).to.equal(terms.price);
      expect(decoded.allocation).to.equal(terms.allocation);
      expect(decoded.closesAt).to.equal(terms.closesAt);
      expect(decoded.maxPerOrder).to.equal(terms.maxPerOrder);
    });

    it("round-trips a mint order", async function () {
      const { harness, alice } = await loadFixture(harnessFixture);
      const order = { saleId: 3, orderId: 41, recipient: alice.address, quantity: 4 };

      const message = await harness.encodeMintOrder(order);
      expect(await harness.kind(message)).to.equal(KIND.MINT_ORDER);

      const decoded = await harness.decodeMintOrder(message);
      expect(decoded.saleId).to.equal(order.saleId);
      expect(decoded.orderId).to.equal(order.orderId);
      expect(decoded.recipient).to.equal(order.recipient);
      expect(decoded.quantity).to.equal(order.quantity);
    });

    it("round-trips a settlement", async function () {
      const { harness } = await loadFixture(harnessFixture);
      const settlement = { saleId: 3, sold: 87 };

      const message = await harness.encodeSaleSettled(settlement);
      expect(await harness.kind(message)).to.equal(KIND.SALE_SETTLED);

      const decoded = await harness.decodeSaleSettled(message);
      expect(decoded.saleId).to.equal(settlement.saleId);
      expect(decoded.sold).to.equal(settlement.sold);
    });

    it("is plain abi.encode(kind, struct), so off-chain code can build and read messages", async function () {
      const { harness, alice } = await loadFixture(harnessFixture);
      const terms = { saleId: 1n, price: 5n, allocation: 10, closesAt: 99, maxPerOrder: 2 };
      const order = { saleId: 1, orderId: 2, recipient: alice.address, quantity: 3 };
      const settlement = { saleId: 1, sold: 9 };

      expect(await harness.encodeSaleOpened(terms)).to.equal(encodeSaleOpened(terms));
      expect(await harness.encodeMintOrder(order)).to.equal(encodeMintOrder(order));
      expect(await harness.encodeSaleSettled(settlement)).to.equal(encodeSaleSettled(settlement));
    });

    it("rejects a message too short to carry a kind", async function () {
      const { harness } = await loadFixture(harnessFixture);

      await expect(harness.kind("0x")).to.be.revertedWithCustomError(harness, "MessageTooShort");
      await expect(harness.kind("0x" + "00".repeat(31))).to.be.revertedWithCustomError(harness, "MessageTooShort");
    });
  });
});
