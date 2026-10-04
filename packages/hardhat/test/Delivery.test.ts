import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import {
  ALLOCATION,
  BASE_EID,
  HEDERA_EID,
  HTS_ADDRESS,
  MAX_PER_ORDER,
  MAX_SUPPLY,
  PRICE,
  buy,
  closeAndSettle,
  encodeMintOrder,
  encodeSaleOpened,
  encodeSaleSettled,
  expectConsistent,
  impersonate,
  lastPacket,
  saleFixture,
  toPeer,
} from "./helpers/fixtures";

const GUID = ethers.id("test message");

/**
 * What happens between the two chains when things do not go to plan: a recipient that cannot receive, messages
 * that arrive out of order, deliveries that fail, and senders that are not who they claim to be.
 */
describe("Cross-chain delivery", function () {
  describe("a recipient that is not associated with the ticket token", function () {
    async function heldFixture() {
      const base = await saleFixture();
      // Like a Hedera account with no free auto-association slot.
      await base.ticket.connect(base.alice).setAutoAssociation(false);
      return base;
    }

    it("does not block the order: the tickets are minted and held for the recipient", async function () {
      const { issuer, booth, ticket, buyer, alice } = await loadFixture(heldFixture);

      const tx = buy(booth, buyer, alice.address, 2);
      await expect(tx).to.emit(issuer, "OrderFulfilled").withArgs(1, 1, alice.address, BASE_EID, [1n, 2n], 2, anyValue);
      await expect(tx).to.emit(issuer, "TicketHeld").withArgs(1, alice.address);
      await expect(tx).to.emit(issuer, "TicketHeld").withArgs(2, alice.address);

      expect(await ticket.ownerOf(1)).to.equal(await issuer.getAddress());
      expect(await issuer.heldTicketsOf(alice.address)).to.deep.equal([1n, 2n]);
      expect(await issuer.totalMinted()).to.equal(2);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("cannot be claimed until the recipient associates", async function () {
      const { issuer, booth, ticket, buyer, alice } = await loadFixture(heldFixture);
      await buy(booth, buyer, alice.address, 2);

      await expect(issuer.connect(alice).claim(10))
        .to.be.revertedWithCustomError(issuer, "TicketNotDeliverable")
        .withArgs(2);
      expect(await issuer.heldTicketsOf(alice.address)).to.deep.equal([1n, 2n]);

      // The association call every HTS token exposes at its own address (HIP-719).
      const token = await ethers.getContractAt("IHRC719", await ticket.getAddress());
      await token.connect(alice).associate();

      const tx = issuer.connect(alice).claim(10);
      await expect(tx).to.emit(issuer, "TicketClaimed").withArgs(1, alice.address);
      await expect(tx).to.emit(issuer, "TicketClaimed").withArgs(2, alice.address);
      expect(await ticket.balanceOf(alice.address)).to.equal(2);
      expect(await issuer.heldTicketsOf(alice.address)).to.deep.equal([]);
    });

    it("can be claimed in batches", async function () {
      const { issuer, booth, ticket, buyer, alice } = await loadFixture(heldFixture);
      await buy(booth, buyer, alice.address, 3);
      await ticket.connect(alice).associate();

      await issuer.connect(alice).claim(2);
      expect(await ticket.balanceOf(alice.address)).to.equal(2);
      expect(await issuer.heldTicketsOf(alice.address)).to.deep.equal([1n]);

      await issuer.connect(alice).claim(5);
      expect(await ticket.balanceOf(alice.address)).to.equal(3);
    });

    it("gives only the recipient the held tickets", async function () {
      const { issuer, booth, buyer, alice, stranger } = await loadFixture(heldFixture);
      await buy(booth, buyer, alice.address, 1);

      await expect(issuer.connect(stranger).claim(1)).to.be.revertedWithCustomError(issuer, "NothingToClaim");
      await expect(issuer.connect(buyer).claim(1)).to.be.revertedWithCustomError(issuer, "NothingToClaim");
      await expect(issuer.connect(alice).claim(0)).to.be.revertedWithCustomError(issuer, "NothingToClaim");
    });

    it("does not affect other recipients in the same sale", async function () {
      const { issuer, booth, ticket, buyer, alice, bob } = await loadFixture(heldFixture);
      await buy(booth, buyer, alice.address, 1);

      await expect(buy(booth, buyer, bob.address, 1))
        .to.emit(issuer, "OrderFulfilled")
        .withArgs(1, 2, bob.address, BASE_EID, [2n], 0, anyValue);
      expect(await ticket.ownerOf(2)).to.equal(bob.address);
    });
  });

  describe("messages that arrive out of order", function () {
    it("mints an order that lands after its sale was settled", async function () {
      const { issuer, booth, ticket, hederaEndpoint, buyer, alice, closesAt } = await loadFixture(saleFixture);
      await hederaEndpoint.setAutoDeliver(false);

      await buy(booth, buyer, alice.address, 2);
      const order = await lastPacket(hederaEndpoint);
      await closeAndSettle(booth, closesAt);
      const settlement = await lastPacket(hederaEndpoint);
      expect(await issuer.totalMinted()).to.equal(0);

      // The settlement overtakes the order. The two tickets it counts stay reserved.
      await expect(hederaEndpoint.deliver(settlement))
        .to.emit(issuer, "SaleSettled")
        .withArgs(1, 2, ALLOCATION - 2);
      expect(await issuer.reservedSupply()).to.equal(2);
      expect(await issuer.availableSupply()).to.equal(MAX_SUPPLY - 2);

      await expect(hederaEndpoint.deliver(order))
        .to.emit(issuer, "OrderFulfilled")
        .withArgs(1, 1, alice.address, BASE_EID, [1n, 2n], 0, anyValue);
      expect(await ticket.balanceOf(alice.address)).to.equal(2);
      expect(await issuer.reservedSupply()).to.equal(0);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("mints orders in whatever order they arrive", async function () {
      const { issuer, booth, ticket, hederaEndpoint, buyer, alice, bob } = await loadFixture(saleFixture);
      await hederaEndpoint.setAutoDeliver(false);

      await buy(booth, buyer, alice.address, 1);
      const first = await lastPacket(hederaEndpoint);
      await buy(booth, buyer, bob.address, 1);
      const second = await lastPacket(hederaEndpoint);

      await hederaEndpoint.deliver(second);
      await hederaEndpoint.deliver(first);

      expect(await ticket.ownerOf(1)).to.equal(bob.address);
      expect(await ticket.ownerOf(2)).to.equal(alice.address);
      await expectConsistent({ issuer, booth, ticket });
    });
  });

  describe("a delivery that fails on Hedera", function () {
    it("keeps the order for a retry when too little gas was bought", async function () {
      const { issuer, booth, ticket, hederaEndpoint, buyer, alice } = await loadFixture(saleFixture);
      await booth.setGasConfig({ mintBase: 40_000n, mintPerTicket: 1n, settle: 150_000n });

      // The purchase itself succeeds on the booth's chain; only the delivery on Hedera fails.
      await expect(buy(booth, buyer, alice.address, 2)).to.emit(hederaEndpoint, "PacketFailed");
      const order = await lastPacket(hederaEndpoint);
      expect((await hederaEndpoint.getPacket(order)).delivered).to.equal(false);
      expect(await booth.proceeds()).to.equal(PRICE * 2n);
      expect(await issuer.totalMinted()).to.equal(0);
      expect(await issuer.reservedSupply()).to.equal(ALLOCATION);

      await expect(hederaEndpoint.retry(order))
        .to.emit(issuer, "OrderFulfilled")
        .withArgs(1, 1, alice.address, BASE_EID, [1n, 2n], 0, anyValue);
      expect(await ticket.balanceOf(alice.address)).to.equal(2);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("keeps the order for a retry when HTS is unavailable", async function () {
      const { issuer, booth, ticket, hederaEndpoint, buyer, alice } = await loadFixture(saleFixture);
      await network.provider.send("hardhat_setCode", [HTS_ADDRESS, "0x"]);

      await expect(buy(booth, buyer, alice.address, 1)).to.emit(hederaEndpoint, "PacketFailed");
      expect(await issuer.totalMinted()).to.equal(0);

      const tokenService = await artifacts.readArtifact("MockHederaTokenService");
      await network.provider.send("hardhat_setCode", [HTS_ADDRESS, tokenService.deployedBytecode]);
      await hederaEndpoint.retry(await lastPacket(hederaEndpoint));

      expect(await ticket.ownerOf(1)).to.equal(alice.address);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("delivers a message once", async function () {
      const { booth, hederaEndpoint, buyer, alice } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 1);
      const order = await lastPacket(hederaEndpoint);

      await expect(hederaEndpoint.deliver(order))
        .to.be.revertedWithCustomError(hederaEndpoint, "AlreadyDelivered")
        .withArgs(order);
    });
  });

  describe("what the issuer accepts", function () {
    async function asEndpointFixture() {
      const base = await saleFixture();
      const endpoint = await impersonate(await base.hederaEndpoint.getAddress());
      const boothPeer = toPeer(await base.booth.getAddress());
      const fromBooth = { srcEid: BASE_EID, sender: boothPeer, nonce: 1 };
      return { ...base, endpoint, fromBooth };
    }

    it("only takes messages from the LayerZero endpoint", async function () {
      const { issuer, alice, stranger, fromBooth } = await loadFixture(asEndpointFixture);
      const order = encodeMintOrder({ saleId: 1, orderId: 1, recipient: alice.address, quantity: 1 });

      await expect(issuer.connect(stranger).lzReceive(fromBooth, GUID, order, stranger.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "OnlyEndpoint")
        .withArgs(stranger.address);
    });

    it("only takes messages sent by its booth", async function () {
      const { issuer, endpoint, alice, stranger } = await loadFixture(asEndpointFixture);
      const order = encodeMintOrder({ saleId: 1, orderId: 1, recipient: alice.address, quantity: 1 });
      const fromStranger = { srcEid: BASE_EID, sender: toPeer(stranger.address), nonce: 1 };

      await expect(issuer.connect(endpoint).lzReceive(fromStranger, GUID, order, stranger.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "OnlyPeer")
        .withArgs(BASE_EID, toPeer(stranger.address));
      expect(await issuer.totalMinted()).to.equal(0);
    });

    it("refuses an order from a booth for a sale that belongs to another booth", async function () {
      const { issuer, endpoint, alice, stranger } = await loadFixture(asEndpointFixture);
      const otherEid = 40161;
      await issuer.setPeer(otherEid, toPeer(stranger.address));
      const fromOtherBooth = { srcEid: otherEid, sender: toPeer(stranger.address), nonce: 1 };
      const order = encodeMintOrder({ saleId: 1, orderId: 1, recipient: alice.address, quantity: 1 });

      await expect(issuer.connect(endpoint).lzReceive(fromOtherBooth, GUID, order, stranger.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "UnknownSale")
        .withArgs(1);
    });

    it("refuses an order for a sale that does not exist", async function () {
      const { issuer, endpoint, alice, fromBooth } = await loadFixture(asEndpointFixture);
      const order = encodeMintOrder({ saleId: 7, orderId: 1, recipient: alice.address, quantity: 1 });

      await expect(issuer.connect(endpoint).lzReceive(fromBooth, GUID, order, alice.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "UnknownSale")
        .withArgs(7);
    });

    it("refuses to mint beyond a sale's allocation", async function () {
      const { issuer, endpoint, alice, fromBooth } = await loadFixture(asEndpointFixture);
      const tooMany = encodeMintOrder({ saleId: 1, orderId: 1, recipient: alice.address, quantity: ALLOCATION + 1 });
      const none = encodeMintOrder({ saleId: 1, orderId: 1, recipient: alice.address, quantity: 0 });

      for (const order of [tooMany, none]) {
        await expect(issuer.connect(endpoint).lzReceive(fromBooth, GUID, order, alice.address, "0x"))
          .to.be.revertedWithCustomError(issuer, "AllocationExceeded")
          .withArgs(1);
      }
    });

    it("refuses to mint beyond the final count once a sale is settled", async function () {
      const { issuer, booth, endpoint, buyer, alice, fromBooth, closesAt } = await loadFixture(asEndpointFixture);
      await buy(booth, buyer, alice.address, 2);
      await closeAndSettle(booth, closesAt);

      // The allocation was ten, but the booth reported two sold and both are minted.
      const extra = encodeMintOrder({ saleId: 1, orderId: 9, recipient: alice.address, quantity: 1 });
      await expect(issuer.connect(endpoint).lzReceive(fromBooth, GUID, extra, alice.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "AllocationExceeded")
        .withArgs(1);
    });

    it("refuses a settlement that contradicts what it has minted", async function () {
      const { issuer, booth, endpoint, buyer, alice, fromBooth } = await loadFixture(asEndpointFixture);
      await buy(booth, buyer, alice.address, 3);

      const overAllocation = encodeSaleSettled({ saleId: 1, sold: ALLOCATION + 1 });
      const belowMinted = encodeSaleSettled({ saleId: 1, sold: 2 });
      for (const settlement of [overAllocation, belowMinted]) {
        await expect(issuer.connect(endpoint).lzReceive(fromBooth, GUID, settlement, alice.address, "0x"))
          .to.be.revertedWithCustomError(issuer, "InvalidSettlement")
          .withArgs(1);
      }

      const valid = encodeSaleSettled({ saleId: 1, sold: 3 });
      await issuer.connect(endpoint).lzReceive(fromBooth, GUID, valid, alice.address, "0x");
      await expect(issuer.connect(endpoint).lzReceive(fromBooth, GUID, valid, alice.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "InvalidSettlement")
        .withArgs(1);
    });

    it("refuses a message of a kind it does not handle", async function () {
      const { issuer, endpoint, alice, fromBooth } = await loadFixture(asEndpointFixture);
      const terms = encodeSaleOpened({ saleId: 2n, price: PRICE, allocation: 1, closesAt: 1, maxPerOrder: 1 });

      // Sale terms only ever travel from the issuer to a booth.
      await expect(issuer.connect(endpoint).lzReceive(fromBooth, GUID, terms, alice.address, "0x"))
        .to.be.revertedWithCustomError(issuer, "UnknownMessage")
        .withArgs(1);
      await expect(
        issuer.connect(endpoint).lzReceive(fromBooth, GUID, "0x1234", alice.address, "0x"),
      ).to.be.revertedWithCustomError(issuer, "MessageTooShort");
    });
  });

  describe("what the booth accepts", function () {
    async function asEndpointFixture() {
      const base = await saleFixture();
      const endpoint = await impersonate(await base.baseEndpoint.getAddress());
      const fromIssuer = { srcEid: HEDERA_EID, sender: toPeer(await base.issuer.getAddress()), nonce: 2 };
      const nextTerms = (saleId: number) =>
        encodeSaleOpened({
          saleId,
          price: PRICE,
          allocation: 5,
          closesAt: base.closesAt + 7200,
          maxPerOrder: MAX_PER_ORDER,
        });
      return { ...base, endpoint, fromIssuer, nextTerms };
    }

    it("only takes messages from the endpoint, and only from its issuer", async function () {
      const { booth, endpoint, stranger, fromIssuer, nextTerms } = await loadFixture(asEndpointFixture);
      const fromStranger = { srcEid: HEDERA_EID, sender: toPeer(stranger.address), nonce: 2 };

      await expect(
        booth.connect(stranger).lzReceive(fromIssuer, GUID, nextTerms(2), stranger.address, "0x"),
      ).to.be.revertedWithCustomError(booth, "OnlyEndpoint");
      await expect(
        booth.connect(endpoint).lzReceive(fromStranger, GUID, nextTerms(2), stranger.address, "0x"),
      ).to.be.revertedWithCustomError(booth, "OnlyPeer");
    });

    it("refuses sale terms from any chain other than the issuer's", async function () {
      const { booth, endpoint, stranger, nextTerms } = await loadFixture(asEndpointFixture);
      const otherEid = 40161;
      await booth.setPeer(otherEid, toPeer(stranger.address));
      const fromOtherChain = { srcEid: otherEid, sender: toPeer(stranger.address), nonce: 1 };

      await expect(booth.connect(endpoint).lzReceive(fromOtherChain, GUID, nextTerms(2), stranger.address, "0x"))
        .to.be.revertedWithCustomError(booth, "NotIssuerChain")
        .withArgs(otherEid);
    });

    it("refuses new terms while its sale has not been settled", async function () {
      const { booth, endpoint, stranger, fromIssuer, nextTerms } = await loadFixture(asEndpointFixture);

      await expect(booth.connect(endpoint).lzReceive(fromIssuer, GUID, nextTerms(2), stranger.address, "0x"))
        .to.be.revertedWithCustomError(booth, "PreviousSaleNotSettled")
        .withArgs(1);
      expect((await booth.currentSale()).saleId).to.equal(1);
    });

    it("refuses terms for a sale it has already seen", async function () {
      const { booth, endpoint, stranger, fromIssuer, nextTerms, closesAt } = await loadFixture(asEndpointFixture);
      await closeAndSettle(booth, closesAt);

      await expect(booth.connect(endpoint).lzReceive(fromIssuer, GUID, nextTerms(1), stranger.address, "0x"))
        .to.be.revertedWithCustomError(booth, "StaleSale")
        .withArgs(1);

      await time.increase(1);
      await booth.connect(endpoint).lzReceive(fromIssuer, GUID, nextTerms(2), stranger.address, "0x");
      expect((await booth.currentSale()).saleId).to.equal(2);
    });

    it("refuses a message of a kind it does not handle", async function () {
      const { booth, endpoint, alice, fromIssuer } = await loadFixture(asEndpointFixture);
      const order = encodeMintOrder({ saleId: 1, orderId: 1, recipient: alice.address, quantity: 1 });

      // Mint orders only ever travel from a booth to the issuer.
      await expect(booth.connect(endpoint).lzReceive(fromIssuer, GUID, order, alice.address, "0x"))
        .to.be.revertedWithCustomError(booth, "UnknownMessage")
        .withArgs(2);
    });
  });
});
