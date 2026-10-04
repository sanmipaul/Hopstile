import { expect } from "chai";
import { deployments, ethers, getNamedAccounts } from "hardhat";

import type { MockEndpointV2, TicketBooth, TicketIssuer } from "../typechain-types";
import { COLLECTION, GAS, HTS_ADDRESS, LOCAL_EIDS, SALE, toPeer } from "../utils/hopstileConfig";

/** Runs the scripts in `deploy/` as `yarn hardhat:deploy --network localhost` does, and checks what they leave. */
describe("Deploy scripts", function () {
  async function deployed() {
    await deployments.fixture();
    const { deployer } = await getNamedAccounts();
    return {
      deployer,
      issuer: await ethers.getContract<TicketIssuer>("TicketIssuer", deployer),
      booth: await ethers.getContract<TicketBooth>("TicketBooth", deployer),
      hederaEndpoint: await ethers.getContract<MockEndpointV2>("MockEndpointHedera", deployer),
    };
  }

  it("install the mock token service and wire the issuer and the booth to each other", async function () {
    const { issuer, booth, deployer } = await deployed();

    expect(await ethers.provider.getCode(HTS_ADDRESS)).to.not.equal("0x");
    expect(await issuer.owner()).to.equal(deployer);
    expect(await booth.owner()).to.equal(deployer);
    expect(await issuer.peers(LOCAL_EIDS.booth)).to.equal(toPeer(await booth.getAddress()).toLowerCase());
    expect(await booth.peers(LOCAL_EIDS.issuer)).to.equal(toPeer(await issuer.getAddress()).toLowerCase());
    expect(await booth.issuerEid()).to.equal(LOCAL_EIDS.issuer);
  });

  it("create the collection and open the sale described in the config", async function () {
    const { issuer, booth } = await deployed();

    expect(await issuer.ticketToken()).to.not.equal(ethers.ZeroAddress);
    expect(await issuer.maxSupply()).to.equal(COLLECTION.maxSupply);
    expect(ethers.toUtf8String(await issuer.ticketMetadata())).to.equal(COLLECTION.metadata);
    expect(await issuer.reservedSupply()).to.equal(SALE.allocation);

    const sale = await booth.currentSale();
    expect(sale.saleId).to.equal(1);
    expect(sale.price).to.equal(SALE.price);
    expect(sale.allocation).to.equal(SALE.allocation);
    expect(sale.maxPerOrder).to.equal(SALE.maxPerOrder);
    expect(await booth.isOpen()).to.equal(true);
  });

  it("leave a booth whose largest order mints within the configured gas", async function () {
    const { issuer, booth, hederaEndpoint, deployer } = await deployed();
    const { total } = await booth.quoteBuy(SALE.maxPerOrder);

    await expect(booth.buy(deployer, SALE.maxPerOrder, { value: total })).to.emit(hederaEndpoint, "PacketDelivered");

    const order = await hederaEndpoint.getPacket((await hederaEndpoint.inboxLength()) - 1n);
    expect(order.gasLimit).to.equal(GAS.mintBase + GAS.mintPerTicket * BigInt(SALE.maxPerOrder));
    expect(await issuer.totalMinted()).to.equal(SALE.maxPerOrder);
  });

  it("change nothing when they are run a second time", async function () {
    const { issuer, booth } = await deployed();
    const before = {
      issuer: await issuer.getAddress(),
      booth: await booth.getAddress(),
      token: await issuer.ticketToken(),
    };

    await deployments.run(undefined, {
      resetMemory: false,
      deletePreviousDeployments: false,
      writeDeploymentsToFiles: false,
    });

    expect((await deployments.get("TicketIssuer")).address).to.equal(before.issuer);
    expect((await deployments.get("TicketBooth")).address).to.equal(before.booth);
    expect(await issuer.ticketToken()).to.equal(before.token);
    expect(await issuer.saleCount()).to.equal(1);
  });
});
