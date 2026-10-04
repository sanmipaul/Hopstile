import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import {
  ALLOCATION,
  BASE_EID,
  GAS,
  HEDERA_EID,
  MAX_PER_ORDER,
  MAX_SUPPLY,
  METADATA,
  PRICE,
  buy,
  closeAndSettle,
  collectionFixture,
  expectConsistent,
  lastPacket,
  saleFixture,
} from "./helpers/fixtures";

describe("TicketBooth", function () {
  describe("deployment", function () {
    it("knows its issuer chain and its gas budgets", async function () {
      const { booth } = await loadFixture(collectionFixture);
      const gas = await booth.gasConfig();

      expect(await booth.issuerEid()).to.equal(HEDERA_EID);
      expect(gas.mintBase).to.equal(GAS.mintBase);
      expect(gas.mintPerTicket).to.equal(GAS.mintPerTicket);
      expect(gas.settle).to.equal(GAS.settle);
      expect(await booth.isOpen()).to.equal(false);
    });

    it("refuses a gas budget of zero", async function () {
      const { booth, baseEndpoint, owner } = await loadFixture(collectionFixture);

      await expect(
        ethers.deployContract("TicketBooth", [
          await baseEndpoint.getAddress(),
          owner.address,
          HEDERA_EID,
          { ...GAS, mintPerTicket: 0n },
        ]),
      ).to.be.revertedWithCustomError(booth, "InvalidGasConfig");
    });
  });

  describe("buy", function () {
    it("takes the price and has the tickets minted on Hedera for the recipient", async function () {
      const { issuer, booth, ticket, buyer, alice } = await loadFixture(saleFixture);

      const tx = buy(booth, buyer, alice.address, 2);
      await expect(tx)
        .to.emit(booth, "TicketsOrdered")
        .withArgs(1, 1, buyer.address, alice.address, 2, PRICE * 2n, anyValue);
      await expect(tx).to.emit(issuer, "OrderFulfilled").withArgs(1, 1, alice.address, BASE_EID, [1n, 2n], 0, anyValue);

      expect(await ticket.ownerOf(1)).to.equal(alice.address);
      expect(await ticket.ownerOf(2)).to.equal(alice.address);
      expect(await ticket.balanceOf(alice.address)).to.equal(2);
      expect(await ticket.balanceOf(buyer.address)).to.equal(0);
      expect(await ticket.tokenURI(1)).to.equal(ethers.toUtf8String(METADATA));

      expect((await booth.currentSale()).sold).to.equal(2);
      expect(await booth.proceeds()).to.equal(PRICE * 2n);
      expect(await booth.orderCount()).to.equal(1);
      expect((await issuer.getSale(1)).minted).to.equal(2);
      expect(await issuer.totalMinted()).to.equal(2);
      expect(await issuer.reservedSupply()).to.equal(ALLOCATION - 2);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("charges the ticket cost plus the LayerZero fee and refunds anything above", async function () {
      const { booth, baseEndpoint, buyer, alice } = await loadFixture(saleFixture);
      const { cost, lzFee, total } = await booth.quoteBuy(3);
      expect(cost).to.equal(PRICE * 3n);
      expect(total).to.equal(cost + lzFee);

      await expect(
        booth.connect(buyer).buy(alice.address, 3, { value: total + ethers.parseEther("1") }),
      ).to.changeEtherBalances([buyer, booth, baseEndpoint], [-total, cost, lzFee]);
    });

    it("buys more gas on Hedera for a larger order", async function () {
      const { booth, hederaEndpoint, buyer, alice } = await loadFixture(saleFixture);

      expect((await booth.quoteBuy(4)).lzFee).to.be.greaterThan((await booth.quoteBuy(1)).lzFee);

      await buy(booth, buyer, alice.address, 1);
      expect((await hederaEndpoint.getPacket(await lastPacket(hederaEndpoint))).gasLimit).to.equal(
        GAS.mintBase + GAS.mintPerTicket,
      );
      await buy(booth, buyer, alice.address, 4);
      expect((await hederaEndpoint.getPacket(await lastPacket(hederaEndpoint))).gasLimit).to.equal(
        GAS.mintBase + GAS.mintPerTicket * 4n,
      );
    });

    it("numbers orders and serials in sequence across buyers", async function () {
      const { issuer, booth, ticket, buyer, alice, bob } = await loadFixture(saleFixture);

      await expect(buy(booth, buyer, alice.address, 1))
        .to.emit(issuer, "OrderFulfilled")
        .withArgs(1, 1, alice.address, BASE_EID, [1n], 0, anyValue);
      await expect(buy(booth, bob, bob.address, 2))
        .to.emit(issuer, "OrderFulfilled")
        .withArgs(1, 2, bob.address, BASE_EID, [2n, 3n], 0, anyValue);

      expect(await ticket.ownerOf(3)).to.equal(bob.address);
      expect(await booth.orderCount()).to.equal(2);
    });

    it("never sells more than the allocation", async function () {
      const { issuer, booth, ticket, buyer, alice } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 4);
      await buy(booth, buyer, alice.address, 4);

      const { total } = await booth.quoteBuy(3);
      await expect(booth.connect(buyer).buy(alice.address, 3, { value: total }))
        .to.be.revertedWithCustomError(booth, "SoldOut")
        .withArgs(2);

      await buy(booth, buyer, alice.address, 2);
      expect((await booth.currentSale()).sold).to.equal(ALLOCATION);
      expect(await booth.isOpen()).to.equal(false);
      await expect(
        booth.connect(buyer).buy(alice.address, 1, { value: (await booth.quoteBuy(1)).total }),
      ).to.be.revertedWithCustomError(booth, "SaleNotOpen");

      expect(await issuer.totalMinted()).to.equal(ALLOCATION);
      expect(await issuer.reservedSupply()).to.equal(0);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("rejects an order the sale does not allow", async function () {
      const { booth, buyer, alice } = await loadFixture(saleFixture);
      const { total } = await booth.quoteBuy(MAX_PER_ORDER);

      await expect(booth.connect(buyer).buy(ethers.ZeroAddress, 1, { value: total })).to.be.revertedWithCustomError(
        booth,
        "ZeroAddress",
      );
      await expect(booth.connect(buyer).buy(alice.address, 0, { value: total })).to.be.revertedWithCustomError(
        booth,
        "InvalidQuantity",
      );
      await expect(
        booth.connect(buyer).buy(alice.address, MAX_PER_ORDER + 1, { value: total * 2n }),
      ).to.be.revertedWithCustomError(booth, "InvalidQuantity");
    });

    it("rejects a payment below the ticket cost", async function () {
      const { booth, buyer, alice } = await loadFixture(saleFixture);

      await expect(booth.connect(buyer).buy(alice.address, 2, { value: PRICE * 2n - 1n }))
        .to.be.revertedWithCustomError(booth, "InsufficientPayment")
        .withArgs(PRICE * 2n);
    });

    it("rejects a payment that covers the tickets but not the LayerZero fee", async function () {
      const { booth, baseEndpoint, buyer, alice } = await loadFixture(saleFixture);
      const { cost, lzFee } = await booth.quoteBuy(1);

      await expect(booth.connect(buyer).buy(alice.address, 1, { value: cost + lzFee - 1n }))
        .to.be.revertedWithCustomError(baseEndpoint, "InsufficientFee")
        .withArgs(lzFee, lzFee - 1n);
      expect(await booth.proceeds()).to.equal(0);
    });

    it("is closed before a sale arrives and after its closing time", async function () {
      const { booth, buyer, alice } = await loadFixture(collectionFixture);
      await expect(booth.connect(buyer).buy(alice.address, 1, { value: PRICE })).to.be.revertedWithCustomError(
        booth,
        "SaleNotOpen",
      );

      const open = await loadFixture(saleFixture);
      await time.increaseTo(open.closesAt);
      expect(await open.booth.isOpen()).to.equal(false);
      await expect(
        open.booth.connect(open.buyer).buy(open.alice.address, 1, { value: (await open.booth.quoteBuy(1)).total }),
      ).to.be.revertedWithCustomError(open.booth, "SaleNotOpen");
    });
  });

  describe("settleSale", function () {
    it("cannot end a sale that is still selling", async function () {
      const { booth } = await loadFixture(saleFixture);

      await expect(booth.settleSale({ value: await booth.quoteSettle() })).to.be.revertedWithCustomError(
        booth,
        "SaleStillOpen",
      );
    });

    it("has nothing to settle before a sale arrives", async function () {
      const { booth } = await loadFixture(collectionFixture);

      await expect(booth.settleSale({ value: 1 })).to.be.revertedWithCustomError(booth, "SaleNotOpen");
    });

    it("reports the final count, and the issuer releases the unsold supply", async function () {
      const { issuer, booth, ticket, buyer, alice, stranger, closesAt } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 3);
      await time.increaseTo(closesAt);

      // Anyone can settle: the booth only reports what it already knows.
      const tx = booth.connect(stranger).settleSale({ value: await booth.quoteSettle() });
      await expect(tx).to.emit(booth, "SaleSettlementSent").withArgs(1, 3, anyValue);
      await expect(tx)
        .to.emit(issuer, "SaleSettled")
        .withArgs(1, 3, ALLOCATION - 3);

      const sale = await issuer.getSale(1);
      expect(sale.settled).to.equal(true);
      expect(sale.sold).to.equal(3);
      expect(await issuer.reservedSupply()).to.equal(0);
      expect(await issuer.availableSupply()).to.equal(MAX_SUPPLY - 3);
      expect((await booth.currentSale()).settled).to.equal(true);
      await expectConsistent({ issuer, booth, ticket });
    });

    it("can settle early once the sale has sold out", async function () {
      const { issuer, booth, buyer, alice } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 4);
      await buy(booth, buyer, alice.address, 4);
      await buy(booth, buyer, alice.address, 2);

      await expect(booth.settleSale({ value: await booth.quoteSettle() }))
        .to.emit(issuer, "SaleSettled")
        .withArgs(1, ALLOCATION, 0);
    });

    it("can only be done once, and stops further sales", async function () {
      const { booth, buyer, alice, closesAt } = await loadFixture(saleFixture);
      await closeAndSettle(booth, closesAt);

      await expect(booth.settleSale({ value: await booth.quoteSettle() })).to.be.revertedWithCustomError(
        booth,
        "SaleNotOpen",
      );
      await expect(
        booth.connect(buyer).buy(alice.address, 1, { value: (await booth.quoteBuy(1)).total }),
      ).to.be.revertedWithCustomError(booth, "SaleNotOpen");
    });

    it("refunds the surplus of the LayerZero fee", async function () {
      const { booth, baseEndpoint, stranger, closesAt } = await loadFixture(saleFixture);
      await time.increaseTo(closesAt);
      const fee = await booth.quoteSettle();

      await expect(booth.connect(stranger).settleSale({ value: fee + ethers.parseEther("1") })).to.changeEtherBalances(
        [stranger, baseEndpoint, booth],
        [-fee, fee, 0n],
      );
    });

    it("makes room for the next sale, which reuses the released supply", async function () {
      const { issuer, booth, ticket, buyer, alice, closesAt } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 2);
      await closeAndSettle(booth, closesAt);

      // Everything except the two minted tickets can be allocated again.
      const nextClose = (await time.latest()) + 3600;
      await issuer.openSale(BASE_EID, PRICE * 2n, MAX_SUPPLY - 2, nextClose, 1, {
        value: await issuer.quoteOpenSale(BASE_EID),
      });

      const listed = await booth.currentSale();
      expect(listed.saleId).to.equal(2);
      expect(listed.price).to.equal(PRICE * 2n);
      expect(listed.sold).to.equal(0);
      expect(listed.settled).to.equal(false);
      expect(await issuer.activeSaleOf(BASE_EID)).to.equal(2);
      expect(await issuer.availableSupply()).to.equal(0);

      await expect(buy(booth, buyer, alice.address, 1))
        .to.emit(issuer, "OrderFulfilled")
        .withArgs(2, 2, alice.address, BASE_EID, [3n], 0, anyValue);
      await expectConsistent({ issuer, booth, ticket });
    });
  });

  describe("administration", function () {
    it("pays the proceeds out to the owner's chosen account", async function () {
      const { booth, buyer, alice, bob, stranger } = await loadFixture(saleFixture);
      await buy(booth, buyer, alice.address, 3);
      const revenue = PRICE * 3n;

      await expect(booth.connect(stranger).withdrawProceeds(stranger.address)).to.be.revertedWithCustomError(
        booth,
        "OwnableUnauthorizedAccount",
      );
      await expect(booth.withdrawProceeds(ethers.ZeroAddress)).to.be.revertedWithCustomError(booth, "ZeroAddress");

      const tx = booth.withdrawProceeds(bob.address);
      await expect(tx).to.changeEtherBalances([booth, bob], [-revenue, revenue]);
      await expect(tx).to.emit(booth, "ProceedsWithdrawn").withArgs(bob.address, revenue);
      expect(await booth.proceeds()).to.equal(0);

      await expect(booth.withdrawProceeds(bob.address)).to.be.revertedWithCustomError(booth, "NothingToWithdraw");
    });

    it("lets the owner retune the gas bought on Hedera", async function () {
      const { booth, stranger } = await loadFixture(saleFixture);
      const before = (await booth.quoteBuy(1)).lzFee;
      const next = { mintBase: 500_000n, mintPerTicket: 400_000n, settle: 200_000n };

      await expect(booth.setGasConfig(next))
        .to.emit(booth, "GasConfigSet")
        .withArgs(next.mintBase, next.mintPerTicket, next.settle);
      expect((await booth.quoteBuy(1)).lzFee).to.be.greaterThan(before);

      await expect(booth.setGasConfig({ ...next, settle: 0n })).to.be.revertedWithCustomError(
        booth,
        "InvalidGasConfig",
      );
      await expect(booth.connect(stranger).setGasConfig(next)).to.be.revertedWithCustomError(
        booth,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
