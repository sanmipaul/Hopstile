import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";
import { getNetworkConfig } from "../utils/hopstileConfig";

/** Deploys `TicketIssuer` on Hedera, or on the local chain. Skipped on booth networks. */
const deployTicketIssuer: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  if (config.role === "booth") return;

  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;

  const endpoint = config.endpoint ?? (await get("MockEndpointHedera")).address;

  await deploy("TicketIssuer", {
    from: deployer,
    args: [endpoint, deployer],
    log: true,
    autoMine: true,
    gasLimit: "5000000",
    gasPrice: await getDeployGasPrice(hre),
  });
};

deployTicketIssuer.tags = ["TicketIssuer"];
deployTicketIssuer.dependencies = ["Mocks"];
export default deployTicketIssuer;
