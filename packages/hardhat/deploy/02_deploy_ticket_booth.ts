import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { GAS, LOCAL_EIDS, NETWORKS, getNetworkConfig } from "../utils/hopstileConfig";

/** Deploys `TicketBooth` on a booth network, or on the local chain. Skipped on Hedera. */
const deployTicketBooth: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  if (config.role === "issuer") return;

  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;

  const endpoint = config.endpoint ?? (await get("MockEndpointBase")).address;
  const issuerEid = config.counterpart ? NETWORKS[config.counterpart].eid : LOCAL_EIDS.issuer;

  await deploy("TicketBooth", {
    from: deployer,
    args: [
      endpoint,
      deployer,
      issuerEid,
      { mintBase: GAS.mintBase, mintPerTicket: GAS.mintPerTicket, settle: GAS.settle },
    ],
    log: true,
    autoMine: true,
    gasLimit: "3500000",
  });
};

deployTicketBooth.tags = ["TicketBooth"];
deployTicketBooth.dependencies = ["Mocks"];
export default deployTicketBooth;
