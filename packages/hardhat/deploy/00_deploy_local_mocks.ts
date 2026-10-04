import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { HTS_ADDRESS, LOCAL_EIDS, isLocalNetwork } from "../utils/hopstileConfig";

/**
 * Local networks only. Sets up what a live network provides:
 * - the Hedera Token Service at 0x167, as `MockHederaTokenService`
 * - one LayerZero endpoint per side, as two linked `MockEndpointV2` contracts
 */
const deployLocalMocks: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!isLocalNetwork(hre.network.name)) return;

  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read, getArtifact, log } = hre.deployments;

  const tokenService = await getArtifact("MockHederaTokenService");
  await hre.network.provider.send("hardhat_setCode", [HTS_ADDRESS, tokenService.deployedBytecode]);
  log(`installed MockHederaTokenService at ${HTS_ADDRESS}`);

  const hederaEndpoint = await deploy("MockEndpointHedera", {
    contract: "MockEndpointV2",
    from: deployer,
    args: [LOCAL_EIDS.issuer],
    log: true,
    autoMine: true,
  });
  const baseEndpoint = await deploy("MockEndpointBase", {
    contract: "MockEndpointV2",
    from: deployer,
    args: [LOCAL_EIDS.booth],
    log: true,
    autoMine: true,
  });

  if ((await read("MockEndpointHedera", "remotes", LOCAL_EIDS.booth)) !== baseEndpoint.address) {
    await execute(
      "MockEndpointHedera",
      { from: deployer, log: true },
      "setRemote",
      LOCAL_EIDS.booth,
      baseEndpoint.address,
    );
  }
  if ((await read("MockEndpointBase", "remotes", LOCAL_EIDS.issuer)) !== hederaEndpoint.address) {
    await execute(
      "MockEndpointBase",
      { from: deployer, log: true },
      "setRemote",
      LOCAL_EIDS.issuer,
      hederaEndpoint.address,
    );
  }
};

deployLocalMocks.tags = ["Mocks"];
export default deployLocalMocks;
