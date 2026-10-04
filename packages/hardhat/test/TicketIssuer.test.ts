import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import {
  ALLOCATION,
  BASE_EID,
  CREATION_FEE,
  MAX_PER_ORDER,
  MAX_SUPPLY,
  METADATA,
  PRICE,
  buy,
  collection,
  collectionFixture,
  deployFixture,
  expectConsistent,
  saleFixture,
} from "./helpers/fixtures";

describe("TicketIssuer", function () {
  describe("createCollection", function () {
    it("creates an HTS token with the issuer as treasury and only minter", async function () {
      const { issuer, owner, tokenService } = await loadFixture(deployFixture);

      await expect(issuer.createCollection(collection(owner.address), { value: CREATION_FEE }))
        .to.emit(issuer, "CollectionCreated")
        .withArgs(anyValue, "Hopstile Launch Night", "HOP", MAX_SUPPLY);

      const token = await issuer.ticketToken();
      expect(token).to.equal(await tokenService.lastToken());
      expect(await issuer.maxSupply()).to.equal(MAX_SUPPLY);
      expect(await issuer.availableSupply()).to.equal(MAX_SUPPLY);
      expect(await issuer.ticketMetadata()).to.equal(ethers.hexlify(METADATA));

      const ticket = await ethers.getContractAt("MockHtsNft", token);
      expect(await ticket.treasury()).to.equal(await issuer.getAddress());
      expect(await ticket.supplyKey()).to.equal(await issuer.getAddress());
      expect(await ticket.maxSupply()).to.equal(MAX_SUPPLY);
    });

    it("pays the creation fee to HTS from msg.value", async function () {
      const { issuer, owner, tokenService } = await loadFixture(deployFixture);

      await expect(issuer.createCollection(collection(owner.address), { value: CREATION_FEE })).to.changeEtherBalances(
        [owner, tokenService, issuer],
        [-CREATION_FEE, CREATION_FEE, 0n],
      );
    });

    it("asks HTS for a royalty with an HBAR fallback fee", async function () {
      const { ticket, owner } = await loadFixture(collectionFixture);
      const royalty = await ticket.royalty();

      expect(royalty.numerator).to.equal(500);
      expect(royalty.denominator).to.equal(10_000);
      expect(royalty.amount).to.equal(100_000_000n);
      expect(royalty.tokenId).to.equal(ethers.ZeroAddress);
      expect(royalty.useHbarsForPayment).to.equal(true);
      expect(royalty.feeCollector).to.equal(owner.address);
    });

    it("creates a collection without a royalty when the rate is zero", async function () {
      const { issuer, owner } = await loadFixture(deployFixture);

      await issuer.createCollection(
        { ...collection(ethers.ZeroAddress), royaltyBps: 0, royaltyFallback: 0 },
        { value: CREATION_FEE },
      );

      const ticket = await ethers.getContractAt("MockHtsNft", await issuer.ticketToken());
      const royalty = await ticket.royalty();
      expect(royalty.numerator).to.equal(0);
      expect(royalty.feeCollector).to.equal(ethers.ZeroAddress);
      expect(await issuer.owner()).to.equal(owner.address);
    });

    it("reverts with the HTS response code when HTS refuses", async function () {
      const { issuer, owner } = await loadFixture(deployFixture);

      // No value means no creation fee: HTS answers INSUFFICIENT_TX_FEE (9).
      await expect(issuer.createCollection(collection(owner.address)))
        .to.be.revertedWithCustomError(issuer, "HtsCallFailed")
        .withArgs(9);
      expect(await issuer.ticketToken()).to.equal(ethers.ZeroAddress);
    });

    it("can only be done once", async function () {
      const { issuer, owner } = await loadFixture(collectionFixture);

      await expect(
        issuer.createCollection(collection(owner.address), { value: CREATION_FEE }),
      ).to.be.revertedWithCustomError(issuer, "CollectionExists");
    });

    it("rejects a collection HTS could not hold", async function () {
      const { issuer, owner } = await loadFixture(deployFixture);
      const valid = collection(owner.address);
      const invalid = [
        { ...valid, maxSupply: 0 },
        { ...valid, metadata: ethers.toUtf8Bytes("x".repeat(101)) },
        { ...valid, royaltyBps: 10_000 },
        { ...valid, royaltyCollector: ethers.ZeroAddress },
        { ...valid, royaltyFallback: 2n ** 63n },
      ];

      for (const params of invalid) {
        await expect(issuer.createCollection(params, { value: CREATION_FEE })).to.be.revertedWithCustomError(
          issuer,
          "InvalidCollection",
        );
      }
    });

    it("is for the owner only", async function () {
      const { issuer, stranger } = await loadFixture(deployFixture);

      await expect(issuer.connect(stranger).createCollection(collection(stranger.address), { value: CREATION_FEE }))
        .to.be.revertedWithCustomError(issuer, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });
  });

  describe("openSale", function () {
    it("reserves the allocation and delivers the terms to the booth", async function () {
      const { issuer, booth, ticket } = await loadFixture(collectionFixture);
      const closesAt = (await time.latest()) + 3600;
      const fee = await issuer.quoteOpenSale(BASE_EID);

      const tx = issuer.openSale(BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, { value: fee });
      await expect(tx)
        .to.emit(issuer, "SaleOpened")
        .withArgs(1, BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, anyValue);
      await expect(tx).to.emit(booth, "SaleListed").withArgs(1, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER);

      const sale = await issuer.getSale(1);
      expect(sale.boothEid).to.equal(BASE_EID);
      expect(sale.price).to.equal(PRICE);
      expect(sale.allocation).to.equal(ALLOCATION);
      expect(sale.minted).to.equal(0);
      expect(sale.settled).to.equal(false);
      expect(await issuer.activeSaleOf(BASE_EID)).to.equal(1);
      expect(await issuer.saleCount()).to.equal(1);
      expect(await issuer.reservedSupply()).to.equal(ALLOCATION);
      expect(await issuer.availableSupply()).to.equal(MAX_SUPPLY - ALLOCATION);

      const listed = await booth.currentSale();
      expect(listed.saleId).to.equal(1);
      expect(listed.price).to.equal(PRICE);
      expect(listed.allocation).to.equal(ALLOCATION);
      expect(listed.closesAt).to.equal(closesAt);
      expect(listed.maxPerOrder).to.equal(MAX_PER_ORDER);
      expect(await booth.isOpen()).to.equal(true);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("pays the quoted LayerZero fee and gets the surplus back", async function () {
      const { issuer, owner, hederaEndpoint } = await loadFixture(collectionFixture);
      const closesAt = (await time.latest()) + 3600;
      const fee = await issuer.quoteOpenSale(BASE_EID);

      await expect(
        issuer.openSale(BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, { value: fee + ethers.parseEther("1") }),
      ).to.changeEtherBalances([owner, hederaEndpoint, issuer], [-fee, fee, 0n]);
    });

    it("reverts when the fee is not covered", async function () {
      const { issuer, hederaEndpoint } = await loadFixture(collectionFixture);
      const closesAt = (await time.latest()) + 3600;
      const fee = await issuer.quoteOpenSale(BASE_EID);

      await expect(issuer.openSale(BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, { value: fee - 1n }))
        .to.be.revertedWithCustomError(hederaEndpoint, "InsufficientFee")
        .withArgs(fee, fee - 1n);
    });

    it("needs the collection to exist", async function () {
      const { issuer } = await loadFixture(deployFixture);
      const closesAt = (await time.latest()) + 3600;

      await expect(
        issuer.openSale(BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, { value: 1 }),
      ).to.be.revertedWithCustomError(issuer, "CollectionNotCreated");
    });

    it("rejects terms a booth could not sell under", async function () {
      const { issuer } = await loadFixture(collectionFixture);
      const now = await time.latest();
      const fee = await issuer.quoteOpenSale(BASE_EID);
      const invalid: [number, number, number][] = [
        [0, now + 3600, MAX_PER_ORDER],
        [ALLOCATION, now, MAX_PER_ORDER],
        [ALLOCATION, now + 3600, 0],
        [ALLOCATION, now + 3600, 11],
      ];

      for (const [allocation, closesAt, maxPerOrder] of invalid) {
        await expect(
          issuer.openSale(BASE_EID, PRICE, allocation, closesAt, maxPerOrder, { value: fee }),
        ).to.be.revertedWithCustomError(issuer, "InvalidSaleTerms");
      }
    });

    it("cannot promise more tickets than the collection has left", async function () {
      const { issuer } = await loadFixture(collectionFixture);
      const closesAt = (await time.latest()) + 3600;
      const fee = await issuer.quoteOpenSale(BASE_EID);

      await expect(issuer.openSale(BASE_EID, PRICE, MAX_SUPPLY + 1, closesAt, MAX_PER_ORDER, { value: fee }))
        .to.be.revertedWithCustomError(issuer, "InsufficientSupply")
        .withArgs(MAX_SUPPLY);
    });

    it("allows one running sale per booth", async function () {
      const { issuer, closesAt } = await loadFixture(saleFixture);
      const fee = await issuer.quoteOpenSale(BASE_EID);

      await expect(issuer.openSale(BASE_EID, PRICE, ALLOCATION, closesAt + 60, MAX_PER_ORDER, { value: fee }))
        .to.be.revertedWithCustomError(issuer, "SaleInProgress")
        .withArgs(1);
    });

    it("needs a booth wired on the destination chain", async function () {
      const { issuer } = await loadFixture(collectionFixture);
      const closesAt = (await time.latest()) + 3600;
      const unwiredEid = 40161;

      await expect(issuer.openSale(unwiredEid, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, { value: 1 }))
        .to.be.revertedWithCustomError(issuer, "NoPeer")
        .withArgs(unwiredEid);
      expect(await issuer.reservedSupply()).to.equal(0);
    });

    it("is for the owner only", async function () {
      const { issuer, stranger } = await loadFixture(collectionFixture);
      const closesAt = (await time.latest()) + 3600;

      await expect(
        issuer.connect(stranger).openSale(BASE_EID, PRICE, ALLOCATION, closesAt, MAX_PER_ORDER, { value: 1 }),
      ).to.be.revertedWithCustomError(issuer, "OwnableUnauthorizedAccount");
    });
  });

  describe("checkIn", function () {
    it("lets the holder use a ticket once", async function () {
      const { issuer, booth, buyer, alice } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 1);

      await expect(issuer.connect(alice).checkIn(1)).to.emit(issuer, "TicketCheckedIn").withArgs(1, alice.address);
      expect(await issuer.checkedIn(1)).to.equal(true);

      await expect(issuer.connect(alice).checkIn(1))
        .to.be.revertedWithCustomError(issuer, "AlreadyCheckedIn")
        .withArgs(1);
    });

    it("refuses anyone who does not hold the ticket", async function () {
      const { issuer, booth, buyer, alice, stranger } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 1);

      // The buyer paid, but the ticket went to alice.
      await expect(issuer.connect(buyer).checkIn(1)).to.be.revertedWithCustomError(issuer, "NotTicketHolder");
      await expect(issuer.connect(stranger).checkIn(1)).to.be.revertedWithCustomError(issuer, "NotTicketHolder");
    });

    it("follows the ticket when it is resold", async function () {
      const { issuer, booth, ticket, buyer, alice, bob } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 1);
      await ticket.connect(alice).transferFrom(alice.address, bob.address, 1);

      await expect(issuer.connect(alice).checkIn(1)).to.be.revertedWithCustomError(issuer, "NotTicketHolder");
      await expect(issuer.connect(bob).checkIn(1)).to.emit(issuer, "TicketCheckedIn").withArgs(1, bob.address);
    });
  });

  describe("administration", function () {
    it("lets the owner change the gas bought for the booth, which changes the fee", async function () {
      const { issuer, stranger } = await loadFixture(collectionFixture);
      const before = await issuer.quoteOpenSale(BASE_EID);

      await expect(issuer.setBoothReceiveGas(400_000)).to.emit(issuer, "BoothReceiveGasSet").withArgs(400_000);
      expect(await issuer.boothReceiveGas()).to.equal(400_000);
      expect(await issuer.quoteOpenSale(BASE_EID)).to.be.greaterThan(before);

      await expect(issuer.connect(stranger).setBoothReceiveGas(1)).to.be.revertedWithCustomError(
        issuer,
        "OwnableUnauthorizedAccount",
      );
    });

    it("lets the owner withdraw HBAR the contract holds", async function () {
      const { issuer, owner, bob, stranger } = await loadFixture(collectionFixture);
      const amount = ethers.parseEther("3");
      await owner.sendTransaction({ to: await issuer.getAddress(), value: amount });

      await expect(issuer.sweepNative(bob.address, amount)).to.changeEtherBalances([issuer, bob], [-amount, amount]);

      await expect(issuer.sweepNative(ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(issuer, "ZeroAddress");
      await expect(issuer.connect(stranger).sweepNative(stranger.address, 0)).to.be.revertedWithCustomError(
        issuer,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
