import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";
import { ZeroHash } from "ethers";

import type { TicketIssuer } from "../typechain-types";
import { LOCAL_EIDS, NETWORKS, SALE, getNetworkConfig, txLinks, txOverrides } from "../utils/hopstileConfig";

/**
 * Opens the first sale: the issuer sends the terms in `SALE` to the booth over LayerZero. Skipped on booth
 * networks, while the booth is not wired yet, and while a sale is already running.
 */
const openSale: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  if (config.role === "booth") return;

  const { deployer } = await hre.getNamedAccounts();
  const { log } = hre.deployments;
  const issuer = await hre.ethers.getContract<TicketIssuer>("TicketIssuer", deployer);

  const boothEid = config.counterpart ? NETWORKS[config.counterpart].eid : LOCAL_EIDS.booth;
  if ((await issuer.peers(boothEid)) === ZeroHash) {
    log("TicketIssuer has no booth peer yet, so no sale was opened. Deploy the booth, then run this deploy again.");
    return;
  }

  const activeSale = await issuer.activeSaleOf(boothEid);
  if (activeSale !== 0n && !(await issuer.getSale(activeSale)).settled) return;

  // The quote is exact for this block. Send a tenth more in case the fee moves; the endpoint refunds the rest.
  const fee = await issuer.quoteOpenSale(boothEid);
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  const closesAt = (latestBlock?.timestamp ?? Math.floor(Date.now() / 1000)) + SALE.durationSeconds;

  const tx = await issuer.openSale(
    boothEid,
    SALE.price,
    SALE.allocation,
    closesAt,
    SALE.maxPerOrder,
    await txOverrides(hre, config, { hederaGasLimit: 1_500_000n, value: (fee * 11n) / 10n }),
  );
  await tx.wait();

  log(
    `sale opened for booth endpoint ${boothEid}: ${SALE.allocation} tickets until ${new Date(closesAt * 1000).toISOString()} (tx: ${tx.hash})`,
  );
  const links = txLinks(config, tx.hash);
  if (links) log(`   ${links}`);
};

openSale.tags = ["Sale"];
openSale.dependencies = ["Collection", "Wire"];
export default openSale;
