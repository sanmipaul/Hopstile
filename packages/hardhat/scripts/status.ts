import hre, { deployments, ethers, network } from "hardhat";
import { ZeroAddress } from "ethers";

import { LOCAL_EIDS, NETWORKS, getNetworkConfig } from "../utils/hopstileConfig";

/**
 * Prints the state of Hopstile on the selected network. Read-only, so it needs no deployer key.
 *
 *   yarn hardhat:status --network hederaTestnet
 *   yarn hardhat:status --network baseSepolia
 */
async function main() {
  const config = getNetworkConfig(hre);
  console.log(`Hopstile on ${network.name} (LayerZero endpoint id ${config.eid})`);

  const issuerDeployment = await deployments.getOrNull("TicketIssuer");
  if (issuerDeployment && config.role !== "booth") {
    const issuer = await ethers.getContractAt("TicketIssuer", issuerDeployment.address);
    const boothEid = config.counterpart ? NETWORKS[config.counterpart].eid : LOCAL_EIDS.booth;
    const token = await issuer.ticketToken();

    console.log(`\nTicketIssuer ${issuerDeployment.address}`);
    console.log(`  ticket token     ${token === ZeroAddress ? "not created yet" : token}`);
    console.log(
      `  supply           ${await issuer.totalMinted()} minted, ${await issuer.reservedSupply()} reserved, ${await issuer.availableSupply()} available of ${await issuer.maxSupply()}`,
    );
    console.log(`  booth peer       ${await issuer.peers(boothEid)}`);

    const saleId = await issuer.activeSaleOf(boothEid);
    if (saleId === 0n) {
      console.log("  sale             none opened");
    } else {
      const sale = await issuer.getSale(saleId);
      console.log(
        `  sale ${saleId}           ${sale.minted} minted of ${sale.allocation} allocated, ${sale.settled ? `settled with ${sale.sold} sold` : "not settled"}`,
      );
      console.log(`  closes           ${new Date(Number(sale.closesAt) * 1000).toISOString()}`);
    }
  }

  const boothDeployment = await deployments.getOrNull("TicketBooth");
  if (boothDeployment && config.role !== "issuer") {
    const booth = await ethers.getContractAt("TicketBooth", boothDeployment.address);
    const sale = await booth.currentSale();

    console.log(`\nTicketBooth ${boothDeployment.address}`);
    console.log(`  issuer peer      ${await booth.peers(await booth.issuerEid())}`);
    if (sale.saleId === 0n) {
      console.log("  sale             none received yet");
    } else {
      console.log(
        `  sale ${sale.saleId}           ${sale.sold} sold of ${sale.allocation}, ${(await booth.isOpen()) ? "open" : sale.settled ? "settled" : "closed"}`,
      );
      console.log(
        `  price            ${ethers.formatEther(sale.price)} per ticket, up to ${sale.maxPerOrder} per order`,
      );
      console.log(`  closes           ${new Date(Number(sale.closesAt) * 1000).toISOString()}`);
    }
    console.log(`  proceeds         ${ethers.formatEther(await booth.proceeds())}`);
  }

  if (!issuerDeployment && !boothDeployment) {
    console.log(
      "\nNothing is deployed on this network from this checkout. Run yarn hardhat:deploy --network <name> first.",
    );
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
