const hre = require("hardhat");

async function main() {
    console.log("开始部署AIXP智能合约...");

    // 部署合约
    const AIXPProtocol = await hre.ethers.getContractFactory("AIXPProtocol");
    const contract = await AIXPProtocol.deploy();
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log("AIXP合约已部署到地址:", address);

    // 获取部署账户
    const [deployer] = await hre.ethers.getSigners();
    console.log("部署账户地址:", deployer.address);

    // 保存部署信息
    const deploymentInfo = {
        contractAddress: address,
        deployerAddress: deployer.address,
        network: hre.network.name,
        timestamp: new Date().toISOString()
    };

    console.log("部署信息:", deploymentInfo);
    
    // 验证合约部署
    console.log("等待区块确认...");
    await hre.ethers.provider.waitForTransaction(contract.deploymentTransaction().hash, 1);
    console.log("部署完成！");

    return deploymentInfo;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("部署失败:", error);
        process.exit(1);
    }); 