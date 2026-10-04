import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import type { TicketBooth, TicketIssuer } from "../typechain-types";
import {
  LOCAL_EIDS,
  NETWORKS,
  getNetworkConfig,
  readDeployedAddress,
  toPeer,
  txOverrides,
} from "../utils/hopstileConfig";

/**
 * Tells each contract which contract on the other chain it may talk to. A LayerZero app only accepts messages
 * from its peer, and only sends to it, so nothing works until both sides are wired.
 *
 * On a live network the other side's address is read from its deployment files. If it has not been deployed
 * yet, this step is skipped: deploy the other side, then run the deploy command for this network again.
 */
const wirePeers: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const config = getNetworkConfig(hre);
  const { deployer } = await hre.getNamedAccounts();
  const { log } = hre.deployments;

  async function setPeer(contractName: "TicketIssuer" | "TicketBooth", remoteEid: number, remoteAddress: string) {
    const contract = await hre.ethers.getContract<TicketIssuer | TicketBooth>(contractName, deployer);
    const peer = toPeer(remoteAddress);
    if ((await contract.peers(remoteEid)).toLowerCase() === peer.toLowerCase()) return;

    const tx = await contract.setPeer(remoteEid, peer, await txOverrides(hre, config, { hederaGasLimit: 200_000n }));
    await tx.wait();
    log(`${contractName}: peer for endpoint ${remoteEid} set to ${remoteAddress} (tx: ${tx.hash})`);
  }

  if (config.role === "local") {
    const { get } = hre.deployments;
    await setPeer("TicketIssuer", LOCAL_EIDS.booth, (await get("TicketBooth")).address);
    await setPeer("TicketBooth", LOCAL_EIDS.issuer, (await get("TicketIssuer")).address);
    return;
  }

  const counterpart = config.counterpart as string;
  const [localName, remoteName] =
    config.role === "issuer" ? (["TicketIssuer", "TicketBooth"] as const) : (["TicketBooth", "TicketIssuer"] as const);
  const remoteAddress = readDeployedAddress(hre, counterpart, remoteName);
  if (!remoteAddress) {
    log(
      `${remoteName} is not deployed on ${counterpart} yet. Deploy it, then run this network's deploy again to wire.`,
    );
    return;
  }
  await setPeer(localName, NETWORKS[counterpart].eid, remoteAddress);
};

wirePeers.tags = ["Wire"];
wirePeers.dependencies = ["TicketIssuer", "TicketBooth"];
export default wirePeers;
