import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import type { TicketBooth } from "../typechain-types";
import { getNetworkConfig, txLinks, txOverrides } from "../utils/hopstileConfig";

/**
 * Settles the booth's sale once it has closed or sold out: the booth reports its final count to the issuer,
 * which releases the unsold supply. Runs only through `yarn hardhat:settle`.
 *
 *   yarn hardhat:settle --network baseSepolia
 */
const settleSale: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  const { deployer } = await hre.getNamedAccounts();
  const { log } = hre.deployments;

  if (config.role === "issuer") {
    log(`A sale is settled from its booth. Run this against the booth network: --network ${config.counterpart}`);
    return;
  }
  const booth = await hre.ethers.getContract<TicketBooth>("TicketBooth", deployer);

  const sale = await booth.currentSale();
  if (sale.saleId === 0n || sale.settled) {
    log("The booth has no sale to settle.");
    return;
  }
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  if (BigInt(latestBlock?.timestamp ?? 0) < sale.closesAt && sale.sold < sale.allocation) {
    log(`Sale ${sale.saleId} is still open until ${new Date(Number(sale.closesAt) * 1000).toISOString()}.`);
    return;
  }

  const fee = await booth.quoteSettle();
  const tx = await booth.settleSale(await txOverrides(hre, config, { hederaGasLimit: 0n, value: (fee * 11n) / 10n }));
  await tx.wait();

  log(`sale ${sale.saleId} settled with ${sale.sold} of ${sale.allocation} tickets sold (tx: ${tx.hash})`);
  const links = txLinks(config, tx.hash, true);
  if (links) log(`   ${links}`);
};

settleSale.skip = async () => process.env.HOPSTILE_ACTION !== "settle";
settleSale.tags = ["Settle"];
export default settleSale;
