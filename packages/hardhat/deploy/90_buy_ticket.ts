import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import type { TicketBooth, TicketIssuer } from "../typechain-types";
import { getNetworkConfig, isLocalNetwork, txLinks, txOverrides } from "../utils/hopstileConfig";

/**
 * Buys tickets at the booth with the deployer account. Runs only through `yarn hardhat:buy`.
 *
 *   yarn hardhat:buy --network baseSepolia
 *   TICKETS=2 RECIPIENT=0x... yarn hardhat:buy --network baseSepolia
 *
 * `TICKETS` defaults to 1 and `RECIPIENT`, the account on Hedera that receives them, to the deployer.
 */
const buyTicket: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  const { deployer } = await hre.getNamedAccounts();
  const { log } = hre.deployments;

  if (config.role === "issuer") {
    log(`Tickets are bought at a booth. Run this against the booth network: --network ${config.counterpart}`);
    return;
  }
  const booth = await hre.ethers.getContract<TicketBooth>("TicketBooth", deployer);
  if (!(await booth.isOpen())) {
    log("The booth has no open sale. It opens when the sale terms sent by the issuer arrive over LayerZero.");
    return;
  }

  const quantity = Number(process.env.TICKETS ?? 1);
  const recipient = process.env.RECIPIENT ?? deployer;

  // Ticket cost plus the LayerZero fee, with a tenth added to the fee in case it moves. The surplus is refunded.
  const { cost, lzFee } = await booth.quoteBuy(quantity);
  const tx = await booth.buy(
    recipient,
    quantity,
    await txOverrides(hre, config, { hederaGasLimit: 0n, value: cost + (lzFee * 11n) / 10n }),
  );
  await tx.wait();

  log(
    `ordered ${quantity} ticket(s) for ${recipient}: ${hre.ethers.formatEther(cost)} for tickets, about ${hre.ethers.formatEther(lzFee)} for LayerZero (tx: ${tx.hash})`,
  );
  if (isLocalNetwork(hre.network.name)) {
    const issuer = await hre.ethers.getContract<TicketIssuer>("TicketIssuer", deployer);
    log(`minted on the local chain: TicketIssuer.totalMinted is now ${await issuer.totalMinted()}`);
    return;
  }
  log("the tickets are minted on Hedera once LayerZero delivers the order, usually within a few minutes");
  log(`   ${txLinks(config, tx.hash)}`);
};

buyTicket.skip = async () => process.env.HOPSTILE_ACTION !== "buy";
buyTicket.tags = ["Buy"];
export default buyTicket;
