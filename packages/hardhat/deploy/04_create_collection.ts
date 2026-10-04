import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";
import { ZeroAddress } from "ethers";

import type { TicketIssuer } from "../typechain-types";
import {
  COLLECTION,
  collectionArgs,
  getNetworkConfig,
  hbarToEvmAmount,
  txLinks,
  txOverrides,
} from "../utils/hopstileConfig";

/** Creates the ticket collection as an HTS non-fungible token, once. Skipped on booth networks. */
const createCollection: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  if (config.role === "booth") return;

  const { deployer } = await hre.getNamedAccounts();
  const { log } = hre.deployments;
  const issuer = await hre.ethers.getContract<TicketIssuer>("TicketIssuer", deployer);

  if ((await issuer.ticketToken()) !== ZeroAddress) return;

  const tx = await issuer.createCollection(
    collectionArgs(deployer),
    await txOverrides(hre, config, {
      hederaGasLimit: 1_500_000n,
      value: hbarToEvmAmount(config, COLLECTION.creationFeeHbar),
    }),
  );
  await tx.wait();

  log(`ticket collection "${COLLECTION.name}" created as HTS token ${await issuer.ticketToken()} (tx: ${tx.hash})`);
  const links = txLinks(config, tx.hash);
  if (links) log(`   ${links}`);
};

createCollection.tags = ["Collection"];
createCollection.dependencies = ["TicketIssuer"];
export default createCollection;
